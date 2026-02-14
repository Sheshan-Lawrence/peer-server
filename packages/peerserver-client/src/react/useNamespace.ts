import { useEffect, useState, useCallback } from 'react';
import { usePeerContext } from './PeerProvider';
import type { PeerInfo } from '../core/types';

export function useNamespace(namespace: string) {
  const { client } = usePeerContext();
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !namespace) return;

    const offJoined = client.on('peer_joined', (info: PeerInfo) => {
      setPeers((prev) => [...prev.filter((p) => p.fingerprint !== info.fingerprint), info]);
    });

    const offLeft = client.on('peer_left', (fp: string) => {
      setPeers((prev) => prev.filter((p) => p.fingerprint !== fp));
    });

    client.join(namespace)
      .then((list: PeerInfo[]) => {
        setPeers(list.filter((p) => p.fingerprint !== client.fingerprint));
        setJoined(true);
      })
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))));

    return () => {
      offJoined();
      offLeft();
      client.leave(namespace);
      setJoined(false);
      setPeers([]);
    };
  }, [client, namespace]);

  const discover = useCallback(async (limit?: number) => {
    if (!client) return [];
    const result = await client.discover(namespace, limit);
    return result;
  }, [client, namespace]);

  return { peers, joined, discover, error };
}
