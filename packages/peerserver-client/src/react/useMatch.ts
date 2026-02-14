import { useState, useCallback } from 'react';
import { usePeerContext } from './PeerProvider';
import type { PeerInfo, MatchResult } from '../core/types';

type MatchStatus = 'idle' | 'matching' | 'matched' | 'error';

export function useMatch() {
  const { client } = usePeerContext();
  const [status, setStatus] = useState<MatchStatus>('idle');
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState<Error | null>(null);

  const match = useCallback(async (namespace: string, meta?: Record<string, any>, count?: number) => {
    if (!client) return;
    setStatus('matching');
    setError(null);
    try {
      const result: MatchResult = await client.match(namespace, meta, count);
      setPeers(result.peers);
      setSessionId(result.session_id);
      setStatus('matched');
      return result;
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setStatus('error');
    }
  }, [client]);

  const reset = useCallback(() => {
    setStatus('idle');
    setPeers([]);
    setSessionId('');
    setError(null);
  }, []);

  return { match, status, peers, sessionId, reset, error };
}
