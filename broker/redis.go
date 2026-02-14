package broker

import (
	"context"
	"sync"

	"github.com/redis/go-redis/v9"
)

type RedisBroker struct {
	client *redis.Client
	pubsub map[string]*redis.PubSub
	mu     sync.RWMutex
	nodeID string
}

func NewRedis(addr, password string, db int, nodeID string) (*RedisBroker, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	if err := client.Ping(context.Background()).Err(); err != nil {
		return nil, err
	}
	return &RedisBroker{
		client: client,
		pubsub: make(map[string]*redis.PubSub),
		nodeID: nodeID,
	}, nil
}

func (b *RedisBroker) Publish(ctx context.Context, channel string, data []byte) error {
	return b.client.Publish(ctx, "peer:"+channel, data).Err()
}

func (b *RedisBroker) Subscribe(ctx context.Context, channel string, handler MessageHandler) error {
	ps := b.client.Subscribe(ctx, "peer:"+channel)
	b.mu.Lock()
	b.pubsub[channel] = ps
	b.mu.Unlock()

	go func() {
		ch := ps.Channel()
		for msg := range ch {
			handler(channel, []byte(msg.Payload))
		}
	}()
	return nil
}

func (b *RedisBroker) Unsubscribe(ctx context.Context, channel string) error {
	b.mu.Lock()
	ps, ok := b.pubsub[channel]
	if ok {
		delete(b.pubsub, channel)
	}
	b.mu.Unlock()
	if ok {
		return ps.Close()
	}
	return nil
}

func (b *RedisBroker) Close() error {
	b.mu.Lock()
	for _, ps := range b.pubsub {
		ps.Close()
	}
	b.pubsub = make(map[string]*redis.PubSub)
	b.mu.Unlock()
	return b.client.Close()
}
