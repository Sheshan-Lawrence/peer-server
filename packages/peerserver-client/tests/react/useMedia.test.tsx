import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

vi.mock('../../src/media', () => {
  class E{l=new Map();on(e,f){if(!this.l.has(e))this.l.set(e,new Set());this.l.get(e).add(f);return()=>this.l.get(e)?.delete(f);}emit(e,...a){this.l.get(e)?.forEach(f=>f(...a));}}
  class DirectMedia extends E {
    constructor(public client: any, public roomId: string) { super(); }
    createAndJoin = vi.fn(async () => {});
    joinAndStart = vi.fn(async () => {});
    close = vi.fn();
    muteAudio = vi.fn();
    unmuteAudio = vi.fn();
    muteVideo = vi.fn();
    unmuteVideo = vi.fn();
  }
  class GroupMedia extends E {
    constructor(public client: any, public roomId: string) { super(); }
    createAndJoin = vi.fn(async () => {});
    joinAndStart = vi.fn(async () => {});
    close = vi.fn();
    muteAudio = vi.fn();
    unmuteAudio = vi.fn();
    muteVideo = vi.fn();
    unmuteVideo = vi.fn();
  }
  return { DirectMedia, GroupMedia };
});

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useMedia } from '../../src/react/useMedia';

describe('useMedia', () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should start with null local stream', () => {
    const { result } = renderHook(() => useMedia('call-1'));
    expect(result.current.localStream).toBeNull();
  });

  it('should start unmuted', () => {
    const { result } = renderHook(() => useMedia('call-1'));
    expect(result.current.audioMuted).toBe(false);
    expect(result.current.videoMuted).toBe(false);
  });

  it('should toggle audio', async () => {
    const { result } = renderHook(() => useMedia('call-1'));
    await act(async () => {});
    act(() => { result.current.muteAudio(); });
    expect(result.current.audioMuted).toBe(true);
    act(() => { result.current.unmuteAudio(); });
    expect(result.current.audioMuted).toBe(false);
  });

  it('should toggle video', async () => {
    const { result } = renderHook(() => useMedia('call-1'));
    await act(async () => {});
    act(() => { result.current.muteVideo(); });
    expect(result.current.videoMuted).toBe(true);
    act(() => { result.current.unmuteVideo(); });
    expect(result.current.videoMuted).toBe(false);
  });

  it('should toggleAudio shortcut', async () => {
    const { result } = renderHook(() => useMedia('call-1'));
    await act(async () => {});
    act(() => { result.current.toggleAudio(); });
    expect(result.current.audioMuted).toBe(true);
    act(() => { result.current.toggleAudio(); });
    expect(result.current.audioMuted).toBe(false);
  });

  it('should toggleVideo shortcut', async () => {
    const { result } = renderHook(() => useMedia('call-1'));
    await act(async () => {});
    act(() => { result.current.toggleVideo(); });
    expect(result.current.videoMuted).toBe(true);
    act(() => { result.current.toggleVideo(); });
    expect(result.current.videoMuted).toBe(false);
  });
});
