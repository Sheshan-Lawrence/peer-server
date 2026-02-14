import { useEffect, useState, useCallback, useRef } from 'react';
import { usePeerContext } from './PeerProvider';
import { StateSync } from '../sync';
import type { SyncMode } from '../core/types';

export function useSync(
  roomId: string,
  mode: SyncMode = 'lww',
  merge?: (local: any, remote: any) => any,
) {
  const { client } = usePeerContext();
  const [state, setState] = useState<Record<string, any>>({});
  const [error, setError] = useState<Error | null>(null);
  const syncRef = useRef<StateSync | null>(null);
  const mergeRef = useRef(merge);
  mergeRef.current = merge;

  useEffect(() => {
    if (!client || !roomId) return;

    const sync = new StateSync(client, roomId, { mode, merge: mergeRef.current });
    syncRef.current = sync;
    sync.start();

    sync.on('state_changed', () => {
      setState(sync.getAll());
    });

    sync.on('error', (e: any) => {
      setError(e instanceof Error ? e : new Error(String(e)));
    });

    return () => {
      sync.destroy();
      syncRef.current = null;
      setState({});
    };
  }, [client, roomId, mode]);

  const set = useCallback((key: string, value: any) => {
    syncRef.current?.set(key, value);
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const del = useCallback((key: string) => {
    syncRef.current?.delete(key);
    setState((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const get = useCallback((key: string) => {
    return syncRef.current?.get(key);
  }, []);

  return { state, set, delete: del, get, error };
}
