# Peer Server

A high-performance WebSocket-based peer discovery, signaling, and relay server built in Go. Designed for WebRTC applications, multiplayer games, and any system requiring real-time peer-to-peer coordination.

## Features

- **Peer Discovery** — Find peers in shared namespaces
- **WebRTC Signaling** — Route offers, answers, and ICE candidates between peers
- **Data Relay** — Relay arbitrary data between peers
- **Broadcast** — Send messages to all peers in a namespace
- **Matchmaking** — Criteria-based group matching with configurable group sizes
- **Rooms** — Private rooms with owner controls and kick functionality
- **Namespaces** — Logical grouping of peers by application or context
- **Horizontal Scaling** — Redis pub/sub broker for multi-node deployments
- **Sharded Architecture** — Lock-free peer lookups across 64 shards
- **Rate Limiting** — Sharded token bucket rate limiter per peer
- **Configurable Compression** — WebSocket compression on/off per deployment

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Client (Browser/App)              │
│                                                      │
│  WebSocket ──► Register ──► Join Namespace ──► Signal│
└──────────────────────┬───────────────────────────────┘
                       │ WSS/WS
                       ▼
┌─────────────────────────────────────────────────────┐
│                   Peer Server                       │
│                                                     │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Server  │  │   Hub    │  │  Namespace Manager │  │
│  │         │──│          │──│                    │  │
│  │ WS      │  │ 64 Shards│  │ Namespaces + Rooms│   │
│  │ Handler │  │ Peer Map │  │ Peer Lists        │   │
│  └─────────┘  └──────────┘  └────────────────────┘  │
│                     │                               │
│  ┌─────────────┐    │  ┌──────────────┐             │
│  │ Rate Limiter│    │  │  Matchmaker  │             │
│  │ 32 Shards   │    │  │  Index+Queue │             │
│  └─────────────┘    │  └──────────────┘             │
│                     │                               │
│              ┌──────┴──────┐                        │
│              │   Broker    │                        │
│              │ Local/Redis │                        │
│              └─────────────┘                        │
└─────────────────────────────────────────────────────┘
```

### Component Overview

| Component | Location | Purpose |
|-----------|----------|---------|
| **Server** | `server/` | WebSocket accept, registration handshake, read/write pumps |
| **Hub** | `hub/` | Central message router, peer registry with 64 shards |
| **Namespace Manager** | `namespace/` | Manages namespaces and rooms, peer membership |
| **Matchmaker** | `matchmaker/` | Criteria-based matchmaking with indexed queues |
| **Broker** | `broker/` | Message bus — local (single node) or Redis (multi-node) |
| **Rate Limiter** | `middleware/` | Sharded token bucket rate limiter |
| **Protocol** | `protocol/` | Message types, encoding/decoding, object pools |
| **Peer** | `peer/` | Peer state, namespace membership, send buffers |
| **Config** | `config/` | Configuration from file, env vars, or defaults |

### Data Flow

```
Client A                    Server                     Client B
   │                          │                           │
   │──── register ───────────►│                           │
   │◄─── registered ──────────│                           │
   │                          │                           │
   │──── join(namespace) ────►│                           │
   │◄─── peer_list ──────────│                           │
   │                          │                           │
   │                          │◄──── register ────────────│
   │                          │──── registered ──────────►│
   │                          │◄──── join(namespace) ─────│
   │◄─── peer_joined ────────│──── peer_list ───────────►│
   │                          │                           │
   │──── signal(to:B) ──────►│──── signal(from:A) ─────►│
   │                          │                           │
   │◄─── signal(from:B) ─────│◄──── signal(to:A) ───────│
   │                          │                           │
   │──── broadcast ──────────►│──── broadcast ──────────►│
   │                          │                           │
```

---

## Project Structure

```
.
├── main.go                  # Entry point
├── config.json              # Configuration file
├── config/
│   ├── config.go            # Config struct, loader, duration parsing
│   └── config_test.go
├── server/
│   ├── server.go            # HTTP server, WebSocket handler, read/write pumps
│   └── server_test.go
├── hub/
│   ├── hub.go               # Central hub, sharded peer map, message routing
│   └── hub_test.go
├── peer/
│   ├── peer.go              # Peer struct, namespace membership, send buffer
│   └── peer_test.go
├── namespace/
│   ├── namespace.go         # Namespace/room management, broadcast, snapshots
│   └── namespace_test.go
├── matchmaker/
│   ├── matchmaker.go        # Indexed matchmaking queues
│   └── matchmaker_test.go
├── broker/
│   ├── broker.go            # Broker interface
│   ├── local.go             # In-memory broker (single node)
│   ├── local_test.go
│   ├── redis.go             # Redis pub/sub broker (multi-node)
│   └── redis_test.go
├── middleware/
│   ├── ratelimit.go         # Sharded token bucket rate limiter
│   └── ratelimit_test.go
├── protocol/
│   ├── protocol.go          # Message types, encode/decode, object pools
│   └── protocol_test.go
├── integration_test.go      # Top-level integration tests
└── benchmark_test.go        # Full benchmark and stress test suite
```

---

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/ws` | WebSocket upgrade endpoint |
| GET | `/health` | Server health check |
| GET | `/stats` | Server statistics |

### GET /health

```json
{
  "status": "ok",
  "peers": 1234,
  "max_peers": 100000,
  "timestamp": 1707849600
}
```

### GET /stats

```json
{
  "total_peers": 1234,
  "max_peers": 100000,
  "namespaces": {
    "game-lobby": 500,
    "chat-room": 200
  },
  "shards": 64
}
```

---

## WebSocket Protocol

All messages are JSON with this structure:

```json
{
  "type": "message_type",
  "from": "fingerprint",
  "to": "fingerprint",
  "namespace": "namespace_name",
  "payload": {},
  "ts": 1707849600000
}
```

### Message Types

#### register

First message after WebSocket connect. Required before any other operation.

**Client sends:**
```json
{
  "type": "register",
  "payload": {
    "public_key": "your-public-key-string",
    "alias": "optional-custom-alias",
    "meta": {
      "name": "Player1",
      "avatar": "warrior"
    }
  }
}
```

**Server responds:**
```json
{
  "type": "registered",
  "from": "a1b2c3d4e5f6...",
  "payload": {
    "fingerprint": "a1b2c3d4e5f6...",
    "alias": "brave-fox-42"
  }
}
```

The fingerprint is a SHA-256 hash of the public key. If no alias is provided, one is auto-generated (e.g., `brave-fox-42`).

---

#### join

Join a namespace to discover and communicate with other peers.

**Client sends:**
```json
{
  "type": "join",
  "payload": {
    "namespace": "game-lobby",
    "app_type": "fps-game",
    "version": "1.0.0",
    "meta": {
      "skill_level": 5
    }
  }
}
```

**Server responds with current peer list:**
```json
{
  "type": "peer_list",
  "payload": {
    "namespace": "game-lobby",
    "peers": [
      {
        "fingerprint": "a1b2c3...",
        "alias": "brave-fox-42",
        "app_type": "fps-game",
        "meta": {}
      }
    ],
    "total": 1
  }
}
```

**Other peers in namespace receive:**
```json
{
  "type": "peer_joined",
  "from": "new-peer-fingerprint",
  "namespace": "game-lobby",
  "payload": {
    "fingerprint": "new-peer-fingerprint",
    "alias": "calm-owl-07",
    "app_type": "fps-game"
  }
}
```

---

#### leave

Leave a namespace.

**Client sends:**
```json
{
  "type": "leave",
  "payload": {
    "namespace": "game-lobby"
  }
}
```

**Other peers receive:**
```json
{
  "type": "peer_left",
  "from": "leaving-peer-fingerprint",
  "namespace": "game-lobby"
}
```

---

#### signal

Route WebRTC signaling data (offer/answer/ICE candidate) to a specific peer. Both peers must share at least one namespace.

**Client sends:**
```json
{
  "type": "signal",
  "to": "target-fingerprint-or-alias",
  "payload": {
    "signal_type": "offer",
    "sdp": "v=0\r\no=- 123..."
  }
}
```

**Target peer receives:**
```json
{
  "type": "signal",
  "from": "sender-fingerprint",
  "to": "target-fingerprint",
  "payload": {
    "signal_type": "offer",
    "sdp": "v=0\r\no=- 123..."
  },
  "ts": 1707849600000
}
```

Signal types: `offer`, `answer`, `candidate`

ICE candidate example:
```json
{
  "type": "signal",
  "to": "target-fingerprint",
  "payload": {
    "signal_type": "candidate",
    "candidate": {
      "candidate": "candidate:1 1 UDP 2122252543 192.168.1.1 12345 typ host",
      "sdpMid": "0",
      "sdpMLineIndex": 0
    }
  }
}
```

---

#### relay

Relay arbitrary data to a specific peer. Same namespace requirement as signal.

**Client sends:**
```json
{
  "type": "relay",
  "to": "target-fingerprint-or-alias",
  "payload": {
    "action": "game_move",
    "data": {"x": 10, "y": 20}
  }
}
```

---

#### broadcast

Send a message to all peers in a namespace. Sender must be a member of the namespace.

**Client sends:**
```json
{
  "type": "broadcast",
  "payload": {
    "namespace": "game-lobby",
    "data": {"event": "game_starting", "countdown": 5}
  }
}
```

All other peers in the namespace receive the broadcast message.

---

#### discover

Query peers in a namespace.

**Client sends:**
```json
{
  "type": "discover",
  "payload": {
    "namespace": "game-lobby",
    "limit": 50
  }
}
```

**Server responds:**
```json
{
  "type": "peer_list",
  "payload": {
    "namespace": "game-lobby",
    "peers": [...],
    "total": 150
  }
}
```

---

#### match

Request matchmaking in a namespace.

**Client sends:**
```json
{
  "type": "match",
  "payload": {
    "namespace": "game-lobby",
    "group_size": 4,
    "criteria": {
      "mode": "ranked",
      "region": "us-east"
    }
  }
}
```

**If waiting:**
```json
{
  "type": "match",
  "payload": {"status": "waiting"}
}
```

**When matched (sent to all matched peers):**
```json
{
  "type": "matched",
  "namespace": "game-lobby",
  "payload": {
    "namespace": "game-lobby",
    "session_id": "a1b2c3d4e5f6...",
    "peers": [
      {"fingerprint": "peer1...", "alias": "brave-fox-42"},
      {"fingerprint": "peer2...", "alias": "calm-owl-07"},
      {"fingerprint": "peer3...", "alias": "dark-elk-13"},
      {"fingerprint": "peer4...", "alias": "eager-bat-99"}
    ]
  }
}
```

Matching rules:
- Peers must have identical criteria and group_size to match
- Minimum group_size is 2
- Closed/disconnected peers are automatically removed from queues

---

#### create_room

Create a private room.

**Client sends:**
```json
{
  "type": "create_room",
  "payload": {
    "room_id": "my-room-123",
    "max_size": 10
  }
}
```

**Server responds:**
```json
{
  "type": "room_created",
  "payload": {
    "room_id": "my-room-123",
    "max_size": 10,
    "owner": "creator-fingerprint"
  }
}
```

Room constraints:
- max_size default: 20
- max_size cap: 30
- Room IDs must be unique
- Creator automatically joins the room
- Empty rooms are auto-deleted

---

#### join_room

Join an existing room.

**Client sends:**
```json
{
  "type": "join_room",
  "payload": {
    "room_id": "my-room-123"
  }
}
```

**Server responds with peer list, other room members get peer_joined.**

---

#### room_info

Query room information.

**Client sends:**
```json
{
  "type": "room_info",
  "payload": {
    "room_id": "my-room-123"
  }
}
```

**Server responds:**
```json
{
  "type": "room_info",
  "payload": {
    "room_id": "my-room-123",
    "peer_count": 5,
    "max_size": 10,
    "owner": "owner-fingerprint"
  }
}
```

---

#### kick

Room owner kicks a peer from the room.

**Client sends:**
```json
{
  "type": "kick",
  "payload": {
    "room_id": "my-room-123",
    "fingerprint": "target-peer-fingerprint"
  }
}
```

Only the room owner can kick. The kicked peer receives a kick message, and all remaining peers receive peer_left.

---

#### metadata

Update peer metadata.

**Client sends:**
```json
{
  "type": "metadata",
  "payload": {
    "meta": {
      "status": "in-game",
      "score": 1500
    }
  }
}
```

---

#### ping / pong

Keepalive mechanism.

**Client sends:**
```json
{"type": "ping"}
```

**Server responds:**
```json
{"type": "pong"}
```

---

#### error

Server error responses.

```json
{
  "type": "error",
  "payload": {
    "code": 403,
    "message": "no shared namespace"
  }
}
```

| Code | Meaning |
|------|---------|
| 400 | Bad request / invalid payload |
| 403 | Forbidden (no shared namespace, not room owner) |
| 404 | Not found (room, peer) |
| 409 | Conflict (room already exists) |
| 429 | Rate limited / namespace full / room full |
| 503 | Server full |

---

## Configuration

### config.json

```json
{
  "host": "0.0.0.0",
  "port": 8080,
  "max_peers": 100000,
  "shard_count": 64,
  "write_timeout": "10s",
  "read_timeout": "60s",
  "ping_interval": "30s",
  "pong_wait": "35s",
  "max_message_size": 65536,
  "broker_type": "local",
  "redis_addr": "localhost:6379",
  "redis_password": "",
  "redis_db": 0,
  "rate_limit_per_sec": 100,
  "rate_limit_burst": 200,
  "rate_limit_shards": 32,
  "tls_cert": "",
  "tls_key": "",
  "metrics_enabled": true,
  "metrics_port": 9090,
  "compression_enabled": false,
  "send_buffer_size": 32
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | string | `0.0.0.0` | Bind address |
| `port` | int | `8080` | Listen port |
| `max_peers` | int | `100000` | Maximum concurrent connections |
| `shard_count` | int | `64` | Number of peer map shards (must be power of 2) |
| `write_timeout` | duration | `10s` | WebSocket write timeout |
| `read_timeout` | duration | `60s` | HTTP read timeout |
| `ping_interval` | duration | `30s` | Server ping interval |
| `pong_wait` | duration | `35s` | Pong wait timeout |
| `max_message_size` | int | `65536` | Maximum WebSocket message size in bytes |
| `broker_type` | string | `local` | Broker type: `local` or `redis` |
| `redis_addr` | string | `localhost:6379` | Redis address |
| `redis_password` | string | `""` | Redis password |
| `redis_db` | int | `0` | Redis database number |
| `rate_limit_per_sec` | int | `100` | Rate limit tokens per second |
| `rate_limit_burst` | int | `200` | Rate limit burst size |
| `rate_limit_shards` | int | `32` | Rate limiter shard count |
| `tls_cert` | string | `""` | TLS certificate file path |
| `tls_key` | string | `""` | TLS key file path |
| `compression_enabled` | bool | `false` | Enable WebSocket compression |
| `send_buffer_size` | int | `32` | Per-peer send channel buffer size |

Durations accept both string format (`"10s"`, `"5m"`) and milliseconds (`10000`).

### Environment Variables

| Variable | Config Field |
|----------|-------------|
| `PEER_HOST` | host |
| `PEER_PORT` | port |
| `PEER_MAX_PEERS` | max_peers |
| `PEER_BROKER` | broker_type |
| `PEER_COMPRESSION` | compression_enabled |
| `PEER_SEND_BUFFER` | send_buffer_size |
| `REDIS_ADDR` | redis_addr |
| `REDIS_PASSWORD` | redis_password |
| `TLS_CERT` | tls_cert |
| `TLS_KEY` | tls_key |

Environment variables override config file values.

---

## Usage

### Build and Run

```bash
# build
go build -o peer-server .

# run with defaults
./peer-server

# run with config file
./peer-server -config config.json

# run with environment variables
PEER_PORT=9090 PEER_BROKER=redis REDIS_ADDR=redis:6379 ./peer-server
```

### Docker

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o peer-server .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/peer-server .
COPY config.json .
EXPOSE 8080
CMD ["./peer-server", "-config", "config.json"]
```

```bash
docker build -t peer-server .
docker run -p 8080:8080 peer-server
```

### Docker Compose (with Redis)

```yaml
version: "3.8"
services:
  peer-server:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PEER_BROKER=redis
      - REDIS_ADDR=redis:6379
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

### TLS

```bash
./peer-server -config config.json
```

With `config.json`:
```json
{
  "tls_cert": "/path/to/cert.pem",
  "tls_key": "/path/to/key.pem"
}
```

---

## Client Examples

### JavaScript (Browser)

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');

ws.onopen = () => {
  // Step 1: Register
  ws.send(JSON.stringify({
    type: 'register',
    payload: {
      public_key: 'my-unique-public-key',
      alias: 'player1'
    }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'registered':
      console.log('Registered as:', msg.payload.fingerprint);
      console.log('Alias:', msg.payload.alias);
    
      // Step 2: Join namespace
      ws.send(JSON.stringify({
        type: 'join',
        payload: {
          namespace: 'game-lobby',
          app_type: 'my-game'
        }
      }));
      break;
    
    case 'peer_list':
      console.log('Peers in namespace:', msg.payload.peers);
      break;
    
    case 'peer_joined':
      console.log('New peer joined:', msg.from);
    
      // Step 3: Send WebRTC offer to new peer
      const pc = new RTCPeerConnection();
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
          type: 'signal',
          to: msg.from,
          payload: {
            signal_type: 'offer',
            sdp: offer.sdp
          }
        }));
      });
      break;
    
    case 'signal':
      console.log('Signal from:', msg.from, msg.payload.signal_type);
      // Handle offer/answer/candidate
      break;
    
    case 'peer_left':
      console.log('Peer left:', msg.from);
      break;
    
    case 'matched':
      console.log('Matched with:', msg.payload.peers);
      console.log('Session:', msg.payload.session_id);
      break;
    
    case 'error':
      console.error('Error:', msg.payload.code, msg.payload.message);
      break;
  }
};

// Keepalive
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);
```

### Matchmaking Example

```javascript
// Request match
ws.send(JSON.stringify({
  type: 'match',
  payload: {
    namespace: 'game-lobby',
    group_size: 4,
    criteria: {
      mode: 'ranked',
      region: 'us-east'
    }
  }
}));

// Handle match result
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'matched') {
    const { peers, session_id } = msg.payload;
    console.log(`Match found! Session: ${session_id}`);
    peers.forEach(peer => {
      console.log(`  ${peer.alias} (${peer.fingerprint})`);
    });
    // Start WebRTC connections with all matched peers
  }
};
```

### Room Example

```javascript
// Create room
ws.send(JSON.stringify({
  type: 'create_room',
  payload: { room_id: 'private-match-1', max_size: 8 }
}));

// Join room (other client)
ws.send(JSON.stringify({
  type: 'join_room',
  payload: { room_id: 'private-match-1' }
}));

// Kick player (owner only)
ws.send(JSON.stringify({
  type: 'kick',
  payload: {
    room_id: 'private-match-1',
    fingerprint: 'player-to-kick-fingerprint'
  }
}));
```

---

## Testing

```bash
# all unit and integration tests
go test -v -race ./...

# specific package
go test -v -race ./hub/
go test -v -race ./server/
go test -v -race ./namespace/

# redis tests (requires running redis)
REDIS_TEST_ADDR=localhost:6379 go test -v -race ./broker/

# benchmarks
go test -bench=. -benchmem -benchtime=3s -run=^$ -v .

# specific benchmark
go test -bench=BenchmarkSignalThroughput -benchmem -benchtime=5s -run=^$ -v .

# stress tests
go test -run=TestStress -stress -timeout=300s -v .

# coverage
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out

# profiling
go test -bench=BenchmarkSignalThroughput -cpuprofile=cpu.prof -memprofile=mem.prof -run=^$ .
go tool pprof cpu.prof
```

---

## Performance

Benchmarked on AMD EPYC (6 cores):

| Operation | Throughput | Latency |
|-----------|-----------|---------|
| Connection + Registration | ~6,500 /sec | ~150µs |
| Signal Routing (10 peers) | ~73,000 msgs/sec | ~14µs |
| Signal Routing (100 peers) | ~80,000 msgs/sec | ~12µs |
| Ping/Pong Round Trip | — | <1ms |

Memory per connection: ~59 KB (including send buffers and goroutines)

### Compression Trade-offs

| Setting | Memory/Connection | CPU | Best For |
|---------|------------------|-----|----------|
| `compression_enabled: false` | ~59 KB | Low | High connection count, LAN |
| `compression_enabled: true` | ~120+ KB | Higher | WAN, bandwidth constrained |

---

## Multi-Node Deployment

For horizontal scaling, use Redis as the broker:

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Node 1  │     │  Node 2  │     │  Node 3  │
│  :8080   │     │  :8081   │     │  :8082   │
└────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │
     └────────┬───────┴───────┬────────┘
              │               │
         ┌────┴────┐    ┌─────┴─────┐
         │  Redis  │    │  Load     │
         │  Broker │    │  Balancer │
         └─────────┘    └───────────┘
```

Each node stamps its `nodeID` on outgoing broker messages. When receiving from Redis, messages from the same node are skipped to prevent double delivery.

Supported cross-node operations:
- Signal routing
- Relay routing
- Broadcast fan-out

---

## License

MIT
