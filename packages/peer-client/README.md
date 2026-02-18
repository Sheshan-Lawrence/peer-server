# peer-client

Universal WebRTC peer-to-peer library with signaling, rooms, media, file transfer, state sync, CRDT, and end-to-end encryption. Framework-agnostic.

## Installation

```bash
pnpm install peer-client
```

## Quick Start

### Vanilla / Any Framework

```ts
import { PeerClient } from 'peer-client';

const client = new PeerClient({ url: 'wss://your-signal-server.com' });
await client.connect();

const peers = await client.join('my-namespace');
const peer = client.connectToPeer(peers[0].fingerprint);
peer.on('connected', () => peer.send({ hello: true }));
```

---

## Core API (Framework-Agnostic)

### PeerClient

Connection, signaling, namespace management, and matchmaking.

```ts
import { PeerClient } from 'peer-client';
```

#### Constructor

```ts
const client = new PeerClient({
  url: 'wss://signal.example.com',    // required
  alias: 'alice',                      // display name
  meta: { role: 'host' },             // arbitrary metadata
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  autoReconnect: true,                 // default: true
  reconnectDelay: 1000,                // default: 1000ms
  reconnectMaxDelay: 30000,            // default: 30000ms
  maxReconnectAttempts: 10,            // default: Infinity
  pingInterval: 25000,                 // default: 25000ms
  identityKeys: exportedKeys,          // optional, for persistent identity
});
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `connect()` | `Promise<void>` | Connect to signaling server |
| `disconnect()` | `void` | Disconnect from server |
| `join(namespace, appType?, version?)` | `Promise<PeerInfo[]>` | Join namespace, returns existing peers |
| `leave(namespace)` | `void` | Leave namespace |
| `discover(namespace, limit?)` | `Promise<PeerInfo[]>` | Discover peers without joining |
| `match(namespace, criteria?, groupSize?)` | `Promise<MatchResult>` | Matchmaking |
| `connectToPeer(fingerprint, alias?, channelConfig?)` | `Peer` | Establish direct P2P connection |
| `getPeer(fingerprint)` | `Peer \| undefined` | Get existing peer |
| `relay(to, payload)` | `void` | Send data via server relay |
| `broadcast(namespace, payload)` | `void` | Broadcast to all peers in namespace |
| `createRoom(roomId, config?)` | `Promise<RoomCreatedResult>` | Create a managed room |
| `joinRoom(roomId)` | `Promise<PeerInfo[]>` | Join existing room |
| `roomInfo(roomId)` | `Promise<RoomInfoResult>` | Get room metadata |
| `kick(roomId, fingerprint)` | `void` | Kick a peer from room |
| `getIdentity()` | `Identity` | Get identity instance |
| `getTransport()` | `Transport` | Get transport instance |

#### Properties

| Property | Type | Description |
|---|---|---|
| `fingerprint` | `string` | Unique identity fingerprint |
| `alias` | `string` | Display name |

#### Events

| Event | Callback | Description |
|---|---|---|
| `connected` | `()` | WebSocket connected |
| `disconnected` | `()` | WebSocket disconnected |
| `registered` | `(fingerprint, alias)` | Registered with server |
| `peer_joined` | `(PeerInfo)` | Peer joined namespace |
| `peer_left` | `(fingerprint)` | Peer left namespace |
| `peer_list` | `(PeerInfo[])` | Peer list received |
| `matched` | `(MatchResult)` | Matchmaking result |
| `relay` | `(from, payload)` | Relay message received |
| `broadcast` | `(from, namespace, payload)` | Broadcast received |
| `error` | `(Error)` | Error occurred |
| `reconnecting` | `(attempt)` | Reconnecting |
| `reconnected` | `()` | Reconnected |
| `room_created` | `(RoomCreatedResult)` | Room created |
| `room_closed` | `(roomId)` | Room closed |
| `kicked` | `(roomId)` | Kicked from room |

---

### Peer

Represents a direct P2P connection with another client.

```ts
const peer = client.connectToPeer('fp-bob', 'bob');
peer.on('connected', () => {
  peer.send({ hello: true });
  peer.send('binary-channel-data', 'my-channel');
  peer.sendBinary(buffer);
});
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `send(data, channel?)` | `void` | Send JSON or string data |
| `sendBinary(data, channel?)` | `void` | Send ArrayBuffer |
| `addStream(stream)` | `void` | Add media stream |
| `removeStream(stream)` | `void` | Remove media stream |
| `createDataChannel(config)` | `RTCDataChannel` | Create named data channel |
| `getChannel(label)` | `RTCDataChannel \| undefined` | Get channel by label |
| `getBufferedAmount(channel?)` | `number` | Buffered bytes |
| `restartIce()` | `void` | Restart ICE negotiation |
| `close()` | `void` | Close connection |

#### Properties

| Property | Type | Description |
|---|---|---|
| `fingerprint` | `string` | Remote peer fingerprint |
| `alias` | `string` | Remote peer alias |
| `connectionState` | `string` | ICE connection state |
| `channelLabels` | `string[]` | Open data channel labels |
| `closed` | `boolean` | Whether connection is closed |

#### Events

| Event | Callback | Description |
|---|---|---|
| `connected` | `()` | P2P connection established |
| `disconnected` | `(state)` | Connection lost |
| `data` | `(data, channel)` | Data received |
| `stream` | `(MediaStream)` | Media stream received |
| `track` | `(RTCTrackEvent)` | Track received |
| `datachannel:create` | `(RTCDataChannel)` | Channel created |
| `datachannel:open` | `(label)` | Channel opened |
| `datachannel:close` | `(label)` | Channel closed |
| `error` | `(Error)` | Error occurred |

---

### Rooms

Managed P2P groups with automatic connection and relay fallback.

```ts
import { DirectRoom, GroupRoom } from 'peer-client';
```

#### DirectRoom (1:1)

```ts
const room = new DirectRoom(client, 'room-123');
await room.create(); // or room.join()
room.on('data', (data, from) => {});
room.send({ msg: 'hi' });
room.close();
```

#### GroupRoom (N:N)

```ts
const room = new GroupRoom(client, 'team-room', 20);
await room.create(); // or room.join()
room.on('data', (data, from) => {});
room.on('peer_joined', (info) => {});
room.on('peer_left', (fingerprint) => {});
room.send({ msg: 'hello' });           // broadcast to all
room.send({ msg: 'dm' }, 'fp-bob');    // to specific peer
room.broadcastViaServer({ msg: 'announcement' });
room.kick('fp-bad-actor');
room.close();
```

#### Room Events

| Event | Callback | Description |
|---|---|---|
| `data` | `(data, from)` | Data received |
| `peer_joined` | `(PeerInfo)` | Peer joined room |
| `peer_left` | `(fingerprint)` | Peer left room |
| `closed` | `()` | Room closed |
| `error` | `(Error)` | Error occurred |

---

### Media

Audio/video calls with mute/unmute controls.

```ts
import { DirectMedia, GroupMedia } from 'peer-client';
```

#### DirectMedia (1:1 Call)

```ts
const call = new DirectMedia(client, 'call-room');
const localStream = await call.createAndJoin({ audio: true, video: true });
call.on('remote_stream', (stream, from) => { videoEl.srcObject = stream; });
call.muteAudio();
call.unmuteAudio();
call.muteVideo();
call.unmuteVideo();
call.close();
```

#### GroupMedia (Conference)

```ts
const conf = new GroupMedia(client, 'conf-room');
const { stream, peers } = await conf.joinAndStart({ audio: true, video: true });
conf.on('remote_stream', (stream, fingerprint) => {});
conf.on('remote_stream_removed', (fingerprint) => {});
conf.close();
```

#### Media Events

| Event | Callback | Description |
|---|---|---|
| `local_stream` | `(MediaStream)` | Local stream acquired |
| `remote_stream` | `(MediaStream, fingerprint)` | Remote stream received |
| `remote_stream_removed` | `(fingerprint)` | Remote stream removed |
| `error` | `(Error)` | Error occurred |

---

### FileTransfer

Stream files up to 4GB over P2P data channels with backpressure control. Never loads the full file into memory.

```ts
import { FileTransfer } from 'peer-client';

const ft = new FileTransfer(client);
```

#### Sending

```ts
const peer = client.connectToPeer('fp-receiver');
peer.on('connected', async () => {
  await ft.send(peer, file, 'report.pdf');
});

ft.on('progress', ({ id, percentage, bytesPerSecond }) => {});
```

#### Receiving

```ts
ft.handleIncoming(peer);

ft.on('incoming', (meta, from) => {
  ft.accept(meta.id);  // or ft.reject(meta.id)
});

ft.on('complete', (id, blob, meta, from) => {
  const url = URL.createObjectURL(blob);
});
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `send(peer, file, filename?)` | `Promise<void>` | Send file to peer |
| `handleIncoming(peer)` | `() => void` | Listen for incoming transfers, returns cleanup |
| `accept(id)` | `void` | Accept incoming transfer |
| `reject(id)` | `void` | Reject incoming transfer |
| `cancel(id)` | `void` | Cancel active transfer |
| `destroy()` | `void` | Clean up all listeners |

#### Events

| Event | Callback | Description |
|---|---|---|
| `incoming` | `(FileMetadata, from)` | Incoming transfer offer |
| `progress` | `(TransferProgress)` | Transfer progress update |
| `complete` | `(id, Blob, FileMetadata, from)` | Transfer completed |
| `cancelled` | `(id)` | Transfer cancelled |
| `error` | `(Error)` | Transfer error |

#### JSONTransfer & ImageTransfer

```ts
import { JSONTransfer, ImageTransfer } from 'peer-client';

const jt = new JSONTransfer(client);
jt.send(peer, { large: 'object' });
jt.on('data', (data, from) => {});

const it = new ImageTransfer(client);
await it.send(peer, imageBlob, 'photo.jpg');
it.on('complete', (id, blob) => {});
```

---

### StateSync

Distributed key-value state with Hybrid Logical Clocks (HLC) for consistent ordering.

```ts
import { StateSync } from 'peer-client';
```

#### Last-Writer-Wins

```ts
const sync = new StateSync(client, 'room-1', { mode: 'lww' });
sync.start();
sync.set('score', 100);
sync.get('score');       // 100
sync.getAll();           // { score: 100 }
sync.delete('score');
sync.destroy();
```

#### Operational (Custom Merge)

```ts
const sync = new StateSync(client, 'room-1', {
  mode: 'operational',
  merge: (local, remote) => [...new Set([...local, ...remote])],
});
sync.start();
sync.set('tags', ['a', 'b']);
sync.on('conflict', (key, local, remote, merged) => {});
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `start()` | `void` | Start sync listeners |
| `set(key, value)` | `void` | Set a key-value pair |
| `get(key)` | `any` | Get value by key |
| `getAll()` | `Record<string, any>` | Get all non-deleted entries |
| `delete(key)` | `void` | Tombstone delete |
| `destroy()` | `void` | Clean up |

#### Events

| Event | Callback | Description |
|---|---|---|
| `state_changed` | `(key, value, from)` | State changed locally or remotely |
| `conflict` | `(key, local, remote, merged)` | Merge conflict (operational mode) |
| `error` | `(Error)` | Error occurred |

---

### CRDTSync

Yjs CRDT integration for real-time collaborative editing.

```ts
import { CRDTSync } from 'peer-client';
import * as Y from 'yjs';

const crdt = new CRDTSync(client, 'collab-room', Y);
crdt.start();

const map = crdt.getMap('shared');
map.set('title', 'Hello');

const text = crdt.getText('doc');
text.insert(0, 'Hello world');

const arr = crdt.getArray('items');
arr.push(['item1']);

crdt.destroy();
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `start()` | `void` | Start CRDT sync |
| `getDoc()` | `Y.Doc` | Get Yjs document |
| `getMap(name?)` | `Y.Map` | Get shared map (default: `'shared'`) |
| `getText(name?)` | `Y.Text` | Get shared text (default: `'text'`) |
| `getArray(name?)` | `Y.Array` | Get shared array (default: `'array'`) |
| `destroy()` | `void` | Clean up |

---

### E2E Encryption

ECDH key exchange with identity-signed ephemeral keys.

```ts
import { GroupKeyManager, E2E } from 'peer-client';
```

#### GroupKeyManager (Recommended)

```ts
const km = new GroupKeyManager(client);
await km.init();

await km.exchangeWith(peer);

const encrypted = await km.encryptForPeer('fp-bob', { secret: true });
peer.send({ _encrypted: true, data: encrypted });

peer.on('data', async (msg) => {
  if (msg._encrypted) {
    const decrypted = await km.decryptFromPeer(peer.fingerprint, msg.data);
  }
});

km.destroy();
```

#### Methods

| Method | Returns | Description |
|---|---|---|
| `init()` | `Promise<void>` | Generate ephemeral key pair |
| `exchangeWith(peer)` | `Promise<void>` | Exchange keys with peer |
| `handleIncomingKeyExchange(peer, data)` | `Promise<void>` | Handle incoming exchange |
| `encryptForPeer(fingerprint, data)` | `Promise<string>` | Encrypt data for peer |
| `decryptFromPeer(fingerprint, data)` | `Promise<any>` | Decrypt data from peer |
| `getE2E()` | `E2E` | Get underlying E2E instance |
| `destroy()` | `void` | Clean up keys |

#### E2E (Low-Level)

```ts
const e2e = new E2E();
await e2e.init();
const pubKey = e2e.getPublicKeyB64();
await e2e.deriveKey('fp-bob', remotePubKeyB64);
const encrypted = await e2e.encrypt('fp-bob', 'secret');
const decrypted = await e2e.decrypt('fp-bob', encrypted);
e2e.hasKey('fp-bob');     // true
e2e.removeKey('fp-bob');
e2e.destroy();
```

---

### Identity

Persistent ECDSA identity for signing and fingerprinting.

```ts
import { Identity } from 'peer-client';

const id = new Identity();
await id.generate();
console.log(id.fingerprint);

const keys = await id.export();
localStorage.setItem('keys', JSON.stringify(keys));

const restored = new Identity();
await restored.restore(JSON.parse(localStorage.getItem('keys')!));

const client = new PeerClient({
  url: 'wss://signal.example.com',
  identityKeys: keys,
});
```

---

### Emitter

All peer-client classes extend `Emitter`:

```ts
const off = emitter.on('event', (...args) => {});   // returns cleanup function
emitter.once('event', (...args) => {});
emitter.off('event', handler);
emitter.emit('event', ...args);

import { setEmitterErrorHandler } from 'peer-client';
setEmitterErrorHandler((error, event) => {
  console.error(`Error in ${event}:`, error);
});
```

---

## Types

All types are exported from the main package:

```ts
import type {
  ClientConfig,
  PeerInfo,
  MatchResult,
  RoomConfig,
  RoomCreatedResult,
  RoomInfoResult,
  MediaConfig,
  DataChannelConfig,
  FileMetadata,
  TransferProgress,
  TransferState,
  SyncConfig,
  SyncMode,
  IdentityKeys,
  HLC,
} from 'peer-client';
```

### Key Types

```ts
interface PeerInfo {
  fingerprint: string;
  alias: string;
  meta?: Record<string, any>;
  app_type?: string;
}

interface MatchResult {
  namespace: string;
  session_id: string;
  peers: PeerInfo[];
}

interface FileMetadata {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  hash?: string;
}

interface IdentityKeys {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

type SyncMode = 'lww' | 'operational' | 'crdt';
```

---

## Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | **required** | WebSocket signaling server URL |
| `iceServers` | `RTCIceServer[]` | Google STUN | ICE/TURN servers |
| `alias` | `string` | `''` | Display name |
| `meta` | `Record<string, any>` | `{}` | Arbitrary metadata |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnectDelay` | `number` | `1000` | Initial reconnect delay (ms) |
| `reconnectMaxDelay` | `number` | `30000` | Max reconnect delay (ms) |
| `maxReconnectAttempts` | `number` | `Infinity` | Max reconnect attempts |
| `pingInterval` | `number` | `25000` | WebSocket keepalive interval (ms) |
| `identityKeys` | `IdentityKeys` | auto-generated | Pre-existing identity keys |

---

## Scripts

```bash
npm run build              # Compile TypeScript to dist/
npm test                   # Run unit tests
npm run test:watch         # Run tests in watch mode
npm run test:coverage      # Run tests with coverage
npm run test:integration   # Run integration tests against live server
```

## Publishing

```bash
npm login
npm pack --dry-run         # Verify package contents
npm publish                # Publish to npm
```

The `prepublishOnly` script automatically runs `tsc` before publish.

## Requirements

- Node.js >= 18
- A WebRTC signaling server compatible with the peer-client protocol

## License

MIT