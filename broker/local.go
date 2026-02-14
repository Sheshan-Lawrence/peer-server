package broker

import (
	"context"
	"sync"
)

type LocalBroker struct {
	subscribers map[string][]MessageHandler
	mu          sync.RWMutex
}

func NewLocal() *LocalBroker {
	return &LocalBroker{
		subscribers: make(map[string][]MessageHandler),
	}
}

func (b *LocalBroker) Publish(_ context.Context, channel string, data []byte) error {
	b.mu.RLock()
	handlers := b.subscribers[channel]
	b.mu.RUnlock()
	for _, h := range handlers {
		h(channel, data)
	}
	return nil
}

func (b *LocalBroker) Subscribe(_ context.Context, channel string, handler MessageHandler) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subscribers[channel] = append(b.subscribers[channel], handler)
	return nil
}

func (b *LocalBroker) Unsubscribe(_ context.Context, channel string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subscribers, channel)
	return nil
}

func (b *LocalBroker) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subscribers = make(map[string][]MessageHandler)
	return nil
}
