import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useNamespace } from '../../src/react/useNamespace';

describe('useNamespace', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should not join empty namespace', () => {
    renderHook(() => useNamespace(''));
    expect(client.join).not.toHaveBeenCalled();
  });

  it('should join on mount', async () => {
    renderHook(() => useNamespace('lobby'));
    await act(async () => {});
    expect(client.join).toHaveBeenCalledWith('lobby');
  });

  it('should leave on unmount', async () => {
    const { unmount } = renderHook(() => useNamespace('lobby'));
    await act(async () => {});
    unmount();
    expect(client.leave).toHaveBeenCalledWith('lobby');
  });

  it('should add peer on peer_joined', async () => {
    const { result } = renderHook(() => useNamespace('lobby'));
    await act(async () => {});
    act(() => { client.emit('peer_joined', { fingerprint: 'fp-bob', alias: 'bob' }); });
    expect(result.current.peers).toHaveLength(1);
  });

  it('should remove peer on peer_left', async () => {
    const { result } = renderHook(() => useNamespace('lobby'));
    await act(async () => {});
    act(() => { client.emit('peer_joined', { fingerprint: 'fp-bob', alias: 'bob' }); });
    act(() => { client.emit('peer_left', 'fp-bob'); });
    expect(result.current.peers).toHaveLength(0);
  });

  it('should deduplicate peers', async () => {
    const { result } = renderHook(() => useNamespace('lobby'));
    await act(async () => {});
    act(() => {
      client.emit('peer_joined', { fingerprint: 'fp-bob', alias: 'bob' });
      client.emit('peer_joined', { fingerprint: 'fp-bob', alias: 'bob' });
    });
    expect(result.current.peers).toHaveLength(1);
  });
});
