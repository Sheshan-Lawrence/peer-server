package middleware

import (
	"crypto/sha256"
	"encoding/binary"
	"sync"
	"time"
)

type rateShard struct {
	clients map[string]*bucket
	mu      sync.RWMutex
}

type RateLimiter struct {
	shards     []*rateShard
	shardCount int
	rate       int
	burst      int
	cleanup    *time.Ticker
	done       chan struct{}
}

type bucket struct {
	tokens    float64
	maxTokens float64
	rate      float64
	lastTime  time.Time
	mu        sync.Mutex
}

func NewRateLimiter(ratePerSec, burst, shardCount int) *RateLimiter {
	if shardCount <= 0 {
		shardCount = 32
	}
	shards := make([]*rateShard, shardCount)
	for i := range shards {
		shards[i] = &rateShard{clients: make(map[string]*bucket)}
	}
	rl := &RateLimiter{
		shards:     shards,
		shardCount: shardCount,
		rate:       ratePerSec,
		burst:      burst,
		cleanup:    time.NewTicker(5 * time.Minute),
		done:       make(chan struct{}),
	}
	go rl.cleanupLoop()
	return rl
}

func (rl *RateLimiter) shardFor(id string) *rateShard {
	h := sha256.Sum256([]byte(id))
	idx := binary.BigEndian.Uint32(h[:4]) & uint32(rl.shardCount-1)
	return rl.shards[idx]
}

func (rl *RateLimiter) Allow(id string) bool {
	shard := rl.shardFor(id)

	shard.mu.RLock()
	b, ok := shard.clients[id]
	shard.mu.RUnlock()

	if !ok {
		shard.mu.Lock()
		b, ok = shard.clients[id]
		if !ok {
			b = &bucket{
				tokens:    float64(rl.burst),
				maxTokens: float64(rl.burst),
				rate:      float64(rl.rate),
				lastTime:  time.Now(),
			}
			shard.clients[id] = b
		}
		shard.mu.Unlock()
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(b.lastTime).Seconds()
	b.tokens += elapsed * b.rate
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}
	b.lastTime = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (rl *RateLimiter) Remove(id string) {
	shard := rl.shardFor(id)
	shard.mu.Lock()
	defer shard.mu.Unlock()
	delete(shard.clients, id)
}

func (rl *RateLimiter) cleanupLoop() {
	for {
		select {
		case <-rl.cleanup.C:
			cutoff := time.Now().Add(-10 * time.Minute)
			for _, shard := range rl.shards {
				shard.mu.Lock()
				for id, b := range shard.clients {
					b.mu.Lock()
					stale := b.lastTime.Before(cutoff)
					b.mu.Unlock()
					if stale {
						delete(shard.clients, id)
					}
				}
				shard.mu.Unlock()
			}
		case <-rl.done:
			return
		}
	}
}

func (rl *RateLimiter) Close() {
	rl.cleanup.Stop()
	close(rl.done)
}
