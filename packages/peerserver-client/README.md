# peer-to-peer-client

Universal WebRTC peer-to-peer library with signaling, rooms, media, file transfer, state sync, CRDT, and end-to-end encryption. Framework-agnostic core with first-class React bindings.

## Installation

```bash
pnpm install peer-to-peer-client
```

For React hooks and components:

```bash
pnpm install peer-to-peer-client react
```

## Quick Start

### Vanilla / Any Framework

```ts
import { PeerClient } from 'peer-to-peer-client';

const client = new PeerClient({ url: 'wss://your-signal-server.com' });
await client.connect();

const peers = await client.join('my-namespace');
const peer = client.connectToPeer(peers[0].fingerprint);
peer.on('connected', () => peer.send({ hello: true }));
```

### React

```tsx
import { PeerProvider, useRoom } from 'peer-to-peer-client/react';

function App() {
  return (
    <PeerProvider config={{ url: 'wss://your-signal-server.com' }}>
      <Chat />
    </PeerProvider>
  );
}

function Chat() {
  const { joined, messages, send } = useRoom('chat-room', 'group');
  return (
    <div>
      {messages.map((m, i) => <p key={i}>{m.data}</p>)}
      <button onClick={() => send('hello')}>Send</button>
    </div>
  );
}
```

---

## Core API (Framework-Agnostic)

### PeerClient

Connection, signaling, namespace management, and matchmaking.

```ts
import { PeerClient } from 'peer-to-peer-client';
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
import { DirectRoom, GroupRoom } from 'peer-to-peer-client';
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
import { DirectMedia, GroupMedia } from 'peer-to-peer-client';
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
import { FileTransfer } from 'peer-to-peer-client';

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
import { JSONTransfer, ImageTransfer } from 'peer-to-peer-client';

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
import { StateSync } from 'peer-to-peer-client';
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
import { CRDTSync } from 'peer-to-peer-client';
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
import { GroupKeyManager, E2E } from 'peer-to-peer-client';
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
import { Identity } from 'peer-to-peer-client';

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

All peer-to-peer-client classes extend `Emitter`:

```ts
const off = emitter.on('event', (...args) => {});   // returns cleanup function
emitter.once('event', (...args) => {});
emitter.off('event', handler);
emitter.emit('event', ...args);

import { setEmitterErrorHandler } from 'peer-to-peer-client';
setEmitterErrorHandler((error, event) => {
  console.error(`Error in ${event}:`, error);
});
```

---

## React API

All hooks and components are exported from `peer-to-peer-client/react`. They require a `<PeerProvider>` ancestor.

```ts
import { PeerProvider, useRoom, useMedia, Video } from 'peer-to-peer-client/react';
```

---

### `<PeerProvider>`

Wraps your app with a PeerClient context. Connects on mount, disconnects on unmount.

```tsx
<PeerProvider config={{
  url: 'wss://signal.example.com',
  alias: 'alice',
  meta: { role: 'player' },
}}>
  <App />
</PeerProvider>
```

| Prop | Type | Description |
|---|---|---|
| `config` | `ClientConfig` | PeerClient configuration |
| `children` | `ReactNode` | Child components |

---

### `usePeerClient()`

Access the raw PeerClient and connection state.

```ts
const { client, connected, fingerprint, alias, error } = usePeerClient();
```

| Return | Type | Description |
|---|---|---|
| `client` | `PeerClient \| null` | Client instance |
| `connected` | `boolean` | WebSocket connected |
| `fingerprint` | `string` | Identity fingerprint |
| `alias` | `string` | Display name |
| `error` | `Error \| null` | Connection error |

---

### `usePeer(fingerprint)`

Track a specific peer's connection lifecycle.

```ts
const { peer, connectionState, send } = usePeer('fp-bob');
```

| Param | Type | Description |
|---|---|---|
| `fingerprint` | `string` | Remote peer fingerprint |

| Return | Type | Description |
|---|---|---|
| `peer` | `Peer \| null` | Peer instance |
| `connectionState` | `string` | `new` · `connected` · `disconnected` · `failed` · `closed` |
| `send` | `(data, channel?) => void` | Send data to peer |

---

### `useNamespace(namespace)`

Join a namespace on mount, leave on unmount. Tracks peer list reactively.

```ts
const { peers, joined, discover, error } = useNamespace('lobby');
```

| Param | Type | Description |
|---|---|---|
| `namespace` | `string` | Namespace to join |

| Return | Type | Description |
|---|---|---|
| `peers` | `PeerInfo[]` | Current peers in namespace |
| `joined` | `boolean` | Whether successfully joined |
| `discover` | `(limit?) => Promise<PeerInfo[]>` | Discover peers |
| `error` | `Error \| null` | Join error |

---

### `useRelay()`

Send and receive server-relayed messages.

```ts
const { messages, send, clear } = useRelay();
send('fp-bob', { msg: 'hi' });
```

| Return | Type | Description |
|---|---|---|
| `messages` | `RelayMessage[]` | Received messages `{ from, payload, ts }` |
| `send` | `(to, payload) => void` | Send relay message |
| `clear` | `() => void` | Clear message history |

---

### `useBroadcast(namespace)`

Send and receive namespace broadcasts.

```ts
const { messages, send, clear } = useBroadcast('lobby');
send({ announcement: 'hello all' });
```

| Param | Type | Description |
|---|---|---|
| `namespace` | `string` | Namespace to listen on |

| Return | Type | Description |
|---|---|---|
| `messages` | `BroadcastMessage[]` | Received messages `{ from, namespace, payload, ts }` |
| `send` | `(payload) => void` | Broadcast to namespace |
| `clear` | `() => void` | Clear message history |

---

### `useMatch()`

Matchmaking with reactive status tracking.

```ts
const { match, status, peers, sessionId, reset, error } = useMatch();
await match('game', { skill: 'beginner' }, 2);
```

| Return | Type | Description |
|---|---|---|
| `match` | `(namespace, meta?, count?) => Promise` | Start matchmaking |
| `status` | `'idle' \| 'matching' \| 'matched' \| 'error'` | Current status |
| `peers` | `PeerInfo[]` | Matched peers |
| `sessionId` | `string` | Match session ID |
| `reset` | `() => void` | Reset to idle |
| `error` | `Error \| null` | Match error |

---

### `useRoom(roomId, type?, create?, maxSize?)`

Join or create a room on mount, leave on unmount. Tracks peers and messages.

```ts
const { joined, peers, messages, send, clearMessages, error, room } = useRoom('room-1', 'group');
```

| Param | Type | Default | Description |
|---|---|---|---|
| `roomId` | `string` | — | Room identifier |
| `type` | `'direct' \| 'group'` | `'direct'` | Room type |
| `create` | `boolean` | `false` | Create vs join |
| `maxSize` | `number` | `20` | Max peers (group only) |

| Return | Type | Description |
|---|---|---|
| `joined` | `boolean` | Successfully joined |
| `peers` | `PeerInfo[]` | Current room peers |
| `messages` | `RoomMessage[]` | Received messages `{ data, from, ts }` |
| `send` | `(data, to?) => void` | Send to all or specific peer |
| `clearMessages` | `() => void` | Clear message history |
| `error` | `Error \| null` | Room error |
| `room` | `DirectRoom \| GroupRoom \| null` | Room instance |

---

### `useMedia(roomId, type?, create?, audio?, video?)`

Audio/video calls with mute controls.

```ts
const {
  localStream, remoteStreams,
  audioMuted, videoMuted,
  muteAudio, unmuteAudio, muteVideo, unmuteVideo,
  toggleAudio, toggleVideo,
  error,
} = useMedia('call-room', 'group', false, true, true);
```

| Param | Type | Default | Description |
|---|---|---|---|
| `roomId` | `string` | — | Room identifier |
| `type` | `'direct' \| 'group'` | `'direct'` | Call type |
| `create` | `boolean` | `false` | Create vs join |
| `audio` | `boolean` | `true` | Enable audio |
| `video` | `boolean` | `true` | Enable video |

| Return | Type | Description |
|---|---|---|
| `localStream` | `MediaStream \| null` | Local media stream |
| `remoteStreams` | `Map<string, MediaStream>` | Remote streams by fingerprint |
| `audioMuted` | `boolean` | Audio muted |
| `videoMuted` | `boolean` | Video muted |
| `muteAudio` | `() => void` | Mute audio |
| `unmuteAudio` | `() => void` | Unmute audio |
| `muteVideo` | `() => void` | Mute video |
| `unmuteVideo` | `() => void` | Unmute video |
| `toggleAudio` | `() => void` | Toggle audio |
| `toggleVideo` | `() => void` | Toggle video |
| `error` | `Error \| null` | Media error |

---

### `useFileTransfer()`

File transfer with reactive transfer state.

```ts
const { transfers, send, accept, reject, cancel, listenToPeer, clearCompleted } = useFileTransfer();

const id = await send(peer, file, 'report.pdf');

listenToPeer(peer);
accept(transferId);
reject(transferId);
cancel(transferId);
```

| Return | Type | Description |
|---|---|---|
| `transfers` | `Map<string, Transfer>` | All active/completed transfers |
| `send` | `(peer, file, filename?) => Promise<string>` | Send file, returns transfer ID |
| `accept` | `(id) => void` | Accept incoming transfer |
| `reject` | `(id) => void` | Reject incoming transfer |
| `cancel` | `(id) => void` | Cancel active transfer |
| `listenToPeer` | `(peer) => () => void` | Listen for incoming, returns cleanup |
| `clearCompleted` | `() => void` | Remove completed/cancelled/errored transfers |

#### Transfer Object

```ts
interface Transfer {
  id: string;
  filename: string;
  size: number;
  direction: 'send' | 'receive';
  from?: string;
  progress: number;          // 0-100
  bytesPerSecond: number;
  status: 'pending' | 'active' | 'complete' | 'cancelled' | 'error';
  blob?: Blob;               // available on complete
  meta?: FileMetadata;
}
```

---

### `useSync(roomId, mode?, merge?)`

Distributed state sync with reactive state object.

```ts
const { state, set, delete: del, get, error } = useSync('room-1', 'lww');

set('score', 100);
del('oldKey');
get('score');    // 100
state;           // { score: 100 }
```

| Param | Type | Default | Description |
|---|---|---|---|
| `roomId` | `string` | — | Room to sync in |
| `mode` | `'lww' \| 'operational' \| 'crdt'` | `'lww'` | Sync mode |
| `merge` | `(local, remote) => any` | — | Custom merge (operational mode) |

| Return | Type | Description |
|---|---|---|
| `state` | `Record<string, any>` | Current state object |
| `set` | `(key, value) => void` | Set key-value |
| `delete` | `(key) => void` | Delete key |
| `get` | `(key) => any` | Get value |
| `error` | `Error \| null` | Sync error |

---

### `useE2E()`

End-to-end encryption with key exchange tracking.

```ts
const { ready, exchangedPeers, exchange, handleIncoming, encrypt, decrypt, hasKey, error } = useE2E();

await exchange(peer);
const encrypted = await encrypt('fp-bob', { secret: true });
const decrypted = await decrypt('fp-bob', encrypted);
```

| Return | Type | Description |
|---|---|---|
| `ready` | `boolean` | Keys generated |
| `exchangedPeers` | `Set<string>` | Fingerprints with established keys |
| `exchange` | `(peer) => Promise<void>` | Exchange keys with peer |
| `handleIncoming` | `(peer, data) => Promise<void>` | Handle incoming exchange |
| `encrypt` | `(fingerprint, data) => Promise<string>` | Encrypt for peer |
| `decrypt` | `(fingerprint, data) => Promise<any>` | Decrypt from peer |
| `hasKey` | `(fingerprint) => boolean` | Check if key exists |
| `error` | `Error \| null` | E2E error |

---

### `useIdentity(persistKey?)`

Persistent identity with localStorage.

```ts
const { ready, fingerprint, exportKeys, regenerate, clear, error } = useIdentity();
```

| Param | Type | Default | Description |
|---|---|---|---|
| `persistKey` | `string` | `'peer-to-peer-client_identity'` | localStorage key |

| Return | Type | Description |
|---|---|---|
| `ready` | `boolean` | Keys loaded |
| `fingerprint` | `string` | Identity fingerprint |
| `exportKeys` | `() => Promise<IdentityKeys>` | Export key material |
| `regenerate` | `() => Promise<void>` | Generate new identity |
| `clear` | `() => void` | Remove from localStorage |
| `error` | `Error \| null` | Identity error |

---

### `useCRDT(roomId, Y)`

Yjs CRDT integration.

```ts
import * as Y from 'yjs';

const { ready, getDoc, getMap, getText, getArray, error } = useCRDT('collab', Y);

const map = getMap('shared');
map.set('title', 'Hello');
```

| Param | Type | Description |
|---|---|---|
| `roomId` | `string` | Room to sync in |
| `Y` | `typeof import('yjs')` | Yjs module reference |

| Return | Type | Description |
|---|---|---|
| `ready` | `boolean` | CRDT initialized |
| `getDoc` | `() => Y.Doc` | Get Yjs document |
| `getMap` | `(name) => Y.Map` | Get shared map |
| `getText` | `(name) => Y.Text` | Get shared text |
| `getArray` | `(name) => Y.Array` | Get shared array |
| `error` | `Error \| null` | CRDT error |

---

## React Components

### `<Video>`

Attaches a `MediaStream` to a `<video>` element with autoplay handling.

```tsx
import { Video } from 'peer-to-peer-client/react';

<Video stream={localStream} muted />
<Video stream={remoteStream} />
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `stream` | `MediaStream \| null` | — | Media stream to display |
| `muted` | `boolean` | `false` | Mute audio |
| `...props` | `VideoHTMLAttributes` | — | Passed to `<video>` |

### `<Audio>`

Attaches a `MediaStream` to an `<audio>` element.

```tsx
import { Audio } from 'peer-to-peer-client/react';

<Audio stream={remoteStream} />
```

| Prop | Type | Description |
|---|---|---|
| `stream` | `MediaStream \| null` | Media stream |
| `...props` | `AudioHTMLAttributes` | Passed to `<audio>` |

### `<TransferProgress>`

Renders file transfer state with progress, speed, and action buttons.

```tsx
import { TransferProgress } from 'peer-to-peer-client/react';

<TransferProgress
  transfer={transfer}
  onAccept={() => accept(transfer.id)}
  onReject={() => reject(transfer.id)}
  onCancel={() => cancel(transfer.id)}
  className="my-transfer"
/>
```

Uses `data-*` attributes for styling: `data-status`, `data-direction`, `data-part`, `data-action`.

| Prop | Type | Description |
|---|---|---|
| `transfer` | `Transfer` | Transfer object from `useFileTransfer` |
| `onAccept` | `() => void` | Accept handler (shown when `status === 'pending'`) |
| `onReject` | `() => void` | Reject handler |
| `onCancel` | `() => void` | Cancel handler (shown when `status === 'active'`) |
| `className` | `string` | CSS class |

### `<PeerStatus>`

Connection status indicator dot.

```tsx
import { PeerStatus } from 'peer-to-peer-client/react';

<PeerStatus state={connectionState} />
<PeerStatus state="connected" label="Online" />
```

| Prop | Type | Description |
|---|---|---|
| `state` | `string` | `connected` · `connecting` · `disconnected` · `failed` · `closed` · `new` |
| `label` | `string` | Override label (defaults to state name) |
| `className` | `string` | CSS class |

Colors: `connected` green · `connecting` yellow · `disconnected`/`failed` red · `closed`/`new` gray

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
} from 'peer-to-peer-client';
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
npm run test:react         # Run React hook/component tests (72 tests)
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
- React >= 18 (optional, for `peer-to-peer-client/react`)
- A WebRTC signaling server compatible with the peer-to-peer-client protocol

## License

MIT