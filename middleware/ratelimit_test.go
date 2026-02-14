package middleware

import (
	"sync"
	"testing"
	"time"
)

func TestRateLimiterAllow(t *testing.T) {
	rl := NewRateLimiter(10, 10, 4)
	defer rl.Close()

	// should allow up to burst
	for i := 0; i < 10; i++ {
		if !rl.Allow("client1") {
			t.Errorf("request %d should be allowed", i)
		}
	}

	// next should be denied
	if rl.Allow("client1") {
		t.Error("request after burst should be denied")
	}
}

func TestRateLimiterRefill(t *testing.T) {
	rl := NewRateLimiter(1000, 1, 4)
	defer rl.Close()

	// exhaust the single token
	if !rl.Allow("client1") {
		t.Error("first request should be allowed")
	}
	if rl.Allow("client1") {
		t.Error("second request should be denied (burst=1)")
	}

	// wait for refill
	time.Sleep(5 * time.Millisecond)
	if !rl.Allow("client1") {
		t.Error("request after refill should be allowed")
	}
}

func TestRateLimiterDifferentClients(t *testing.T) {
	rl := NewRateLimiter(10, 5, 4)
	defer rl.Close()

	// exhaust client1
	for i := 0; i < 5; i++ {
		rl.Allow("client1")
	}
	if rl.Allow("client1") {
		t.Error("client1 should be denied")
	}

	// client2 should still be allowed
	if !rl.Allow("client2") {
		t.Error("client2 should be allowed")
	}
}

func TestRateLimiterRemove(t *testing.T) {
	rl := NewRateLimiter(10, 5, 4)
	defer rl.Close()

	for i := 0; i < 5; i++ {
		rl.Allow("client1")
	}
	if rl.Allow("client1") {
		t.Error("should be denied after burst")
	}

	rl.Remove("client1")

	// after removal, client gets fresh bucket
	if !rl.Allow("client1") {
		t.Error("should be allowed after removal")
	}
}

func TestRateLimiterConcurrent(t *testing.T) {
	rl := NewRateLimiter(100, 100, 8)
	defer rl.Close()

	var wg sync.WaitGroup
	var allowed sync.Map

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			client := "concurrent-client"
			if rl.Allow(client) {
				allowed.Store(id, true)
			}
		}(i)
	}
	wg.Wait()

	count := 0
	allowed.Range(func(key, value interface{}) bool {
		count++
		return true
	})
	// with burst=100 and only 50 requests, all should pass
	if count != 50 {
		t.Errorf("expected 50 allowed, got %d", count)
	}
}

func TestRateLimiterSharding(t *testing.T) {
	rl := NewRateLimiter(10, 10, 16)
	defer rl.Close()

	// different clients should hit different shards without issue
	clients := []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot"}
	for _, c := range clients {
		if !rl.Allow(c) {
			t.Errorf("client %s should be allowed", c)
		}
	}
}

func TestRateLimiterClose(t *testing.T) {
	rl := NewRateLimiter(10, 10, 4)
	rl.Close()
	// should not panic after close
	rl.Allow("test")
}

func BenchmarkRateLimiterAllow(b *testing.B) {
	rl := NewRateLimiter(1000000, 1000000, 32)
	defer rl.Close()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			rl.Allow("bench-client")
		}
	})
}
