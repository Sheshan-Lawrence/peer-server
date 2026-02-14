import { useEffect, useState, useCallback, useRef } from 'react';
import { Identity } from '../core/identity';
import type { IdentityKeys } from '../core/types';

const STORAGE_KEY = 'peerlib_identity';

export function useIdentity(persistKey = STORAGE_KEY) {
  const [ready, setReady] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const idRef = useRef<Identity | null>(null);

  useEffect(() => {
    const id = new Identity();
    idRef.current = id;

    const init = async () => {
      try {
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(persistKey) : null;
        if (stored) {
          await id.restore(JSON.parse(stored));
        } else {
          await id.generate();
          const exported = await id.export();
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(persistKey, JSON.stringify(exported));
          }
        }
        setFingerprint(id.fingerprint);
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    init();

    return () => { idRef.current = null; };
  }, [persistKey]);

  const exportKeys = useCallback(async (): Promise<IdentityKeys | null> => {
    if (!idRef.current) return null;
    return idRef.current.export();
  }, []);

  const regenerate = useCallback(async () => {
    if (!idRef.current) return;
    try {
      await idRef.current.generate();
      const exported = await idRef.current.export();
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(persistKey, JSON.stringify(exported));
      }
      setFingerprint(idRef.current.fingerprint);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [persistKey]);

  const clear = useCallback(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(persistKey);
    }
    setFingerprint('');
    setReady(false);
  }, [persistKey]);

  return { ready, fingerprint, exportKeys, regenerate, clear, error };
}
