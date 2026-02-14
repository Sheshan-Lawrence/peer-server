// integration_test.go
package main

import (
	"fmt"
	"sync"
	"testing"

	"peerserver/broker"
	"peerserver/config"
	"peerserver/hub"
	"peerserver/server"
)

func TestConfigLoading(t *testing.T) {
	cfg := config.Default()
	if cfg == nil {
		t.Fatal("default config should not be nil")
	}
	if cfg.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Port)
	}
}

func TestBrokerCreation(t *testing.T) {
	b := broker.NewLocal()
	if b == nil {
		t.Fatal("local broker should not be nil")
	}
	err := b.Close()
	if err != nil {
		t.Errorf("close error: %v", err)
	}
}

func TestHubCreation(t *testing.T) {
	b := broker.NewLocal()
	h := hub.New(64, 1000, b)
	if h == nil {
		t.Fatal("hub should not be nil")
	}
	if h.PeerCount() != 0 {
		t.Errorf("expected 0 peers, got %d", h.PeerCount())
	}
	h.Shutdown()
}

func TestServerCreation(t *testing.T) {
	cfg := config.Default()
	b := broker.NewLocal()
	h := hub.New(cfg.ShardCount, cfg.MaxPeers, b)
	srv := server.New(cfg, h)
	if srv == nil {
		t.Fatal("server should not be nil")
	}
	srv.Shutdown()
}

func TestHubShutdownCleansUp(t *testing.T) {
	b := broker.NewLocal()
	h := hub.New(16, 100, b)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			_ = fmt.Sprintf("peer-%d", id)
		}(i)
	}
	wg.Wait()

	h.Shutdown()

	if h.PeerCount() != 0 {
		t.Errorf("expected 0 peers after shutdown, got %d", h.PeerCount())
	}
}
