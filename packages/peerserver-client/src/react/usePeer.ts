import { useEffect, useState, useCallback } from 'react';
import { usePeerContext } from './PeerProvider';
import type { Peer } from '../core/peer';

export function usePeer(fingerprint: string) {
  const { client } = usePeerContext();
  const [peer, setPeer] = useState<Peer | null>(null);
  const [connectionState, setConnectionState] = useState('new');

  useEffect(() => {
    if (!client || !fingerprint) return;

    const existing = client.getPeer(fingerprint);
    if (existing) {
      setPeer(existing);
      setConnectionState(existing.connectionState);
    }

    const offJoined = client.on('peer_joined', (info: any) => {
      if (info.fingerprint === fingerprint) {
        const p = client.getPeer(fingerprint);
        if (p) {
          setPeer(p);
          setConnectionState(p.connectionState);
        }
      }
    });

    const offLeft = client.on('peer_left', (fp: string) => {
      if (fp === fingerprint) {
        setPeer(null);
        setConnectionState('closed');
      }
    });

    return () => {
      offJoined();
      offLeft();
    };
  }, [client, fingerprint]);

  useEffect(() => {
    if (!peer) return;
    const offConnected = peer.on('connected', () => setConnectionState('connected'));
    const offDisconnected = peer.on('disconnected', (s: string) => setConnectionState(s));
    return () => {
      offConnected();
      offDisconnected();
    };
  }, [peer]);

  const send = useCallback((data: any, channel?: string) => {
    peer?.send(data, channel);
  }, [peer]);

  return { peer, connectionState, send };
}
