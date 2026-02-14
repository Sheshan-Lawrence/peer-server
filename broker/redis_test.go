package broker

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

// Redis tests require a running Redis instance.
// Set REDIS_TEST_ADDR env var to enable, e.g. REDIS_TEST_ADDR=localhost:6379
// Skip by default in CI / when Redis is not available.

func getRedisAddr() string {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		return ""
	}
	return addr
}

func skipIfNoRedis(t *testing.T) {
	t.Helper()
	if getRedisAddr() == "" {
		t.Skip("skipping redis test: set REDIS_TEST_ADDR to enable")
	}
}

func newTestRedisBroker(t *testing.T, nodeID string) *RedisBroker {
	t.Helper()
	addr := getRedisAddr()
	b, err := NewRedis(addr, "", 0, nodeID)
	if err != nil {
		t.Fatalf("redis connection failed: %v", err)
	}
	return b
}

func TestRedisNewConnection(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-1")
	defer b.Close()
}

func TestRedisNewConnectionBadAddr(t *testing.T) {
	_, err := NewRedis("localhost:59999", "", 0, "node1")
	if err == nil {
		t.Error("expected error for bad redis address")
	}
}

func TestRedisPublishSubscribe(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-pubsub")
	defer b.Close()

	var received atomic.Int32
	var receivedPayload atomic.Value

	ctx := context.Background()
	err := b.Subscribe(ctx, "test-channel", func(channel string, data []byte) {
		receivedPayload.Store(string(data))
		received.Add(1)
	})
	if err != nil {
		t.Fatalf("subscribe error: %v", err)
	}

	// small delay for subscription to be ready
	time.Sleep(100 * time.Millisecond)

	err = b.Publish(ctx, "test-channel", []byte("hello-redis"))
	if err != nil {
		t.Fatalf("publish error: %v", err)
	}

	// wait for message delivery
	deadline := time.After(3 * time.Second)
	for received.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("timeout waiting for redis message")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if received.Load() != 1 {
		t.Errorf("expected 1 receive, got %d", received.Load())
	}

	payload, ok := receivedPayload.Load().(string)
	if !ok || payload != "hello-redis" {
		t.Errorf("expected 'hello-redis', got '%v'", payload)
	}
}

func TestRedisPublishNoSubscribers(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-nosub")
	defer b.Close()

	err := b.Publish(context.Background(), "empty-channel", []byte("hello"))
	if err != nil {
		t.Fatalf("publish to empty channel should not error: %v", err)
	}
}

func TestRedisMultipleChannels(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-multi")
	defer b.Close()

	var countA, countB atomic.Int32
	ctx := context.Background()

	b.Subscribe(ctx, "chan-a", func(channel string, data []byte) {
		countA.Add(1)
	})
	b.Subscribe(ctx, "chan-b", func(channel string, data []byte) {
		countB.Add(1)
	})

	time.Sleep(100 * time.Millisecond)

	b.Publish(ctx, "chan-a", []byte("msg-a"))
	b.Publish(ctx, "chan-b", []byte("msg-b"))

	deadline := time.After(3 * time.Second)
	for countA.Load() == 0 || countB.Load() == 0 {
		select {
		case <-deadline:
			t.Fatalf("timeout: countA=%d countB=%d", countA.Load(), countB.Load())
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if countA.Load() != 1 {
		t.Errorf("expected chan-a count 1, got %d", countA.Load())
	}
	if countB.Load() != 1 {
		t.Errorf("expected chan-b count 1, got %d", countB.Load())
	}
}

func TestRedisUnsubscribe(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-unsub")
	defer b.Close()

	var count atomic.Int32
	ctx := context.Background()

	b.Subscribe(ctx, "unsub-test", func(channel string, data []byte) {
		count.Add(1)
	})

	time.Sleep(100 * time.Millisecond)

	b.Publish(ctx, "unsub-test", []byte("before"))

	deadline := time.After(3 * time.Second)
	for count.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("timeout waiting for first message")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if count.Load() != 1 {
		t.Errorf("expected 1, got %d", count.Load())
	}

	err := b.Unsubscribe(ctx, "unsub-test")
	if err != nil {
		t.Fatalf("unsubscribe error: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	b.Publish(ctx, "unsub-test", []byte("after"))
	time.Sleep(500 * time.Millisecond)

	if count.Load() != 1 {
		t.Errorf("expected still 1 after unsubscribe, got %d", count.Load())
	}
}

func TestRedisUnsubscribeNonExistent(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-unsub-ne")
	defer b.Close()

	err := b.Unsubscribe(context.Background(), "nonexistent")
	if err != nil {
		t.Errorf("unsubscribe nonexistent should not error: %v", err)
	}
}

func TestRedisClose(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-close")

	var count atomic.Int32
	b.Subscribe(context.Background(), "close-test", func(channel string, data []byte) {
		count.Add(1)
	})

	time.Sleep(100 * time.Millisecond)

	err := b.Close()
	if err != nil {
		t.Fatalf("close error: %v", err)
	}

	// publish after close should error
	err = b.Publish(context.Background(), "close-test", []byte("after close"))
	if err == nil {
		t.Error("expected error publishing after close")
	}
}

func TestRedisCrossNodeDelivery(t *testing.T) {
	skipIfNoRedis(t)

	b1 := newTestRedisBroker(t, "node-1")
	defer b1.Close()
	b2 := newTestRedisBroker(t, "node-2")
	defer b2.Close()

	var received atomic.Int32
	var receivedPayload atomic.Value

	ctx := context.Background()

	// node-2 subscribes
	err := b2.Subscribe(ctx, "cross-node", func(channel string, data []byte) {
		receivedPayload.Store(string(data))
		received.Add(1)
	})
	if err != nil {
		t.Fatalf("subscribe error: %v", err)
	}

	time.Sleep(200 * time.Millisecond)

	// node-1 publishes
	err = b1.Publish(ctx, "cross-node", []byte("from-node-1"))
	if err != nil {
		t.Fatalf("publish error: %v", err)
	}

	deadline := time.After(3 * time.Second)
	for received.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("timeout waiting for cross-node message")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	payload, ok := receivedPayload.Load().(string)
	if !ok || payload != "from-node-1" {
		t.Errorf("expected 'from-node-1', got '%v'", payload)
	}
}

func TestRedisHighThroughput(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-throughput")
	defer b.Close()

	messageCount := 100
	var received atomic.Int32
	ctx := context.Background()

	b.Subscribe(ctx, "throughput", func(channel string, data []byte) {
		received.Add(1)
	})

	time.Sleep(100 * time.Millisecond)

	for i := 0; i < messageCount; i++ {
		err := b.Publish(ctx, "throughput", []byte("msg"))
		if err != nil {
			t.Fatalf("publish error at %d: %v", i, err)
		}
	}

	deadline := time.After(10 * time.Second)
	for received.Load() < int32(messageCount) {
		select {
		case <-deadline:
			t.Fatalf("timeout: received %d of %d messages", received.Load(), messageCount)
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if received.Load() != int32(messageCount) {
		t.Errorf("expected %d messages, got %d", messageCount, received.Load())
	}
}

func TestRedisPrefixIsolation(t *testing.T) {
	skipIfNoRedis(t)

	b := newTestRedisBroker(t, "test-node-prefix")
	defer b.Close()

	var count atomic.Int32
	ctx := context.Background()

	// subscribe to "mychan" which internally becomes "peer:mychan"
	b.Subscribe(ctx, "mychan", func(channel string, data []byte) {
		count.Add(1)
	})

	time.Sleep(100 * time.Millisecond)

	// publish to same logical channel
	b.Publish(ctx, "mychan", []byte("test"))

	deadline := time.After(3 * time.Second)
	for count.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("timeout")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}

	if count.Load() != 1 {
		t.Errorf("expected 1, got %d", count.Load())
	}
}

func BenchmarkRedisPublish(b *testing.B) {
	addr := getRedisAddr()
	if addr == "" {
		b.Skip("skipping redis benchmark: set REDIS_TEST_ADDR to enable")
	}

	br, err := NewRedis(addr, "", 0, "bench-node")
	if err != nil {
		b.Fatalf("redis connection failed: %v", err)
	}
	defer br.Close()

	data := []byte("benchmark message payload")
	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		br.Publish(ctx, "bench-channel", data)
	}
}
