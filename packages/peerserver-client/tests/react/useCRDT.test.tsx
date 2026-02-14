import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => ((globalThis as any).__peerlib_mock_context__),
}));

vi.mock('../../src/sync', () => {
  class E{l=new Map();on(e,f){if(!this.l.has(e))this.l.set(e,new Set());this.l.get(e).add(f);return()=>this.l.get(e)?.delete(f);}emit(e,...a){this.l.get(e)?.forEach(f=>f(...a));}}
  class CRDTSync extends E {
    private doc: any;
    constructor(public client: any, public roomId: string, public Y: any) {
      super();
      this.doc = {
        getMap: (n: string) => ({ name: n, type: 'map' }),
        getText: (n: string) => ({ name: n, type: 'text' }),
        getArray: (n: string) => ({ name: n, type: 'array' }),
      };
    }
    start = vi.fn();
    destroy = vi.fn();
    getDoc() { return this.doc; }
    getMap(name: string) { return this.doc.getMap(name); }
    getText(name: string) { return this.doc.getText(name); }
    getArray(name: string) { return this.doc.getArray(name); }
  }
  class StateSync extends E {
    constructor(public client: any, public roomId: string, public config: any) { super(); }
    start = vi.fn();
    destroy = vi.fn();
    set() {}
    delete() {}
    get() {}
    getAll() { return {}; }
  }
  return { CRDTSync, StateSync };
});

import { renderHook, act, createMockClient, setupContext } from './setup';
import { useCRDT } from '../../src/react/useCRDT';

describe('useCRDT', () => {
  let client: ReturnType<typeof createMockClient>;
  const Y = {};
  beforeEach(() => { client = createMockClient(); setupContext(client); });

  it('should not init without roomId', () => {
    const { result } = renderHook(() => useCRDT('', Y));
    expect(result.current.ready).toBe(false);
  });

  it('should init with roomId', async () => {
    const { result } = renderHook(() => useCRDT('collab', Y));
    await act(async () => {});
    expect(result.current.ready).toBe(true);
  });

  it('should getDoc', async () => {
    const { result } = renderHook(() => useCRDT('collab', Y));
    await act(async () => {});
    expect(result.current.getDoc()).toBeTruthy();
  });

  it('should getMap', async () => {
    const { result } = renderHook(() => useCRDT('collab', Y));
    await act(async () => {});
    expect(result.current.getMap('shared')?.name).toBe('shared');
  });

  it('should getText', async () => {
    const { result } = renderHook(() => useCRDT('collab', Y));
    await act(async () => {});
    expect(result.current.getText('doc')?.name).toBe('doc');
  });

  it('should getArray', async () => {
    const { result } = renderHook(() => useCRDT('collab', Y));
    await act(async () => {});
    expect(result.current.getArray('items')?.name).toBe('items');
  });

  it('should clean up on unmount', async () => {
    const { unmount } = renderHook(() => useCRDT('collab', Y));
    await act(async () => {});
    unmount();
  });
});
