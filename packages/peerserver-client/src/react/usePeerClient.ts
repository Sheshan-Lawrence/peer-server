import { usePeerContext } from './PeerProvider';

export function usePeerClient() {
  const { client, connected, fingerprint, alias, error } = usePeerContext();
  return { client, connected, fingerprint, alias, error };
}
