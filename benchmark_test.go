package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"peerserver/broker"
	"peerserver/config"
	"peerserver/hub"
	"peerserver/protocol"
	"peerserver/server"

	"github.com/coder/websocket"
	jsoniter "github.com/json-iterator/go"
)

var (
	bjson  = jsoniter.ConfigCompatibleWithStandardLibrary
	stress = flag.Bool("stress", false, "run stress tests")
)

type benchClient struct {
	conn        *websocket.Conn
	fingerprint string
	received    chan []byte
	ctx         context.Context
	cancel      context.CancelFunc
	closed      atomic.Bool
}

func newBenchServer(maxPeers int) (*server.Server, *httptest.Server) {
	cfg := config.Default()
	cfg.MaxPeers = maxPeers
	cfg.RateLimitPerSec = 1000000
	cfg.RateLimitBurst = 2000000
	cfg.SendBufferSize = 256
	cfg.CompressionEnabled = false
	cfg.ShardCount = 64

	b := broker.NewLocal()
	h := hub.New(cfg.ShardCount, cfg.MaxPeers, b)
	srv := server.New(cfg, h)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.HandleWebSocket)
	mux.HandleFunc("/health", srv.HandleHealth)
	mux.HandleFunc("/stats", srv.HandleStats)

	ts := httptest.NewServer(mux)
	return srv, ts
}

func connectBenchClient(tsURL string, publicKey string, recvBuf int) (*benchClient, error) {
	url := "ws" + strings.TrimPrefix(tsURL, "http") + "/ws"
	ctx, cancel := context.WithCancel(context.Background())

	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		cancel()
		return nil, err
	}

	regPayload, _ := bjson.Marshal(protocol.RegisterPayload{PublicKey: publicKey})
	regMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRegister, Payload: regPayload})
	if err := conn.Write(ctx, websocket.MessageText, regMsg); err != nil {
		conn.CloseNow()
		cancel()
		return nil, err
	}

	readCtx, readCancel := context.WithTimeout(ctx, 10*time.Second)
	_, data, err := conn.Read(readCtx)
	readCancel()
	if err != nil {
		conn.CloseNow()
		cancel()
		return nil, err
	}

	msg, _ := protocol.Decode(data)
	var rp protocol.RegisteredPayload
	bjson.Unmarshal(msg.Payload, &rp)

	bc := &benchClient{
		conn:        conn,
		fingerprint: rp.Fingerprint,
		received:    make(chan []byte, recvBuf),
		ctx:         ctx,
		cancel:      cancel,
	}

	go bc.readLoop()
	return bc, nil
}

func (bc *benchClient) readLoop() {
	for {
		_, data, err := bc.conn.Read(bc.ctx)
		if err != nil {
			return
		}
		select {
		case bc.received <- data:
		default:
		}
	}
}

func (bc *benchClient) send(msg *protocol.Message) error {
	if bc.closed.Load() {
		return fmt.Errorf("client closed")
	}
	data, _ := protocol.Encode(msg)
	return bc.conn.Write(bc.ctx, websocket.MessageText, data)
}

func (bc *benchClient) joinNamespace(ns string) error {
	payload, _ := bjson.Marshal(protocol.JoinPayload{Namespace: ns, AppType: "bench"})
	return bc.send(&protocol.Message{Type: protocol.TypeJoin, Payload: payload})
}

func (bc *benchClient) drainN(n int, timeout time.Duration) int {
	deadline := time.After(timeout)
	count := 0
	for count < n {
		select {
		case <-bc.received:
			count++
		case <-deadline:
			return count
		}
	}
	return count
}

func (bc *benchClient) drain(timeout time.Duration) int {
	if timeout <= 0 {
		// non-blocking drain
		count := 0
		for {
			select {
			case <-bc.received:
				count++
			default:
				return count
			}
		}
	}
	deadline := time.After(timeout)
	count := 0
	for {
		select {
		case <-bc.received:
			count++
		case <-deadline:
			return count
		}
	}
}

func (bc *benchClient) close() {
	if bc.closed.CompareAndSwap(false, true) {
		bc.cancel()
		bc.conn.CloseNow()
	}
}

func (bc *benchClient) waitForType(msgType string, timeout time.Duration) (*protocol.Message, bool) {
	deadline := time.After(timeout)
	for {
		select {
		case data := <-bc.received:
			msg, err := protocol.Decode(data)
			if err == nil && msg.Type == msgType {
				return msg, true
			}
		case <-deadline:
			return nil, false
		}
	}
}

func connectNPeers(b *testing.B, tsURL string, ns string, n int) []*benchClient {
	b.Helper()
	clients := make([]*benchClient, n)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	sem := make(chan struct{}, 50)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			key := fmt.Sprintf("bench-key-%d-%d", time.Now().UnixNano(), idx)
			bc, err := connectBenchClient(tsURL, key, 1024)
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				return
			}
			if ns != "" {
				bc.joinNamespace(ns)
				bc.drainN(1, 2*time.Second)
			}
			mu.Lock()
			clients[idx] = bc
			mu.Unlock()
		}(i)
	}
	wg.Wait()

	if firstErr != nil {
		for _, c := range clients {
			if c != nil {
				c.close()
			}
		}
		b.Fatalf("connect error: %v", firstErr)
	}

	time.Sleep(100 * time.Millisecond)
	for _, c := range clients {
		if c != nil {
			c.drain(50 * time.Millisecond)
		}
	}

	return clients
}

func connectNPeersT(t *testing.T, tsURL string, ns string, n int) []*benchClient {
	t.Helper()
	clients := make([]*benchClient, n)
	var wg sync.WaitGroup
	var mu sync.Mutex
	failed := 0

	sem := make(chan struct{}, 50)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			key := fmt.Sprintf("stress-key-%d-%d", time.Now().UnixNano(), idx)
			bc, err := connectBenchClient(tsURL, key, 256)
			if err != nil {
				mu.Lock()
				failed++
				mu.Unlock()
				return
			}
			if ns != "" {
				bc.joinNamespace(ns)
				bc.drain(200 * time.Millisecond)
			}
			mu.Lock()
			clients[idx] = bc
			mu.Unlock()
		}(i)
	}
	wg.Wait()

	if failed > 0 {
		t.Logf("  warning: %d/%d connections failed", failed, n)
	}

	time.Sleep(100 * time.Millisecond)
	for _, c := range clients {
		if c != nil {
			c.drain(50 * time.Millisecond)
		}
	}

	return clients
}

func closeAll(clients []*benchClient) {
	var wg sync.WaitGroup
	for _, c := range clients {
		if c != nil {
			wg.Add(1)
			go func(cl *benchClient) {
				defer wg.Done()
				cl.close()
			}(c)
		}
	}
	wg.Wait()
}

func countValid(clients []*benchClient) int {
	n := 0
	for _, c := range clients {
		if c != nil && !c.closed.Load() {
			n++
		}
	}
	return n
}

func validClients(clients []*benchClient) []*benchClient {
	var out []*benchClient
	for _, c := range clients {
		if c != nil && !c.closed.Load() {
			out = append(out, c)
		}
	}
	return out
}

func memStats() runtime.MemStats {
	runtime.GC()
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms
}

// ============================================================
// BENCHMARKS
// ============================================================

func BenchmarkConnectionRegistration(b *testing.B) {
	_, ts := newBenchServer(b.N + 1000)
	defer ts.Close()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			key := fmt.Sprintf("conn-bench-%d-%d", time.Now().UnixNano(), i)
			bc, err := connectBenchClient(ts.URL, key, 16)
			if err != nil {
				b.Fatalf("connect error: %v", err)
			}
			bc.close()
			i++
		}
	})
	b.StopTimer()
}

func BenchmarkSignalThroughput(b *testing.B) {
	for _, peerCount := range []int{10, 100, 500} {
		b.Run(fmt.Sprintf("peers-%d", peerCount), func(b *testing.B) {
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			clients := connectNPeers(b, ts.URL, "signal-bench", peerCount)
			defer closeAll(clients)

			pairs := peerCount / 2
			signalPayload, _ := bjson.Marshal(protocol.SignalPayload{
				SignalType: "offer",
				SDP:        "v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
			})

			b.ResetTimer()

			var ops atomic.Int64
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					idx := int(ops.Add(1)-1) % pairs
					sender := clients[idx*2]
					receiver := clients[idx*2+1]

					msg := &protocol.Message{
						Type:    protocol.TypeSignal,
						To:      receiver.fingerprint,
						Payload: signalPayload,
					}
					if err := sender.send(msg); err != nil {
						continue
					}

					_, ok := receiver.waitForType(protocol.TypeSignal, 5*time.Second)
					if !ok {
						continue
					}
				}
			})
			b.StopTimer()

			elapsed := b.Elapsed()
			totalOps := ops.Load()
			if elapsed > 0 && totalOps > 0 {
				b.ReportMetric(float64(totalOps)/elapsed.Seconds(), "msgs/sec")
			}
		})
	}
}

func BenchmarkRelayThroughput(b *testing.B) {
	for _, peerCount := range []int{10, 100} {
		b.Run(fmt.Sprintf("peers-%d", peerCount), func(b *testing.B) {
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			clients := connectNPeers(b, ts.URL, "relay-bench", peerCount)
			defer closeAll(clients)

			pairs := peerCount / 2
			relayPayload, _ := bjson.Marshal(map[string]string{"data": "benchmark relay payload data here"})

			b.ResetTimer()

			var ops atomic.Int64
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					idx := int(ops.Add(1)-1) % pairs
					sender := clients[idx*2]
					receiver := clients[idx*2+1]

					msg := &protocol.Message{
						Type:    protocol.TypeRelay,
						To:      receiver.fingerprint,
						Payload: relayPayload,
					}
					if err := sender.send(msg); err != nil {
						continue
					}

					_, ok := receiver.waitForType(protocol.TypeRelay, 5*time.Second)
					if !ok {
						continue
					}
				}
			})
			b.StopTimer()

			elapsed := b.Elapsed()
			totalOps := ops.Load()
			if elapsed > 0 && totalOps > 0 {
				b.ReportMetric(float64(totalOps)/elapsed.Seconds(), "msgs/sec")
			}
		})
	}
}

func BenchmarkBroadcastFanOut(b *testing.B) {
	for _, peerCount := range []int{10, 50, 100, 500} {
		b.Run(fmt.Sprintf("peers-%d", peerCount), func(b *testing.B) {
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			ns := fmt.Sprintf("bcast-bench-%d", peerCount)
			clients := connectNPeers(b, ts.URL, ns, peerCount)
			defer closeAll(clients)

			bcastPayload, _ := bjson.Marshal(protocol.BroadcastPayload{
				Namespace: ns,
				Data:      []byte(`{"msg":"benchmark broadcast payload"}`),
			})
			bcastMsg := &protocol.Message{Type: protocol.TypeBroadcast, Payload: bcastPayload}

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				for _, r := range clients[1:] {
					r.drain(0)
				}

				clients[0].send(bcastMsg)

				for _, r := range clients[1:] {
					r.drainN(1, 5*time.Second)
				}
			}
			b.StopTimer()

			b.ReportMetric(float64(peerCount-1), "fan-out")
		})
	}
}

func BenchmarkMatchmaking(b *testing.B) {
	for _, groupSize := range []int{2, 4} {
		b.Run(fmt.Sprintf("group-%d", groupSize), func(b *testing.B) {
			peerCount := 200
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			clients := connectNPeers(b, ts.URL, "match-bench", peerCount)
			defer closeAll(clients)

			matchPayload, _ := bjson.Marshal(protocol.MatchPayload{
				Namespace: "match-bench",
				GroupSize: groupSize,
			})
			matchMsg := &protocol.Message{Type: protocol.TypeMatch, Payload: matchPayload}

			b.ResetTimer()

			matchesFormed := 0
			for i := 0; i < b.N; i++ {
				startIdx := (i * groupSize) % (peerCount - groupSize)
				for j := 0; j < groupSize; j++ {
					clients[startIdx+j].send(matchMsg)
				}

				gotMatch := false
				for j := 0; j < groupSize; j++ {
					msg, ok := clients[startIdx+j].waitForType(protocol.TypeMatched, 2*time.Second)
					if ok && msg != nil {
						gotMatch = true
					}
					clients[startIdx+j].drain(10 * time.Millisecond)
				}
				if gotMatch {
					matchesFormed++
				}
			}
			b.StopTimer()

			b.ReportMetric(float64(matchesFormed), "matches")
		})
	}
}

func BenchmarkJoinLeaveChurn(b *testing.B) {
	for _, peerCount := range []int{10, 50, 100} {
		b.Run(fmt.Sprintf("peers-%d", peerCount), func(b *testing.B) {
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			clients := connectNPeers(b, ts.URL, "", peerCount)
			defer closeAll(clients)

			b.ResetTimer()

			var ops atomic.Int64
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					idx := int(ops.Add(1)-1) % peerCount
					c := clients[idx]
					ns := fmt.Sprintf("churn-ns-%d", idx)

					joinPayload, _ := bjson.Marshal(protocol.JoinPayload{Namespace: ns, AppType: "bench"})
					c.send(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
					c.drainN(1, 2*time.Second)

					leavePayload, _ := bjson.Marshal(map[string]string{"namespace": ns})
					c.send(&protocol.Message{Type: protocol.TypeLeave, Payload: leavePayload})
				}
			})
			b.StopTimer()
		})
	}
}

func BenchmarkConcurrentSignaling(b *testing.B) {
	for _, peerCount := range []int{50, 200} {
		b.Run(fmt.Sprintf("peers-%d", peerCount), func(b *testing.B) {
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			clients := connectNPeers(b, ts.URL, "concurrent-signal", peerCount)
			defer closeAll(clients)

			signalPayload, _ := bjson.Marshal(protocol.SignalPayload{
				SignalType: "offer",
				SDP:        "v=0\r\no=- 999 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n",
			})

			b.ResetTimer()

			var totalSent atomic.Int64
			var totalRecv atomic.Int64

			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					sIdx := int(totalSent.Add(1)-1) % peerCount
					tIdx := (sIdx + 1) % peerCount

					sender := clients[sIdx]
					receiver := clients[tIdx]

					msg := &protocol.Message{
						Type:    protocol.TypeSignal,
						To:      receiver.fingerprint,
						Payload: signalPayload,
					}
					if err := sender.send(msg); err != nil {
						continue
					}

					_, ok := receiver.waitForType(protocol.TypeSignal, 5*time.Second)
					if ok {
						totalRecv.Add(1)
					}
				}
			})
			b.StopTimer()

			elapsed := b.Elapsed()
			sent := totalSent.Load()
			recv := totalRecv.Load()
			if elapsed > 0 && sent > 0 {
				b.ReportMetric(float64(sent)/elapsed.Seconds(), "sent/sec")
				b.ReportMetric(float64(recv)/elapsed.Seconds(), "recv/sec")
				b.ReportMetric(float64(recv)/float64(sent)*100, "delivery-%")
			}
		})
	}
}

func BenchmarkRoomCreateJoinLeave(b *testing.B) {
	_, ts := newBenchServer(1000)
	defer ts.Close()

	clients := connectNPeers(b, ts.URL, "", 100)
	defer closeAll(clients)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		roomID := fmt.Sprintf("bench-room-%d", i)
		ownerIdx := i % 100
		joinerIdx := (i + 1) % 100
		owner := clients[ownerIdx]
		joiner := clients[joinerIdx]

		createPayload, _ := bjson.Marshal(protocol.CreateRoomPayload{RoomID: roomID, MaxSize: 10})
		owner.send(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
		owner.drainN(1, 2*time.Second)

		joinPayload, _ := bjson.Marshal(protocol.JoinRoomPayload{RoomID: roomID})
		joiner.send(&protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})
		joiner.drainN(1, 2*time.Second)
		owner.drain(100 * time.Millisecond)

		leavePayload, _ := bjson.Marshal(map[string]string{"namespace": roomID})
		joiner.send(&protocol.Message{Type: protocol.TypeLeave, Payload: leavePayload})
		owner.send(&protocol.Message{Type: protocol.TypeLeave, Payload: leavePayload})
		owner.drain(100 * time.Millisecond)
		joiner.drain(100 * time.Millisecond)
	}
	b.StopTimer()
}

func BenchmarkPingPong(b *testing.B) {
	_, ts := newBenchServer(100)
	defer ts.Close()

	bc, err := connectBenchClient(ts.URL, "ping-bench-key", 1024)
	if err != nil {
		b.Fatalf("connect error: %v", err)
	}
	defer bc.close()

	pingMsg := &protocol.Message{Type: protocol.TypePing}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		bc.send(pingMsg)
		_, ok := bc.waitForType(protocol.TypePong, 5*time.Second)
		if !ok {
			b.Fatal("timeout waiting for pong")
		}
	}
	b.StopTimer()
}

func BenchmarkDiscoverPeers(b *testing.B) {
	for _, peerCount := range []int{10, 100, 500} {
		b.Run(fmt.Sprintf("peers-%d", peerCount), func(b *testing.B) {
			_, ts := newBenchServer(peerCount + 100)
			defer ts.Close()

			ns := fmt.Sprintf("discover-bench-%d", peerCount)
			clients := connectNPeers(b, ts.URL, ns, peerCount)
			defer closeAll(clients)

			discoverPayload, _ := bjson.Marshal(protocol.DiscoverPayload{Namespace: ns, Limit: 50})
			discoverMsg := &protocol.Message{Type: protocol.TypeDiscover, Payload: discoverPayload}

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				idx := i % peerCount
				clients[idx].send(discoverMsg)
				_, ok := clients[idx].waitForType(protocol.TypePeerList, 5*time.Second)
				if !ok {
					continue
				}
			}
			b.StopTimer()
		})
	}
}

func BenchmarkMetadataUpdate(b *testing.B) {
	_, ts := newBenchServer(200)
	defer ts.Close()

	clients := connectNPeers(b, ts.URL, "", 100)
	defer closeAll(clients)

	b.ResetTimer()
	var ops atomic.Int64
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			idx := int(ops.Add(1)-1) % 100
			metaPayload, _ := bjson.Marshal(protocol.MetadataPayload{
				Meta: map[string]interface{}{
					"score":  ops.Load(),
					"status": "playing",
					"level":  42,
				},
			})
			clients[idx].send(&protocol.Message{Type: protocol.TypeMetadata, Payload: metaPayload})
		}
	})
	b.StopTimer()
}

// ============================================================
// STRESS TESTS — only run with -stress flag
// ============================================================

func TestStressMaxConnections(t *testing.T) {
	if !*stress {
		t.Skip("skipping stress test: use -stress flag to enable")
	}

	levels := []int{100, 500, 1000, 2000, 5000}
	maxLevel := levels[len(levels)-1]

	_, ts := newBenchServer(maxLevel + 1000)
	defer ts.Close()

	var allClients []*benchClient
	defer func() {
		closeAll(allClients)
	}()

	for _, target := range levels {
		need := target - len(allClients)
		if need <= 0 {
			continue
		}

		before := memStats()
		connectStart := time.Now()

		newClients := connectNPeersT(t, ts.URL, "stress-ns", need)
		connectDur := time.Since(connectStart)

		connected := 0
		for _, c := range newClients {
			if c != nil {
				allClients = append(allClients, c)
				connected++
			}
		}

		after := memStats()
		memPerConn := uint64(0)
		if connected > 0 {
			memPerConn = (after.HeapAlloc - before.HeapAlloc) / uint64(connected)
		}

		totalConnected := countValid(allClients)

		// signal throughput at this level
		signalCount := 1000
		valid := validClients(allClients)
		if len(valid) < 2 {
			t.Logf("=== %d PEERS === (not enough connections)", target)
			continue
		}

		signalPayload, _ := bjson.Marshal(protocol.SignalPayload{SignalType: "offer", SDP: "bench"})
		signalStart := time.Now()
		var delivered atomic.Int64

		var swg sync.WaitGroup
		sem := make(chan struct{}, 100)
		for j := 0; j < signalCount; j++ {
			swg.Add(1)
			go func(idx int) {
				defer swg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				sIdx := (idx * 2) % len(valid)
				tIdx := (sIdx + 1) % len(valid)
				sender := valid[sIdx]
				receiver := valid[tIdx]

				msg := &protocol.Message{
					Type:    protocol.TypeSignal,
					To:      receiver.fingerprint,
					Payload: signalPayload,
				}
				if err := sender.send(msg); err != nil {
					return
				}
				_, ok := receiver.waitForType(protocol.TypeSignal, 5*time.Second)
				if ok {
					delivered.Add(1)
				}
			}(j)
		}
		swg.Wait()
		signalDur := time.Since(signalStart)

		signalsPerSec := float64(delivered.Load()) / signalDur.Seconds()
		deliveryPct := float64(delivered.Load()) / float64(signalCount) * 100

		t.Logf("=== %d PEERS (connected: %d) ===", target, totalConnected)
		t.Logf("  Connect time:    %v (%.0f peers/sec)", connectDur, float64(connected)/connectDur.Seconds())
		t.Logf("  Heap alloc:      %d MB", after.HeapAlloc/1024/1024)
		t.Logf("  Memory/conn:     %d KB", memPerConn/1024)
		t.Logf("  Goroutines:      %d", runtime.NumGoroutine())
		t.Logf("  Signals:         %d/%d delivered (%.1f%%)", delivered.Load(), signalCount, deliveryPct)
		t.Logf("  Signal rate:     %.0f msgs/sec", signalsPerSec)
		t.Logf("  Signal latency:  %.2f ms avg", signalDur.Seconds()/float64(signalCount)*1000)
		t.Logf("")
	}
}

func TestStressSignalLatencyPercentiles(t *testing.T) {
	if !*stress {
		t.Skip("skipping stress test: use -stress flag to enable")
	}

	_, ts := newBenchServer(1000)
	defer ts.Close()

	clients := connectNPeersT(t, ts.URL, "latency-ns", 200)
	defer closeAll(clients)

	valid := validClients(clients)
	if len(valid) < 2 {
		t.Fatal("not enough connected clients")
	}

	iterations := 1000
	latencies := make([]time.Duration, 0, iterations)
	var mu sync.Mutex

	signalPayload, _ := bjson.Marshal(protocol.SignalPayload{SignalType: "offer", SDP: "latency-test"})

	for i := 0; i < iterations; i++ {
		sIdx := (i * 2) % len(valid)
		tIdx := (sIdx + 1) % len(valid)
		sender := valid[sIdx]
		receiver := valid[tIdx]

		start := time.Now()
		msg := &protocol.Message{
			Type:    protocol.TypeSignal,
			To:      receiver.fingerprint,
			Payload: signalPayload,
		}
		if err := sender.send(msg); err != nil {
			continue
		}
		_, ok := receiver.waitForType(protocol.TypeSignal, 5*time.Second)
		if ok {
			lat := time.Since(start)
			mu.Lock()
			latencies = append(latencies, lat)
			mu.Unlock()
		}
	}

	if len(latencies) == 0 {
		t.Fatal("no latency samples collected")
	}

	sortDurations(latencies)

	p50 := latencies[len(latencies)*50/100]
	p95 := latencies[len(latencies)*95/100]
	p99 := latencies[len(latencies)*99/100]

	var total time.Duration
	for _, l := range latencies {
		total += l
	}
	avg := total / time.Duration(len(latencies))

	t.Logf("Signal Latency (%d samples, %d peers):", len(latencies), len(valid))
	t.Logf("  Average: %v", avg)
	t.Logf("  P50:     %v", p50)
	t.Logf("  P95:     %v", p95)
	t.Logf("  P99:     %v", p99)
	t.Logf("  Min:     %v", latencies[0])
	t.Logf("  Max:     %v", latencies[len(latencies)-1])
}

func TestStressBroadcastScaling(t *testing.T) {
	if !*stress {
		t.Skip("skipping stress test: use -stress flag to enable")
	}

	levels := []int{10, 50, 100, 250, 500}
	maxLevel := levels[len(levels)-1]

	_, ts := newBenchServer(maxLevel + 100)
	defer ts.Close()

	var allClients []*benchClient
	defer closeAll(allClients)

	for _, target := range levels {
		need := target - len(allClients)
		if need > 0 {
			newClients := connectNPeersT(t, ts.URL, "bcast-scale-ns", need)
			for _, c := range newClients {
				if c != nil {
					allClients = append(allClients, c)
				}
			}
		}

		valid := validClients(allClients)
		if len(valid) < 2 {
			t.Logf("Broadcast to %d peers: not enough connections", target)
			continue
		}

		// drain
		for _, c := range valid {
			c.drain(50 * time.Millisecond)
		}

		bcastPayload, _ := bjson.Marshal(protocol.BroadcastPayload{
			Namespace: "bcast-scale-ns",
			Data:      []byte(`{"benchmark":"broadcast scaling test"}`),
		})

		iterations := 10
		var totalTime time.Duration

		for i := 0; i < iterations; i++ {
			for _, r := range valid[1:] {
				r.drain(0)
			}

			start := time.Now()
			valid[0].send(&protocol.Message{Type: protocol.TypeBroadcast, Payload: bcastPayload})

			received := 0
			for _, r := range valid[1:] {
				n := r.drainN(1, 5*time.Second)
				received += n
			}
			totalTime += time.Since(start)
		}

		avgTime := totalTime / time.Duration(iterations)
		t.Logf("Broadcast to %d peers: avg=%v", len(valid), avgTime)
	}
}

// ============================================================
// HELPERS
// ============================================================

func sortDurations(d []time.Duration) {
	n := len(d)
	for i := 1; i < n; i++ {
		key := d[i]
		j := i - 1
		for j >= 0 && d[j] > key {
			d[j+1] = d[j]
			j--
		}
		d[j+1] = key
	}
}
