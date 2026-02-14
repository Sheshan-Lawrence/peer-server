package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/http"
	"strings"
	"time"

	"peerserver/config"
	"peerserver/hub"
	"peerserver/middleware"
	"peerserver/peer"

	"peerserver/protocol"

	"github.com/coder/websocket"
	jsoniter "github.com/json-iterator/go"
)

var json = jsoniter.ConfigCompatibleWithStandardLibrary

type Server struct {
	cfg     *config.Config
	hub     *hub.Hub
	limiter *middleware.RateLimiter
}

func New(cfg *config.Config, h *hub.Hub) *Server {
	return &Server{
		cfg:     cfg,
		hub:     h,
		limiter: middleware.NewRateLimiter(cfg.RateLimitPerSec, cfg.RateLimitBurst, cfg.RateLimitShards),
	}
}

func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/stats", s.handleStats)

	addr := fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
	log.Printf("peer server starting on %s", addr)

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  s.cfg.ReadTimeout.Duration,
		WriteTimeout: s.cfg.WriteTimeout.Duration,
	}

	if s.cfg.TLSCert != "" && s.cfg.TLSKey != "" {
		return srv.ListenAndServeTLS(s.cfg.TLSCert, s.cfg.TLSKey)
	}
	return srv.ListenAndServe()
}

func (s *Server) compressionMode() websocket.CompressionMode {
	if s.cfg.CompressionEnabled {
		return websocket.CompressionContextTakeover
	}
	return websocket.CompressionDisabled
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    s.compressionMode(),
	})
	if err != nil {
		log.Printf("accept error: %v", err)
		return
	}
	conn.SetReadLimit(s.cfg.MaxMessageSize)

	ctx, cancel := context.WithCancel(r.Context())
	p := peer.New(conn, s.cfg.SendBufferSize, cancel)

	readCtx, readCancel := context.WithTimeout(ctx, s.cfg.PongWait.Duration)
	_, regData, err := conn.Read(readCtx)
	readCancel()
	if err != nil {
		conn.Close(websocket.StatusPolicyViolation, "registration timeout")
		cancel()
		return
	}

	msg, err := protocol.Decode(regData)
	if err != nil || msg.Type != protocol.TypeRegister {
		errMsg, _ := protocol.Encode(protocol.NewError(400, "first message must be register"))
		conn.Write(ctx, websocket.MessageText, errMsg)
		conn.Close(websocket.StatusPolicyViolation, "invalid registration")
		cancel()
		protocol.ReleaseMessage(msg)
		return
	}

	var regPayload protocol.RegisterPayload
	if err := json.Unmarshal(msg.Payload, &regPayload); err != nil || regPayload.PublicKey == "" {
		errMsg, _ := protocol.Encode(protocol.NewError(400, "public_key required"))
		conn.Write(ctx, websocket.MessageText, errMsg)
		conn.Close(websocket.StatusPolicyViolation, "missing public key")
		cancel()
		protocol.ReleaseMessage(msg)
		return
	}
	protocol.ReleaseMessage(msg)

	fingerprint := generateFingerprint(regPayload.PublicKey)
	alias := regPayload.Alias
	if alias == "" {
		alias = generateAlias(fingerprint)
	}

	p.Fingerprint = fingerprint
	p.Alias = alias
	if regPayload.Meta != nil {
		p.UpdateMeta(regPayload.Meta)
	}

	if !s.hub.Register(p) {
		errMsg, _ := protocol.Encode(protocol.NewError(503, "server full"))
		conn.Write(ctx, websocket.MessageText, errMsg)
		conn.Close(websocket.StatusTryAgainLater, "server full")
		cancel()
		return
	}

	regResp := protocol.NewMessage(protocol.TypeRegistered, fingerprint, protocol.RegisteredPayload{
		Fingerprint: fingerprint,
		Alias:       alias,
	})
	data, _ := protocol.Encode(regResp)
	conn.Write(ctx, websocket.MessageText, data)

	go s.writePump(ctx, p)
	s.readPump(ctx, p)
}

func isExpectedCloseError(err error) bool {
	if err == nil {
		return false
	}
	// context canceled = normal shutdown
	if errors.Is(err, context.Canceled) {
		return true
	}
	// check for network close errors
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return true
	}
	// check for websocket close
	status := websocket.CloseStatus(err)
	if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
		return true
	}
	// EOF / connection reset / broken pipe
	errStr := err.Error()
	if strings.Contains(errStr, "EOF") ||
		strings.Contains(errStr, "connection reset") ||
		strings.Contains(errStr, "broken pipe") ||
		strings.Contains(errStr, "use of closed") {
		return true
	}
	return false
}

func (s *Server) readPump(ctx context.Context, p *peer.Peer) {
	defer func() {
		s.limiter.Remove(p.Fingerprint)
		s.hub.Unregister(p.Fingerprint)
	}()

	for {
		_, data, err := p.Conn.Read(ctx)
		if err != nil {
			if !isExpectedCloseError(err) && ctx.Err() == nil {
				log.Printf("read error [%s]: %v", p.Fingerprint[:8], err)
			}
			return
		}

		if !s.limiter.Allow(p.Fingerprint) {
			p.SendRaw(protocol.RateLimitBytes)
			continue
		}

		p.IncrementMsgCount()
		s.hub.HandleMessage(p, data)
	}
}

func (s *Server) writePump(ctx context.Context, p *peer.Peer) {
	ticker := time.NewTicker(s.cfg.PingInterval.Duration)
	defer func() {
		ticker.Stop()
		p.Conn.CloseNow()
	}()

	for {
		select {
		case data, ok := <-p.Send:
			if !ok {
				p.Conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			writeCtx, writeCancel := context.WithTimeout(ctx, s.cfg.WriteTimeout.Duration)
			err := p.Conn.Write(writeCtx, websocket.MessageText, data)
			writeCancel()
			if err != nil {
				return
			}

			// batch drain
			n := len(p.Send)
			for i := 0; i < n; i++ {
				extra, ok := <-p.Send
				if !ok {
					p.Conn.Close(websocket.StatusNormalClosure, "")
					return
				}
				writeCtx, writeCancel := context.WithTimeout(ctx, s.cfg.WriteTimeout.Duration)
				err := p.Conn.Write(writeCtx, websocket.MessageText, extra)
				writeCancel()
				if err != nil {
					return
				}
			}
		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, s.cfg.WriteTimeout.Duration)
			err := p.Conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "ok",
		"peers":     s.hub.PeerCount(),
		"max_peers": s.cfg.MaxPeers,
		"timestamp": time.Now().Unix(),
	})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"total_peers": s.hub.PeerCount(),
		"max_peers":   s.cfg.MaxPeers,
		"namespaces":  s.hub.NamespaceStats(),
		"shards":      s.cfg.ShardCount,
	})
}

func (s *Server) Shutdown() {
	s.limiter.Close()
	s.hub.Shutdown()
}

func generateFingerprint(publicKey string) string {
	hash := sha256.Sum256([]byte(publicKey))
	return hex.EncodeToString(hash[:])
}

var adjectives = []string{
	"brave", "calm", "dark", "eager", "fair", "gold", "happy", "iron",
	"jade", "keen", "live", "mild", "neat", "open", "pale", "quick",
	"rare", "safe", "tall", "warm", "wise", "bold", "cool", "deep",
	"fast", "grim", "high", "just", "kind", "loud", "next", "pure",
	"rich", "soft", "thin", "vast", "wild", "blue", "cyan", "grey",
}

var nouns = []string{
	"fox", "owl", "cat", "elk", "bat", "ray", "ant", "bee",
	"cod", "doe", "eel", "fly", "gnu", "hen", "jay", "kit",
	"lark", "moth", "newt", "orca", "puma", "ram", "seal", "toad",
	"vole", "wasp", "yak", "wolf", "bear", "crow", "dove", "frog",
	"goat", "hawk", "ibis", "kite", "lynx", "mole", "pike", "swan",
}

func generateAlias(fingerprint string) string {
	hash := sha256.Sum256([]byte(fingerprint))
	seed := int64(hash[0])<<56 | int64(hash[1])<<48 | int64(hash[2])<<40 | int64(hash[3])<<32 |
		int64(hash[4])<<24 | int64(hash[5])<<16 | int64(hash[6])<<8 | int64(hash[7])
	r := rand.New(rand.NewSource(seed))
	adj := adjectives[r.Intn(len(adjectives))]
	noun := nouns[r.Intn(len(nouns))]
	num := int(hash[8])%99 + 1
	return fmt.Sprintf("%s-%s-%02d", adj, noun, num)
}

func (s *Server) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	s.handleWebSocket(w, r)
}

func (s *Server) HandleHealth(w http.ResponseWriter, r *http.Request) {
	s.handleHealth(w, r)
}

func (s *Server) HandleStats(w http.ResponseWriter, r *http.Request) {
	s.handleStats(w, r)
}
