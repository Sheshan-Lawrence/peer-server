package broker

import "context"

type MessageHandler func(channel string, data []byte)

type Broker interface {
	Publish(ctx context.Context, channel string, data []byte) error
	Subscribe(ctx context.Context, channel string, handler MessageHandler) error
	Unsubscribe(ctx context.Context, channel string) error
	Close() error
}
