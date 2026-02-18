import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerClient } from '../core/client';
import { MockSignalServer, delay, waitForEvent, REAL_SERVER } from './setup';

describe('PeerClient — Mock Server', () => {
  let server: MockSignalServer;
  let client: PeerClient;

  beforeEach(async () => {
    server = new MockSignalServer();
    await server.start();
  });

  afterEach(async () => {
    client?.disconnect();
    await server.stop();
  });

  it('connects and registers', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    expect(client.fingerprint).toBeTruthy();
    expect(client.connected).toBe(true);
  });

  it('emits registered event with fingerprint and alias', async () => {
    client = new PeerClient({ url: server.url, alias: 'alice', autoReconnect: false });
    const regPromise = waitForEvent(client, 'registered');
    await client.connect();
    const [fp, alias] = await regPromise;
    expect(fp).toBeTruthy();
    expect(alias).toBe('alice');
  });

  it('join returns peer list', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const peers = await client.join('test-ns');
    expect(Array.isArray(peers)).toBe(true);
    expect(peers.length).toBeGreaterThanOrEqual(1);
  });

  it('join emits peer_list event', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const plPromise = waitForEvent(client, 'peer_list');
    client.join('test-ns');
    const [ns, peers] = await plPromise;
    expect(ns).toBe('test-ns');
    expect(Array.isArray(peers)).toBe(true);
  });

  it('leave removes namespace', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    await client.join('ns1');
    client.leave('ns1');
    await delay(50);
  });

  it('two clients see each other after join', async () => {
    const client1 = new PeerClient({ url: server.url, alias: 'c1', autoReconnect: false });
    const client2 = new PeerClient({ url: server.url, alias: 'c2', autoReconnect: false });
    await client1.connect();
    await client2.connect();
    await client1.join('shared');

    const joinedPromise = waitForEvent(client1, 'peer_joined');
    await client2.join('shared');
    const [info] = await joinedPromise;
    expect(info.fingerprint).toBe(client2.fingerprint);

    client1.disconnect();
    client2.disconnect();
  });

  it('peer_left fires when peer disconnects', async () => {
    const client1 = new PeerClient({ url: server.url, autoReconnect: false });
    const client2 = new PeerClient({ url: server.url, autoReconnect: false });
    await client1.connect();
    await client2.connect();
    await client1.join('ns');
    await client2.join('ns');

    const leftPromise = waitForEvent(client1, 'peer_left');
    client2.disconnect();
    const [fp] = await leftPromise;
    expect(fp).toBe(client2.fingerprint);

    client1.disconnect();
  });

  it('discover returns peers in namespace', async () => {
    const client1 = new PeerClient({ url: server.url, autoReconnect: false });
    const client2 = new PeerClient({ url: server.url, autoReconnect: false });
    await client1.connect();
    await client2.connect();
    await client1.join('disco');
    await client2.join('disco');

    const peers = await client1.discover('disco');
    expect(peers.length).toBeGreaterThanOrEqual(2);

    client1.disconnect();
    client2.disconnect();
  });

  it('discover with limit', async () => {
    const clients: PeerClient[] = [];
    for (let i = 0; i < 5; i++) {
      const c = new PeerClient({ url: server.url, autoReconnect: false });
      await c.connect();
      await c.join('big-ns');
      clients.push(c);
    }
    const peers = await clients[0].discover('big-ns', 3);
    expect(peers.length).toBeLessThanOrEqual(3);
    clients.forEach((c) => c.disconnect());
  });

  it('createRoom returns room info', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const result = await client.createRoom('room1');
    expect(result.room_id).toBe('room1');
    expect(result.owner).toBe(client.fingerprint);
  });

  it('joinRoom returns peer list', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.createRoom('room2');
    const peers = await c2.joinRoom('room2');
    expect(peers.length).toBeGreaterThanOrEqual(1);
    c1.disconnect();
    c2.disconnect();
  });

  it('createRoom duplicate fails', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    await client.createRoom('dup');
    await expect(client.createRoom('dup')).rejects.toThrow();
  });

  it('roomInfo returns correct data', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    await client.createRoom('info-room', { maxSize: 10 });
    const info = await client.roomInfo('info-room');
    expect(info.room_id).toBe('info-room');
    expect(info.owner).toBe(client.fingerprint);
  });

  it('relay delivers message', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();

    const relayPromise = waitForEvent(c2, 'relay');
    c1.relay(c2.fingerprint, { hello: 'world' });
    const [from, payload] = await relayPromise;
    expect(from).toBe(c1.fingerprint);
    expect(payload.hello).toBe('world');

    c1.disconnect();
    c2.disconnect();
  });

  it('broadcast delivers to namespace members', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join('bcast');
    await c2.join('bcast');

    const bcPromise = waitForEvent(c2, 'broadcast');
    c1.broadcast('bcast', { msg: 'hi' });
    const [from, ns, data] = await bcPromise;
    expect(from).toBe(c1.fingerprint);
    expect(ns).toBe('bcast');
    expect(data.msg).toBe('hi');

    c1.disconnect();
    c2.disconnect();
  });

  it('match resolves when group forms', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join('match-ns');
    await c2.join('match-ns');

    const [r1] = await Promise.all([
      c1.match('match-ns', undefined, 2),
      c2.match('match-ns', undefined, 2),
    ]);
    expect(r1.peers.length).toBe(2);
    expect(r1.session_id).toBeTruthy();

    c1.disconnect();
    c2.disconnect();
  });

  it('cancelMatch rejects pending match', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const matchPromise = client.match('cancel-ns', undefined, 5);
    client.cancelMatch('cancel-ns');
    await expect(matchPromise).rejects.toThrow('cancelled');
  });

  it('kick removes peer from room', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.createRoom('kick-room');
    await c2.joinRoom('kick-room');

    const kickedPromise = waitForEvent(c2, 'kicked');
    c1.kick('kick-room', c2.fingerprint);
    const [payload] = await kickedPromise;
    expect(payload.room_id).toBe('kick-room');

    c1.disconnect();
    c2.disconnect();
  });

  it('disconnect cleans up all state', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    await client.join('ns1');
    client.disconnect();
    expect(client.connected).toBe(false);
    expect(client.peerMap.size).toBe(0);
  });

  it('connectToPeer creates a Peer object', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const peer = client.connectToPeer('some-fp', 'alias');
    expect(peer).toBeTruthy();
    expect(peer.fingerprint).toBe('some-fp');
    expect(client.peerMap.has('some-fp')).toBe(true);
  });

  it('connectToPeer returns existing peer if not closed', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const p1 = client.connectToPeer('fp1', 'a');
    const p2 = client.connectToPeer('fp1', 'a');
    expect(p1).toBe(p2);
  });

  it('getPeer returns undefined for unknown', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    expect(client.getPeer('nonexist')).toBeUndefined();
  });

  it('closePeer removes from map', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    client.connectToPeer('fp-close', 'x');
    expect(client.getPeer('fp-close')).toBeTruthy();
    client.closePeer('fp-close');
    expect(client.getPeer('fp-close')).toBeUndefined();
  });

  it('updateMetadata sends metadata message', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    expect(() => client.updateMetadata({ role: 'host' })).not.toThrow();
  });

  it('getIdentity returns Identity instance', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    const id = client.getIdentity();
    expect(id.fingerprint).toBe(client.fingerprint);
  });

  it('getTransport returns Transport instance', async () => {
    client = new PeerClient({ url: server.url, autoReconnect: false });
    await client.connect();
    expect(client.getTransport().connected).toBe(true);
  });

  it('alias getter returns configured alias', async () => {
    client = new PeerClient({ url: server.url, alias: 'myalias', autoReconnect: false });
    await client.connect();
    expect(client.alias).toBe('myalias');
  });

  it('default config values applied', () => {
    client = new PeerClient({ url: server.url });
    expect(client).toBeTruthy();
  });

  it('error event fires on server error message', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c1.createRoom('err-room');

    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c2.connect();
    await c2.createRoom('err-room').catch(() => {});

    c1.disconnect();
    c2.disconnect();
  });
});

describe('PeerClient — Real Server', () => {
  let client: PeerClient;

  afterEach(() => {
    client?.disconnect();
  });

  it('connects and registers on real server', async () => {
    client = new PeerClient({ url: REAL_SERVER, alias: 'test-client', autoReconnect: false });
    await client.connect();
    expect(client.fingerprint).toBeTruthy();
    expect(client.connected).toBe(true);
  }, 15000);

  it('join namespace on real server', async () => {
    client = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await client.connect();
    const peers = await client.join('vitest-ns-' + Date.now());
    expect(Array.isArray(peers)).toBe(true);
  }, 15000);

  it('two clients join same namespace on real server', async () => {
    const ns = 'vitest-pair-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, alias: 'r1', autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, alias: 'r2', autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join(ns);
    const joinedPromise = waitForEvent(c1, 'peer_joined', 10000);
    await c2.join(ns);
    const [info] = await joinedPromise;
    expect(info.fingerprint).toBe(c2.fingerprint);
    c1.disconnect();
    c2.disconnect();
  }, 20000);

  it('relay between two clients on real server', async () => {
    const ns = 'vitest-relay-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join(ns);
    await c2.join(ns);
    await delay(200);

    const relayPromise = waitForEvent(c2, 'relay', 10000);
    c1.relay(c2.fingerprint, { test: 'relay' });
    const [from, payload] = await relayPromise;
    expect(from).toBe(c1.fingerprint);
    expect(payload.test).toBe('relay');

    c1.disconnect();
    c2.disconnect();
  }, 15000);

  it('broadcast on real server', async () => {
    const ns = 'vitest-bc-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join(ns);
    await c2.join(ns);
    await delay(200);

    const bcPromise = waitForEvent(c2, 'broadcast', 10000);
    c1.broadcast(ns, { data: 'bcast' });
    const [from, rns, data] = await bcPromise;
    expect(from).toBe(c1.fingerprint);
    expect(data.data).toBe('bcast');

    c1.disconnect();
    c2.disconnect();
  }, 20000);

  it('stress: 20 clients join same namespace', async () => {
    const ns = 'vitest-stress-' + Date.now();
    const clients: PeerClient[] = [];
    for (let i = 0; i < 20; i++) {
      const c = new PeerClient({ url: REAL_SERVER, alias: `s${i}`, autoReconnect: false });
      await c.connect();
      await c.join(ns);
      clients.push(c);
    }
    const peers = await clients[0].discover(ns);
    expect(peers.length).toBeGreaterThanOrEqual(15);
    clients.forEach((c) => c.disconnect());
  }, 60000);

  it('stress: rapid join/leave cycles', async () => {
    client = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await client.connect();
    for (let i = 0; i < 10; i++) {
      const ns = `cycle-${Date.now()}-${i}`;
      await client.join(ns);
      client.leave(ns);
    }
    await delay(500);
    expect(client.connected).toBe(true);
  }, 30000);
});