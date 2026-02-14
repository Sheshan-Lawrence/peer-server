import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

vi.mock('../../src/room', () => {
  class E{l=new Map();on(e,f){if(!this.l.has(e))this.l.set(e,new Set());this.l.get(e).add(f);return()=>this.l.get(e)?.delete(f);}emit(e,...a){this.l.get(e)?.forEach(f=>f(...a));}}
  class DirectRoom extends E {
    constructor(public client: any, public roomId: string) { super(); }
    create = vi.fn(async () => {});
    join = vi.fn(async () => []);
    close = vi.fn(() => { this.emit('closed'); });
    send = vi.fn();
  }
  class GroupRoom extends E {
    constructor(public client: any, public roomId: string, public maxSize: number) { super(); }
    create = vi.fn(async () => {});
    join = vi.fn(async () => []);
    close = vi.fn(() => { this.emit('closed'); });
    send = vi.fn();
    broadcastViaServer = vi.fn();
    getPeerCount = vi.fn(() => 0);
  }
  return { DirectRoom, GroupRoom };
});

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useRoom } from '../../src/react/useRoom';

describe('useRoom', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    setupContext(client);
  });

  it('should not join with empty roomId', () => {
    const { result } = renderHook(() => useRoom(''));
    expect(result.current.joined).toBe(false);
  });

  it('should join room on mount', async () => {
    const { result } = renderHook(() => useRoom('room-1', 'direct', false));
    await act(async () => {});
    expect(result.current.joined).toBe(true);
  });

  it('should create room when create=true', async () => {
    const { result } = renderHook(() => useRoom('room-1', 'direct', true));
    await act(async () => {});
    expect(result.current.joined).toBe(true);
  });

  it('should start with empty peers and messages', () => {
    const { result } = renderHook(() => useRoom('room-1'));
    expect(result.current.peers).toEqual([]);
    expect(result.current.messages).toEqual([]);
  });

  it('should provide send function', async () => {
    const { result } = renderHook(() => useRoom('room-1'));
    await act(async () => {});
    expect(typeof result.current.send).toBe('function');
  });

  it('should clear messages', async () => {
    const { result } = renderHook(() => useRoom('room-1'));
    await act(async () => {});
    act(() => { result.current.clearMessages(); });
    expect(result.current.messages).toEqual([]);
  });

  it('should accept group type', async () => {
    const { result } = renderHook(() => useRoom('room-1', 'group', false, 30));
    await act(async () => {});
    expect(result.current.joined).toBe(true);
  });
});
