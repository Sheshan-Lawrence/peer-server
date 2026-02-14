import { describe, it, expect, afterEach } from 'vitest';
import { connectClient, connectPair, cleanup, waitForEvent, TIMEOUT, delay } from './setup';
import type { PeerClient } from '../../src/core/client';

let clients: PeerClient[] = [];

afterEach(() => {
  cleanup(...clients);
  clients = [];
});

describe('Client Integration', { timeout: TIMEOUT }, () => {
  it('should connect and register with server', async () => {
    const client = await connectClient('reg-test');
    clients.push(client);

    expect(client.fingerprint).toBeTruthy();
    expect(client.connected).toBe(true);
  });

  it('should receive unique fingerprints per client', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    expect(a.fingerprint).toBeTruthy();
    expect(b.fingerprint).toBeTruthy();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('should join namespace and discover peers', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `discover-${Date.now()}`;
    await a.join(ns);
    await b.join(ns);

    await delay(500);
    const peers = await a.discover(ns);
    const found = peers.some((p) => p.fingerprint === b.fingerprint);
    expect(found).toBe(true);
  });

  it('should receive peer_joined when another client joins', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `joined-${Date.now()}`;
    await a.join(ns);

    const joinedPromise = waitForEvent(a, 'peer_joined');
    await b.join(ns);
    const info = await joinedPromise;

    expect(info.fingerprint).toBe(b.fingerprint);
  });

  it('should receive peer_left when client leaves', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `left-${Date.now()}`;
    await a.join(ns);
    await b.join(ns);
    await delay(300);

    const leftPromise = waitForEvent(a, 'peer_left');
    b.leave(ns);
    const fp = await leftPromise;
    expect(fp).toBe(b.fingerprint);
  });

  it('should relay messages through server', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `relay-${Date.now()}`;
    await a.join(ns);
    await b.join(ns);
    await delay(300);

    const relayPromise = waitForEvent(b, 'relay');
    a.relay(b.fingerprint, { msg: 'hello-relay' });
    const [from, payload] = await relayPromise;

    expect(from).toBe(a.fingerprint);
    expect(payload.msg).toBe('hello-relay');
  });

  it('should broadcast to namespace', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `bcast-${Date.now()}`;
    await a.join(ns);
    await b.join(ns);
    await delay(300);

    const bcastPromise = waitForEvent(b, 'broadcast');
    a.broadcast(ns, { msg: 'hello-broadcast' });
    const [from, receivedNs, payload] = await bcastPromise;

    expect(from).toBe(a.fingerprint);
    expect(payload.msg).toBe('hello-broadcast');
  });

  it('should create and join room', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `room-${Date.now()}`;
    const result = await a.createRoom(roomId, { maxSize: 5 });
    expect(result.room_id).toBe(roomId);

    const joinedPromise = waitForEvent(a, 'peer_joined');
    const peers = await b.joinRoom(roomId);
    await joinedPromise;
    expect(peers).toBeDefined();
  });

  it('should get room info', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `info-${Date.now()}`;
    await a.createRoom(roomId, { maxSize: 10 });
    await b.joinRoom(roomId);
    await delay(300);

    const info = await a.roomInfo(roomId);
    expect(info.room_id).toBe(roomId);
    expect(info.peer_count).toBeGreaterThanOrEqual(2);
  });

  it('should handle disconnect cleanly', async () => {
    const client = await connectClient('dc-test');
    clients.push(client);

    expect(client.connected).toBe(true);
    client.disconnect();
    expect(client.connected).toBe(false);
  });
});
