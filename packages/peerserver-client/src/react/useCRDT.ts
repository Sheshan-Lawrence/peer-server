import { useEffect, useState, useCallback, useRef } from 'react';
import { usePeerContext } from './PeerProvider';
import { CRDTSync } from '../sync';

export function useCRDT(roomId: string, Y: any) {
  const { client } = usePeerContext();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const crdtRef = useRef<CRDTSync | null>(null);
  const yRef = useRef(Y);
  yRef.current = Y;

  useEffect(() => {
    if (!client || !roomId || !yRef.current) return;

    const crdt = new CRDTSync(client, roomId, yRef.current);
    crdtRef.current = crdt;
    crdt.start();
    setReady(true);

    return () => {
      crdt.destroy();
      crdtRef.current = null;
      setReady(false);
    };
  }, [client, roomId]);

  const getDoc = useCallback(() => {
    return crdtRef.current?.getDoc() ?? null;
  }, []);

  const getMap = useCallback((name: string) => {
    return crdtRef.current?.getMap(name) ?? null;
  }, []);

  const getText = useCallback((name: string) => {
    return crdtRef.current?.getText(name) ?? null;
  }, []);

  const getArray = useCallback((name: string) => {
    return crdtRef.current?.getArray(name) ?? null;
  }, []);

  return { ready, getDoc, getMap, getText, getArray, error };
}
