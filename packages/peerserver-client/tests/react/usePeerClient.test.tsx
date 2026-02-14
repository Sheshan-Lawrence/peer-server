import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, createMockClient, setupContext, getMockContext } from './setup';

vi.mock('../../src/react/PeerProvider', () => ({
  usePeerContext: () => getMockContext(),
}));

import { usePeerClient } from '../../src/react/usePeerClient';

describe('usePeerClient', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    setupContext(client);
  });

  it('should return client from context', () => {
    const { result } = renderHook(() => usePeerClient());
    expect(result.current.client).toBe(client);
  });

  it('should return connected state', () => {
    const { result } = renderHook(() => usePeerClient());
    expect(result.current.connected).toBe(true);
  });

  it('should return fingerprint', () => {
    const { result } = renderHook(() => usePeerClient());
    expect(result.current.fingerprint).toBe('fp-test-abc');
  });

  it('should return alias', () => {
    const { result } = renderHook(() => usePeerClient());
    expect(result.current.alias).toBe('test-user');
  });

  it('should return null error', () => {
    const { result } = renderHook(() => usePeerClient());
    expect(result.current.error).toBeNull();
  });
});
