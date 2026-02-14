import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useBroadcast } from '../../src/react/useBroadcast';

describe('useBroadcast', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should start empty', () => {
    const { result } = renderHook(() => useBroadcast('lobby'));
    expect(result.current.messages).toEqual([]);
  });

  it('should receive matching namespace broadcast', () => {
    const { result } = renderHook(() => useBroadcast('lobby'));
    act(() => { client.emit('broadcast', 'fp-bob', 'lobby', { msg: 'hey' }); });
    expect(result.current.messages).toHaveLength(1);
  });

  it('should ignore other namespace', () => {
    const { result } = renderHook(() => useBroadcast('lobby'));
    act(() => { client.emit('broadcast', 'fp-bob', 'other', { msg: 'hey' }); });
    expect(result.current.messages).toHaveLength(0);
  });

  it('should send broadcast', () => {
    const { result } = renderHook(() => useBroadcast('lobby'));
    act(() => { result.current.send({ msg: 'all' }); });
    expect(client.broadcast).toHaveBeenCalledWith('lobby', { msg: 'all' });
  });

  it('should clear', () => {
    const { result } = renderHook(() => useBroadcast('lobby'));
    act(() => { client.emit('broadcast', 'fp-a', 'lobby', {}); });
    act(() => { result.current.clear(); });
    expect(result.current.messages).toEqual([]);
  });
});
