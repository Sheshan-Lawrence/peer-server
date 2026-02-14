package config

import (
	"os"
	"testing"
	"time"
)

func TestDefaultConfig(t *testing.T) {
	cfg := Default()
	if cfg.Host != "0.0.0.0" {
		t.Errorf("expected host 0.0.0.0, got %s", cfg.Host)
	}
	if cfg.Port != 8080 {
		t.Errorf("expected port 8080, got %d", cfg.Port)
	}
	if cfg.MaxPeers != 100000 {
		t.Errorf("expected max_peers 100000, got %d", cfg.MaxPeers)
	}
	if cfg.ShardCount != 64 {
		t.Errorf("expected shard_count 64, got %d", cfg.ShardCount)
	}
	if cfg.WriteTimeout.Duration != 10*time.Second {
		t.Errorf("expected write_timeout 10s, got %v", cfg.WriteTimeout.Duration)
	}
	if cfg.PingInterval.Duration != 30*time.Second {
		t.Errorf("expected ping_interval 30s, got %v", cfg.PingInterval.Duration)
	}
	if cfg.CompressionEnabled {
		t.Error("expected compression disabled by default")
	}
	if cfg.SendBufferSize != 32 {
		t.Errorf("expected send_buffer_size 32, got %d", cfg.SendBufferSize)
	}
	if cfg.RateLimitShards != 32 {
		t.Errorf("expected rate_limit_shards 32, got %d", cfg.RateLimitShards)
	}
}

func TestLoadFromFileStringDurations(t *testing.T) {
	content := `{
		"host": "127.0.0.1",
		"port": 9090,
		"write_timeout": "5s",
		"read_timeout": "30s",
		"ping_interval": "15s",
		"pong_wait": "20s",
		"compression_enabled": true,
		"send_buffer_size": 64
	}`
	tmpFile, err := os.CreateTemp("", "config-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.WriteString(content)
	tmpFile.Close()

	cfg, err := LoadFromFile(tmpFile.Name())
	if err != nil {
		t.Fatalf("load error: %v", err)
	}
	if cfg.Host != "127.0.0.1" {
		t.Errorf("expected host 127.0.0.1, got %s", cfg.Host)
	}
	if cfg.Port != 9090 {
		t.Errorf("expected port 9090, got %d", cfg.Port)
	}
	if cfg.WriteTimeout.Duration != 5*time.Second {
		t.Errorf("expected write_timeout 5s, got %v", cfg.WriteTimeout.Duration)
	}
	if cfg.ReadTimeout.Duration != 30*time.Second {
		t.Errorf("expected read_timeout 30s, got %v", cfg.ReadTimeout.Duration)
	}
	if cfg.PingInterval.Duration != 15*time.Second {
		t.Errorf("expected ping_interval 15s, got %v", cfg.PingInterval.Duration)
	}
	if cfg.PongWait.Duration != 20*time.Second {
		t.Errorf("expected pong_wait 20s, got %v", cfg.PongWait.Duration)
	}
	if !cfg.CompressionEnabled {
		t.Error("expected compression enabled")
	}
	if cfg.SendBufferSize != 64 {
		t.Errorf("expected send_buffer_size 64, got %d", cfg.SendBufferSize)
	}
}

func TestLoadFromFileMillisecondDurations(t *testing.T) {
	content := `{
		"write_timeout": 5000,
		"ping_interval": 15000
	}`
	tmpFile, err := os.CreateTemp("", "config-ms-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.WriteString(content)
	tmpFile.Close()

	cfg, err := LoadFromFile(tmpFile.Name())
	if err != nil {
		t.Fatalf("load error: %v", err)
	}
	if cfg.WriteTimeout.Duration != 5*time.Second {
		t.Errorf("expected write_timeout 5s, got %v", cfg.WriteTimeout.Duration)
	}
	if cfg.PingInterval.Duration != 15*time.Second {
		t.Errorf("expected ping_interval 15s, got %v", cfg.PingInterval.Duration)
	}
}

func TestLoadFromFileMissing(t *testing.T) {
	cfg, err := LoadFromFile("/nonexistent/path/config.json")
	if err == nil {
		t.Error("expected error for missing file")
	}
	// should still return defaults
	if cfg.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Port)
	}
}

func TestLoadFromFileInvalidJSON(t *testing.T) {
	tmpFile, err := os.CreateTemp("", "config-bad-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.WriteString("not valid json{{{")
	tmpFile.Close()

	_, err = LoadFromFile(tmpFile.Name())
	if err == nil {
		t.Error("expected error for invalid json")
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("PEER_HOST", "10.0.0.1")
	os.Setenv("PEER_PORT", "3000")
	os.Setenv("PEER_BROKER", "redis")
	os.Setenv("REDIS_ADDR", "redis.local:6379")
	os.Setenv("REDIS_PASSWORD", "secret")
	os.Setenv("PEER_COMPRESSION", "true")
	os.Setenv("PEER_SEND_BUFFER", "128")
	os.Setenv("PEER_MAX_PEERS", "50000")
	defer func() {
		os.Unsetenv("PEER_HOST")
		os.Unsetenv("PEER_PORT")
		os.Unsetenv("PEER_BROKER")
		os.Unsetenv("REDIS_ADDR")
		os.Unsetenv("REDIS_PASSWORD")
		os.Unsetenv("PEER_COMPRESSION")
		os.Unsetenv("PEER_SEND_BUFFER")
		os.Unsetenv("PEER_MAX_PEERS")
	}()

	cfg := LoadFromEnv()
	if cfg.Host != "10.0.0.1" {
		t.Errorf("expected host 10.0.0.1, got %s", cfg.Host)
	}
	if cfg.Port != 3000 {
		t.Errorf("expected port 3000, got %d", cfg.Port)
	}
	if cfg.BrokerType != "redis" {
		t.Errorf("expected broker redis, got %s", cfg.BrokerType)
	}
	if cfg.RedisAddr != "redis.local:6379" {
		t.Errorf("expected redis addr redis.local:6379, got %s", cfg.RedisAddr)
	}
	if cfg.RedisPassword != "secret" {
		t.Errorf("expected redis password secret, got %s", cfg.RedisPassword)
	}
	if !cfg.CompressionEnabled {
		t.Error("expected compression enabled from env")
	}
	if cfg.SendBufferSize != 128 {
		t.Errorf("expected send_buffer_size 128, got %d", cfg.SendBufferSize)
	}
	if cfg.MaxPeers != 50000 {
		t.Errorf("expected max_peers 50000, got %d", cfg.MaxPeers)
	}
}

func TestLoadFromEnvInvalidPort(t *testing.T) {
	os.Setenv("PEER_PORT", "not_a_number")
	defer os.Unsetenv("PEER_PORT")

	cfg := LoadFromEnv()
	if cfg.Port != 8080 {
		t.Errorf("expected default port 8080 for invalid env, got %d", cfg.Port)
	}
}

func TestDurationMarshalJSON(t *testing.T) {
	d := Duration{10 * time.Second}
	data, err := d.MarshalJSON()
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}
	expected := `"10s"`
	if string(data) != expected {
		t.Errorf("expected %s, got %s", expected, string(data))
	}
}
