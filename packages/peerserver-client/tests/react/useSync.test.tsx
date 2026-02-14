import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

vi.mock('../../src/sync', () => {
  class E{l=new Map();on(e,f){if(!this.l.has(e))this.l.set(e,new Set());this.l.get(e).add(f);return()=>this.l.get(e)?.delete(f);}emit(e,...a){this.l.get(e)?.forEach(f=>f(...a));}}
  class StateSync extends E {
    private _state = new Map<string, any>();
    constructor(public client: any, public roomId: string, public config: any) { super(); }
    start = vi.fn();
    destroy = vi.fn();
    set(key: string, value: any) { this._state.set(key, value); this.emit('state_changed', key, value); }
    delete(key: string) { this._state.delete(key); this.emit('state_changed', key, undefined); }
    get(key: string) { return this._state.get(key); }
    getAll() { return Object.fromEntries(this._state); }
  }
  return { StateSync };
});

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useSync } from '../../src/react/useSync';

describe('useSync', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should start with empty state', () => {
    const { result } = renderHook(() => useSync('room-1', 'lww'));
    expect(result.current.state).toEqual({});
  });

  it('should set a value', async () => {
    const { result } = renderHook(() => useSync('room-1', 'lww'));
    await act(async () => {});
    act(() => { result.current.set('key', 'value'); });
    expect(result.current.state.key).toBe('value');
  });

  it('should delete a value', async () => {
    const { result } = renderHook(() => useSync('room-1', 'lww'));
    await act(async () => {});
    act(() => { result.current.set('key', 'value'); });
    act(() => { result.current.delete('key'); });
    expect(result.current.state.key).toBeUndefined();
  });

  it('should get a value', async () => {
    const { result } = renderHook(() => useSync('room-1', 'lww'));
    await act(async () => {});
    act(() => { result.current.set('x', 42); });
    expect(result.current.get('x')).toBe(42);
  });

  it('should handle no roomId', () => {
    const { result } = renderHook(() => useSync('', 'lww'));
    expect(result.current.state).toEqual({});
  });
});
