// tests/react/useIdentity.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/core/identity', () => {
  class Identity {
    fingerprint = '';
    generate = vi.fn(async function(this: any) { this.fingerprint = 'fp-gen-' + Math.random().toString(36).slice(2, 6); });
    restore = vi.fn(async function(this: any, keys: any) { this.fingerprint = keys.fingerprint || 'fp-restored'; });
    export = vi.fn(async function(this: any) { return { publicKey: 'pub', privateKey: 'priv', fingerprint: this.fingerprint }; });
  }
  return { Identity };
});

import { renderHook, act } from './setup';
import { useIdentity } from '../../src/react/useIdentity';

const store: Record<string, string> = {};
const mockStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k in store) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
};

Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

describe('useIdentity', () => {
  beforeEach(() => { mockStorage.clear(); });

  it('should generate on first mount', async () => {
    const { result } = renderHook(() => useIdentity('id-1'));
    await act(async () => {});
    expect(result.current.ready).toBe(true);
    expect(result.current.fingerprint).toContain('fp-gen-');
  });

  it('should persist', async () => {
    renderHook(() => useIdentity('id-2'));
    await act(async () => {});
    expect(store['id-2']).toBeTruthy();
    expect(JSON.parse(store['id-2']).publicKey).toBe('pub');
  });

  it('should restore', async () => {
    store['id-3'] = JSON.stringify({ publicKey: 'p', privateKey: 'k', fingerprint: 'fp-saved' });
    const { result } = renderHook(() => useIdentity('id-3'));
    await act(async () => {});
    expect(result.current.ready).toBe(true);
  });

  it('should export', async () => {
    const { result } = renderHook(() => useIdentity('id-4'));
    await act(async () => {});
    let exp: any;
    await act(async () => { exp = await result.current.exportKeys(); });
    expect(exp?.publicKey).toBe('pub');
  });

  it('should regenerate', async () => {
    const { result } = renderHook(() => useIdentity('id-5'));
    await act(async () => {});
    await act(async () => { await result.current.regenerate(); });
    expect(result.current.fingerprint).toBeTruthy();
  });

  it('should clear', async () => {
    const { result } = renderHook(() => useIdentity('id-6'));
    await act(async () => {});
    act(() => { result.current.clear(); });
    expect(result.current.fingerprint).toBe('');
    expect(result.current.ready).toBe(false);
    expect(store['id-6']).toBeUndefined();
  });
});