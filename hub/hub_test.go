package hub

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"peerserver/broker"
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

func newTestHub() *Hub {
	b := broker.NewLocal()
	return New(64, 100, b)
}

func TestHubRegister(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()

	if !h.Register(p) {
		t.Error("should register peer")
	}
	if h.PeerCount() != 1 {
		t.Errorf("expected peer count 1, got %d", h.PeerCount())
	}

	got, ok := h.GetPeer("fp1")
	if !ok || got.Fingerprint != "fp1" {
		t.Error("should find registered peer")
	}
}

func TestHubRegisterMaxPeers(t *testing.T) {
	b := broker.NewLocal()
	h := New(4, 2, b)
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()
	p3, c3 := makePeer(t, "fp3")
	defer c3()

	h.Register(p1)
	h.Register(p2)
	if h.Register(p3) {
		t.Error("should reject third peer when max is 2")
	}
	if h.PeerCount() != 2 {
		t.Errorf("expected peer count 2, got %d", h.PeerCount())
	}
}

func TestHubRegisterReplace(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp1") // same fingerprint
	defer c2()

	h.Register(p1)
	if !h.Register(p2) {
		t.Error("should replace existing peer")
	}
	if h.PeerCount() != 1 {
		t.Errorf("expected peer count 1 after replace, got %d", h.PeerCount())
	}

	got, ok := h.GetPeer("fp1")
	if !ok {
		t.Fatal("should find peer")
	}
	if got == p1 {
		t.Error("should be the new peer, not the old one")
	}
}

func TestHubUnregister(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()

	h.Register(p)
	h.Unregister("fp1")

	if h.PeerCount() != 0 {
		t.Errorf("expected peer count 0, got %d", h.PeerCount())
	}
	_, ok := h.GetPeer("fp1")
	if ok {
		t.Error("should not find unregistered peer")
	}
}

func TestHubUnregisterNonExistent(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	// should not panic
	h.Unregister("nonexistent")
}

func TestHubAliasResolution(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	p.Alias = "cool-fox"

	h.Register(p)

	fp, ok := h.ResolveAlias("cool-fox")
	if !ok || fp != "fp1" {
		t.Error("should resolve alias to fingerprint")
	}

	_, ok = h.ResolveAlias("nonexistent-alias")
	if ok {
		t.Error("should not resolve nonexistent alias")
	}
}

func TestHubAliasCollision(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p1.Alias = "same-alias"
	h.Register(p1)

	p2, c2 := makePeer(t, "fp2")
	defer c2()
	p2.Alias = "same-alias"
	h.Register(p2)

	// alias should still point to fp1 (first one stored)
	fp, ok := h.ResolveAlias("same-alias")
	if !ok {
		t.Fatal("alias should resolve")
	}
	if fp != "fp1" {
		t.Errorf("alias should still point to fp1, got %s", fp)
	}
}

func TestHubAliasCleanupOnUnregister(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	p.Alias = "my-alias"
	h.Register(p)

	h.Unregister("fp1")
	_, ok := h.ResolveAlias("my-alias")
	if ok {
		t.Error("alias should be cleaned up after unregister")
	}
}

func TestHubHandleJoin(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	joinPayload, _ := json.Marshal(protocol.JoinPayload{
		Namespace: "test-ns",
		AppType:   "game",
		Version:   "1.0",
	})
	msg := &protocol.Message{
		Type:    protocol.TypeJoin,
		Payload: joinPayload,
	}
	data, _ := protocol.Encode(msg)

	h.HandleMessage(p, data)

	// should receive peer_list
	select {
	case raw := <-p.Send:
		decoded, err := protocol.Decode(raw)
		if err != nil {
			t.Fatalf("decode error: %v", err)
		}
		if decoded.Type != protocol.TypePeerList {
			t.Errorf("expected peer_list, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for peer_list")
	}

	if !p.InNamespace("test-ns") {
		t.Error("peer should be in test-ns")
	}
}

func TestHubHandleJoinEmptyNamespace(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: ""})
	msg := &protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload}
	data, _ := protocol.Encode(msg)
	h.HandleMessage(p, data)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleLeave(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	// join first
	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "test-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p, joinMsg)
	<-p.Send // drain peer_list

	// leave
	leavePayload, _ := json.Marshal(map[string]string{"namespace": "test-ns"})
	leaveMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeLeave, Payload: leavePayload})
	h.HandleMessage(p, leaveMsg)

	if p.InNamespace("test-ns") {
		t.Error("peer should not be in test-ns after leaving")
	}
}

func TestHubHandleSignalSharedNamespace(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	// both join same namespace
	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "shared-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p1, joinMsg)
	<-p1.Send // peer_list

	h.HandleMessage(p2, joinMsg)
	<-p2.Send // peer_list
	// p1 gets peer_joined for p2
	select {
	case <-p1.Send:
	case <-time.After(100 * time.Millisecond):
	}

	// signal from p1 to p2
	signalPayload, _ := json.Marshal(protocol.SignalPayload{SignalType: "offer", SDP: "test-sdp"})
	signalMsg, _ := protocol.Encode(&protocol.Message{
		Type:    protocol.TypeSignal,
		To:      "fp2",
		Payload: signalPayload,
	})
	h.HandleMessage(p1, signalMsg)

	select {
	case raw := <-p2.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeSignal {
			t.Errorf("expected signal, got %s", decoded.Type)
		}
		if decoded.From != "fp1" {
			t.Errorf("expected from fp1, got %s", decoded.From)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for signal")
	}
}

func TestHubHandleSignalNoSharedNamespace(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	// join different namespaces
	join1, _ := json.Marshal(protocol.JoinPayload{Namespace: "ns1", AppType: "game"})
	join1Msg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: join1})
	h.HandleMessage(p1, join1Msg)
	<-p1.Send

	join2, _ := json.Marshal(protocol.JoinPayload{Namespace: "ns2", AppType: "game"})
	join2Msg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: join2})
	h.HandleMessage(p2, join2Msg)
	<-p2.Send

	// signal should be denied
	signalPayload, _ := json.Marshal(protocol.SignalPayload{SignalType: "offer"})
	signalMsg, _ := protocol.Encode(&protocol.Message{
		Type:    protocol.TypeSignal,
		To:      "fp2",
		Payload: signalPayload,
	})
	h.HandleMessage(p1, signalMsg)

	select {
	case raw := <-p1.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error for no shared namespace, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleSignalNoTarget(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	signalMsg, _ := protocol.Encode(&protocol.Message{
		Type: protocol.TypeSignal,
		To:   "",
	})
	h.HandleMessage(p, signalMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleSignalViaAlias(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()
	p2.Alias = "target-alias"

	h.Register(p1)
	h.Register(p2)

	// both in same namespace
	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "shared", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p1, joinMsg)
	<-p1.Send
	h.HandleMessage(p2, joinMsg)
	<-p2.Send
	// drain peer_joined notifications
	select {
	case <-p1.Send:
	case <-time.After(50 * time.Millisecond):
	}

	signalPayload, _ := json.Marshal(protocol.SignalPayload{SignalType: "offer"})
	signalMsg, _ := protocol.Encode(&protocol.Message{
		Type:    protocol.TypeSignal,
		To:      "target-alias",
		Payload: signalPayload,
	})
	h.HandleMessage(p1, signalMsg)

	select {
	case raw := <-p2.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeSignal {
			t.Errorf("expected signal via alias, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for signal via alias")
	}
}

func TestHubHandleBroadcast(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "sender")
	defer c1()
	p2, c2 := makePeer(t, "receiver")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	// both join same namespace
	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "broadcast-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p1, joinMsg)
	<-p1.Send
	h.HandleMessage(p2, joinMsg)
	<-p2.Send
	select {
	case <-p1.Send:
	case <-time.After(50 * time.Millisecond):
	}

	bcastPayload, _ := json.Marshal(protocol.BroadcastPayload{Namespace: "broadcast-ns", Data: []byte(`"hello"`)})
	bcastMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeBroadcast, Payload: bcastPayload})
	h.HandleMessage(p1, bcastMsg)

	select {
	case raw := <-p2.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeBroadcast {
			t.Errorf("expected broadcast, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for broadcast")
	}

	// sender should not receive own broadcast
	select {
	case <-p1.Send:
		t.Error("sender should not receive own broadcast")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestHubHandleBroadcastNotInNamespace(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "outsider")
	defer c1()
	p2, c2 := makePeer(t, "insider")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "private-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p2, joinMsg)
	<-p2.Send

	// p1 tries to broadcast to namespace they're not in
	bcastPayload, _ := json.Marshal(protocol.BroadcastPayload{Namespace: "private-ns", Data: []byte(`"sneaky"`)})
	bcastMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeBroadcast, Payload: bcastPayload})
	h.HandleMessage(p1, bcastMsg)

	select {
	case raw := <-p1.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error for unauthorized broadcast, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandlePing(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	pingMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypePing})
	h.HandleMessage(p, pingMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypePong {
			t.Errorf("expected pong, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for pong")
	}
}

func TestHubHandleInvalidMessage(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	h.HandleMessage(p, []byte("not json"))

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleUnknownType(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	msg, _ := protocol.Encode(&protocol.Message{Type: "unknown_type"})
	h.HandleMessage(p, msg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleDiscover(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "discover-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p1, joinMsg)
	<-p1.Send
	h.HandleMessage(p2, joinMsg)
	<-p2.Send
	select {
	case <-p1.Send:
	case <-time.After(50 * time.Millisecond):
	}

	discoverPayload, _ := json.Marshal(protocol.DiscoverPayload{Namespace: "discover-ns", Limit: 10})
	discoverMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeDiscover, Payload: discoverPayload})
	h.HandleMessage(p1, discoverMsg)

	select {
	case raw := <-p1.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypePeerList {
			t.Errorf("expected peer_list, got %s", decoded.Type)
		}
		var pl protocol.PeerListPayload
		json.Unmarshal(decoded.Payload, &pl)
		if pl.Total != 2 {
			t.Errorf("expected 2 total peers, got %d", pl.Total)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleDiscoverNonExistent(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	discoverPayload, _ := json.Marshal(protocol.DiscoverPayload{Namespace: "nonexistent"})
	discoverMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeDiscover, Payload: discoverPayload})
	h.HandleMessage(p, discoverMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypePeerList {
			t.Errorf("expected peer_list, got %s", decoded.Type)
		}
		var pl protocol.PeerListPayload
		json.Unmarshal(decoded.Payload, &pl)
		if pl.Total != 0 {
			t.Errorf("expected 0 peers, got %d", pl.Total)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleCreateRoom(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "room1", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(p, createMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeRoomCreated {
			t.Errorf("expected room_created, got %s", decoded.Type)
		}
		var rc protocol.RoomCreatedPayload
		json.Unmarshal(decoded.Payload, &rc)
		if rc.RoomID != "room1" {
			t.Errorf("expected room1, got %s", rc.RoomID)
		}
		if rc.Owner != "fp1" {
			t.Errorf("expected owner fp1, got %s", rc.Owner)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleCreateRoomDuplicate(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "room1", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(p, createMsg)
	<-p.Send // room_created

	h.HandleMessage(p, createMsg)
	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error for duplicate room, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleJoinRoom(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	owner, oc := makePeer(t, "owner")
	defer oc()
	joiner, jc := makePeer(t, "joiner")
	defer jc()

	h.Register(owner)
	h.Register(joiner)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "room1", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(owner, createMsg)
	<-owner.Send // room_created

	joinPayload, _ := json.Marshal(protocol.JoinRoomPayload{RoomID: "room1"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})
	h.HandleMessage(joiner, joinMsg)

	// joiner gets peer_list
	select {
	case raw := <-joiner.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypePeerList {
			t.Errorf("expected peer_list, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout for joiner peer_list")
	}

	// owner gets peer_joined
	select {
	case raw := <-owner.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypePeerJoined {
			t.Errorf("expected peer_joined, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout for owner peer_joined")
	}
}

func TestHubHandleJoinRoomNonExistent(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	joinPayload, _ := json.Marshal(protocol.JoinRoomPayload{RoomID: "nonexistent"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})
	h.HandleMessage(p, joinMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleRoomInfo(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "room1", MaxSize: 15})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(p, createMsg)
	<-p.Send

	infoPayload, _ := json.Marshal(map[string]string{"room_id": "room1"})
	infoMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRoomInfo, Payload: infoPayload})
	h.HandleMessage(p, infoMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeRoomInfo {
			t.Errorf("expected room_info, got %s", decoded.Type)
		}
		var ri protocol.RoomInfoPayload
		json.Unmarshal(decoded.Payload, &ri)
		if ri.Owner != "fp1" {
			t.Errorf("expected owner fp1, got %s", ri.Owner)
		}
		if ri.MaxSize != 15 {
			t.Errorf("expected max_size 15, got %d", ri.MaxSize)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleKick(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	owner, oc := makePeer(t, "owner")
	defer oc()
	target, tc := makePeer(t, "target")
	defer tc()

	h.Register(owner)
	h.Register(target)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "room1", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(owner, createMsg)
	<-owner.Send

	joinPayload, _ := json.Marshal(protocol.JoinRoomPayload{RoomID: "room1"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})
	h.HandleMessage(target, joinMsg)
	<-target.Send // peer_list
	select {
	case <-owner.Send: // peer_joined
	case <-time.After(50 * time.Millisecond):
	}

	kickPayload, _ := json.Marshal(protocol.KickPayload{RoomID: "room1", Fingerprint: "target"})
	kickMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeKick, Payload: kickPayload})
	h.HandleMessage(owner, kickMsg)

	// target gets kick message
	select {
	case raw := <-target.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeKick {
			t.Errorf("expected kick, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for kick")
	}
}

func TestHubHandleKickNotOwner(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	owner, oc := makePeer(t, "owner")
	defer oc()
	p2, c2 := makePeer(t, "peer2")
	defer c2()
	p3, c3 := makePeer(t, "peer3")
	defer c3()

	h.Register(owner)
	h.Register(p2)
	h.Register(p3)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "room1", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(owner, createMsg)
	<-owner.Send

	joinPayload, _ := json.Marshal(protocol.JoinRoomPayload{RoomID: "room1"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})
	h.HandleMessage(p2, joinMsg)
	<-p2.Send
	select {
	case <-owner.Send:
	case <-time.After(50 * time.Millisecond):
	}
	h.HandleMessage(p3, joinMsg)
	<-p3.Send
	select {
	case <-owner.Send:
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case <-p2.Send:
	case <-time.After(50 * time.Millisecond):
	}

	// p2 tries to kick p3 (not owner)
	kickPayload, _ := json.Marshal(protocol.KickPayload{RoomID: "room1", Fingerprint: "peer3"})
	kickMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeKick, Payload: kickPayload})
	h.HandleMessage(p2, kickMsg)

	select {
	case raw := <-p2.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error for non-owner kick, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleMetadata(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	metaPayload, _ := json.Marshal(protocol.MetadataPayload{Meta: map[string]interface{}{"name": "test"}})
	metaMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeMetadata, Payload: metaPayload})
	h.HandleMessage(p, metaMsg)

	info := p.Info()
	if info.Meta["name"] != "test" {
		t.Errorf("expected meta name=test, got %v", info.Meta["name"])
	}
}

func TestHubHandleRelay(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "relay-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p1, joinMsg)
	<-p1.Send
	h.HandleMessage(p2, joinMsg)
	<-p2.Send
	select {
	case <-p1.Send:
	case <-time.After(50 * time.Millisecond):
	}

	relayPayload, _ := json.Marshal(map[string]string{"data": "relayed"})
	relayMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRelay, To: "fp2", Payload: relayPayload})
	h.HandleMessage(p1, relayMsg)

	select {
	case raw := <-p2.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeRelay {
			t.Errorf("expected relay, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout waiting for relay")
	}
}

func TestHubHandleRelayNoSharedNamespace(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	join1, _ := json.Marshal(protocol.JoinPayload{Namespace: "ns1"})
	join1Msg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: join1})
	h.HandleMessage(p1, join1Msg)
	<-p1.Send

	join2, _ := json.Marshal(protocol.JoinPayload{Namespace: "ns2"})
	join2Msg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: join2})
	h.HandleMessage(p2, join2Msg)
	<-p2.Send

	relayMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeRelay, To: "fp2"})
	h.HandleMessage(p1, relayMsg)

	select {
	case raw := <-p1.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubHandleMatch(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	p1.JoinNamespace("match-ns", "game", "1.0", nil)
	p2.JoinNamespace("match-ns", "game", "1.0", nil)

	matchPayload, _ := json.Marshal(protocol.MatchPayload{Namespace: "match-ns", GroupSize: 2})
	matchMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeMatch, Payload: matchPayload})

	h.HandleMessage(p1, matchMsg)
	select {
	case raw := <-p1.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeMatch {
			t.Errorf("expected match (waiting), got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}

	h.HandleMessage(p2, matchMsg)

	// both should get matched
	gotMatched := 0
	for i := 0; i < 2; i++ {
		select {
		case raw := <-p1.Send:
			decoded, _ := protocol.Decode(raw)
			if decoded.Type == protocol.TypeMatched {
				gotMatched++
			}
		case raw := <-p2.Send:
			decoded, _ := protocol.Decode(raw)
			if decoded.Type == protocol.TypeMatched {
				gotMatched++
			}
		case <-time.After(time.Second):
			t.Error("timeout waiting for matched")
		}
	}

	if gotMatched != 2 {
		t.Errorf("expected 2 matched messages, got %d", gotMatched)
	}
}

func TestHubDiscoverRoom403(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "secret-room", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(p, createMsg)
	<-p.Send

	discoverPayload, _ := json.Marshal(protocol.DiscoverPayload{Namespace: "secret-room"})
	discoverMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeDiscover, Payload: discoverPayload})
	h.HandleMessage(p, discoverMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error for discover on room, got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubNodeID(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	nodeID := h.NodeID()
	if nodeID == "" {
		t.Error("nodeID should not be empty")
	}
	if len(nodeID) != 32 { // 16 bytes hex encoded
		t.Errorf("expected nodeID length 32, got %d", len(nodeID))
	}
}

func TestHubBrokerSkipSelfNode(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	// simulate broker message from same node
	msg := protocol.NewMessage(protocol.TypeSignal, "someone", nil)
	msg.To = "fp1"
	msg.NodeID = h.NodeID()
	data, _ := protocol.Encode(msg)

	h.handleBrokerMessage(data)

	// peer should not receive it (skipped because same node)
	select {
	case <-p.Send:
		t.Error("should not receive message from same node via broker")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestHubBrokerDeliverFromOtherNode(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	msg := protocol.NewMessage(protocol.TypeSignal, "remote-peer", nil)
	msg.To = "fp1"
	msg.NodeID = "other-node-id"
	data, _ := protocol.Encode(msg)

	h.handleBrokerMessage(data)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeSignal {
			t.Errorf("expected signal, got %s", decoded.Type)
		}
		if decoded.NodeID != "" {
			t.Error("nodeID should be stripped before forwarding to client")
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}

func TestHubConcurrentRegister(t *testing.T) {
	b := broker.NewLocal()
	h := New(64, 1000, b)
	defer h.Shutdown()

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			p, c := makePeer(t, fmt.Sprintf("fp-%d", id))
			defer c()
			h.Register(p)
		}(i)
	}
	wg.Wait()

	if h.PeerCount() != 100 {
		t.Errorf("expected 100 peers, got %d", h.PeerCount())
	}
}

func TestHubConcurrentRegisterUnregister(t *testing.T) {
	b := broker.NewLocal()
	h := New(64, 1000, b)
	defer h.Shutdown()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			fp := fmt.Sprintf("fp-%d", id)
			p, c := makePeer(t, fp)
			defer c()
			h.Register(p)
			h.Unregister(fp)
		}(i)
	}
	wg.Wait()

	if h.PeerCount() != 0 {
		t.Errorf("expected 0 peers after unregister all, got %d", h.PeerCount())
	}
}

func TestHubNamespaceStats(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p1, c1 := makePeer(t, "fp1")
	defer c1()
	p2, c2 := makePeer(t, "fp2")
	defer c2()

	h.Register(p1)
	h.Register(p2)

	joinPayload, _ := json.Marshal(protocol.JoinPayload{Namespace: "stats-ns", AppType: "game"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoin, Payload: joinPayload})
	h.HandleMessage(p1, joinMsg)
	<-p1.Send
	h.HandleMessage(p2, joinMsg)
	<-p2.Send
	select {
	case <-p1.Send:
	case <-time.After(50 * time.Millisecond):
	}

	stats := h.NamespaceStats()
	if stats["stats-ns"] != 2 {
		t.Errorf("expected 2 in stats-ns, got %d", stats["stats-ns"])
	}
}

func TestHubRoomAutoCleanup(t *testing.T) {
	h := newTestHub()
	defer h.Shutdown()

	p, c := makePeer(t, "fp1")
	defer c()
	h.Register(p)

	createPayload, _ := json.Marshal(protocol.CreateRoomPayload{RoomID: "temp-room", MaxSize: 10})
	createMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeCreateRoom, Payload: createPayload})
	h.HandleMessage(p, createMsg)
	<-p.Send

	// leave the room
	leavePayload, _ := json.Marshal(map[string]string{"namespace": "temp-room"})
	leaveMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeLeave, Payload: leavePayload})
	h.HandleMessage(p, leaveMsg)

	// try to join - should be gone
	joinPayload, _ := json.Marshal(protocol.JoinRoomPayload{RoomID: "temp-room"})
	joinMsg, _ := protocol.Encode(&protocol.Message{Type: protocol.TypeJoinRoom, Payload: joinPayload})
	h.HandleMessage(p, joinMsg)

	select {
	case raw := <-p.Send:
		decoded, _ := protocol.Decode(raw)
		if decoded.Type != protocol.TypeError {
			t.Errorf("expected error (room gone), got %s", decoded.Type)
		}
	case <-time.After(time.Second):
		t.Error("timeout")
	}
}
