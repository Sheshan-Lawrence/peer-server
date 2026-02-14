package namespace

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"peerserver/peer"
	"peerserver/protocol"

	"github.com/coder/websocket"
)

func makePeer(t *testing.T, fingerprint string) (*peer.Peer, func()) {
	t.Helper()

	var serverConn *websocket.Conn
	ready := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var err error
		serverConn, err = websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		close(ready)
		select {}
	}))

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientConn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}

	<-ready

	_, cancel := context.WithCancel(context.Background())
	p := peer.New(serverConn, 32, cancel)
	p.Fingerprint = fingerprint
	p.Alias = fingerprint + "-alias"

	cleanup := func() {
		clientConn.CloseNow()
		if serverConn != nil {
			serverConn.CloseNow()
		}
		srv.Close()
	}

	return p, cleanup
}

func TestNamespaceAddRemove(t *testing.T) {
	ns := New("test", 100)

	p, cleanup := makePeer(t, "fp1")
	defer cleanup()

	if !ns.Add(p) {
		t.Error("should add peer")
	}
	if ns.Count() != 1 {
		t.Errorf("expected count 1, got %d", ns.Count())
	}
	if !ns.Has("fp1") {
		t.Error("should have fp1")
	}

	ns.Remove("fp1")
	if ns.Count() != 0 {
		t.Errorf("expected count 0, got %d", ns.Count())
	}
	if ns.Has("fp1") {
		t.Error("should not have fp1")
	}
}

func TestNamespaceMaxSize(t *testing.T) {
	ns := New("test", 2)

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()
	p3, c3 := makePeer(t, "fp3")
	defer c3()

	if !ns.Add(p1) {
		t.Error("should add fp1")
	}
	if !ns.Add(p2) {
		t.Error("should add fp2")
	}
	if ns.Add(p3) {
		t.Error("should not add fp3, namespace full")
	}
	if ns.Count() != 2 {
		t.Errorf("expected count 2, got %d", ns.Count())
	}
}

func TestNamespaceList(t *testing.T) {
	ns := New("test", 100)

	for i := 0; i < 10; i++ {
		p, c := makePeer(t, fmt.Sprintf("fp%d", i))
		defer c()
		ns.Add(p)
	}

	peers := ns.List(5)
	if len(peers) != 5 {
		t.Errorf("expected 5 peers, got %d", len(peers))
	}

	allPeers := ns.List(0)
	if len(allPeers) != 10 {
		t.Errorf("expected 10 peers, got %d", len(allPeers))
	}

	overLimit := ns.List(100)
	if len(overLimit) != 10 {
		t.Errorf("expected 10 peers, got %d", len(overLimit))
	}
}

func TestNamespaceSnapshot(t *testing.T) {
	ns := New("test", 100)

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	ns.Add(p1)
	ns.Add(p2)

	snap := ns.Snapshot()
	if len(snap) != 2 {
		t.Errorf("expected snapshot of 2, got %d", len(snap))
	}
}

func TestNamespaceBroadcast(t *testing.T) {
	ns := New("test", 100)

	p1, c1 := makePeer(t, "sender")
	defer c1()
	p2, c2 := makePeer(t, "receiver1")
	defer c2()
	p3, c3 := makePeer(t, "receiver2")
	defer c3()

	ns.Add(p1)
	ns.Add(p2)
	ns.Add(p3)

	msg := protocol.NewMessage(protocol.TypeBroadcast, "sender", map[string]string{"data": "hello"})
	ns.Broadcast(msg, "sender")

	// check that receivers got the message
	select {
	case <-p2.Send:
	default:
		t.Error("receiver1 should have received broadcast")
	}
	select {
	case <-p3.Send:
	default:
		t.Error("receiver2 should have received broadcast")
	}

	// sender should not receive
	select {
	case <-p1.Send:
		t.Error("sender should not receive own broadcast")
	default:
	}
}

func TestNamespaceBroadcastRaw(t *testing.T) {
	ns := New("test", 100)

	p1, c1 := makePeer(t, "sender")
	defer c1()
	p2, c2 := makePeer(t, "receiver")
	defer c2()

	ns.Add(p1)
	ns.Add(p2)

	ns.BroadcastRaw([]byte("raw data"), "sender")

	select {
	case data := <-p2.Send:
		if string(data) != "raw data" {
			t.Errorf("expected 'raw data', got '%s'", string(data))
		}
	default:
		t.Error("receiver should have received raw broadcast")
	}
}

func TestNamespaceIsEmpty(t *testing.T) {
	ns := New("test", 100)

	if !ns.IsEmpty() {
		t.Error("new namespace should be empty")
	}

	p, c := makePeer(t, "fp1")
	defer c()
	ns.Add(p)

	if ns.IsEmpty() {
		t.Error("namespace with peer should not be empty")
	}

	ns.Remove("fp1")
	if !ns.IsEmpty() {
		t.Error("namespace should be empty after removing all peers")
	}
}

func TestNamespaceGet(t *testing.T) {
	ns := New("test", 100)

	p, c := makePeer(t, "fp1")
	defer c()
	ns.Add(p)

	got, ok := ns.Get("fp1")
	if !ok || got.Fingerprint != "fp1" {
		t.Error("should get fp1")
	}

	_, ok = ns.Get("nonexistent")
	if ok {
		t.Error("should not find nonexistent")
	}
}

func TestNamespaceRandomPeer(t *testing.T) {
	ns := New("test", 100)

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	ns.Add(p1)
	ns.Add(p2)

	rp := ns.RandomPeer("fp1")
	if rp == nil || rp.Fingerprint != "fp2" {
		t.Error("random peer excluding fp1 should return fp2")
	}

	rp = ns.RandomPeer("fp1")
	if rp == nil {
		t.Error("should return a peer")
	}

	// single peer namespace
	ns2 := New("single", 100)
	ns2.Add(p1)
	rp = ns2.RandomPeer("fp1")
	if rp != nil {
		t.Error("should return nil when only excluded peer exists")
	}
}

func TestNewRoom(t *testing.T) {
	room := NewRoom("room1", 10, "owner-fp")
	if !room.IsRoom {
		t.Error("should be a room")
	}
	if room.Owner != "owner-fp" {
		t.Errorf("expected owner owner-fp, got %s", room.Owner)
	}
	if room.MaxSize() != 10 {
		t.Errorf("expected max size 10, got %d", room.MaxSize())
	}
}

func TestNewRoomMaxSizeCap(t *testing.T) {
	room := NewRoom("room1", 100, "owner")
	if room.MaxSize() != 30 {
		t.Errorf("expected max size capped at 30, got %d", room.MaxSize())
	}

	room2 := NewRoom("room2", 0, "owner")
	if room2.MaxSize() != 20 {
		t.Errorf("expected default max size 20, got %d", room2.MaxSize())
	}
}

func TestManagerGetOrCreate(t *testing.T) {
	mgr := NewManager(1000)

	ns1 := mgr.GetOrCreate("test-ns")
	if ns1 == nil {
		t.Fatal("should create namespace")
	}

	ns2 := mgr.GetOrCreate("test-ns")
	if ns1 != ns2 {
		t.Error("should return same namespace instance")
	}
}

func TestManagerCreateRoom(t *testing.T) {
	mgr := NewManager(1000)

	room, created := mgr.CreateRoom("room1", 10, "owner")
	if !created || room == nil {
		t.Fatal("should create room")
	}

	_, created = mgr.CreateRoom("room1", 10, "owner")
	if created {
		t.Error("should not create duplicate room")
	}
}

func TestManagerGet(t *testing.T) {
	mgr := NewManager(1000)

	_, ok := mgr.Get("nonexistent")
	if ok {
		t.Error("should not find nonexistent")
	}

	mgr.GetOrCreate("exists")
	_, ok = mgr.Get("exists")
	if !ok {
		t.Error("should find existing namespace")
	}
}

func TestManagerRemove(t *testing.T) {
	mgr := NewManager(1000)
	mgr.GetOrCreate("to-remove")

	mgr.Remove("to-remove")
	_, ok := mgr.Get("to-remove")
	if ok {
		t.Error("should not find removed namespace")
	}
}

func TestManagerRemoveIfEmpty(t *testing.T) {
	mgr := NewManager(1000)
	ns := mgr.GetOrCreate("test-ns")

	// empty namespace should be removed
	if !mgr.RemoveIfEmpty("test-ns") {
		t.Error("should remove empty namespace")
	}

	// re-create and add a peer
	ns = mgr.GetOrCreate("test-ns")
	p, c := makePeer(t, "fp1")
	defer c()
	ns.Add(p)

	if mgr.RemoveIfEmpty("test-ns") {
		t.Error("should not remove non-empty namespace")
	}
}

func TestManagerCleanup(t *testing.T) {
	mgr := NewManager(1000)
	mgr.GetOrCreate("empty1")
	mgr.GetOrCreate("empty2")
	ns := mgr.GetOrCreate("has-peer")

	p, c := makePeer(t, "fp1")
	defer c()
	ns.Add(p)

	mgr.Cleanup()

	_, ok := mgr.Get("empty1")
	if ok {
		t.Error("empty1 should be cleaned up")
	}
	_, ok = mgr.Get("empty2")
	if ok {
		t.Error("empty2 should be cleaned up")
	}
	_, ok = mgr.Get("has-peer")
	if !ok {
		t.Error("has-peer should not be cleaned up")
	}
}

func TestManagerStats(t *testing.T) {
	mgr := NewManager(1000)
	ns1 := mgr.GetOrCreate("ns1")
	ns2 := mgr.GetOrCreate("ns2")

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()
	p3, c3 := makePeer(t, "fp3")
	defer c3()

	ns1.Add(p1)
	ns1.Add(p2)
	ns2.Add(p3)

	stats := mgr.Stats()
	if stats["ns1"] != 2 {
		t.Errorf("expected ns1 count 2, got %d", stats["ns1"])
	}
	if stats["ns2"] != 1 {
		t.Errorf("expected ns2 count 1, got %d", stats["ns2"])
	}
}

func TestManagerConcurrent(t *testing.T) {
	mgr := NewManager(100000)
	var wg sync.WaitGroup

	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			name := fmt.Sprintf("ns-%d", id%10)
			mgr.GetOrCreate(name)
		}(i)
	}
	wg.Wait()

	stats := mgr.Stats()
	if len(stats) != 10 {
		t.Errorf("expected 10 namespaces, got %d", len(stats))
	}
}
