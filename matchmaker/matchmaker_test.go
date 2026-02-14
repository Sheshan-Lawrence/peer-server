package matchmaker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"peerserver/namespace"
	"peerserver/peer"

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

func TestMatchTwoPeers(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()
	p2, c2 := makePeer(t, "peer2")
	defer c2()

	p1.JoinNamespace("game", "fps", "1.0", nil)
	p2.JoinNamespace("game", "fps", "1.0", nil)

	result := m.RequestMatch(p1, "game", nil, 2)
	if result != nil {
		t.Error("first peer should get nil (waiting)")
	}

	result = m.RequestMatch(p2, "game", nil, 2)
	if result == nil {
		t.Fatal("second peer should trigger match")
	}

	if len(result.Peers) != 2 {
		t.Errorf("expected 2 peers in match, got %d", len(result.Peers))
	}
	if result.SessionID == "" {
		t.Error("session_id should not be empty")
	}
	if result.Namespace != "game" {
		t.Errorf("expected namespace game, got %s", result.Namespace)
	}
}

func TestMatchGroupOfThree(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	peers := make([]*peer.Peer, 3)
	cleanups := make([]func(), 3)
	for i := 0; i < 3; i++ {
		peers[i], cleanups[i] = makePeer(t, fmt.Sprintf("peer%d", i))
		defer cleanups[i]()
		peers[i].JoinNamespace("game", "fps", "1.0", nil)
	}

	r1 := m.RequestMatch(peers[0], "game", nil, 3)
	if r1 != nil {
		t.Error("first should wait")
	}

	r2 := m.RequestMatch(peers[1], "game", nil, 3)
	if r2 != nil {
		t.Error("second should wait")
	}

	r3 := m.RequestMatch(peers[2], "game", nil, 3)
	if r3 == nil {
		t.Fatal("third should trigger match")
	}

	if len(r3.Peers) != 3 {
		t.Errorf("expected 3 peers, got %d", len(r3.Peers))
	}
}

func TestMatchWithCriteria(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()
	p2, c2 := makePeer(t, "peer2")
	defer c2()
	p3, c3 := makePeer(t, "peer3")
	defer c3()

	criteria1 := map[string]interface{}{"mode": "ranked"}
	criteria2 := map[string]interface{}{"mode": "casual"}

	m.RequestMatch(p1, "game", criteria1, 2)
	result := m.RequestMatch(p2, "game", criteria2, 2)
	if result != nil {
		t.Error("different criteria should not match")
	}

	result = m.RequestMatch(p3, "game", criteria1, 2)
	if result == nil {
		t.Fatal("same criteria should match")
	}
	if len(result.Peers) != 2 {
		t.Errorf("expected 2 peers, got %d", len(result.Peers))
	}
}

func TestMatchDifferentGroupSize(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()
	p2, c2 := makePeer(t, "peer2")
	defer c2()

	m.RequestMatch(p1, "game", nil, 2)
	result := m.RequestMatch(p2, "game", nil, 3)
	if result != nil {
		t.Error("different group sizes should not match")
	}

	if m.QueueSize("game") != 2 {
		t.Errorf("expected queue size 2, got %d", m.QueueSize("game"))
	}
}

func TestMatchMinGroupSize(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()
	p2, c2 := makePeer(t, "peer2")
	defer c2()

	// group_size < 2 should be treated as 2
	m.RequestMatch(p1, "game", nil, 0)
	result := m.RequestMatch(p2, "game", nil, 1)
	if result == nil {
		t.Fatal("should match with group_size normalized to 2")
	}
}

func TestRemoveFromQueue(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()

	m.RequestMatch(p1, "game", nil, 2)
	if m.QueueSize("game") != 1 {
		t.Errorf("expected queue size 1, got %d", m.QueueSize("game"))
	}

	m.RemoveFromQueue("peer1", "game")
	if m.QueueSize("game") != 0 {
		t.Errorf("expected queue size 0, got %d", m.QueueSize("game"))
	}
}

func TestRemoveFromAllQueues(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()

	m.RequestMatch(p1, "game1", nil, 2)
	m.RequestMatch(p1, "game2", nil, 2)

	m.RemoveFromAllQueues("peer1")

	if m.QueueSize("game1") != 0 {
		t.Errorf("expected game1 queue size 0, got %d", m.QueueSize("game1"))
	}
	if m.QueueSize("game2") != 0 {
		t.Errorf("expected game2 queue size 0, got %d", m.QueueSize("game2"))
	}
}

func TestRemoveNonExistentFromQueue(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	// should not panic
	m.RemoveFromQueue("nonexistent", "game")
	m.RemoveFromAllQueues("nonexistent")
}

func TestQueueSizeNonExistent(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	if m.QueueSize("nonexistent") != 0 {
		t.Error("expected queue size 0 for nonexistent namespace")
	}
}

func TestMatchClosedPeerCleaned(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()
	p2, c2 := makePeer(t, "peer2")
	defer c2()
	p3, c3 := makePeer(t, "peer3")
	defer c3()

	m.RequestMatch(p1, "game", nil, 2)
	p1.Close() // close peer1

	result := m.RequestMatch(p2, "game", nil, 2)
	if result != nil {
		t.Error("should not match with closed peer")
	}

	result = m.RequestMatch(p3, "game", nil, 2)
	if result == nil {
		t.Fatal("should match peer2 and peer3")
	}
}

func TestMatchSamePeerTwice(t *testing.T) {
	nsMgr := namespace.NewManager(1000)
	m := New(nsMgr)

	p1, c1 := makePeer(t, "peer1")
	defer c1()

	m.RequestMatch(p1, "game", nil, 2)
	// same peer again - should replace, not duplicate
	m.RequestMatch(p1, "game", nil, 2)

	if m.QueueSize("game") != 1 {
		t.Errorf("expected queue size 1 (deduped), got %d", m.QueueSize("game"))
	}
}

func TestCriteriaKey(t *testing.T) {
	key1 := criteriaKey(2, map[string]interface{}{"mode": "ranked", "region": "us"})
	key2 := criteriaKey(2, map[string]interface{}{"region": "us", "mode": "ranked"})
	if key1 != key2 {
		t.Error("criteria keys should be order-independent")
	}

	key3 := criteriaKey(3, map[string]interface{}{"mode": "ranked"})
	if key1 == key3 {
		t.Error("different group sizes should produce different keys")
	}

	key4 := criteriaKey(2, nil)
	key5 := criteriaKey(2, map[string]interface{}{})
	if key4 != key5 {
		t.Error("nil and empty criteria should produce same key")
	}
}
