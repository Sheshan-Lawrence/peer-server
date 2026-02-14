import { useEffect, useState, useCallback, useRef } from 'react';
import { usePeerContext } from './PeerProvider';
import { FileTransfer } from '../transfer';
import type { Peer } from '../core/peer';
import type { FileMetadata, TransferProgress } from '../core/types';

interface Transfer {
  id: string;
  filename: string;
  size: number;
  direction: 'send' | 'receive';
  from?: string;
  progress: number;
  bytesPerSecond: number;
  status: 'pending' | 'active' | 'complete' | 'cancelled' | 'error';
  blob?: Blob;
  meta?: FileMetadata;
}

export type { Transfer };

export function useFileTransfer() {
  const { client } = usePeerContext();
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const ftRef = useRef<FileTransfer | null>(null);
  const cleanupRefs = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!client) return;
    ftRef.current = new FileTransfer(client);
    const ft = ftRef.current;

    ft.on('progress', (p: TransferProgress) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(p.id);
        if (t) {
          next.set(p.id, { ...t, progress: p.percentage, bytesPerSecond: p.bytesPerSecond ?? 0, status: 'active' });
        }
        return next;
      });
    });

    ft.on('incoming', (meta: FileMetadata, from: string) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        next.set(meta.id, {
          id: meta.id,
          filename: meta.filename,
          size: meta.size,
          direction: 'receive',
          from,
          progress: 0,
          bytesPerSecond: 0,
          status: 'pending',
          meta,
        });
        return next;
      });
    });

    ft.on('complete', (id: string, blob: Blob) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(id);
        if (t) {
          next.set(id, { ...t, progress: 100, status: 'complete', blob: blob instanceof Blob ? blob : undefined });
        }
        return next;
      });
    });

    ft.on('cancelled', (id: string) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(id);
        if (t) next.set(id, { ...t, status: 'cancelled' });
        return next;
      });
    });

    ft.on('error', (err: any) => {
      const id = err?.id;
      if (id) {
        setTransfers((prev) => {
          const next = new Map(prev);
          const t = next.get(id);
          if (t) next.set(id, { ...t, status: 'error' });
          return next;
        });
      }
    });

    return () => {
      cleanupRefs.current.forEach((fn) => fn());
      cleanupRefs.current = [];
      ft.destroy();
      ftRef.current = null;
    };
  }, [client]);

  const send = useCallback(async (peer: Peer, file: File | Blob, filename?: string): Promise<string> => {
    if (!ftRef.current) throw new Error('FileTransfer not initialized');
    const name = filename ?? (file instanceof File ? file.name : 'file');
    const id = crypto.randomUUID();
    setTransfers((prev) => {
      const next = new Map(prev);
      next.set(id, {
        id,
        filename: name,
        size: file.size,
        direction: 'send',
        progress: 0,
        bytesPerSecond: 0,
        status: 'active',
      });
      return next;
    });
    await ftRef.current.send(peer, file, name);
    return id;
  }, []);

  const accept = useCallback((id: string) => {
    ftRef.current?.accept(id);
  }, []);

  const reject = useCallback((id: string) => {
    ftRef.current?.reject(id);
    setTransfers((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const cancel = useCallback((id: string) => {
    ftRef.current?.cancel(id);
  }, []);

  const listenToPeer = useCallback((peer: Peer) => {
    if (!ftRef.current) return () => {};
    const off = ftRef.current.handleIncoming(peer);
    cleanupRefs.current.push(off);
    return off;
  }, []);

  const clearCompleted = useCallback(() => {
    setTransfers((prev) => {
      const next = new Map(prev);
      for (const [id, t] of next) {
        if (t.status === 'complete' || t.status === 'cancelled' || t.status === 'error') {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  return { transfers, send, accept, reject, cancel, listenToPeer, clearCompleted };
}
