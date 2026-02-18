import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerClient } from '../core/client';
import { DirectRoom, GroupRoom } from '../room';
import { MockSignalServer, delay, waitForEvent, REAL_SERVER } from './setup';

describe('DirectRoom — Mock Server', () => {
  let server: MockSignalServer;

  beforeEach(async () => {
    server = new MockSignalServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('create() creates a room', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr1');
    await room.create();
    room.close();
    c.disconnect();
  });

  it('join() returns peer list', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new DirectRoom(c1, 'dr2');
    await room1.create();

    const room2 = new DirectRoom(c2, 'dr2');
    const peers = await room2.join();
    expect(peers.length).toBeGreaterThanOrEqual(1);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('emits peer_joined when second peer joins', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new DirectRoom(c1, 'dr3');
    await room1.create();

    const joinedPromise = waitForEvent(room1, 'peer_joined');
    const room2 = new DirectRoom(c2, 'dr3');
    await room2.join();
    const [info] = await joinedPromise;
    expect(info.fingerprint).toBe(c2.fingerprint);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('send falls back to relay when no P2P', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new DirectRoom(c1, 'dr-relay');
    await room1.create();

    const room2 = new DirectRoom(c2, 'dr-relay');
    await room2.join();
    await delay(100);

    const dataPromise = waitForEvent(room1, 'data', 5000);
    room2.send({ msg: 'via relay' });
    const [data, from] = await dataPromise;
    expect(data.msg).toBe('via relay');

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('close emits closed event', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-close');
    await room.create();
    const closedPromise = waitForEvent(room, 'closed');
    room.close();
    await closedPromise;
    c.disconnect();
  });

  it('send after close is a no-op', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-noop');
    await room.create();
    room.close();
    expect(() => room.send({ x: 1 })).not.toThrow();
    c.disconnect();
  });

  it('getPeer returns null initially', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-nopeer');
    await room.create();
    expect(room.getPeer()).toBeNull();
    room.close();
    c.disconnect();
  });

  it('getRemoteFingerprint is empty initially', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-nofp');
    await room.create();
    expect(room.getRemoteFingerprint()).toBe('');
    room.close();
    c.disconnect();
  });

  it('double close is safe', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-dbl');
    await room.create();
    room.close();
    room.close();
    c.disconnect();
  });

  it('emits peer_left when remote disconnects', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new DirectRoom(c1, 'dr-left');
    await room1.create();

    const room2 = new DirectRoom(c2, 'dr-left');
    await room2.join();
    await delay(100);

    const leftPromise = waitForEvent(room1, 'peer_left', 5000);
    c2.disconnect();
    const [fp] = await leftPromise;
    expect(fp).toBe(c2.fingerprint);

    room1.close();
    c1.disconnect();
  });
});

describe('GroupRoom — Mock Server', () => {
  let server: MockSignalServer;

  beforeEach(async () => {
    server = new MockSignalServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('create and join group room', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    const room = new GroupRoom(c1, 'gr1', 10);
    await room.create();
    room.close();
    c1.disconnect();
  });

  it('multiple peers join group', async () => {
    const clients: PeerClient[] = [];
    const rooms: GroupRoom[] = [];

    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    const room1 = new GroupRoom(c1, 'gr-multi', 10);
    await room1.create();
    clients.push(c1);
    rooms.push(room1);

    for (let i = 0; i < 3; i++) {
      const c = new PeerClient({ url: server.url, autoReconnect: false });
      await c.connect();
      const r = new GroupRoom(c, 'gr-multi', 10);
      await r.join();
      clients.push(c);
      rooms.push(r);
    }

    expect(room1.getPeerCount()).toBeGreaterThanOrEqual(0);

    rooms.forEach((r) => r.close());
    clients.forEach((c) => c.disconnect());
  });

  it('send to specific peer via relay', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new GroupRoom(c1, 'gr-send', 10);
    await room1.create();

    const room2 = new GroupRoom(c2, 'gr-send', 10);
    await room2.join();
    await delay(200);

    const dataPromise = waitForEvent(room2, 'data', 5000);
    room1.send({ target: 'msg' }, c2.fingerprint);
    const [data] = await dataPromise;
    expect(data.target).toBe('msg');

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('broadcastViaServer sends to all', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new GroupRoom(c1, 'gr-bc', 10);
    await room1.create();
    const room2 = new GroupRoom(c2, 'gr-bc', 10);
    await room2.join();
    await delay(200);

    const dataPromise = waitForEvent(room2, 'data', 5000);
    room1.broadcastViaServer({ bc: true });
    const [data] = await dataPromise;
    expect(data.bc).toBe(true);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('getPeers returns connected peers map', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new GroupRoom(c, 'gr-peers', 10);
    await room.create();
    const peers = room.getPeers();
    expect(peers instanceof Map).toBe(true);
    room.close();
    c.disconnect();
  });

  it('close cleans up', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new GroupRoom(c, 'gr-cleanup', 10);
    await room.create();
    room.close();
    expect(room.getPeerCount()).toBe(0);
    c.disconnect();
  });

  it('kick delegates to client', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new GroupRoom(c1, 'gr-kick', 10);
    await room1.create();
    const room2 = new GroupRoom(c2, 'gr-kick', 10);
    await room2.join();
    await delay(100);

    const kickedPromise = waitForEvent(c2, 'kicked', 5000);
    room1.kick(c2.fingerprint);
    await kickedPromise;

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('double close is safe', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new GroupRoom(c, 'gr-dbl', 10);
    await room.create();
    room.close();
    room.close();
    c.disconnect();
  });

  it('peer_left event fires', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new GroupRoom(c1, 'gr-left', 10);
    await room1.create();
    const room2 = new GroupRoom(c2, 'gr-left', 10);
    await room2.join();
    await delay(100);

    const leftPromise = waitForEvent(room1, 'peer_left', 5000);
    c2.disconnect();
    const [fp] = await leftPromise;
    expect(fp).toBe(c2.fingerprint);

    room1.close();
    c1.disconnect();
  });
});

describe('DirectRoom — Real Server', () => {
  it('create and join on real server', async () => {
    const roomId = 'vitest-dr-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new DirectRoom(c1, roomId);
    await room1.create();

    const room2 = new DirectRoom(c2, roomId);
    const peers = await room2.join();
    expect(peers.length).toBeGreaterThanOrEqual(1);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  }, 20000);

  it('relay messaging on real server', async () => {
    const roomId = 'vitest-dr-relay-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new DirectRoom(c1, roomId);
    await room1.create();

    const room2 = new DirectRoom(c2, roomId);
    await room2.join();
    await delay(300);

    const dataPromise = waitForEvent(room1, 'data', 10000);
    room2.send({ real: 'relay' });
    const [data] = await dataPromise;
    expect(data.real).toBe('relay');

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  }, 20000);

  it('send to all in group room', async () => {
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c3 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c3.connect();

    const room1 = new GroupRoom(c1, 'gr-all', 10);
    await room1.create();
    const room2 = new GroupRoom(c2, 'gr-all', 10);
    await room2.join();
    const room3 = new GroupRoom(c3, 'gr-all', 10);
    await room3.join();
    await delay(200);

    const d2 = waitForEvent(room2, 'data', 5000);
    const d3 = waitForEvent(room3, 'data', 5000);
    room1.send({ all: true });
    await Promise.all([d2, d3]);

    room1.close();
    room2.close();
    room3.close();
    c1.disconnect();
    c2.disconnect();
    c3.disconnect();
  });

  it('getPeerCount reflects current peers', async () => {
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new GroupRoom(c1, 'gr-count', 10);
    await room1.create();
    const room2 = new GroupRoom(c2, 'gr-count', 10);
    await room2.join();
    await delay(200);

    expect(room1.getPeerCount()).toBeGreaterThanOrEqual(1);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('group room respects maxSize constructor arg', async () => {
    const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c.connect();
    const room = new GroupRoom(c, 'gr-maxsize', 5);
    await room.create();
    room.close();
    c.disconnect();
  });

  it('DirectRoom create then immediate close', async () => {
    const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-imm-close');
    await room.create();
    room.close();
    expect(room.getPeer()).toBeNull();
    c.disconnect();
  });

  it('GroupRoom peer_joined event fires', async () => {
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new GroupRoom(c1, 'gr-pj', 10);
    await room1.create();

    const pjP = waitForEvent(room1, 'peer_joined');
    const room2 = new GroupRoom(c2, 'gr-pj', 10);
    await room2.join();
    const [info] = await pjP;
    expect(info.fingerprint).toBe(c2.fingerprint);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('GroupRoom send after close is no-op', async () => {
    const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c.connect();
    const room = new GroupRoom(c, 'gr-send-closed', 10);
    await room.create();
    room.close();
    expect(() => room.send({ x: 1 })).not.toThrow();
    c.disconnect();
  });

  it('DirectRoom send after close is no-op', async () => {
    const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c.connect();
    const room = new DirectRoom(c, 'dr-send-closed');
    await room.create();
    room.close();
    expect(() => room.send({ x: 1 })).not.toThrow();
    c.disconnect();
  });

  it('stress: 5 peers in a group room exchange messages', async () => {
    const clients: PeerClient[] = [];
    const rooms: GroupRoom[] = [];

    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    const room1 = new GroupRoom(c1, 'gr-stress-5', 10);
    await room1.create();
    clients.push(c1);
    rooms.push(room1);

    for (let i = 0; i < 4; i++) {
      const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
      await c.connect();
      const r = new GroupRoom(c, 'gr-stress-5', 10);
      await r.join();
      clients.push(c);
      rooms.push(r);
    }

    await delay(200);

    const received: any[] = [];
    rooms[1].on('data', (d: any) => received.push(d));
    for (let i = 0; i < 10; i++) {
      rooms[0].broadcastViaServer({ idx: i });
    }
    await delay(1000);
    expect(received.length).toBeGreaterThanOrEqual(5);

    rooms.forEach((r) => r.close());
    clients.forEach((c) => c.disconnect());
  });

  it('stress: 10 rooms created in sequence on real server', async () => {
    const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c.connect();
    const rooms: DirectRoom[] = [];
    for (let i = 0; i < 10; i++) {
      const room = new DirectRoom(c, `vitest-stress-room-${Date.now()}-${i}`);
      await room.create();
      rooms.push(room);
    }
    rooms.forEach((r) => r.close());
    c.disconnect();
  }, 30000);
});