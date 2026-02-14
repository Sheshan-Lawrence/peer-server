import { useEffect, useState, useCallback, useRef } from 'react';
import { usePeerContext } from './PeerProvider';
import { GroupKeyManager } from '../crypto';
import type { Peer } from '../core/peer';

export function useE2E() {
  const { client } = usePeerContext();
  const [ready, setReady] = useState(false);
  const [exchangedPeers, setExchangedPeers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<Error | null>(null);
  const kmRef = useRef<GroupKeyManager | null>(null);

  useEffect(() => {
    if (!client) return;

    const km = new GroupKeyManager(client);
    kmRef.current = km;

    km.init()
      .then(() => setReady(true))
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))));

    return () => {
      km.destroy();
      kmRef.current = null;
      setReady(false);
      setExchangedPeers(new Set());
    };
  }, [client]);

  const exchange = useCallback(async (peer: Peer) => {
    if (!kmRef.current) throw new Error('E2E not initialized');
    await kmRef.current.exchangeWith(peer);
    setExchangedPeers((prev) => new Set(prev).add(peer.fingerprint));
  }, []);

  const handleIncoming = useCallback(async (peer: Peer, data: any) => {
    if (!kmRef.current) return;
    await kmRef.current.handleIncomingKeyExchange(peer, data);
    if (kmRef.current.getE2E().hasKey(peer.fingerprint)) {
      setExchangedPeers((prev) => new Set(prev).add(peer.fingerprint));
    }
  }, []);

  const encrypt = useCallback(async (fingerprint: string, data: any): Promise<string> => {
    if (!kmRef.current) throw new Error('E2E not initialized');
    return kmRef.current.encryptForPeer(fingerprint, data);
  }, []);

  const decrypt = useCallback(async (fingerprint: string, data: string): Promise<any> => {
    if (!kmRef.current) throw new Error('E2E not initialized');
    return kmRef.current.decryptFromPeer(fingerprint, data);
  }, []);

  const hasKey = useCallback((fingerprint: string): boolean => {
    return kmRef.current?.getE2E().hasKey(fingerprint) ?? false;
  }, []);

  return {
    ready,
    exchangedPeers,
    exchange,
    handleIncoming,
    encrypt,
    decrypt,
    hasKey,
    error,
  };
}
