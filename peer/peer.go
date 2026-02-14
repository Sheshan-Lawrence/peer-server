package peer

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"peerserver/protocol"

	"github.com/coder/websocket"
)

var (
	ErrClosed     = errors.New("connection closed")
	ErrBufferFull = errors.New("send buffer full")
)

type Peer struct {
	Fingerprint string
	Alias       string
	Conn        *websocket.Conn
	Send        chan []byte
	Namespaces  map[string]*NamespaceInfo
	Meta        map[string]interface{}
	ConnectedAt time.Time
	LastPing    time.Time
	mu          sync.RWMutex
	closed      atomic.Bool
	msgCount    atomic.Int64
	cancel      context.CancelFunc
}

type NamespaceInfo struct {
	Name    string
	AppType string
	Version string
	Meta    map[string]interface{}
	Joined  time.Time
}

func New(conn *websocket.Conn, sendBufSize int, cancel context.CancelFunc) *Peer {
	if sendBufSize <= 0 {
		sendBufSize = 32
	}
	return &Peer{
		Conn:        conn,
		Send:        make(chan []byte, sendBufSize),
		Namespaces:  make(map[string]*NamespaceInfo),
		Meta:        make(map[string]interface{}),
		ConnectedAt: time.Now(),
		LastPing:    time.Now(),
		cancel:      cancel,
	}
}

func (p *Peer) JoinNamespace(ns string, appType, version string, meta map[string]interface{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Namespaces[ns] = &NamespaceInfo{
		Name:    ns,
		AppType: appType,
		Version: version,
		Meta:    meta,
		Joined:  time.Now(),
	}
}

func (p *Peer) LeaveNamespace(ns string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.Namespaces, ns)
}

func (p *Peer) InNamespace(ns string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	_, ok := p.Namespaces[ns]
	return ok
}

func (p *Peer) GetNamespaces() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	ns := make([]string, 0, len(p.Namespaces))
	for k := range p.Namespaces {
		ns = append(ns, k)
	}
	return ns
}

func (p *Peer) SharesNamespace(other *Peer) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	other.mu.RLock()
	defer other.mu.RUnlock()
	for k := range p.Namespaces {
		if _, ok := other.Namespaces[k]; ok {
			return true
		}
	}
	return false
}

func (p *Peer) Info() protocol.PeerInfo {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return protocol.PeerInfo{
		Fingerprint: p.Fingerprint,
		Alias:       p.Alias,
		Meta:        p.Meta,
	}
}

func (p *Peer) InfoForNamespace(ns string) protocol.PeerInfo {
	p.mu.RLock()
	defer p.mu.RUnlock()
	info := protocol.PeerInfo{
		Fingerprint: p.Fingerprint,
		Alias:       p.Alias,
		Meta:        p.Meta,
	}
	if nsInfo, ok := p.Namespaces[ns]; ok {
		info.AppType = nsInfo.AppType
	}
	return info
}

func (p *Peer) SendMessage(msg *protocol.Message) error {
	if p.closed.Load() {
		return ErrClosed
	}
	data, err := protocol.Encode(msg)
	if err != nil {
		return err
	}
	return p.SendRaw(data)
}

func (p *Peer) SendRaw(data []byte) (err error) {
	if p.closed.Load() {
		return ErrClosed
	}

	// protect against send on closed channel race
	defer func() {
		if r := recover(); r != nil {
			err = ErrClosed
		}
	}()

	select {
	case p.Send <- data:
		return nil
	default:
		return ErrBufferFull
	}
}

func (p *Peer) Close() {
	if p.closed.CompareAndSwap(false, true) {
		close(p.Send)
		p.cancel()
		p.Conn.CloseNow()
	}
}

func (p *Peer) IsClosed() bool {
	return p.closed.Load()
}

func (p *Peer) IncrementMsgCount() int64 {
	return p.msgCount.Add(1)
}

func (p *Peer) UpdateMeta(meta map[string]interface{}) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, v := range meta {
		p.Meta[k] = v
	}
}
