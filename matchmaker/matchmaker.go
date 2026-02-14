package matchmaker

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"

	"peerserver/namespace"
	"peerserver/peer"
	"peerserver/protocol"
)

type WaitingPeer struct {
	Peer      *peer.Peer
	Criteria  map[string]interface{}
	GroupSize int
}

type Queue struct {
	namespace string
	waiting   []*WaitingPeer
	index     map[string][]*WaitingPeer
	mu        sync.Mutex
}

type Matchmaker struct {
	queues map[string]*Queue
	mu     sync.RWMutex
	nsMgr  *namespace.Manager
}

func New(nsMgr *namespace.Manager) *Matchmaker {
	return &Matchmaker{
		queues: make(map[string]*Queue),
		nsMgr:  nsMgr,
	}
}

func (m *Matchmaker) getQueue(ns string) *Queue {
	m.mu.RLock()
	q, ok := m.queues[ns]
	m.mu.RUnlock()
	if ok {
		return q
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if q, ok = m.queues[ns]; ok {
		return q
	}
	q = &Queue{
		namespace: ns,
		index:     make(map[string][]*WaitingPeer),
	}
	m.queues[ns] = q
	return q
}

func criteriaKey(groupSize int, criteria map[string]interface{}) string {
	if len(criteria) == 0 {
		return fmt.Sprintf("%d:", groupSize)
	}
	keys := make([]string, 0, len(criteria))
	for k := range criteria {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(criteria))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, criteria[k]))
	}
	return fmt.Sprintf("%d:%s", groupSize, strings.Join(parts, ","))
}

func (m *Matchmaker) RequestMatch(p *peer.Peer, ns string, criteria map[string]interface{}, groupSize int) *protocol.MatchedPayload {
	if groupSize < 2 {
		groupSize = 2
	}

	q := m.getQueue(ns)
	q.mu.Lock()
	defer q.mu.Unlock()

	key := criteriaKey(groupSize, criteria)

	// remove this peer from waiting list and index if already present (dedup)
	q.removePeerLocked(p.Fingerprint, key)

	// clean stale entries from index
	indexed := q.index[key]
	cleaned := make([]*WaitingPeer, 0, len(indexed))
	for _, wp := range indexed {
		if !wp.Peer.IsClosed() && wp.Peer.Fingerprint != p.Fingerprint {
			cleaned = append(cleaned, wp)
		}
	}
	q.index[key] = cleaned

	if len(cleaned) >= groupSize-1 {
		matched := cleaned[:groupSize-1]
		q.index[key] = cleaned[groupSize-1:]

		remove := make(map[string]bool, len(matched))
		for _, wp := range matched {
			remove[wp.Peer.Fingerprint] = true
		}
		filtered := make([]*WaitingPeer, 0, len(q.waiting))
		for _, wp := range q.waiting {
			if !remove[wp.Peer.Fingerprint] {
				filtered = append(filtered, wp)
			}
		}
		q.waiting = filtered

		sessionID := generateSessionID()
		peers := make([]protocol.PeerInfo, 0, groupSize)
		for _, wp := range matched {
			peers = append(peers, wp.Peer.InfoForNamespace(ns))
		}
		peers = append(peers, p.InfoForNamespace(ns))

		return &protocol.MatchedPayload{
			Namespace: ns,
			Peers:     peers,
			SessionID: sessionID,
		}
	}

	wp := &WaitingPeer{
		Peer:      p,
		Criteria:  criteria,
		GroupSize: groupSize,
	}
	q.waiting = append(q.waiting, wp)
	q.index[key] = append(q.index[key], wp)
	return nil
}

// removePeerLocked removes a peer from both the waiting list and the index.
// Must be called with q.mu held.
func (q *Queue) removePeerLocked(fingerprint string, key string) {
	// remove from waiting list
	for i, wp := range q.waiting {
		if wp.Peer.Fingerprint == fingerprint {
			q.waiting = append(q.waiting[:i], q.waiting[i+1:]...)
			break
		}
	}
	// remove from index
	indexed := q.index[key]
	for i, wp := range indexed {
		if wp.Peer.Fingerprint == fingerprint {
			q.index[key] = append(indexed[:i], indexed[i+1:]...)
			break
		}
	}
}

func (m *Matchmaker) RemoveFromQueue(fingerprint string, ns string) {
	q := m.getQueue(ns)
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, wp := range q.waiting {
		if wp.Peer.Fingerprint == fingerprint {
			key := criteriaKey(wp.GroupSize, wp.Criteria)
			indexed := q.index[key]
			for j, iwp := range indexed {
				if iwp.Peer.Fingerprint == fingerprint {
					q.index[key] = append(indexed[:j], indexed[j+1:]...)
					break
				}
			}
			q.waiting = append(q.waiting[:i], q.waiting[i+1:]...)
			return
		}
	}
}

func (m *Matchmaker) RemoveFromAllQueues(fingerprint string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, q := range m.queues {
		q.mu.Lock()
		for i, wp := range q.waiting {
			if wp.Peer.Fingerprint == fingerprint {
				key := criteriaKey(wp.GroupSize, wp.Criteria)
				indexed := q.index[key]
				for j, iwp := range indexed {
					if iwp.Peer.Fingerprint == fingerprint {
						q.index[key] = append(indexed[:j], indexed[j+1:]...)
						break
					}
				}
				q.waiting = append(q.waiting[:i], q.waiting[i+1:]...)
				break
			}
		}
		q.mu.Unlock()
	}
}

func (m *Matchmaker) QueueSize(ns string) int {
	m.mu.RLock()
	q, ok := m.queues[ns]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.waiting)
}

func generateSessionID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
