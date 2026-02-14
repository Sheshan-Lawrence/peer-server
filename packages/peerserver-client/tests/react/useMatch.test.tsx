import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useMatch } from '../../src/react/useMatch';

describe('useMatch', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should start idle', () => {
    const { result } = renderHook(() => useMatch());
    expect(result.current.status).toBe('idle');
    expect(result.current.peers).toEqual([]);
    expect(result.current.sessionId).toBe('');
  });

  it('should match and return peers', async () => {
    const { result } = renderHook(() => useMatch());
    await act(async () => { await result.current.match('game', { skill: 1 }, 2); });
    expect(result.current.status).toBe('matched');
    expect(result.current.peers).toHaveLength(1);
    expect(result.current.sessionId).toBe('sess-1');
  });

  it('should handle error', async () => {
    client.match.mockRejectedValueOnce(new Error('fail'));
    const { result } = renderHook(() => useMatch());
    await act(async () => { await result.current.match('game'); });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('fail');
  });

  it('should reset', async () => {
    const { result } = renderHook(() => useMatch());
    await act(async () => { await result.current.match('game'); });
    act(() => { result.current.reset(); });
    expect(result.current.status).toBe('idle');
    expect(result.current.peers).toEqual([]);
  });
});
