import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import { PeerClient } from '../core/client';
import type { ClientConfig } from '../core/types';

interface PeerContextValue {
  client: PeerClient | null;
  connected: boolean;
  fingerprint: string;
  alias: string;
  error: Error | null;
}

const PeerContext = createContext<PeerContextValue>({
  client: null,
  connected: false,
  fingerprint: '',
  alias: '',
  error: null,
});

export function usePeerContext(): PeerContextValue {
  return useContext(PeerContext);
}

interface PeerProviderProps {
  config: ClientConfig;
  children: ReactNode;
}

export function PeerProvider({ config, children }: PeerProviderProps) {
  const [client, setClient] = useState<PeerClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [fingerprint, setFingerprint] = useState('');
  const [alias, setAlias] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const c = new PeerClient(configRef.current);
    setClient(c);

    const offRegistered = c.on('registered', (fp: string, a: string) => {
      setFingerprint(fp);
      setAlias(a);
    });
    const offDisconnected = c.on('disconnected', () => setConnected(false));
    const offReconnected = c.on('reconnected', () => setConnected(true));
    const offError = c.on('error', (e: any) => setError(e instanceof Error ? e : new Error(String(e))));

    c.connect()
      .then(() => setConnected(true))
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))));

    return () => {
      offRegistered();
      offDisconnected();
      offReconnected();
      offError();
      c.disconnect();
      setClient(null);
      setConnected(false);
    };
  }, [config.url]);

  return (
    <PeerContext.Provider value={{ client, connected, fingerprint, alias, error }}>
      {children}
    </PeerContext.Provider>
  );
}
