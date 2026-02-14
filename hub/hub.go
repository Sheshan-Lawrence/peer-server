package hub

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"peerserver/broker"
	"peerserver/matchmaker"
	"peerserver/namespace"
	"peerserver/peer"
	"peerserver/protocol"

	jsoniter "github.com/json-iterator/go"
)

var json = jsoniter.ConfigCompatibleWithStandardLibrary

type Shard struct {
	peers map[string]*peer.Peer
	mu    sync.RWMutex
}

type Hub struct {
	shards     []*Shard
	shardCount int
	nsMgr      *namespace.Manager
	matchmaker *matchmaker.Matchmaker
	broker     broker.Broker
	peerCount  atomic.Int64
	maxPeers   int
	aliases    sync.Map
	done       chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	nodeID     string
}

func New(shardCount, maxPeers int, b broker.Broker) *Hub {
	shards := make([]*Shard, shardCount)
	for i := range shards {
		shards[i] = &Shard{peers: make(map[string]*peer.Peer)}
	}
	nsMgr := namespace.NewManager(maxPeers)

	nodeBytes := make([]byte, 16)
	rand.Read(nodeBytes)
	nodeID := hex.EncodeToString(nodeBytes)

	ctx, cancel := context.WithCancel(context.Background())

	h := &Hub{
		shards:     shards,
		shardCount: shardCount,
		nsMgr:      nsMgr,
		matchmaker: matchmaker.New(nsMgr),
		broker:     b,
		maxPeers:   maxPeers,
		done:       make(chan struct{}),
		ctx:        ctx,
		cancel:     cancel,
		nodeID:     nodeID,
	}

	b.Subscribe(ctx, "signal", func(_ string, data []byte) {
		h.handleBrokerMessage(data)
	})
	b.Subscribe(ctx, "relay", func(_ string, data []byte) {
		h.handleBrokerMessage(data)
	})
	b.Subscribe(ctx, "broadcast", func(_ string, data []byte) {
		h.handleBrokerBroadcast(data)
	})

	go h.maintenance()
	return h
}

func (h *Hub) shardFor(fingerprint string) *Shard {
	// fingerprint is already a hex-encoded sha256, use first 4 hex chars directly
	if len(fingerprint) >= 4 {
		var idx uint32
		for i := 0; i < 4; i++ {
			c := fingerprint[i]
			var v byte
			if c >= '0' && c <= '9' {
				v = c - '0'
			} else if c >= 'a' && c <= 'f' {
				v = c - 'a' + 10
			} else if c >= 'A' && c <= 'F' {
				v = c - 'A' + 10
			}
			idx = (idx << 4) | uint32(v)
		}
		return h.shards[idx&uint32(h.shardCount-1)]
	}
	// fallback
	return h.shards[0]
}

func (h *Hub) Register(p *peer.Peer) bool {
	shard := h.shardFor(p.Fingerprint)
	shard.mu.Lock()

	// check max peers inside lock to prevent race
	current := h.peerCount.Load()
	if existing, ok := shard.peers[p.Fingerprint]; ok {
		// replacing existing peer, no net count change needed beyond swap
		existing.Close()
		shard.peers[p.Fingerprint] = p
		shard.mu.Unlock()

		if p.Alias != "" {
			h.storeAlias(p.Alias, p.Fingerprint)
		}
		return true
	}

	if int(current) >= h.maxPeers {
		shard.mu.Unlock()
		return false
	}

	shard.peers[p.Fingerprint] = p
	shard.mu.Unlock()
	h.peerCount.Add(1)

	if p.Alias != "" {
		h.storeAlias(p.Alias, p.Fingerprint)
	}
	return true
}

func (h *Hub) storeAlias(alias, fingerprint string) bool {
	existing, loaded := h.aliases.LoadOrStore(alias, fingerprint)
	if !loaded {
		return true
	}
	return existing.(string) == fingerprint
}

func (h *Hub) Unregister(fingerprint string) {
	shard := h.shardFor(fingerprint)
	shard.mu.Lock()
	p, ok := shard.peers[fingerprint]
	if ok {
		delete(shard.peers, fingerprint)
	}
	shard.mu.Unlock()

	if !ok {
		return
	}

	h.peerCount.Add(-1)
	h.matchmaker.RemoveFromAllQueues(fingerprint)

	for _, ns := range p.GetNamespaces() {
		if nsObj, exists := h.nsMgr.Get(ns); exists {
			nsObj.Remove(fingerprint)
			notify := protocol.NewMessage(protocol.TypePeerLeft, fingerprint, nil)
			notify.Namespace = ns
			nsObj.Broadcast(notify, fingerprint)

			if nsObj.IsRoom {
				h.nsMgr.RemoveIfEmpty(ns)
			}
		}
	}

	if p.Alias != "" {
		h.aliases.Delete(p.Alias)
	}
	p.Close()
}

func (h *Hub) GetPeer(fingerprint string) (*peer.Peer, bool) {
	shard := h.shardFor(fingerprint)
	shard.mu.RLock()
	defer shard.mu.RUnlock()
	p, ok := shard.peers[fingerprint]
	return p, ok
}

func (h *Hub) ResolveAlias(alias string) (string, bool) {
	fp, ok := h.aliases.Load(alias)
	if ok {
		return fp.(string), true
	}
	return "", false
}

func (h *Hub) HandleMessage(p *peer.Peer, data []byte) {
	msg, err := protocol.Decode(data)
	if err != nil {
		p.SendMessage(protocol.NewError(400, "invalid message"))
		return
	}
	msg.From = p.Fingerprint
	msg.Timestamp = time.Now().UnixMilli()

	switch msg.Type {
	case protocol.TypeJoin:
		h.handleJoin(p, msg)
	case protocol.TypeLeave:
		h.handleLeave(p, msg)
	case protocol.TypeSignal:
		h.handleSignal(p, msg)
	case protocol.TypeDiscover:
		h.handleDiscover(p, msg)
	case protocol.TypeMatch:
		h.handleMatch(p, msg)
	case protocol.TypeRelay:
		h.handleRelay(p, msg)
	case protocol.TypeBroadcast:
		h.handleBroadcast(p, msg)
	case protocol.TypeMetadata:
		h.handleMetadata(p, msg)
	case protocol.TypeCreateRoom:
		h.handleCreateRoom(p, msg)
	case protocol.TypeJoinRoom:
		h.handleJoinRoom(p, msg)
	case protocol.TypeRoomInfo:
		h.handleRoomInfo(p, msg)
	case protocol.TypeKick:
		h.handleKick(p, msg)
	case protocol.TypePing:
		p.LastPing = time.Now()
		p.SendRaw(protocol.PongBytes)
	default:
		p.SendMessage(protocol.NewError(400, "unknown message type"))
	}

	protocol.ReleaseMessage(msg)
}

func (h *Hub) handleJoin(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.JoinPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid join payload"))
		return
	}
	if payload.Namespace == "" {
		p.SendMessage(protocol.NewError(400, "namespace required"))
		return
	}

	ns := h.nsMgr.GetOrCreate(payload.Namespace)
	if !ns.Add(p) {
		p.SendMessage(protocol.NewError(429, "namespace full"))
		return
	}
	p.JoinNamespace(payload.Namespace, payload.AppType, payload.Version, payload.Meta)

	notify := protocol.NewMessage(protocol.TypePeerJoined, p.Fingerprint, p.InfoForNamespace(payload.Namespace))
	notify.Namespace = payload.Namespace
	ns.Broadcast(notify, p.Fingerprint)

	peers := ns.List(50)
	resp := protocol.NewMessage(protocol.TypePeerList, "", protocol.PeerListPayload{
		Namespace: payload.Namespace,
		Peers:     peers,
		Total:     ns.Count(),
	})
	p.SendMessage(resp)
}

func (h *Hub) handleLeave(p *peer.Peer, msg *protocol.Message) {
	var payload struct {
		Namespace string `json:"namespace"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.Namespace == "" {
		p.SendMessage(protocol.NewError(400, "namespace required"))
		return
	}

	ns := payload.Namespace
	if nsObj, ok := h.nsMgr.Get(ns); ok {
		nsObj.Remove(p.Fingerprint)
		notify := protocol.NewMessage(protocol.TypePeerLeft, p.Fingerprint, nil)
		notify.Namespace = ns
		nsObj.Broadcast(notify, p.Fingerprint)

		if nsObj.IsRoom {
			h.nsMgr.RemoveIfEmpty(ns)
		}
	}
	p.LeaveNamespace(ns)
	h.matchmaker.RemoveFromQueue(p.Fingerprint, ns)
}

func (h *Hub) handleSignal(p *peer.Peer, msg *protocol.Message) {
	to := msg.To
	if to == "" {
		p.SendMessage(protocol.NewError(400, "target peer required"))
		return
	}
	if fp, ok := h.ResolveAlias(to); ok {
		to = fp
		msg.To = to
	}

	target, ok := h.GetPeer(to)
	if ok {
		if !p.SharesNamespace(target) {
			p.SendMessage(protocol.NewError(403, "no shared namespace"))
			return
		}
		target.SendMessage(msg)
		return
	}

	// cross-node: stamp nodeID and publish
	msg.NodeID = h.nodeID
	data, _ := protocol.Encode(msg)
	h.broker.Publish(h.ctx, "signal", data)
}

func (h *Hub) handleDiscover(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.DiscoverPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid discover payload"))
		return
	}

	ns, ok := h.nsMgr.Get(payload.Namespace)
	if !ok {
		p.SendMessage(protocol.NewMessage(protocol.TypePeerList, "", protocol.PeerListPayload{
			Namespace: payload.Namespace,
			Peers:     []protocol.PeerInfo{},
			Total:     0,
		}))
		return
	}

	if ns.IsRoom {
		p.SendMessage(protocol.NewError(403, "cannot discover room peers"))
		return
	}

	limit := payload.Limit
	if limit <= 0 {
		limit = 50
	}
	peers := ns.List(limit)
	resp := protocol.NewMessage(protocol.TypePeerList, "", protocol.PeerListPayload{
		Namespace: payload.Namespace,
		Peers:     peers,
		Total:     ns.Count(),
	})
	p.SendMessage(resp)
}

func (h *Hub) handleMatch(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.MatchPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid match payload"))
		return
	}

	groupSize := payload.GroupSize
	if groupSize < 2 {
		groupSize = 2
	}

	result := h.matchmaker.RequestMatch(p, payload.Namespace, payload.Criteria, groupSize)
	if result == nil {
		p.SendMessage(protocol.NewMessage(protocol.TypeMatch, "", map[string]string{"status": "waiting"}))
		return
	}

	matched := protocol.NewMessage(protocol.TypeMatched, "", result)
	matched.Namespace = payload.Namespace
	// pre-encode once for all recipients
	matchData, err := protocol.Encode(matched)
	if err != nil {
		return
	}
	for _, pi := range result.Peers {
		if target, ok := h.GetPeer(pi.Fingerprint); ok {
			target.SendRaw(matchData)
		}
	}
}

func (h *Hub) handleRelay(p *peer.Peer, msg *protocol.Message) {
	to := msg.To
	if to == "" {
		p.SendMessage(protocol.NewError(400, "target peer required"))
		return
	}
	if fp, ok := h.ResolveAlias(to); ok {
		to = fp
		msg.To = to
	}

	target, ok := h.GetPeer(to)
	if ok {
		if !p.SharesNamespace(target) {
			p.SendMessage(protocol.NewError(403, "no shared namespace"))
			return
		}
		target.SendMessage(msg)
		return
	}

	msg.NodeID = h.nodeID
	data, _ := protocol.Encode(msg)
	h.broker.Publish(h.ctx, "relay", data)
}

func (h *Hub) handleBroadcast(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.BroadcastPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid broadcast payload"))
		return
	}
	ns, ok := h.nsMgr.Get(payload.Namespace)
	if !ok {
		return
	}

	// verify sender is in namespace
	if !ns.Has(p.Fingerprint) {
		p.SendMessage(protocol.NewError(403, "not in namespace"))
		return
	}

	// pre-encode once, broadcast raw
	data, err := protocol.Encode(msg)
	if err != nil {
		return
	}
	ns.BroadcastRaw(data, p.Fingerprint)

	// publish to broker for cross-node
	msg.NodeID = h.nodeID
	brokerData, _ := protocol.Encode(msg)
	h.broker.Publish(h.ctx, "broadcast", brokerData)
}

func (h *Hub) handleMetadata(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.MetadataPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid metadata payload"))
		return
	}
	p.UpdateMeta(payload.Meta)
}

func (h *Hub) handleCreateRoom(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.CreateRoomPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid create_room payload"))
		return
	}
	if payload.RoomID == "" {
		p.SendMessage(protocol.NewError(400, "room_id required"))
		return
	}
	maxSize := payload.MaxSize
	if maxSize <= 0 {
		maxSize = 20
	}
	if maxSize > 30 {
		maxSize = 30
	}

	ns, created := h.nsMgr.CreateRoom(payload.RoomID, maxSize, p.Fingerprint)
	if !created {
		p.SendMessage(protocol.NewError(409, "room already exists"))
		return
	}

	ns.Add(p)
	p.JoinNamespace(payload.RoomID, "room", "", nil)

	p.SendMessage(protocol.NewMessage(protocol.TypeRoomCreated, "", protocol.RoomCreatedPayload{
		RoomID:  payload.RoomID,
		MaxSize: maxSize,
		Owner:   p.Fingerprint,
	}))
}

func (h *Hub) handleJoinRoom(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.JoinRoomPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid join_room payload"))
		return
	}
	if payload.RoomID == "" {
		p.SendMessage(protocol.NewError(400, "room_id required"))
		return
	}

	ns, ok := h.nsMgr.Get(payload.RoomID)
	if !ok || !ns.IsRoom {
		p.SendMessage(protocol.NewError(404, "room not found"))
		return
	}

	if !ns.Add(p) {
		p.SendMessage(protocol.NewError(429, "room full"))
		return
	}
	p.JoinNamespace(payload.RoomID, "room", "", nil)

	notify := protocol.NewMessage(protocol.TypePeerJoined, p.Fingerprint, p.InfoForNamespace(payload.RoomID))
	notify.Namespace = payload.RoomID
	ns.Broadcast(notify, p.Fingerprint)

	peers := ns.List(ns.MaxSize())
	resp := protocol.NewMessage(protocol.TypePeerList, "", protocol.PeerListPayload{
		Namespace: payload.RoomID,
		Peers:     peers,
		Total:     ns.Count(),
	})
	p.SendMessage(resp)
}

func (h *Hub) handleRoomInfo(p *peer.Peer, msg *protocol.Message) {
	var payload struct {
		RoomID string `json:"room_id"`
	}
	if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.RoomID == "" {
		p.SendMessage(protocol.NewError(400, "room_id required"))
		return
	}

	ns, ok := h.nsMgr.Get(payload.RoomID)
	if !ok || !ns.IsRoom {
		p.SendMessage(protocol.NewError(404, "room not found"))
		return
	}

	p.SendMessage(protocol.NewMessage(protocol.TypeRoomInfo, "", protocol.RoomInfoPayload{
		RoomID:    payload.RoomID,
		PeerCount: ns.Count(),
		MaxSize:   ns.MaxSize(),
		Owner:     ns.Owner,
	}))
}

func (h *Hub) handleKick(p *peer.Peer, msg *protocol.Message) {
	var payload protocol.KickPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		p.SendMessage(protocol.NewError(400, "invalid kick payload"))
		return
	}
	if payload.RoomID == "" || payload.Fingerprint == "" {
		p.SendMessage(protocol.NewError(400, "room_id and fingerprint required"))
		return
	}

	ns, ok := h.nsMgr.Get(payload.RoomID)
	if !ok || !ns.IsRoom {
		p.SendMessage(protocol.NewError(404, "room not found"))
		return
	}
	if ns.Owner != p.Fingerprint {
		p.SendMessage(protocol.NewError(403, "only room owner can kick"))
		return
	}

	target, ok := h.GetPeer(payload.Fingerprint)
	if !ok {
		p.SendMessage(protocol.NewError(404, "peer not found"))
		return
	}

	ns.Remove(payload.Fingerprint)
	target.LeaveNamespace(payload.RoomID)

	target.SendMessage(protocol.NewMessage(protocol.TypeKick, p.Fingerprint, protocol.KickPayload{
		RoomID:      payload.RoomID,
		Fingerprint: payload.Fingerprint,
	}))

	notify := protocol.NewMessage(protocol.TypePeerLeft, payload.Fingerprint, nil)
	notify.Namespace = payload.RoomID
	ns.Broadcast(notify, payload.Fingerprint)
}

func (h *Hub) handleBrokerMessage(data []byte) {
	msg, err := protocol.Decode(data)
	if err != nil {
		return
	}
	defer protocol.ReleaseMessage(msg)

	// skip messages from self
	if msg.NodeID == h.nodeID {
		return
	}

	to := msg.To
	if to == "" {
		return
	}
	target, ok := h.GetPeer(to)
	if !ok {
		return
	}
	// clear nodeID before forwarding to client
	msg.NodeID = ""
	target.SendMessage(msg)
}

func (h *Hub) handleBrokerBroadcast(data []byte) {
	msg, err := protocol.Decode(data)
	if err != nil {
		return
	}
	defer protocol.ReleaseMessage(msg)

	// skip messages from self
	if msg.NodeID == h.nodeID {
		return
	}

	var payload protocol.BroadcastPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		return
	}
	ns, ok := h.nsMgr.Get(payload.Namespace)
	if !ok {
		return
	}

	// clear nodeID before forwarding
	msg.NodeID = ""
	rawData, err := protocol.Encode(msg)
	if err != nil {
		return
	}
	ns.BroadcastRaw(rawData, msg.From)
}

func (h *Hub) PeerCount() int64 {
	return h.peerCount.Load()
}

func (h *Hub) NamespaceStats() map[string]int {
	return h.nsMgr.Stats()
}

func (h *Hub) NodeID() string {
	return h.nodeID
}

func (h *Hub) maintenance() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			h.nsMgr.Cleanup()
		case <-h.done:
			return
		}
	}
}

func (h *Hub) Shutdown() {
	close(h.done)
	h.cancel()
	for _, shard := range h.shards {
		shard.mu.Lock()
		for _, p := range shard.peers {
			p.Close()
		}
		shard.mu.Unlock()
	}
	if err := h.broker.Close(); err != nil {
		log.Printf("broker close error: %v", err)
	}
}

// shardFor helper for external use if needed
func shardIndex(fingerprint string, count int) uint32 {
	if len(fingerprint) >= 4 {
		var idx uint32
		for i := 0; i < 4; i++ {
			c := fingerprint[i]
			var v byte
			switch {
			case c >= '0' && c <= '9':
				v = c - '0'
			case c >= 'a' && c <= 'f':
				v = c - 'a' + 10
			case c >= 'A' && c <= 'F':
				v = c - 'A' + 10
			}
			idx = (idx << 4) | uint32(v)
		}
		return idx & uint32(count-1)
	}
	h := binary.BigEndian.Uint32([]byte(fingerprint))
	return h & uint32(count-1)
}
