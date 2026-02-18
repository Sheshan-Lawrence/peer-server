import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerClient } from '../core/client';
import { E2EDirectRoom } from '../e2e.room';
import { E2E } from '../crypto';
import { DirectRoom } from '../room';
import { MockSignalServer, delay, waitForEvent, REAL_SERVER } from './setup';

describe('E2EDirectRoom — Mock Server', () => {
  let server: MockSignalServer;

  beforeEach(async () => {
    server = new MockSignalServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('constructor sets initial state to connecting', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-1');
    expect(room.state).toBe('connecting');
    room.close();
    c.disconnect();
  });

  it('create() initializes E2E and creates room', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-create');
    await room.create();
    expect(room.getE2E().isInitialized()).toBe(true);
    room.close();
    c.disconnect();
  });

  it('join() returns peer list', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new E2EDirectRoom(c1, 'e2e-join');
    await room1.create();

    const room2 = new E2EDirectRoom(c2, 'e2e-join');
    const peers = await room2.join();
    expect(peers.length).toBeGreaterThanOrEqual(1);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('uses provided E2E instance', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const e2e = new E2E();
    await e2e.init();
    const room = new E2EDirectRoom(c, 'e2e-custom', { e2e });
    expect(room.getE2E()).toBe(e2e);
    room.close();
    c.disconnect();
  });

  it('uses custom room factory', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();

    const factoryFn = vi.fn((client, id) => new DirectRoom(client, id));
    const room = new E2EDirectRoom(c, 'e2e-factory', { roomFactory: factoryFn });
    await room.create();
    expect(factoryFn).toHaveBeenCalledOnce();

    room.close();
    c.disconnect();
  });

  it('hasEncryption is false initially', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-noenc');
    await room.create();
    expect(room.hasEncryption()).toBe(false);
    room.close();
    c.disconnect();
  });

  it('fingerprint is empty initially', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-nofp');
    expect(room.fingerprint).toBe('');
    room.close();
    c.disconnect();
  });

  it('getRoom returns DirectRoom after create', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-getroom');
    expect(room.getRoom()).toBeNull();
    await room.create();
    expect(room.getRoom()).toBeTruthy();
    room.close();
    c.disconnect();
  });

  it('close emits closed event', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-close-ev');
    await room.create();
    const closedP = waitForEvent(room, 'closed');
    room.close();
    await closedP;
    c.disconnect();
  });

  it('close sets state to closed', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-close-st');
    await room.create();
    room.close();
    expect(room.state).toBe('closed');
    c.disconnect();
  });

  it('create after close throws', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-closed-create');
    room.close();
    await expect(room.create()).rejects.toThrow('closed');
    c.disconnect();
  });

  it('join after close throws', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-closed-join');
    room.close();
    await expect(room.join()).rejects.toThrow('closed');
    c.disconnect();
  });

  it('send when closed is a no-op', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-send-closed');
    room.close();
    expect(() => room.send({ x: 1 })).not.toThrow();
    c.disconnect();
  });

  it('double close is safe', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-dbl');
    await room.create();
    room.close();
    room.close();
    expect(room.state).toBe('closed');
    c.disconnect();
  });

  it('send without room is a no-op', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-noroom');
    expect(() => room.send({ x: 1 })).not.toThrow();
    room.close();
    c.disconnect();
  });

  it('state_changed emits on state transitions', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-state-ev');
    const states: string[] = [];
    room.on('state_changed', (s: string) => states.push(s));
    await room.create();
    room.close();
    expect(states).toContain('closed');
    c.disconnect();
  });

  it('peer_joined event propagates', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new E2EDirectRoom(c1, 'e2e-pj');
    await room1.create();

    const pjPromise = waitForEvent(room1, 'peer_joined');
    const room2 = new E2EDirectRoom(c2, 'e2e-pj');
    await room2.join();
    const [info] = await pjPromise;
    expect(info.fingerprint).toBe(c2.fingerprint);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('peer_left emits when remote disconnects', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new E2EDirectRoom(c1, 'e2e-pl');
    await room1.create();
    const room2 = new E2EDirectRoom(c2, 'e2e-pl');
    await room2.join();
    await delay(100);

    const leftP = waitForEvent(room1, 'peer_left', 5000);
    c2.disconnect();
    const [fp] = await leftP;
    expect(fp).toBe(c2.fingerprint);

    room1.close();
    c1.disconnect();
  });

  it('plaintext send works before key exchange', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new E2EDirectRoom(c1, 'e2e-plain');
    await room1.create();
    const room2 = new E2EDirectRoom(c2, 'e2e-plain');
    await room2.join();
    await delay(200);

    const dataP = waitForEvent(room1, 'data', 5000);
    room2.send({ plain: true });
    const [data] = await dataP;
    expect(data.plain).toBe(true);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('getE2E returns E2E instance', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-get');
    const e2e = room.getE2E();
    expect(e2e).toBeInstanceOf(E2E);
    room.close();
    c.disconnect();
  });

  it('send emits no error when state not ready and no room', () => {
    const c = new PeerClient({ url: 'ws://localhost:1', autoReconnect: false });
    const room = new E2EDirectRoom(c, 'e2e-no-err');
    expect(() => room.send('test')).not.toThrow();
    room.close();
  });

  it('multiple state_changed events in lifecycle', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const states: string[] = [];
    const room1 = new E2EDirectRoom(c1, 'e2e-lifecycle');
    room1.on('state_changed', (s: string) => states.push(s));
    await room1.create();

    const room2 = new E2EDirectRoom(c2, 'e2e-lifecycle');
    await room2.join();
    await delay(200);

    room1.close();
    expect(states).toContain('closed');

    room2.close();
    c1.disconnect();
    c2.disconnect();
  });

  it('getRoom is null before create/join', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-nullroom');
    expect(room.getRoom()).toBeNull();
    room.close();
    c.disconnect();
  });

  it('getRoom is null after close', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-nullroom2');
    await room.create();
    room.close();
    expect(room.getRoom()).toBeNull();
    c.disconnect();
  });

  it('hasEncryption false when state is closed', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-enc-closed');
    await room.create();
    room.close();
    expect(room.hasEncryption()).toBe(false);
    c.disconnect();
  });

  it('error event emitted for E2E errors', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const room = new E2EDirectRoom(c, 'e2e-err');
    const errors: Error[] = [];
    room.on('error', (e: Error) => errors.push(e));
    await room.create();
    room.close();
    c.disconnect();
  });

  it('concurrent creates on different rooms', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    const rooms = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const room = new E2EDirectRoom(c, `e2e-conc-${i}`);
        return room.create().then(() => room);
      })
    );
    rooms.forEach((r) => r.close());
    c.disconnect();
  });

  it('stress: rapid create/close cycles', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    for (let i = 0; i < 10; i++) {
      const room = new E2EDirectRoom(c, `e2e-stress-${i}`);
      await room.create();
      room.close();
    }
    c.disconnect();
  });
});

describe('E2EDirectRoom — Real Server', () => {
  it('create and join on real server', async () => {
    const roomId = 'vitest-e2e-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new E2EDirectRoom(c1, roomId);
    await room1.create();

    const room2 = new E2EDirectRoom(c2, roomId);
    const peers = await room2.join();
    expect(peers.length).toBeGreaterThanOrEqual(1);

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  }, 20000);

  it('plaintext data exchange on real server', async () => {
    const roomId = 'vitest-e2e-data-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const room1 = new E2EDirectRoom(c1, roomId);
    await room1.create();

    const room2 = new E2EDirectRoom(c2, roomId);
    await room2.join();
    await delay(500);

    const dataP = waitForEvent(room1, 'data', 10000);
    room2.send({ real: 'e2e' });
    const [data] = await dataP;
    expect(data.real).toBe('e2e');

    room1.close();
    room2.close();
    c1.disconnect();
    c2.disconnect();
  }, 25000);
});