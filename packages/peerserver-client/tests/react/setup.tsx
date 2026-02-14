import React from 'react';
import { renderHook, act, render } from '@testing-library/react';
import { vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';

export class MockClient extends Emitter {
  fingerprint = 'fp-test-abc';
  alias = 'test-user';
  connected = true;
  private _peers = new Map<string, any>();

  connect = vi.fn(async () => { this.connected = true; });
  disconnect = vi.fn(() => { this.connected = false; });
  join = vi.fn(async (_ns: string) => [] as any[]);
  leave = vi.fn((_ns: string) => {});
  discover = vi.fn(async (_ns: string, _limit?: number) => [] as any[]);
  match = vi.fn(async (_ns: string, _meta?: any, _count?: number) => ({
    namespace: _ns, session_id: 'sess-1', peers: [{ fingerprint: 'fp-match', alias: 'matched' }],
  }));
  relay = vi.fn((_to: string, _payload: any) => {});
  broadcast = vi.fn((_ns: string, _payload: any) => {});
  createRoom = vi.fn(async (_id: string) => ({
    room_id: _id, max_size: 10, owner: 'fp-test-abc',
  }));
  joinRoom = vi.fn(async (_id: string) => [] as any[]);
  roomInfo = vi.fn(async (_id: string) => ({
    room_id: _id, peer_count: 1, max_size: 10, owner: 'fp-test-abc',
  }));
  kick = vi.fn();
  connectToPeer = vi.fn((fp: string, alias = '') => {
    const peer = new MockPeer(fp, alias);
    this._peers.set(fp, peer);
    return peer;
  });
  getPeer = vi.fn((fp: string) => this._peers.get(fp));
}

export class MockPeer extends Emitter {
  fingerprint: string;
  alias: string;
  connectionState = 'connected';
  closed = false;

  constructor(fp: string, alias = '') {
    super();
    this.fingerprint = fp;
    this.alias = alias;
  }

  send = vi.fn();
  sendBinary = vi.fn();
  close = vi.fn(() => { this.closed = true; this.connectionState = 'closed'; });
  createDataChannel = vi.fn();
  get channelLabels() { return ['data']; }
}

export function createMockClient(): MockClient {
  return new MockClient();
}

export function setupContext(client: MockClient) {
  (globalThis as any).__peerlib_mock_context__ = {
    client,
    connected: true,
    fingerprint: client.fingerprint,
    alias: client.alias,
    error: null,
  };
}

export function getMockContext() {
  return (globalThis as any).__peerlib_mock_context__ ?? {
    client: null, connected: false, fingerprint: '', alias: '', error: null,
  };
}

export { renderHook, act, render };
