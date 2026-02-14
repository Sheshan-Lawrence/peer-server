package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"peerserver/broker"
	"peerserver/config"
	"peerserver/hub"
	"peerserver/protocol"

	"github.com/coder/websocket"
)

func newTestServerSimple() (*Server, *httptest.Server) {
	cfg := config.Default()
	cfg.MaxPeers = 100
	cfg.RateLimitPerSec = 1000
	cfg.RateLimitBurst = 2000
	cfg.SendBufferSize = 32
	cfg.CompressionEnabled = false

	b := broker.NewLocal()
	h := hub.New(cfg.ShardCount, cfg.MaxPeers, b)
	srv := New(cfg, h)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.handleWebSocket)
	mux.HandleFunc("/health", srv.handleHealth)
	mux.HandleFunc("/stats", srv.handleStats)

	ts := httptest.NewServer(mux)
	return srv, ts
}

func connectAndRegister(t *testing.T, tsURL, publicKey string) (*websocket.Conn, string) {
	t.Helper()

	url := "ws" + strings.TrimPrefix(tsURL, "http") + "/ws"
	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}

	regPayload, _ := json.Marshal(protocol.RegisterPayload{PublicKey: publicKey})
	regMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRegister, Payload: regPayload})
	conn.Write(ctx, websocket.MessageText, regMsg)

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read registered response error: %v", err)
	}
	msg, _ := protocol.Decode(data)
	if msg.Type != protocol.TypeRegistered {
		t.Fatalf("expected registered, got %s", msg.Type)
	}

	var rp protocol.RegisteredPayload
	json.Unmarshal(msg.Payload, &rp)
	return conn, rp.Fingerprint
}

func readMessage(t *testing.T, conn *websocket.Conn, timeout time.Duration) *protocol.Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	msg, err := protocol.Decode(data)
	if err != nil {
		t.Fatalf("decode error: %v", err)
	}
	return msg
}

func sendMessage(t *testing.T, conn *websocket.Conn, msg *protocol.Message) {
	t.Helper()
	data, _ := protocol.Encode(msg)
	err := conn.Write(context.Background(), websocket.MessageText, data)
	if err != nil {
		t.Fatalf("write error: %v", err)
	}
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestServerHealthEndpoint(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatalf("health request error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body)
	if body["status"] != "ok" {
		t.Errorf("expected status ok, got %v", body["status"])
	}
}

func TestServerStatsEndpoint(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/stats")
	if err != nil {
		t.Fatalf("stats request error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var body map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&body)
	if body["total_peers"] == nil {
		t.Error("expected total_peers in stats")
	}
}

func TestServerWebSocketRegister(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	conn, fp := connectAndRegister(t, ts.URL, "test-public-key-1")
	defer conn.CloseNow()

	expectedFP := sha256Hex("test-public-key-1")
	if fp != expectedFP {
		t.Errorf("expected fingerprint %s, got %s", expectedFP, fp)
	}
}

func TestServerRegisterMissingPublicKey(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer conn.CloseNow()

	regPayload, _ := json.Marshal(protocol.RegisterPayload{PublicKey: ""})
	regMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRegister, Payload: regPayload})
	conn.Write(context.Background(), websocket.MessageText, regMsg)

	_, data, err := conn.Read(context.Background())
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	msg, _ := protocol.Decode(data)
	if msg.Type != protocol.TypeError {
		t.Errorf("expected error, got %s", msg.Type)
	}
}

func TestServerRegisterInvalidFirstMessage(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer conn.CloseNow()

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "test"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	conn.Write(context.Background(), websocket.MessageText, joinMsg)

	_, data, err := conn.Read(context.Background())
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	msg, _ := protocol.Decode(data)
	if msg.Type != protocol.TypeError {
		t.Errorf("expected error, got %s", msg.Type)
	}
}

func TestServerFullFlow(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	conn1, _ := connectAndRegister(t, ts.URL, "key1")
	defer conn1.CloseNow()
	conn2, _ := connectAndRegister(t, ts.URL, "key2")
	defer conn2.CloseNow()

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "lobby", AppType: "game"})
	joinMsg := &protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload}

	sendMessage(t, conn1, joinMsg)
	msg1 := readMessage(t, conn1, 2*time.Second)
	if msg1.Type != protocol.TypePeerList {
		t.Errorf("expected peer_list, got %s", msg1.Type)
	}

	sendMessage(t, conn2, joinMsg)
	msg2 := readMessage(t, conn2, 2*time.Second)
	if msg2.Type != protocol.TypePeerList {
		t.Errorf("expected peer_list, got %s", msg2.Type)
	}

	msg3 := readMessage(t, conn1, 2*time.Second)
	if msg3.Type != protocol.TypePeerJoined {
		t.Errorf("expected peer_joined, got %s", msg3.Type)
	}
}

func TestServerSignalFlow(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	conn1, fp1 := connectAndRegister(t, ts.URL, "signal-key1")
	defer conn1.CloseNow()
	conn2, fp2 := connectAndRegister(t, ts.URL, "signal-key2")
	defer conn2.CloseNow()

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "signal-ns", AppType: "game"})
	joinMsg := &protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload}

	sendMessage(t, conn1, joinMsg)
	readMessage(t, conn1, 2*time.Second)

	sendMessage(t, conn2, joinMsg)
	readMessage(t, conn2, 2*time.Second)
	readMessage(t, conn1, 2*time.Second)

	signalPayload, _ := json.Marshal(protocol.SignalPayload{SignalType: "offer", SDP: "test-sdp"})
	signalMsg := &protocol.Message{Type: protocol.TypeSignal, To: fp2, Payload: signalPayload}
	sendMessage(t, conn1, signalMsg)

	received := readMessage(t, conn2, 2*time.Second)
	if received.Type != protocol.TypeSignal {
		t.Errorf("expected signal, got %s", received.Type)
	}
	if received.From != fp1 {
		t.Errorf("expected from %s, got %s", fp1, received.From)
	}
}

func TestServerRoomFlow(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	conn1, _ := connectAndRegister(t, ts.URL, "room-owner-key")
	defer conn1.CloseNow()
	conn2, _ := connectAndRegister(t, ts.URL, "room-joiner-key")
	defer conn2.CloseNow()

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "test-room", MaxSize: 10})
	sendMessage(t, conn1, &protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})

	msg := readMessage(t, conn1, 2*time.Second)
	if msg.Type != protocol.TypeRoomCreated {
		t.Errorf("expected room_created, got %s", msg.Type)
	}

	joinPayload, _ := json.Marshal(protocol.JoinRoomPayload{RoomID: "test-room"})
	sendMessage(t, conn2, &protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})

	msg = readMessage(t, conn2, 2*time.Second)
	if msg.Type != protocol.TypePeerList {
		t.Errorf("expected peer_list, got %s", msg.Type)
	}

	msg = readMessage(t, conn1, 2*time.Second)
	if msg.Type != protocol.TypePeerJoined {
		t.Errorf("expected peer_joined, got %s", msg.Type)
	}
}

func TestServerPing(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	conn, _ := connectAndRegister(t, ts.URL, "ping-key")
	defer conn.CloseNow()

	sendMessage(t, conn, &protocol.Message{Type: protocol.TypePing})
	msg := readMessage(t, conn, 2*time.Second)
	if msg.Type != protocol.TypePong {
		t.Errorf("expected pong, got %s", msg.Type)
	}
}

func TestServerConcurrentConnections(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	var wg sync.WaitGroup
	var mu sync.Mutex
	conns := make([]*websocket.Conn, 0)

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			conn, _ := connectAndRegister(t, ts.URL, fmt.Sprintf("concurrent-key-%d", id))
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
		}(i)
	}
	wg.Wait()

	for _, c := range conns {
		c.CloseNow()
	}
}

func TestServerCustomAlias(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer conn.CloseNow()

	regPayload, _ := json.Marshal(protocol.RegisterPayload{
		PublicKey: "alias-test-key",
		Alias:     "my-custom-alias",
	})
	regMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRegister, Payload: regPayload})
	conn.Write(context.Background(), websocket.MessageText, regMsg)

	_, data, err := conn.Read(context.Background())
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	msg, _ := protocol.Decode(data)
	var rp protocol.RegisteredPayload
	json.Unmarshal(msg.Payload, &rp)

	if rp.Alias != "my-custom-alias" {
		t.Errorf("expected alias my-custom-alias, got %s", rp.Alias)
	}
}

func TestServerBroadcastFlow(t *testing.T) {
	_, ts := newTestServerSimple()
	defer ts.Close()

	conn1, _ := connectAndRegister(t, ts.URL, "bcast-key1")
	defer conn1.CloseNow()
	conn2, _ := connectAndRegister(t, ts.URL, "bcast-key2")
	defer conn2.CloseNow()

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "bcast-ns", AppType: "game"})
	joinMsg := &protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload}

	sendMessage(t, conn1, joinMsg)
	readMessage(t, conn1, 2*time.Second)
	sendMessage(t, conn2, joinMsg)
	readMessage(t, conn2, 2*time.Second)
	readMessage(t, conn1, 2*time.Second)

	bcastPayload, _ := json.Marshal(protocol.BroadcastPayload{Namespace: "bcast-ns", Data: []byte(`"hello all"`)})
	sendMessage(t, conn1, &protocol.Message{Type: protocol.TypeBroadcast, Payload: bcastPayload})

	msg := readMessage(t, conn2, 2*time.Second)
	if msg.Type != protocol.TypeBroadcast {
		t.Errorf("expected broadcast, got %s", msg.Type)
	}
}

func TestGenerateFingerprint(t *testing.T) {
	fp := generateFingerprint("test-key")
	expected := sha256Hex("test-key")
	if fp != expected {
		t.Errorf("expected %s, got %s", expected, fp)
	}

	fp2 := generateFingerprint("test-key")
	if fp != fp2 {
		t.Error("fingerprint should be deterministic")
	}

	fp3 := generateFingerprint("other-key")
	if fp == fp3 {
		t.Error("different keys should produce different fingerprints")
	}
}

func TestGenerateAlias(t *testing.T) {
	alias := generateAlias("some-fingerprint")
	if alias == "" {
		t.Error("alias should not be empty")
	}

	parts := strings.Split(alias, "-")
	if len(parts) != 3 {
		t.Errorf("expected 3 parts in alias, got %d: %s", len(parts), alias)
	}

	alias2 := generateAlias("some-fingerprint")
	if alias != alias2 {
		t.Error("alias should be deterministic for same fingerprint")
	}
}

func TestCompressionMode(t *testing.T) {
	cfg := config.Default()
	cfg.CompressionEnabled = false
	b := broker.NewLocal()
	h := hub.New(cfg.ShardCount, cfg.MaxPeers, b)
	srv := New(cfg, h)
	defer srv.Shutdown()

	if srv.compressionMode() != websocket.CompressionDisabled {
		t.Error("expected CompressionDisabled")
	}

	cfg2 := config.Default()
	cfg2.CompressionEnabled = true
	srv2 := New(cfg2, h)
	if srv2.compressionMode() != websocket.CompressionContextTakeover {
		t.Error("expected CompressionContextTakeover")
	}
}
