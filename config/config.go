package config

import (
	"encoding/json"
	"os"
	"strconv"
	"time"
)

type Duration struct {
	time.Duration
}

func (d *Duration) UnmarshalJSON(b []byte) error {
	var v interface{}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	switch val := v.(type) {
	case float64:
		d.Duration = time.Duration(int64(val)) * time.Millisecond
		return nil
	case string:
		var err error
		d.Duration, err = time.ParseDuration(val)
		return err
	default:
		return nil
	}
}

func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(d.Duration.String())
}

type Config struct {
	Host               string   `json:"host"`
	Port               int      `json:"port"`
	MaxPeers           int      `json:"max_peers"`
	ShardCount         int      `json:"shard_count"`
	WriteTimeout       Duration `json:"write_timeout"`
	ReadTimeout        Duration `json:"read_timeout"`
	PingInterval       Duration `json:"ping_interval"`
	PongWait           Duration `json:"pong_wait"`
	MaxMessageSize     int64    `json:"max_message_size"`
	BrokerType         string   `json:"broker_type"`
	RedisAddr          string   `json:"redis_addr"`
	RedisPassword      string   `json:"redis_password"`
	RedisDB            int      `json:"redis_db"`
	RateLimitPerSec    int      `json:"rate_limit_per_sec"`
	RateLimitBurst     int      `json:"rate_limit_burst"`
	RateLimitShards    int      `json:"rate_limit_shards"`
	TLSCert            string   `json:"tls_cert"`
	TLSKey             string   `json:"tls_key"`
	MetricsEnabled     bool     `json:"metrics_enabled"`
	MetricsPort        int      `json:"metrics_port"`
	CompressionEnabled bool     `json:"compression_enabled"`
	SendBufferSize     int      `json:"send_buffer_size"`
}

func Default() *Config {
	return &Config{
		Host:               "0.0.0.0",
		Port:               8080,
		MaxPeers:           100000,
		ShardCount:         64,
		WriteTimeout:       Duration{10 * time.Second},
		ReadTimeout:        Duration{60 * time.Second},
		PingInterval:       Duration{30 * time.Second},
		PongWait:           Duration{35 * time.Second},
		MaxMessageSize:     65536,
		BrokerType:         "local",
		RedisAddr:          "localhost:6379",
		RedisPassword:      "",
		RedisDB:            0,
		RateLimitPerSec:    100,
		RateLimitBurst:     200,
		RateLimitShards:    32,
		TLSCert:            "",
		TLSKey:             "",
		MetricsEnabled:     true,
		MetricsPort:        9090,
		CompressionEnabled: false,
		SendBufferSize:     32,
	}
}

func LoadFromFile(path string) (*Config, error) {
	cfg := Default()
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	err = json.Unmarshal(data, cfg)
	return cfg, err
}

func LoadFromEnv() *Config {
	cfg := Default()
	if v := os.Getenv("PEER_HOST"); v != "" {
		cfg.Host = v
	}
	if v := os.Getenv("PEER_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil {
			cfg.Port = port
		}
	}
	if v := os.Getenv("PEER_BROKER"); v != "" {
		cfg.BrokerType = v
	}
	if v := os.Getenv("REDIS_ADDR"); v != "" {
		cfg.RedisAddr = v
	}
	if v := os.Getenv("REDIS_PASSWORD"); v != "" {
		cfg.RedisPassword = v
	}
	if v := os.Getenv("TLS_CERT"); v != "" {
		cfg.TLSCert = v
	}
	if v := os.Getenv("TLS_KEY"); v != "" {
		cfg.TLSKey = v
	}
	if v := os.Getenv("PEER_MAX_PEERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.MaxPeers = n
		}
	}
	if v := os.Getenv("PEER_COMPRESSION"); v == "true" || v == "1" {
		cfg.CompressionEnabled = true
	}
	if v := os.Getenv("PEER_SEND_BUFFER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.SendBufferSize = n
		}
	}
	return cfg
}
