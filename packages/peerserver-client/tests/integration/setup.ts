import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'node-datachannel/polyfill';
import WebSocket from 'ws';
import { PeerClient } from '../../src/core/client';
import type { Peer } from '../../src/core/peer';

(globalThis as any).RTCPeerConnection = RTCPeerConnection;
(globalThis as any).RTCSessionDescription = RTCSessionDescription;
(globalThis as any).RTCIceCandidate = RTCIceCandidate;
(globalThis as any).WebSocket = WebSocket;

export const SERVER_URL = process.env.PEER_SERVER_URL || 'wss://peer.fewclicks.org/ws';

export const TIMEOUT = 15000;

export function createClient(alias?: string): PeerClient {
  return new PeerClient({
    url: SERVER_URL,
    alias: alias ?? `test-${Math.random().toString(36).slice(2, 8)}`,
    autoReconnect: false,
    pingInterval: 30000,
  });
}

export async function connectClient(alias?: string): Promise<PeerClient> {
  const client = createClient(alias);
  await client.connect();
  return client;
}

export async function connectPair(): Promise<[PeerClient, PeerClient]> {
  const [a, b] = await Promise.all([connectClient('alice'), connectClient('bob')]);
  return [a, b];
}

export function waitForEvent<T = any>(
  emitter: { on: (event: any, fn: (...args: any[]) => void) => () => void },
  event: string,
  timeout = TIMEOUT,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timeout waiting for "${event}" (${timeout}ms)`));
    }, timeout);
    const off = emitter.on(event, (...args: any[]) => {
      clearTimeout(timer);
      off();
      resolve(args.length === 1 ? args[0] : args as any);
    });
  });
}

export async function establishP2P(
  clientA: PeerClient,
  clientB: PeerClient,
): Promise<[Peer, Peer]> {
  const ns = `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await clientA.join(ns);
  await clientB.join(ns);

  await delay(300);

  const peerBReady = new Promise<Peer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for peerB')), TIMEOUT);
    const check = () => {
      const p = clientB.getPeer(clientA.fingerprint);
      if (p) { clearTimeout(timer); resolve(p); return; }
      setTimeout(check, 50);
    };
    check();
  });

  const peerA = clientA.connectToPeer(clientB.fingerprint, 'bob');

  const peerB = await peerBReady;

  await Promise.all([
    waitForEvent(peerA, 'datachannel:open'),
    waitForEvent(peerB, 'datachannel:open'),
  ]);

  return [peerA, peerB];
}

export function cleanup(...clients: PeerClient[]): void {
  clients.forEach((c) => {
    try { c.disconnect(); } catch {}
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
