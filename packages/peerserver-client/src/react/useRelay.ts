import { useEffect, useState, useCallback } from 'react';
import { usePeerContext } from './PeerProvider';

interface RelayMessage {
  from: string;
  payload: any;
  ts: number;
}

export function useRelay() {
  const { client } = usePeerContext();
  const [messages, setMessages] = useState<RelayMessage[]>([]);

  useEffect(() => {
    if (!client) return;

    const off = client.on('relay', (from: string, payload: any) => {
      setMessages((prev) => [...prev, { from, payload, ts: Date.now() }]);
    });

    return () => { off(); };
  }, [client]);

  const send = useCallback((to: string, payload: any) => {
    client?.relay(to, payload);
  }, [client]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, send, clear };
}
