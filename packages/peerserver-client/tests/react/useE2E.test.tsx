import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

vi.mock('../../src/crypto', () => {
  class E{l=new Map();on(e,f){if(!this.l.has(e))this.l.set(e,new Set());this.l.get(e).add(f);return()=>this.l.get(e)?.delete(f);}emit(e,...a){this.l.get(e)?.forEach(f=>f(...a));}}
  class MockE2E {
    private keys = new Set<string>();
    async init() {}
    destroy() {}
    getPublicKeyB64() { return 'pub-key-b64'; }
    async deriveKey(id: string) { this.keys.add(id); }
    hasKey(id: string) { return this.keys.has(id); }
    removeKey(id: string) { this.keys.delete(id); }
    async encrypt(_id: string, data: string) { return `enc:${data}`; }
    async decrypt(_id: string, data: string) { return data.replace('enc:', ''); }
  }
  class GroupKeyManager extends E {
    private e2e = new MockE2E();
    constructor(public client: any) { super(); }
    init = vi.fn(async () => {});
    destroy = vi.fn();
    exchangeWith = vi.fn(async (peer: any) => { await this.e2e.deriveKey(peer.fingerprint); });
    handleIncomingKeyExchange = vi.fn(async (peer: any) => { await this.e2e.deriveKey(peer.fingerprint); });
    encryptForPeer = vi.fn(async (_fp: string, data: any) => `enc:${JSON.stringify(data)}`);
    decryptFromPeer = vi.fn(async (_fp: string, data: string) => JSON.parse(data.replace('enc:', '')));
    getE2E() { return this.e2e; }
  }
  return { E2E: MockE2E, GroupKeyManager };
});

import { renderHook, act, createMockClient, setupContext, MockPeer } from './setup';
import { useE2E } from '../../src/react/useE2E';

describe('useE2E', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should become ready', async () => {
    const { result } = renderHook(() => useE2E());
    await act(async () => {});
    expect(result.current.ready).toBe(true);
  });

  it('should start with empty exchanged peers', () => {
    const { result } = renderHook(() => useE2E());
    expect(result.current.exchangedPeers.size).toBe(0);
  });

  it('should exchange with peer', async () => {
    const { result } = renderHook(() => useE2E());
    await act(async () => {});
    const peer = new MockPeer('fp-bob');
    await act(async () => { await result.current.exchange(peer as any); });
    expect(result.current.exchangedPeers.has('fp-bob')).toBe(true);
  });

  it('should encrypt data', async () => {
    const { result } = renderHook(() => useE2E());
    await act(async () => {});
    let enc: string;
    await act(async () => { enc = await result.current.encrypt('fp-bob', { s: 1 }); });
    expect(enc!).toContain('enc:');
  });

  it('should decrypt data', async () => {
    const { result } = renderHook(() => useE2E());
    await act(async () => {});
    let dec: any;
    await act(async () => { dec = await result.current.decrypt('fp-bob', 'enc:{"s":1}'); });
    expect(dec).toEqual({ s: 1 });
  });

  it('should check hasKey', async () => {
    const { result } = renderHook(() => useE2E());
    await act(async () => {});
    expect(result.current.hasKey('fp-unknown')).toBe(false);
  });
});
