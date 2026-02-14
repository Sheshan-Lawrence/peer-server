import { describe, it, expect, afterEach } from 'vitest';
import { connectPair, connectClient, cleanup, waitForEvent, TIMEOUT, delay } from './setup';
import { DirectRoom, GroupRoom } from '../../src/room';
import type { PeerClient } from '../../src/core/client';

let clients: PeerClient[] = [];

afterEach(() => {
  cleanup(...clients);
  clients = [];
});

describe('DirectRoom Integration', { timeout: TIMEOUT }, () => {
  it('should create and join a direct room', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `direct-${Date.now()}`;
    const roomA = new DirectRoom(a, roomId);
    await roomA.create();

    const roomB = new DirectRoom(b, roomId);
    const joinedPromise = waitForEvent(roomA, 'peer_joined');
    await roomB.join();
    await joinedPromise;
  });

  it('should exchange data over direct room P2P', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `direct-data-${Date.now()}`;
    const roomA = new DirectRoom(a, roomId);
    await roomA.create();

    const roomB = new DirectRoom(b, roomId);
    await roomB.join();

    await delay(3000);

    const dataPromise = waitForEvent(roomB, 'data');
    roomA.send({ msg: 'hello-direct' });
    const [data, from] = await dataPromise;

    expect(data.msg).toBe('hello-direct');
  });

  it('should exchange data bidirectionally', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `direct-bidi-${Date.now()}`;
    const roomA = new DirectRoom(a, roomId);
    await roomA.create();

    const roomB = new DirectRoom(b, roomId);
    await roomB.join();

    await delay(3000);

    const fromA = waitForEvent(roomB, 'data');
    const fromB = waitForEvent(roomA, 'data');

    roomA.send({ from: 'a' });
    roomB.send({ from: 'b' });

    const [[dataA], [dataB]] = await Promise.all([fromA, fromB]);
    expect(dataA.from).toBe('a');
    expect(dataB.from).toBe('b');
  });

  it('should emit closed on close', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `direct-close-${Date.now()}`;
    const roomA = new DirectRoom(a, roomId);
    await roomA.create();

    const closedPromise = waitForEvent(roomA, 'closed');
    roomA.close();
    await closedPromise;
  });

  it('should fallback to relay when P2P not established', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `direct-relay-${Date.now()}`;
    const roomA = new DirectRoom(a, roomId);
    await roomA.create();

    const roomB = new DirectRoom(b, roomId);
    await roomB.join();
    await delay(500);

    const dataPromise = waitForEvent(roomB, 'data');
    roomA.send({ msg: 'relay-fallback' });
    const [data] = await dataPromise;

    expect(data.msg).toBe('relay-fallback');
  });
});

describe('GroupRoom Integration', { timeout: 30000 }, () => {
  it('should create and join a group room', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `group-${Date.now()}`;
    const roomA = new GroupRoom(a, roomId, 10);
    await roomA.create();

    const roomB = new GroupRoom(b, roomId, 10);
    const joinedPromise = waitForEvent(roomA, 'peer_joined');
    await roomB.join();
    await joinedPromise;

    expect(roomA.getPeerCount()).toBeGreaterThanOrEqual(1);
  });

  it('should send data to all group members', async () => {
    const [a, b] = await connectPair();
    const c = await connectClient('charlie');
    clients.push(a, b, c);

    const roomId = `group-all-${Date.now()}`;
    const roomA = new GroupRoom(a, roomId, 10);
    await roomA.create();

    const roomB = new GroupRoom(b, roomId, 10);
    const roomC = new GroupRoom(c, roomId, 10);
    await roomB.join();
    await roomC.join();

    await delay(3000);

    const dataB = waitForEvent(roomB, 'data');
    const dataC = waitForEvent(roomC, 'data');

    roomA.send({ msg: 'to-all' });

    const [[receivedB], [receivedC]] = await Promise.all([dataB, dataC]);
    expect(receivedB.msg).toBe('to-all');
    expect(receivedC.msg).toBe('to-all');

    roomA.close();
    roomB.close();
    roomC.close();
  });

  it('should send data to specific peer', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `group-dm-${Date.now()}`;
    const roomA = new GroupRoom(a, roomId, 10);
    await roomA.create();

    const roomB = new GroupRoom(b, roomId, 10);
    await roomB.join();
    await delay(3000);

    const dataPromise = waitForEvent(roomB, 'data');
    roomA.send({ msg: 'dm' }, b.fingerprint);
    const [data] = await dataPromise;

    expect(data.msg).toBe('dm');

    roomA.close();
    roomB.close();
  });

  it('should broadcast via server', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `group-bcast-${Date.now()}`;
    const roomA = new GroupRoom(a, roomId, 10);
    await roomA.create();

    const roomB = new GroupRoom(b, roomId, 10);
    await roomB.join();
    await delay(1000);

    const dataPromise = waitForEvent(roomB, 'data');
    roomA.broadcastViaServer({ msg: 'server-broadcast' });
    const [data] = await dataPromise;

    expect(data.msg).toBe('server-broadcast');

    roomA.close();
    roomB.close();
  });

  it('should handle peer leaving group', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `group-leave-${Date.now()}`;
    const roomA = new GroupRoom(a, roomId, 10);
    await roomA.create();

    const roomB = new GroupRoom(b, roomId, 10);
    await roomB.join();
    await delay(1000);

    const leftPromise = waitForEvent(roomA, 'peer_left');
    roomB.close();
    const fp = await leftPromise;

    expect(fp).toBe(b.fingerprint);

    roomA.close();
  });

  it('should close group room cleanly', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `group-close-${Date.now()}`;
    const room = new GroupRoom(a, roomId, 10);
    await room.create();

    const closedPromise = waitForEvent(room, 'closed');
    room.close();
    await closedPromise;

    expect(room.getPeerCount()).toBe(0);
  });

  it('should handle multiple messages in sequence', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const roomId = `group-multi-${Date.now()}`;
    const roomA = new GroupRoom(a, roomId, 10);
    await roomA.create();

    const roomB = new GroupRoom(b, roomId, 10);
    await roomB.join();
    await delay(3000);

    const messages: any[] = [];
    roomB.on('data', (data: any) => messages.push(data));

    for (let i = 0; i < 5; i++) {
      roomA.send({ idx: i });
    }

    await delay(2000);

    expect(messages.length).toBe(5);
    expect(messages.map((m) => m.idx)).toEqual([0, 1, 2, 3, 4]);

    roomA.close();
    roomB.close();
  });
});
