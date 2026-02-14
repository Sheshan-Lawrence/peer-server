import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, createMockClient, setupContext, getMockContext, MockPeer } from './setup';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => getMockContext(),
}));

import { usePeer } from '../../src/react/usePeer';

describe('usePeer', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    setupContext(client);
  });

  it('should return null peer when not found', () => {
    const { result } = renderHook(() => usePeer('fp-unknown'));
    expect(result.current.peer).toBeNull();
  });

  it('should find existing peer', () => {
    const peer = client.connectToPeer('fp-bob', 'bob');
    const { result } = renderHook(() => usePeer('fp-bob'));
    expect(result.current.peer).toBe(peer);
    expect(result.current.connectionState).toBe('connected');
  });

  it('should update peer on peer_joined', () => {
    const { result } = renderHook(() => usePeer('fp-new'));
    expect(result.current.peer).toBeNull();

    act(() => {
      client.connectToPeer('fp-new', 'new');
      client.emit('peer_joined', { fingerprint: 'fp-new', alias: 'new' });
    });

    expect(result.current.peer).toBeTruthy();
  });

  it('should clear peer on peer_left', () => {
    client.connectToPeer('fp-bob', 'bob');
    const { result } = renderHook(() => usePeer('fp-bob'));

    act(() => { client.emit('peer_left', 'fp-bob'); });

    expect(result.current.peer).toBeNull();
    expect(result.current.connectionState).toBe('closed');
  });

  it('should track disconnected state', () => {
    const peer = client.connectToPeer('fp-bob', 'bob') as MockPeer;
    const { result } = renderHook(() => usePeer('fp-bob'));

    act(() => { peer.emit('disconnected', 'disconnected'); });

    expect(result.current.connectionState).toBe('disconnected');
  });

  it('should provide send function', () => {
    client.connectToPeer('fp-bob', 'bob');
    const { result } = renderHook(() => usePeer('fp-bob'));

    act(() => { result.current.send({ hello: true }); });

    expect((client.getPeer('fp-bob') as MockPeer).send).toHaveBeenCalled();
  });
});
