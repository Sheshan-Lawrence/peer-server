// main.go
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"peerserver/broker"
	"peerserver/config"
	"peerserver/hub"
	"peerserver/server"
)

func main() {
	configPath := flag.String("config", "", "path to config file")
	flag.Parse()

	var cfg *config.Config
	if *configPath != "" {
		var err error
		cfg, err = config.LoadFromFile(*configPath)
		if err != nil {
			log.Printf("config file error: %v, using defaults", err)
			cfg = config.LoadFromEnv()
		}
	} else {
		cfg = config.LoadFromEnv()
	}

	h := hub.New(cfg.ShardCount, cfg.MaxPeers, createBroker(cfg, ""))
	// re-create broker with nodeID for redis
	if cfg.BrokerType == "redis" {
		h.Shutdown()
		b, err := broker.NewRedis(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB, h.NodeID())
		if err != nil {
			log.Fatalf("redis connection failed: %v", err)
		}
		h = hub.New(cfg.ShardCount, cfg.MaxPeers, b)
	}

	srv := server.New(cfg, h)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := srv.Start(); err != nil {
			log.Fatalf("server error: %v", err)
		}
	}()

	log.Printf("peer server running [max_peers=%d, shards=%d, broker=%s, compression=%v]",
		cfg.MaxPeers, cfg.ShardCount, cfg.BrokerType, cfg.CompressionEnabled)

	<-quit
	log.Println("shutting down...")
	srv.Shutdown()
	log.Println("server stopped")
}

func createBroker(cfg *config.Config, nodeID string) broker.Broker {
	switch cfg.BrokerType {
	case "redis":
		b, err := broker.NewRedis(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB, nodeID)
		if err != nil {
			log.Fatalf("redis connection failed: %v", err)
		}
		log.Println("using redis broker")
		return b
	default:
		log.Println("using local broker")
		return broker.NewLocal()
	}
}
