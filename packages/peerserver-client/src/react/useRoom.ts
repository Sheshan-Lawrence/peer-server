import { useEffect, useState, useCallback, useRef } from 'react';
import { usePeerContext } from './PeerProvider';
import { DirectRoom, GroupRoom } from '../room';
import type { PeerInfo } from '../core/types';

interface RoomMessage {
  data: any;
  from: string;
  ts: number;
}

export function useRoom(
  roomId: string,
  type: 'direct' | 'group' = 'direct',
  create = false,
  maxSize = 20,
) {
  const { client } = usePeerContext();
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const roomRef = useRef<DirectRoom | GroupRoom | null>(null);

  useEffect(() => {
    if (!client || !roomId) return;

    const room = type === 'group'
      ? new GroupRoom(client, roomId, maxSize)
      : new DirectRoom(client, roomId);
    roomRef.current = room;

    room.on('peer_joined', (info: PeerInfo) => {
      setPeers((prev) => [...prev.filter((p) => p.fingerprint !== info.fingerprint), info]);
    });

    room.on('peer_left', (fp: string) => {
      setPeers((prev) => prev.filter((p) => p.fingerprint !== fp));
    });

    room.on('data', (data: any, from: string) => {
      setMessages((prev) => [...prev, { data, from, ts: Date.now() }]);
    });

    room.on('error', (e: any) => {
      setError(e instanceof Error ? e : new Error(String(e)));
    });

    const init = async () => {
      try {
        if (create) {
          await room.create();
        } else {
          const peerList = await room.join();
          const others = peerList.filter((p: PeerInfo) => p.fingerprint !== client.fingerprint);
          setPeers(others);
        }
        setJoined(true);
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    init();

    return () => {
      room.close();
      roomRef.current = null;
      setJoined(false);
      setPeers([]);
    };
  }, [client, roomId, type, maxSize, create]);

  const send = useCallback((data: any, to?: string) => {
    const room = roomRef.current;
    if (!room) return;
    if (room instanceof GroupRoom) {
      room.send(data, to);
    } else {
      (room as DirectRoom).send(data);
    }
  }, []);

  const clearMessages = useCallback(() => setMessages([]), []);

  return { joined, peers, messages, send, clearMessages, error, room: roomRef.current };
}
