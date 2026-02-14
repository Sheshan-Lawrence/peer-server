package namespace

import (
	"sync"

	"peerserver/peer"
	"peerserver/protocol"
)

type Namespace struct {
	Name    string
	Owner   string
	IsRoom  bool
	peers   map[string]*peer.Peer
	mu      sync.RWMutex
	maxSize int
}

func New(name string, maxSize int) *Namespace {
	if maxSize <= 0 {
		maxSize = 100000
	}
	return &Namespace{
		Name:    name,
		peers:   make(map[string]*peer.Peer),
		maxSize: maxSize,
	}
}

func NewRoom(name string, maxSize int, owner string) *Namespace {
	if maxSize <= 0 {
		maxSize = 20
	}
	if maxSize > 30 {
		maxSize = 30
	}
	return &Namespace{
		Name:    name,
		Owner:   owner,
		IsRoom:  true,
		peers:   make(map[string]*peer.Peer),
		maxSize: maxSize,
	}
}

func (ns *Namespace) Add(p *peer.Peer) bool {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	if len(ns.peers) >= ns.maxSize {
		return false
	}
	ns.peers[p.Fingerprint] = p
	return true
}

func (ns *Namespace) Remove(fingerprint string) {
	ns.mu.Lock()
	defer ns.mu.Unlock()
	delete(ns.peers, fingerprint)
}

func (ns *Namespace) Get(fingerprint string) (*peer.Peer, bool) {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	p, ok := ns.peers[fingerprint]
	return p, ok
}

func (ns *Namespace) Has(fingerprint string) bool {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	_, ok := ns.peers[fingerprint]
	return ok
}

func (ns *Namespace) Count() int {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	return len(ns.peers)
}

func (ns *Namespace) MaxSize() int {
	return ns.maxSize
}

func (ns *Namespace) List(limit int) []protocol.PeerInfo {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	if limit <= 0 || limit > len(ns.peers) {
		limit = len(ns.peers)
	}
	peers := make([]protocol.PeerInfo, 0, limit)
	i := 0
	for _, p := range ns.peers {
		if i >= limit {
			break
		}
		peers = append(peers, p.InfoForNamespace(ns.Name))
		i++
	}
	return peers
}

// Snapshot returns a copy of non-closed peer pointers under the lock
func (ns *Namespace) Snapshot() []*peer.Peer {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	peers := make([]*peer.Peer, 0, len(ns.peers))
	for _, p := range ns.peers {
		if !p.IsClosed() {
			peers = append(peers, p)
		}
	}
	return peers
}

// BroadcastRaw sends pre-encoded bytes to all non-closed peers except excluded
func (ns *Namespace) BroadcastRaw(data []byte, exclude string) {
	peers := ns.Snapshot()
	for _, p := range peers {
		if p.Fingerprint == exclude {
			continue
		}
		p.SendRaw(data)
	}
}

func (ns *Namespace) Broadcast(msg *protocol.Message, exclude string) {
	data, err := protocol.Encode(msg)
	if err != nil {
		return
	}
	ns.BroadcastRaw(data, exclude)
}

func (ns *Namespace) IsEmpty() bool {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	return len(ns.peers) == 0
}

func (ns *Namespace) RandomPeer(exclude string) *peer.Peer {
	ns.mu.RLock()
	defer ns.mu.RUnlock()
	for fp, p := range ns.peers {
		if fp != exclude {
			return p
		}
	}
	return nil
}

type Manager struct {
	namespaces map[string]*Namespace
	mu         sync.RWMutex
	maxSize    int
}

func NewManager(maxNsSize int) *Manager {
	return &Manager{
		namespaces: make(map[string]*Namespace),
		maxSize:    maxNsSize,
	}
}

func (m *Manager) GetOrCreate(name string) *Namespace {
	m.mu.RLock()
	ns, ok := m.namespaces[name]
	m.mu.RUnlock()
	if ok {
		return ns
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if ns, ok = m.namespaces[name]; ok {
		return ns
	}
	ns = New(name, m.maxSize)
	m.namespaces[name] = ns
	return ns
}

func (m *Manager) CreateRoom(name string, maxSize int, owner string) (*Namespace, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.namespaces[name]; ok {
		return nil, false
	}
	ns := NewRoom(name, maxSize, owner)
	m.namespaces[name] = ns
	return ns, true
}

func (m *Manager) Get(name string) (*Namespace, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ns, ok := m.namespaces[name]
	return ns, ok
}

func (m *Manager) Remove(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.namespaces, name)
}

func (m *Manager) RemoveIfEmpty(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	ns, ok := m.namespaces[name]
	if !ok {
		return false
	}
	ns.mu.RLock()
	empty := len(ns.peers) == 0
	ns.mu.RUnlock()
	if empty {
		delete(m.namespaces, name)
		return true
	}
	return false
}

func (m *Manager) Cleanup() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, ns := range m.namespaces {
		ns.mu.RLock()
		empty := len(ns.peers) == 0
		ns.mu.RUnlock()
		if empty {
			delete(m.namespaces, name)
		}
	}
}

func (m *Manager) Stats() map[string]int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	stats := make(map[string]int, len(m.namespaces))
	for name, ns := range m.namespaces {
		stats[name] = ns.Count()
	}
	return stats
}
