import { describe, it, expect, afterEach } from 'vitest';
import { connectPair, establishP2P, cleanup, waitForEvent, TIMEOUT, delay } from './setup';
import type { PeerClient } from '../../src/core/client';

let clients: PeerClient[] = [];

afterEach(() => {
  cleanup(...clients);
  clients = [];
});

describe('Peer Integration', { timeout: TIMEOUT }, () => {
  it('should establish P2P connection via signaling server', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);
    expect(peerA.connectionState).toBe('connected');
    expect(peerB.connectionState).toBe('connected');
  });

  it('should send and receive JSON over data channel', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    const received = waitForEvent(peerB, 'data');
    peerA.send({ hello: 'world' }, 'data');
    const [data] = await received;

    expect(data).toEqual({ hello: 'world' });
  });

  it('should send and receive string over data channel', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    const received = waitForEvent(peerB, 'data');
    peerA.send('raw-string', 'data');
    const [data] = await received;

    expect(data).toBe('raw-string');
  });

  it('should send and receive binary data', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const received = waitForEvent(peerB, 'data');
    peerA.sendBinary(payload.buffer, 'data');
    const [data] = await received;

    expect(new Uint8Array(data)).toEqual(payload);
  });

  it('should exchange multiple messages bidirectionally', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    const messagesA: any[] = [];
    const messagesB: any[] = [];

    peerA.on('data', (d: any) => messagesA.push(d));
    peerB.on('data', (d: any) => messagesB.push(d));

    for (let i = 0; i < 10; i++) {
      peerA.send({ from: 'a', i }, 'data');
      peerB.send({ from: 'b', i }, 'data');
    }

    await delay(2000);

    expect(messagesB.length).toBe(10);
    expect(messagesA.length).toBe(10);
    expect(messagesB.every((m) => m.from === 'a')).toBe(true);
    expect(messagesA.every((m) => m.from === 'b')).toBe(true);
  });

  it('should emit datachannel:open event', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `dco-${Date.now()}`;
    await a.join(ns);
    await b.join(ns);

    const openPromise = new Promise<string>((resolve) => {
      const peer = a.connectToPeer(b.fingerprint, 'bob');
      peer.on('datachannel:open', (label: string) => resolve(label));
    });

    const label = await openPromise;
    expect(label).toBe('data');
  });

  it('should close peer connection cleanly', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    peerA.close();
    expect(peerA.closed).toBe(true);
    expect(peerA.connectionState).toBe('closed');

    await delay(1000);
  });

  it('should create additional data channels', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    const chOpenPromise = waitForEvent(peerB, 'datachannel:create');
    peerA.createDataChannel({ label: 'extra', ordered: true });

    await chOpenPromise;
    await delay(500);

    expect(peerA.channelLabels).toContain('extra');
  });

  it('should handle large JSON payload', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const [peerA, peerB] = await establishP2P(a, b);

    const bigData = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: 'x'.repeat(100) })) };

    const received = waitForEvent(peerB, 'data');
    peerA.send(bigData, 'data');
    const [data] = await received;

    expect(data.items.length).toBe(1000);
  });
});
