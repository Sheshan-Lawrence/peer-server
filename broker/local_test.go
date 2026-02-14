package broker

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestLocalPublishSubscribe(t *testing.T) {
	b := NewLocal()
	defer b.Close()

	var received atomic.Int32
	var receivedData []byte
	var mu sync.Mutex

	err := b.Subscribe(context.Background(), "test-chan", func(channel string, data []byte) {
		mu.Lock()
		receivedData = data
		mu.Unlock()
		received.Add(1)
	})
	if err != nil {
		t.Fatalf("subscribe error: %v", err)
	}

	err = b.Publish(context.Background(), "test-chan", []byte("hello"))
	if err != nil {
		t.Fatalf("publish error: %v", err)
	}

	time.Sleep(10 * time.Millisecond)
	if received.Load() != 1 {
		t.Errorf("expected 1 receive, got %d", received.Load())
	}
	mu.Lock()
	if string(receivedData) != "hello" {
		t.Errorf("expected 'hello', got '%s'", string(receivedData))
	}
	mu.Unlock()
}

func TestLocalPublishNoSubscribers(t *testing.T) {
	b := NewLocal()
	defer b.Close()

	err := b.Publish(context.Background(), "empty-chan", []byte("hello"))
	if err != nil {
		t.Fatalf("publish to empty channel should not error: %v", err)
	}
}

func TestLocalMultipleSubscribers(t *testing.T) {
	b := NewLocal()
	defer b.Close()

	var count atomic.Int32

	for i := 0; i < 3; i++ {
		b.Subscribe(context.Background(), "multi", func(channel string, data []byte) {
			count.Add(1)
		})
	}

	b.Publish(context.Background(), "multi", []byte("msg"))
	time.Sleep(10 * time.Millisecond)

	if count.Load() != 3 {
		t.Errorf("expected 3 receives, got %d", count.Load())
	}
}

func TestLocalUnsubscribe(t *testing.T) {
	b := NewLocal()
	defer b.Close()

	var count atomic.Int32
	b.Subscribe(context.Background(), "unsub-test", func(channel string, data []byte) {
		count.Add(1)
	})

	b.Publish(context.Background(), "unsub-test", []byte("before"))
	time.Sleep(10 * time.Millisecond)
	if count.Load() != 1 {
		t.Errorf("expected 1, got %d", count.Load())
	}

	b.Unsubscribe(context.Background(), "unsub-test")
	b.Publish(context.Background(), "unsub-test", []byte("after"))
	time.Sleep(10 * time.Millisecond)
	if count.Load() != 1 {
		t.Errorf("expected still 1 after unsubscribe, got %d", count.Load())
	}
}

func TestLocalUnsubscribeNonExistent(t *testing.T) {
	b := NewLocal()
	defer b.Close()

	err := b.Unsubscribe(context.Background(), "nonexistent")
	if err != nil {
		t.Errorf("unsubscribe nonexistent should not error: %v", err)
	}
}

func TestLocalClose(t *testing.T) {
	b := NewLocal()

	var count atomic.Int32
	b.Subscribe(context.Background(), "close-test", func(channel string, data []byte) {
		count.Add(1)
	})

	b.Close()
	b.Publish(context.Background(), "close-test", []byte("after close"))
	time.Sleep(10 * time.Millisecond)

	if count.Load() != 0 {
		t.Errorf("expected 0 after close, got %d", count.Load())
	}
}

func TestLocalIsolatedChannels(t *testing.T) {
	b := NewLocal()
	defer b.Close()

	var countA, countB atomic.Int32
	b.Subscribe(context.Background(), "chan-a", func(channel string, data []byte) {
		countA.Add(1)
	})
	b.Subscribe(context.Background(), "chan-b", func(channel string, data []byte) {
		countB.Add(1)
	})

	b.Publish(context.Background(), "chan-a", []byte("msg"))
	time.Sleep(10 * time.Millisecond)

	if countA.Load() != 1 {
		t.Errorf("expected chan-a count 1, got %d", countA.Load())
	}
	if countB.Load() != 0 {
		t.Errorf("expected chan-b count 0, got %d", countB.Load())
	}
}

func BenchmarkLocalPublish(b *testing.B) {
	br := NewLocal()
	defer br.Close()
	br.Subscribe(context.Background(), "bench", func(channel string, data []byte) {})
	data := []byte("benchmark message")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		br.Publish(context.Background(), "bench", data)
	}
}
