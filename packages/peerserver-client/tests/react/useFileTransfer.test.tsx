import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

vi.mock('../../src/transfer', () => {
  class E{l=new Map();on(e,f){if(!this.l.has(e))this.l.set(e,new Set());this.l.get(e).add(f);return()=>this.l.get(e)?.delete(f);}emit(e,...a){this.l.get(e)?.forEach(f=>f(...a));}}
  class FileTransfer extends E {
    constructor(public client: any) { super(); }
    send = vi.fn(async () => 'ft-1');
    accept = vi.fn();
    reject = vi.fn();
    cancel = vi.fn();
    handleIncoming = vi.fn(() => () => {});
    destroy = vi.fn();
  }
  return { FileTransfer };
});

import { renderHook, act, createMockClient, setupContext, MockPeer } from './setup';
import { useFileTransfer } from '../../src/react/useFileTransfer';

describe('useFileTransfer', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should start with empty transfers', () => {
    const { result } = renderHook(() => useFileTransfer());
    expect(result.current.transfers.size).toBe(0);
  });

  it('should provide all functions', () => {
    const { result } = renderHook(() => useFileTransfer());
    expect(typeof result.current.send).toBe('function');
    expect(typeof result.current.accept).toBe('function');
    expect(typeof result.current.reject).toBe('function');
    expect(typeof result.current.cancel).toBe('function');
    expect(typeof result.current.listenToPeer).toBe('function');
    expect(typeof result.current.clearCompleted).toBe('function');
  });

  it('should listenToPeer return cleanup', () => {
    const peer = new MockPeer('fp-bob');
    const { result } = renderHook(() => useFileTransfer());
    let cleanup: () => void;
    act(() => { cleanup = result.current.listenToPeer(peer as any); });
    expect(typeof cleanup!).toBe('function');
  });

  it('should clearCompleted', () => {
    const { result } = renderHook(() => useFileTransfer());
    act(() => { result.current.clearCompleted(); });
    expect(result.current.transfers.size).toBe(0);
  });
});
