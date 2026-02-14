```markdown
# Usage Guide

## Table of Contents

1. [Getting Started](#getting-started)
2. [Connection Lifecycle](#connection-lifecycle)
3. [Peer Registration](#peer-registration)
4. [Namespaces](#namespaces)
5. [WebRTC Signaling Flow](#webrtc-signaling-flow)
6. [Data Relay](#data-relay)
7. [Broadcasting](#broadcasting)
8. [Matchmaking](#matchmaking)
9. [Rooms](#rooms)
10. [Metadata](#metadata)
11. [Keepalive](#keepalive)
12. [Error Handling](#error-handling)
13. [Multi-Node Setup](#multi-node-setup)
14. [Production Deployment](#production-deployment)
15. [Frequently Asked Questions](#frequently-asked-questions)

---

## Getting Started

### Installation

```bash
git clone https://github.com/your-org/peer-relay-server.git
cd peer-relay-server
go mod tidy
go build -o peer-server .
```

### Quick Start

```bash
# run with defaults (port 8080, local broker, no TLS)
./peer-server

# run with config file
./peer-server -config config.json

# run with environment variables
PEER_PORT=9090 PEER_MAX_PEERS=50000 ./peer-server
```

### Verify Server is Running

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "ok",
  "peers": 0,
  "max_peers": 100000,
  "timestamp": 1707849600
}
```

---

## Connection Lifecycle

Every client follows the same lifecycle:

```
Connect (WebSocket) ──► Register ──► Join Namespace(s) ──► Interact ──► Disconnect
```

### Step 1: Connect

Open a WebSocket connection to the server:

```javascript
const ws = new WebSocket('ws://localhost:8080/ws');
// or with TLS:
const ws = new WebSocket('wss://your-domain.com/ws');
```

### Step 2: Register (mandatory first message)

The very first message must be `register`. Any other message type before registration will be rejected and the connection closed.

```javascript
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'register',
    payload: {
      public_key: 'your-unique-key-here',
      alias: 'player-one',        // optional
      meta: { name: 'Alice' }     // optional
    }
  }));
};
```

The server responds with a fingerprint (SHA-256 hash of your public key) and your alias:

```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'registered') {
    const myFingerprint = msg.payload.fingerprint;
    const myAlias = msg.payload.alias;
    console.log(`Registered: ${myAlias} (${myFingerprint})`);
  }
};
```

### Step 3: Join Namespace(s)

Join one or more namespaces to find and communicate with other peers:

```javascript
ws.send(JSON.stringify({
  type: 'join',
  payload: {
    namespace: 'my-game-lobby',
    app_type: 'fps-shooter',
    version: '2.1.0'
  }
}));
```

### Step 4: Interact

Send signals, relay data, broadcast, match, etc.

### Step 5: Disconnect

Simply close the WebSocket. The server automatically:
- Removes you from all namespaces
- Notifies other peers with `peer_left` in each namespace
- Removes you from matchmaking queues
- Cleans up empty rooms you were in
- Frees your alias for reuse

```javascript
ws.close();
```

---

## Peer Registration

### Public Key

The `public_key` field is used to generate a deterministic fingerprint. The same public key always produces the same fingerprint. This means:

- If you reconnect with the same public key, you get the same fingerprint
- The previous connection with that fingerprint is terminated and replaced
- Your identity persists across reconnections

**Best practice:** Use your actual WebRTC public key, a UUID, or any unique stable identifier.

```javascript
// using a UUID
{
  "type": "register",
  "payload": {
    "public_key": "550e8400-e29b-41d4-a716-446655440000"
  }
}

// using an actual public key
{
  "type": "register",
  "payload": {
    "public_key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
  }
}
```

### Alias

If you don't provide an alias, one is auto-generated from your fingerprint in the format `adjective-animal-number` (e.g., `brave-fox-42`). Auto-generated aliases are deterministic — same fingerprint always gets the same alias.

Custom aliases are first-come-first-served. If another peer already has that alias, the server still registers you but the alias may not resolve for routing purposes.

### Metadata

Optional key-value metadata attached to your peer profile. Other peers can see this when they discover you or when you join a namespace.

```javascript
{
  "type": "register",
  "payload": {
    "public_key": "my-key",
    "meta": {
      "display_name": "Alice",
      "avatar_url": "https://example.com/avatar.png",
      "level": 42,
      "platform": "web"
    }
  }
}
```

You can update metadata later without re-registering:

```javascript
ws.send(JSON.stringify({
  type: 'metadata',
  payload: {
    meta: { status: 'in-game', score: 1500 }
  }
}));
```

---

## Namespaces

Namespaces are logical groups of peers. They serve as:
- **Discovery scope** — you can only discover peers in your namespace
- **Communication boundary** — signaling and relay require a shared namespace
- **Broadcast target** — broadcasts go to all peers in a namespace

### Joining

```javascript
ws.send(JSON.stringify({
  type: 'join',
  payload: {
    namespace: 'game:ranked:us-east',
    app_type: 'battle-royale',
    version: '3.0.0',
    meta: { skill_rating: 1500 }
  }
}));
```

You receive a peer list of everyone currently in the namespace:

```json
{
  "type": "peer_list",
  "payload": {
    "namespace": "game:ranked:us-east",
    "peers": [
      {
        "fingerprint": "abc123...",
        "alias": "gold-hawk-11",
        "app_type": "battle-royale",
        "meta": { "skill_rating": 1800 }
      }
    ],
    "total": 1
  }
}
```

### Multiple Namespaces

A single peer can join multiple namespaces simultaneously. This is useful for:
- Being in a game lobby AND a chat channel
- Being in a global namespace AND a regional namespace
- Being in a public namespace AND a private room

```javascript
// join lobby
ws.send(JSON.stringify({
  type: 'join',
  payload: { namespace: 'game-lobby', app_type: 'game' }
}));

// also join chat
ws.send(JSON.stringify({
  type: 'join',
  payload: { namespace: 'global-chat', app_type: 'chat' }
}));
```

### Leaving

```javascript
ws.send(JSON.stringify({
  type: 'leave',
  payload: { namespace: 'game-lobby' }
}));
```

Everyone else in the namespace receives `peer_left`.

### Discovering Peers

Query who is in a namespace at any time:

```javascript
ws.send(JSON.stringify({
  type: 'discover',
  payload: {
    namespace: 'game-lobby',
    limit: 50  // optional, default 50
  }
}));
```

**Note:** You cannot discover peers in rooms (returns 403 error). Rooms are private by design.

### Namespace Naming Conventions

There are no restrictions on namespace names. Recommended patterns:

```
game-lobby                    # simple
game:ranked:us-east          # hierarchical
app/v2/rooms                 # path-style
com.myapp.lobby              # reverse domain
```

---

## WebRTC Signaling Flow

The primary use case for this server is WebRTC signaling. Here is the complete flow:

### Peer A (Caller)

```javascript
const myFingerprint = '...'; // from registration
const targetFingerprint = '...'; // from peer_list or peer_joined

// 1. Create RTCPeerConnection
const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

// 2. Add local tracks
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
stream.getTracks().forEach(track => pc.addTrack(track, stream));

// 3. Handle ICE candidates
pc.onicecandidate = (event) => {
  if (event.candidate) {
    ws.send(JSON.stringify({
      type: 'signal',
      to: targetFingerprint,
      payload: {
        signal_type: 'candidate',
        candidate: event.candidate.toJSON()
      }
    }));
  }
};

// 4. Create and send offer
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

ws.send(JSON.stringify({
  type: 'signal',
  to: targetFingerprint,
  payload: {
    signal_type: 'offer',
    sdp: offer.sdp
  }
}));
```

### Peer B (Callee)

```javascript
ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'signal') {
    switch (msg.payload.signal_type) {
      case 'offer':
        // 1. Create peer connection
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
      
        // 2. Handle ICE candidates
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            ws.send(JSON.stringify({
              type: 'signal',
              to: msg.from,
              payload: {
                signal_type: 'candidate',
                candidate: event.candidate.toJSON()
              }
            }));
          }
        };
      
        // 3. Handle remote tracks
        pc.ontrack = (event) => {
          document.getElementById('remote-video').srcObject = event.streams[0];
        };
      
        // 4. Set remote description and create answer
        await pc.setRemoteDescription({
          type: 'offer',
          sdp: msg.payload.sdp
        });
      
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
      
        ws.send(JSON.stringify({
          type: 'signal',
          to: msg.from,
          payload: {
            signal_type: 'answer',
            sdp: answer.sdp
          }
        }));
        break;
      
      case 'answer':
        await pc.setRemoteDescription({
          type: 'answer',
          sdp: msg.payload.sdp
        });
        break;
      
      case 'candidate':
        await pc.addIceCandidate(msg.payload.candidate);
        break;
    }
  }
};
```

### Signaling with Alias

You can signal using a peer's alias instead of their fingerprint:

```javascript
ws.send(JSON.stringify({
  type: 'signal',
  to: 'brave-fox-42',  // alias works here
  payload: {
    signal_type: 'offer',
    sdp: offer.sdp
  }
}));
```

The server resolves the alias to the fingerprint automatically.

---

## Data Relay

Relay arbitrary application data through the server. Useful when WebRTC data channels are not yet established or for fallback.

```javascript
// send game state to specific peer
ws.send(JSON.stringify({
  type: 'relay',
  to: 'target-fingerprint',
  payload: {
    action: 'player_move',
    position: { x: 100, y: 200, z: 50 },
    timestamp: Date.now()
  }
}));
```

The target receives the message with `from` set to the sender's fingerprint:

```json
{
  "type": "relay",
  "from": "sender-fingerprint",
  "to": "target-fingerprint",
  "payload": {
    "action": "player_move",
    "position": { "x": 100, "y": 200, "z": 50 },
    "timestamp": 1707849600000
  },
  "ts": 1707849600001
}
```

**Requirements:**
- Both peers must share at least one namespace
- The `to` field is required
- You can use fingerprint or alias in the `to` field

---

## Broadcasting

Send a message to all peers in a namespace:

```javascript
ws.send(JSON.stringify({
  type: 'broadcast',
  payload: {
    namespace: 'game-lobby',
    data: {
      event: 'game_starting',
      map: 'dust2',
      countdown: 10
    }
  }
}));
```

**Rules:**
- You must be a member of the namespace
- You do NOT receive your own broadcast
- All other peers in the namespace receive it
- In multi-node setups, the broadcast is forwarded to all nodes via the broker

---

## Matchmaking

### Basic Match (1v1)

```javascript
ws.send(JSON.stringify({
  type: 'match',
  payload: {
    namespace: 'game-lobby',
    group_size: 2
  }
}));
```

If no one else is waiting, you get:
```json
{ "type": "match", "payload": { "status": "waiting" } }
```

When another peer requests a match with the same parameters, both receive:
```json
{
  "type": "matched",
  "namespace": "game-lobby",
  "payload": {
    "namespace": "game-lobby",
    "session_id": "a1b2c3d4...",
    "peers": [
      { "fingerprint": "peer1...", "alias": "brave-fox-42" },
      { "fingerprint": "peer2...", "alias": "calm-owl-07" }
    ]
  }
}
```

### Group Match (2v2, 4-player, etc.)

```javascript
ws.send(JSON.stringify({
  type: 'match',
  payload: {
    namespace: 'game-lobby',
    group_size: 4
  }
}));
```

The match triggers only when `group_size` peers are waiting with identical parameters.

### Criteria-Based Matching

Only peers with identical criteria match:

```javascript
// Player A — ranked US East
ws.send(JSON.stringify({
  type: 'match',
  payload: {
    namespace: 'game-lobby',
    group_size: 2,
    criteria: { mode: 'ranked', region: 'us-east' }
  }
}));

// Player B — ranked US East (matches Player A)
ws.send(JSON.stringify({
  type: 'match',
  payload: {
    namespace: 'game-lobby',
    group_size: 2,
    criteria: { mode: 'ranked', region: 'us-east' }
  }
}));

// Player C — casual EU West (does NOT match A or B)
ws.send(JSON.stringify({
  type: 'match',
  payload: {
    namespace: 'game-lobby',
    group_size: 2,
    criteria: { mode: 'casual', region: 'eu-west' }
  }
}));
```

### Post-Match Workflow

After receiving `matched`, the typical flow is:

1. All matched peers already share a namespace
2. Use the `session_id` to identify this match
3. One peer (e.g., first in the list) acts as the "host" and sends offers to all others
4. Establish WebRTC peer connections using signaling
5. Once data channels are open, communicate directly peer-to-peer

```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'matched') {
    const { peers, session_id } = msg.payload;
  
    // am I the first peer? (simple host selection)
    if (peers[0].fingerprint === myFingerprint) {
      // I'm the host — send offers to everyone else
      for (let i = 1; i < peers.length; i++) {
        createAndSendOffer(peers[i].fingerprint);
      }
    }
    // otherwise wait for incoming offers
  }
};
```

---

## Rooms

Rooms are private namespaces with an owner and a size limit.

### Creating a Room

```javascript
ws.send(JSON.stringify({
  type: 'create_room',
  payload: {
    room_id: 'private-match-abc',
    max_size: 8
  }
}));
```

Response:
```json
{
  "type": "room_created",
  "payload": {
    "room_id": "private-match-abc",
    "max_size": 8,
    "owner": "creator-fingerprint"
  }
}
```

The creator is automatically joined to the room.

### Joining a Room

```javascript
ws.send(JSON.stringify({
  type: 'join_room',
  payload: { room_id: 'private-match-abc' }
}));
```

You receive a peer list, and everyone else in the room gets `peer_joined`.

### Room Info

```javascript
ws.send(JSON.stringify({
  type: 'room_info',
  payload: { room_id: 'private-match-abc' }
}));
```

### Kicking a Player

Only the room owner can kick:

```javascript
ws.send(JSON.stringify({
  type: 'kick',
  payload: {
    room_id: 'private-match-abc',
    fingerprint: 'player-to-kick'
  }
}));
```

The kicked player receives a `kick` message. All other room members receive `peer_left`.

### Room Constraints

| Property | Value |
|----------|-------|
| Default max_size | 20 |
| Maximum max_size | 30 |
| Room ID uniqueness | Must be unique across the server |
| Auto-cleanup | Empty rooms are automatically deleted |
| Discovery | Room peers cannot be discovered via `discover` |

### Room vs Namespace

| Feature | Namespace | Room |
|---------|-----------|------|
| Size limit | 100,000 (configurable) | 30 max |
| Owner | No | Yes |
| Kick | No | Owner only |
| Discoverable | Yes | No |
| Auto-create | Yes (on first join) | No (explicit create) |
| Auto-delete | When empty (periodic) | When empty (immediate) |

---

## Metadata

Update your peer metadata at any time after registration:

```javascript
ws.send(JSON.stringify({
  type: 'metadata',
  payload: {
    meta: {
      status: 'in-game',
      current_map: 'dust2',
      kills: 15,
      deaths: 3
    }
  }
}));
```

Metadata is merged, not replaced. Sending `{ "kills": 16 }` updates only the `kills` field. Existing fields like `status` and `current_map` remain unchanged.

Other peers see your metadata when they:
- Receive `peer_joined` notifications
- Call `discover`
- Receive `peer_list` after joining
- Receive `matched` payloads

---

## Keepalive

The server sends WebSocket-level pings at the configured `ping_interval` (default 30s). If the client does not respond with a pong within `pong_wait` (default 35s), the connection is terminated.

You can also send application-level pings:

```javascript
// send ping
ws.send(JSON.stringify({ type: 'ping' }));

// receive pong
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'pong') {
    console.log('server alive');
  }
};
```

Recommended: send a ping every 30 seconds from the client side as well:

```javascript
const keepalive = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000);

ws.onclose = () => {
  clearInterval(keepalive);
};
```

---

## Error Handling

All errors follow the same format:

```json
{
  "type": "error",
  "payload": {
    "code": 403,
    "message": "no shared namespace"
  }
}
```

### Error Codes

| Code | Meaning | Common Causes |
|------|---------|---------------|
| 400 | Bad Request | Invalid JSON, missing required fields, unknown message type |
| 403 | Forbidden | Signaling without shared namespace, kicking without ownership, discovering room peers |
| 404 | Not Found | Room doesn't exist, peer not found |
| 409 | Conflict | Room ID already exists |
| 429 | Too Many Requests / Full | Rate limited, namespace full, room full |
| 503 | Service Unavailable | Server at max_peers capacity |

### Client-Side Error Handling

```javascript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'error') {
    const { code, message } = msg.payload;
  
    switch (code) {
      case 429:
        // rate limited — back off
        console.warn('Rate limited, slowing down...');
        break;
      case 503:
        // server full — try another server or retry later
        console.error('Server full, try again later');
        ws.close();
        setTimeout(reconnect, 5000);
        break;
      case 403:
        // permission denied
        console.error(`Forbidden: ${message}`);
        break;
      default:
        console.error(`Error ${code}: ${message}`);
    }
  }
};
```

### Connection Error Handling

```javascript
ws.onerror = (event) => {
  console.error('WebSocket error:', event);
};

ws.onclose = (event) => {
  console.log(`Connection closed: ${event.code} ${event.reason}`);

  // reconnect with exponential backoff
  let delay = 1000;
  const maxDelay = 30000;

  function reconnect() {
    const newWs = new WebSocket('ws://localhost:8080/ws');
    newWs.onopen = () => {
      delay = 1000; // reset on success
      // re-register with same public key to get same fingerprint
      newWs.send(JSON.stringify({
        type: 'register',
        payload: { public_key: myPublicKey }
      }));
    };
    newWs.onerror = () => {
      delay = Math.min(delay * 2, maxDelay);
      setTimeout(reconnect, delay);
    };
  }

  setTimeout(reconnect, delay);
};
```

---

## Multi-Node Setup

### When to Use Multi-Node

- More than 50,000 concurrent peers
- Geographic distribution (US, EU, Asia nodes)
- High availability requirements
- Zero-downtime deployments

### Setup with Redis

Node 1:
```bash
PEER_PORT=8080 PEER_BROKER=redis REDIS_ADDR=redis:6379 ./peer-server
```

Node 2:
```bash
PEER_PORT=8081 PEER_BROKER=redis REDIS_ADDR=redis:6379 ./peer-server
```

### Load Balancer (nginx)

```nginx
upstream peer_servers {
    # use ip_hash so the same client always hits the same node
    # (WebSocket connections are stateful)
    ip_hash;
    server node1:8080;
    server node2:8081;
    server node3:8082;
}

server {
    listen 443 ssl;
    server_name peer.example.com;

    ssl_certificate /etc/ssl/cert.pem;
    ssl_certificate_key /etc/ssl/key.pem;

    location /ws {
        proxy_pass http://peer_servers;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location /health {
        proxy_pass http://peer_servers;
    }

    location /stats {
        proxy_pass http://peer_servers;
    }
}
```

### What Crosses Nodes

| Operation | Cross-Node Support |
|-----------|-------------------|
| Signal routing | Yes — via Redis |
| Relay routing | Yes — via Redis |
| Broadcast | Yes — via Redis |
| Discover | No — local only |
| Matchmaking | No — local only |
| Rooms | No — local only |

For full cross-node matchmaking and discovery, put a shared Redis-backed service in front, or ensure your load balancer routes by namespace.

---

## Production Deployment

### Recommended Config

```json
{
  "host": "0.0.0.0",
  "port": 8080,
  "max_peers": 50000,
  "shard_count": 64,
  "write_timeout": "10s",
  "read_timeout": "60s",
  "ping_interval": "30s",
  "pong_wait": "35s",
  "max_message_size": 65536,
  "broker_type": "redis",
  "redis_addr": "redis:6379",
  "rate_limit_per_sec": 50,
  "rate_limit_burst": 100,
  "tls_cert": "/etc/ssl/cert.pem",
  "tls_key": "/etc/ssl/key.pem",
  "compression_enabled": false,
  "send_buffer_size": 64
}
```

### System Tuning (Linux)

```bash
# increase file descriptor limit
echo "* soft nofile 1000000" >> /etc/security/limits.conf
echo "* hard nofile 1000000" >> /etc/security/limits.conf

# increase TCP buffer sizes
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216"
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"

# increase connection tracking
sysctl -w net.netfilter.nf_conntrack_max=1000000

# increase local port range
sysctl -w net.ipv4.ip_local_port_range="1024 65535"

# enable TCP reuse
sysctl -w net.ipv4.tcp_tw_reuse=1
```

### Monitoring

```bash
# check peer count
curl -s http://localhost:8080/health | jq '.peers'

# check namespace breakdown
curl -s http://localhost:8080/stats | jq '.namespaces'

# watch in real time
watch -n 1 'curl -s http://localhost:8080/stats | jq .'
```

### Graceful Shutdown

The server handles `SIGINT` and `SIGTERM`:

```bash
kill -SIGTERM $(pidof peer-server)
```

On shutdown:
1. Stops accepting new connections
2. Closes all existing peer connections
3. Closes the broker connection
4. Exits cleanly

---

## Frequently Asked Questions

### Q1: If two peers are connected and then the server stops, will the peers keep working until the end of their connection or will it break when the server stops?

**It depends on what stage they are in.**

If the two peers have already completed WebRTC signaling through this server and established a direct peer-to-peer connection (data channel, video, audio), then **yes, their direct connection survives the server shutdown**. The relay server was only used to exchange SDP offers/answers and ICE candidates. Once WebRTC establishes a direct link, the signaling server is no longer involved. The peers talk directly to each other using STUN/TURN and the peer-to-peer connection will keep working until one of them disconnects.

However, their **WebSocket connection to this server will break immediately** on shutdown. This means:
- They will not be able to signal new peers
- They will not be able to discover new peers
- They will not receive `peer_joined` or `peer_left` notifications
- Broadcast and relay through the server will stop
- Matchmaking will stop

**Best practice:** Design your client to detect the WebSocket close, reconnect with the same public key when the server comes back, and re-join namespaces. The WebRTC connections established before the outage will continue working independently.

---

### Q2: What happens if a peer sends a message before registering?

The server rejects it. The first message on any WebSocket connection must be `type: "register"`. If any other message type is sent first, the server responds with an error and immediately closes the connection with WebSocket close code 1008 (Policy Violation). There is also a timeout — if no register message arrives within the `pong_wait` duration (default 35 seconds), the connection is closed.

---

### Q3: Can two different peers use the same public key?

Yes, but the second one **replaces** the first. When a new connection registers with a public key that maps to an existing fingerprint, the old connection is immediately terminated and the new connection takes over. This is by design — it handles reconnection scenarios where the old connection is stale. There is no duplicate fingerprint state.

---

### Q4: Is there a limit to how many namespaces a single peer can join?

There is no hard-coded limit. A peer can join as many namespaces as they want. However, each namespace membership adds memory overhead and generates `peer_joined`/`peer_left` notifications. In practice, joining more than 10-20 namespaces per peer is unusual and may impact performance if those namespaces are very active.

---

### Q5: What happens when the server reaches max_peers?

New connections that try to register receive a `503` error with the message "server full" and the WebSocket is closed with status code 1013 (Try Again Later). Existing connections are unaffected. The peer count decreases as peers disconnect, and new connections are accepted again once there is capacity.

---

### Q6: Can I use this server without WebRTC? Just for messaging?

Yes. The signal and relay message types can carry any JSON payload. You can use this server purely as a real-time messaging relay without ever establishing WebRTC connections. Use `relay` for point-to-point messages and `broadcast` for one-to-many messages.

---

### Q7: How does rate limiting work?

Each peer gets a token bucket rate limiter identified by their fingerprint. The bucket refills at `rate_limit_per_sec` tokens per second up to a maximum of `rate_limit_burst` tokens. Each message consumes one token. When tokens are exhausted, the peer receives a `429` error response. The connection is NOT closed — the peer can continue sending once tokens refill. Rate limiter state is automatically cleaned up when the peer disconnects or after 10 minutes of inactivity.

---

### Q8: Are messages guaranteed to be delivered in order?

Messages from a single sender to a single receiver are delivered in the order they are sent, because the server processes them sequentially in the read pump and delivers them sequentially through the send channel. However, if multiple senders are sending to the same receiver, the interleaving order depends on goroutine scheduling and is not guaranteed.

---

### Q9: What happens to matchmaking if a peer disconnects while waiting?

The peer is automatically removed from all matchmaking queues on disconnect. Their slot opens up and does not block other matches. If a peer was about to be matched but disconnects before the match completes, the remaining peers stay in the queue and wait for another peer to fill the group.

---

### Q10: Can I send binary data through the server?

No. All messages must be valid JSON text. The server only accepts WebSocket text frames. If you need to send binary data, encode it as base64 inside a JSON payload and decode it on the receiving end:

```javascript
ws.send(JSON.stringify({
  type: 'relay',
  to: 'target',
  payload: {
    data_type: 'binary',
    content: btoa(binaryData)  // base64 encode
  }
}));
```

---

### Q11: How do I handle reconnection gracefully?

Register with the same `public_key` on reconnect. You get the same fingerprint. Then re-join all namespaces you were in. The server automatically cleaned up your old state on disconnect, so you start fresh but with the same identity. Other peers see a `peer_left` followed by `peer_joined` — your client should handle this as a reconnection rather than a new peer.

```javascript
function reconnect() {
  const ws = new WebSocket('ws://localhost:8080/ws');
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'register',
      payload: { public_key: savedPublicKey }
    }));
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'registered') {
      // re-join all namespaces
      savedNamespaces.forEach(ns => {
        ws.send(JSON.stringify({
          type: 'join',
          payload: { namespace: ns }
        }));
      });
    }
  };
}
```

---

### Q12: What is the maximum message size?

Default is 65,536 bytes (64 KB) configurable via `max_message_size`. Messages exceeding this limit cause the WebSocket connection to be closed. For WebRTC signaling, this is more than sufficient — SDP offers are typically 2-5 KB. If you are relaying large payloads, increase this setting or chunk the data client-side.

---

### Q13: Does the server store any messages? Can I retrieve message history?

No. The server is purely a real-time relay. It does not persist any messages. If a peer is offline when a message is sent to them, the message is lost. For message persistence, use a separate database or message queue alongside this server.

---

### Q14: How does the sharded architecture work?

The hub maintains 64 independent shards, each with its own peer map and mutex lock. When a peer registers, their fingerprint (a hex-encoded SHA-256 hash) determines which shard they belong to. The first 4 hex characters are parsed as a 16-bit number, and the shard is selected by masking with `shard_count - 1`. This means concurrent operations on different peers rarely contend for the same lock, enabling high throughput under load.

---

### Q15: What is the difference between signal and relay?

Functionally they are almost identical — both route a message from one peer to another. The distinction is semantic:
- **signal** is intended for WebRTC signaling (offers, answers, ICE candidates)
- **relay** is intended for application data

Both require a shared namespace. Both support alias resolution. Both are forwarded across nodes via the broker. The server processes them through the same code path.

---

### Q16: Can I run the server behind a reverse proxy?

Yes. Use nginx, Caddy, HAProxy, or any proxy that supports WebSocket upgrade. Key requirements:
- Proxy must support HTTP upgrade to WebSocket
- Set `proxy_read_timeout` and `proxy_send_timeout` to a high value (86400 for 24 hours)
- Use `ip_hash` or sticky sessions if running multiple nodes
- Forward `X-Real-IP` header if you want client IP logging

---

### Q17: How does cross-node signaling work with Redis?

When Peer A on Node 1 sends a signal to Peer B on Node 2:
1. Node 1 checks its local shards for Peer B — not found
2. Node 1 publishes the message to Redis channel `peer:signal` with its `nodeID` stamped
3. Node 2 receives the message from Redis
4. Node 2 checks the `nodeID` — it's different from its own, so it processes the message
5. Node 2 finds Peer B in its local shards and delivers the message
6. Node 1 also receives its own message from Redis but skips it because the `nodeID` matches

---

### Q18: What happens if Redis goes down in a multi-node setup?

Local operations continue working normally. Peers on the same node can still signal, relay, broadcast, and match with each other. Cross-node operations fail silently — signals and relays to peers on other nodes are published to Redis but lost if Redis is down. There is no retry or queue. When Redis recovers, cross-node operations resume immediately.

---

### Q19: Can I use rooms and namespaces together?

Yes. A room IS a namespace with extra features (owner, size limit, kick, private discovery). When you create a room, you can also join regular namespaces. Peers in a room can signal peers in a regular namespace as long as they share at least one namespace with them. However, room peers cannot be found via `discover` — only regular namespace peers can.

---

### Q20: How do I implement a lobby system?

Typical pattern:

1. All players join a global namespace: `game:lobby`
2. Players use `discover` to see who is online
3. One player creates a room: `game:match:12345`
4. Player shares the room ID with friends (via relay or external means)
5. Friends join the room: `join_room`
6. Owner starts the match and kicks/closes as needed
7. Players establish WebRTC connections for actual gameplay
8. After the match, everyone leaves the room (room auto-deletes)

---

### Q21: Is there authentication? How do I secure the server?

The server does not have built-in authentication. The `public_key` in the register message is used only for fingerprint generation, not for cryptographic verification. For production:

- **TLS:** Enable `tls_cert` and `tls_key` to encrypt all traffic
- **Reverse proxy auth:** Put the server behind nginx and add JWT/token validation at the proxy layer
- **Origin checking:** The `InsecureSkipVerify: true` in WebSocket accept can be changed to validate origins
- **Rate limiting:** Built-in rate limiter prevents abuse
- **Max peers:** Limits resource exhaustion

For application-level auth, validate tokens in your client before establishing the WebSocket connection, or add a middleware layer.

---

### Q22: What happens to a peer's state when their network temporarily drops?

The server detects the drop via failed ping (within `ping_interval` + `pong_wait`, typically 65 seconds). Until detection:
- Messages sent to the peer buffer in the send channel (up to `send_buffer_size`)
- If the buffer fills, messages are dropped with `ErrBufferFull`
- Once the server detects the dead connection, it unregisters the peer and notifies namespaces

The peer should implement reconnection logic on their side. If they reconnect with the same public key within the detection window, the old connection is replaced cleanly.

---

### Q23: Can I broadcast to a subset of peers?

The broadcast message type supports an `exclude` field:

```javascript
ws.send(JSON.stringify({
  type: 'broadcast',
  payload: {
    namespace: 'game-lobby',
    data: { event: 'team_update' },
    exclude: ['fingerprint-to-skip-1', 'fingerprint-to-skip-2']
  }
}));
```

For more targeted messaging, use `relay` to send to specific peers individually, or organize peers into separate namespaces that represent groups.

---

### Q24: How much memory does each connection use?

Approximately 59 KB per connection with default settings, broken down as:
- WebSocket connection buffers: ~8 KB
- Send channel buffer (32 slots × ~512 bytes): ~16 KB
- Peer struct, namespace maps, metadata: ~3 KB
- Two goroutines (read pump + write pump): ~16 KB each
- Rate limiter bucket: ~200 bytes

With `compression_enabled: true`, add ~60 KB per connection for the compression context.

At 50,000 connections: ~3 GB RAM
At 100,000 connections: ~6 GB RAM

---

### Q25: Can peers communicate across different namespaces?

No. Signaling, relay, and broadcast all require a shared namespace. If Peer A is in `namespace-x` and Peer B is in `namespace-y`, they cannot send messages to each other through the server. This is a security boundary — it prevents random peers from messaging each other.

To allow cross-namespace communication, have both peers join a common namespace, even temporarily.

---

### Q26: What is the `session_id` in the matched payload?

It is a random 32-character hex string generated by the server to uniquely identify a match. All matched peers receive the same `session_id`. Use it to:
- Identify which match a subsequent signal or relay belongs to
- Create a room named after the session_id for the matched group
- Log and track matches server-side

The server does not use the session_id internally after sending it. It is purely for client-side coordination.

---

### Q27: How do I scale matchmaking across nodes?

The current matchmaker is local to each node. For cross-node matchmaking:

**Option 1: Sticky routing.** Route all match requests for a given namespace to the same node using consistent hashing at the load balancer level.

**Option 2: Shared queue.** Implement a Redis-backed matchmaker that replaces the local one. Peers on any node publish match requests to Redis, a single consumer matches them, and results are published back.

**Option 3: Dedicated match service.** Run a separate matchmaking service that receives match requests via API, forms matches, and notifies peers via the relay server.

---

### Q28: Can I send a message to a peer who is not in any namespace?

No, for signal and relay. Both require at least one shared namespace between sender and receiver. A registered peer who has not joined any namespace can only receive `error` messages and `pong` responses. They cannot be discovered, signaled, or relayed to.

Exception: the server can push system messages (errors, registration response) to any connected peer regardless of namespace membership.

---

### Q29: How do I monitor server performance in production?

Use the built-in endpoints:

```bash
# peer count and status
curl http://localhost:8080/health

# namespace breakdown
curl http://localhost:8080/stats
```

For detailed metrics, run benchmarks against your production config:

```bash
go test -bench=BenchmarkSignalThroughput -benchmem -benchtime=10s -run=^$ -v .
```

For profiling:

```bash
go test -bench=BenchmarkConcurrentSignaling -cpuprofile=cpu.prof -memprofile=mem.prof -run=^$ .
go tool pprof -http=:6060 cpu.prof
```

External monitoring: scrape `/health` with Prometheus, alert on peer count, track connection rate, and monitor Redis pub/sub lag for multi-node setups.

---

### Q30: What happens if the send buffer is full?

When a peer's send channel buffer is full (default 32 messages), new messages to that peer are dropped with `ErrBufferFull`. The sender is NOT notified — the drop is silent. This prevents a slow consumer from blocking the entire server.

Common causes:
- Peer has a slow network connection
- Peer is in a large namespace receiving many broadcasts
- Client code is not reading from the WebSocket fast enough

Solutions:
- Increase `send_buffer_size` (costs more memory per peer)
- Reduce broadcast frequency
- Ensure client reads WebSocket messages continuously without blocking

---

### Q31: Is the fingerprint private? Can other peers see it?

The fingerprint is visible to all peers in shared namespaces. It appears in:
- `peer_list` responses
- `peer_joined` notifications
- `matched` payloads
- `from` field of received signals and relays

It is a SHA-256 hash of the public key, so the original public key cannot be derived from it. Treat the fingerprint as a public identifier, similar to a username.
```