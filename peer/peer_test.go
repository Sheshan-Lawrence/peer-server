package peer

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"peerserver/protocol"

	"github.com/coder/websocket"
)

func setupTestPeer(t *testing.T) (*Peer, *websocket.Conn, func()) {
	t.Helper()

	var serverConn *websocket.Conn
	ready := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var err error
		serverConn, err = websocket.Accept(w, r, nil)
		if err != nil {
			t.Fatalf("accept error: %v", err)
		}
		close(ready)
		// keep handler alive
		select {}
	}))

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientConn, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}

	<-ready

	_, cancel := context.WithCancel(context.Background())
	p := New(serverConn, 32, cancel)
	p.Fingerprint = "test-fingerprint-abc123"
	p.Alias = "test-fox-01"

	cleanup := func() {
		clientConn.CloseNow()
		if serverConn != nil {
			serverConn.CloseNow()
		}
		srv.Close()
	}

	return p, clientConn, cleanup
}

func TestPeerNew(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	if p.Fingerprint != "test-fingerprint-abc123" {
		t.Errorf("expected fingerprint test-fingerprint-abc123, got %s", p.Fingerprint)
	}
	if p.Alias != "test-fox-01" {
		t.Errorf("expected alias test-fox-01, got %s", p.Alias)
	}
	if p.IsClosed() {
		t.Error("new peer should not be closed")
	}
	if p.ConnectedAt.IsZero() {
		t.Error("connected_at should be set")
	}
}

func TestPeerJoinLeaveNamespace(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	p.JoinNamespace("game-lobby", "game", "1.0", map[string]interface{}{"level": 5})

	if !p.InNamespace("game-lobby") {
		t.Error("should be in game-lobby")
	}

	namespaces := p.GetNamespaces()
	if len(namespaces) != 1 || namespaces[0] != "game-lobby" {
		t.Errorf("expected [game-lobby], got %v", namespaces)
	}

	p.LeaveNamespace("game-lobby")
	if p.InNamespace("game-lobby") {
		t.Error("should not be in game-lobby after leaving")
	}

	namespaces = p.GetNamespaces()
	if len(namespaces) != 0 {
		t.Errorf("expected empty namespaces, got %v", namespaces)
	}
}

func TestPeerLeaveNonExistentNamespace(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	// should not panic
	p.LeaveNamespace("nonexistent")
}

func TestPeerMultipleNamespaces(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	p.JoinNamespace("ns1", "app", "1.0", nil)
	p.JoinNamespace("ns2", "app", "2.0", nil)
	p.JoinNamespace("ns3", "app", "3.0", nil)

	if len(p.GetNamespaces()) != 3 {
		t.Errorf("expected 3 namespaces, got %d", len(p.GetNamespaces()))
	}

	p.LeaveNamespace("ns2")
	if p.InNamespace("ns2") {
		t.Error("should not be in ns2")
	}
	if !p.InNamespace("ns1") || !p.InNamespace("ns3") {
		t.Error("should still be in ns1 and ns3")
	}
}

func TestPeerSharesNamespace(t *testing.T) {
	p1, _, cleanup1 := setupTestPeer(t)
	defer cleanup1()
	p2, _, cleanup2 := setupTestPeer(t)
	defer cleanup2()

	p1.Fingerprint = "peer1"
	p2.Fingerprint = "peer2"

	p1.JoinNamespace("shared", "app", "1.0", nil)
	p2.JoinNamespace("shared", "app", "1.0", nil)

	if !p1.SharesNamespace(p2) {
		t.Error("peers should share namespace")
	}

	p2.LeaveNamespace("shared")
	p2.JoinNamespace("different", "app", "1.0", nil)

	if p1.SharesNamespace(p2) {
		t.Error("peers should not share namespace")
	}
}

func TestPeerInfo(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	p.UpdateMeta(map[string]interface{}{"name": "test"})
	p.JoinNamespace("ns1", "game", "1.0", nil)

	info := p.Info()
	if info.Fingerprint != "test-fingerprint-abc123" {
		t.Errorf("wrong fingerprint in info")
	}
	if info.Alias != "test-fox-01" {
		t.Errorf("wrong alias in info")
	}

	nsInfo := p.InfoForNamespace("ns1")
	if nsInfo.AppType != "game" {
		t.Errorf("expected app_type game, got %s", nsInfo.AppType)
	}

	nsInfo2 := p.InfoForNamespace("nonexistent")
	if nsInfo2.AppType != "" {
		t.Errorf("expected empty app_type for nonexistent namespace")
	}
}

func TestPeerSendRaw(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	err := p.SendRaw([]byte("test data"))
	if err != nil {
		t.Errorf("SendRaw error: %v", err)
	}

	select {
	case data := <-p.Send:
		if string(data) != "test data" {
			t.Errorf("expected 'test data', got '%s'", string(data))
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for send data")
	}
}

func TestPeerSendMessage(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	msg := protocol.NewMessage(protocol.TypePong, "", nil)
	err := p.SendMessage(msg)
	if err != nil {
		t.Errorf("SendMessage error: %v", err)
	}

	select {
	case data := <-p.Send:
		decoded, err := protocol.Decode(data)
		if err != nil {
			t.Fatalf("decode error: %v", err)
		}
		if decoded.Type != protocol.TypePong {
			t.Errorf("expected pong, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for send data")
	}
}

func TestPeerSendRawClosed(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	p.Close()
	err := p.SendRaw([]byte("data"))
	if err != ErrClosed {
		t.Errorf("expected ErrClosed, got %v", err)
	}
}

func TestPeerSendRawBufferFull(t *testing.T) {
	_, cancel := context.WithCancel(context.Background())
	p := &Peer{
		Send:   make(chan []byte, 1),
		cancel: cancel,
	}

	// fill the buffer
	p.Send <- []byte("first")

	err := p.SendRaw([]byte("second"))
	if err != ErrBufferFull {
		t.Errorf("expected ErrBufferFull, got %v", err)
	}
}

func TestPeerClose(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	p.Close()
	if !p.IsClosed() {
		t.Error("peer should be closed")
	}

	// double close should not panic
	p.Close()
}

func TestPeerIncrementMsgCount(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	for i := 0; i < 100; i++ {
		p.IncrementMsgCount()
	}
	// msgCount is unexported, but we can verify IncrementMsgCount returns correct value
	val := p.IncrementMsgCount()
	if val != 101 {
		t.Errorf("expected 101, got %d", val)
	}
}

func TestPeerUpdateMeta(t *testing.T) {
	p, _, cleanup := setupTestPeer(t)
	defer cleanup()

	p.UpdateMeta(map[string]interface{}{"key1": "val1"})
	p.UpdateMeta(map[string]interface{}{"key2": "val2"})

	info := p.Info()
	if info.Meta["key1"] != "val1" {
		t.Errorf("expected key1=val1")
	}
	if info.Meta["key2"] != "val2" {
		t.Errorf("expected key2=val2")
	}

	// overwrite
	p.UpdateMeta(map[string]interface{}{"key1": "updated"})
	info = p.Info()
	if info.Meta["key1"] != "updated" {
		t.Errorf("expected key1=updated")
	}
}
