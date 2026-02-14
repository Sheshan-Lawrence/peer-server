import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useRelay } from '../../src/react/useRelay';

describe('useRelay', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should start empty', () => {
    const { result } = renderHook(() => useRelay());
    expect(result.current.messages).toEqual([]);
  });

  it('should receive relay', () => {
    const { result } = renderHook(() => useRelay());
    act(() => { client.emit('relay', 'fp-bob', { msg: 'hi' }); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].from).toBe('fp-bob');
  });

  it('should accumulate', () => {
    const { result } = renderHook(() => useRelay());
    act(() => {
      client.emit('relay', 'fp-a', { n: 1 });
      client.emit('relay', 'fp-b', { n: 2 });
    });
    expect(result.current.messages).toHaveLength(2);
  });

  it('should send relay', () => {
    const { result } = renderHook(() => useRelay());
    act(() => { result.current.send('fp-bob', { x: 1 }); });
    expect(client.relay).toHaveBeenCalledWith('fp-bob', { x: 1 });
  });

  it('should clear', () => {
    const { result } = renderHook(() => useRelay());
    act(() => { client.emit('relay', 'fp-a', {}); });
    act(() => { result.current.clear(); });
    expect(result.current.messages).toEqual([]);
  });
});
