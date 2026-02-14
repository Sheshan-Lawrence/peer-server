import { useEffect, useState, useCallback } from 'react';
import { usePeerContext } from './PeerProvider';

interface BroadcastMessage {
  from: string;
  namespace: string;
  payload: any;
  ts: number;
}

export function useBroadcast(namespace: string) {
  const { client } = usePeerContext();
  const [messages, setMessages] = useState<BroadcastMessage[]>([]);

  useEffect(() => {
    if (!client || !namespace) return;

    const off = client.on('broadcast', (from: string, ns: string, payload: any) => {
      if (ns === namespace) {
        setMessages((prev) => [...prev, { from, namespace: ns, payload, ts: Date.now() }]);
      }
    });

    return () => { off(); };
  }, [client, namespace]);

  const send = useCallback((payload: any) => {
    client?.broadcast(namespace, payload);
  }, [client, namespace]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, send, clear };
}
