import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { Peer } from './core/peer';
import type { FileMetadata, TransferProgress, TransferControl } from './core/types';
import { LIMITS } from './core/types';

type TransferEvent =
  | 'incoming'
  | 'progress'
  | 'complete'
  | 'error'
  | 'cancelled';

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function encodeChunk(index: number, data: ArrayBuffer): ArrayBuffer {
  const header = new ArrayBuffer(4);
  new DataView(header).setUint32(0, index, true);
  const combined = new Uint8Array(4 + data.byteLength);
  combined.set(new Uint8Array(header), 0);
  combined.set(new Uint8Array(data), 4);
  return combined.buffer;
}

function decodeChunk(buffer: ArrayBuffer): { index: number; data: ArrayBuffer } {
  const view = new DataView(buffer);
  const index = view.getUint32(0, true);
  const data = buffer.slice(4);
  return { index, data };
}

interface ActiveSend {
  id: string;
  file: File | Blob;
  filename: string;
  peer: Peer;
  channel: RTCDataChannel;
  totalChunks: number;
  chunkSize: number;
  currentIndex: number;
  cancelled: boolean;
  paused: boolean;
  startTime: number;
  bytesSent: number;
  resolve: (id: string) => void;
  reject: (e: Error) => void;
}

interface ActiveReceive {
  id: string;
  meta: FileMetadata;
  chunks: (ArrayBuffer | null)[];
  received: number;
  from: string;
  startTime: number;
}

export class FileTransfer extends Emitter<TransferEvent> {
  private client: PeerClient;
  private sending = new Map<string, ActiveSend>();
  private receiving = new Map<string, ActiveReceive>();
  private channelListeners = new Map<string, () => void>();

  constructor(client: PeerClient) {
    super();
    this.client = client;
  }

  async send(peer: Peer, file: File | Blob, filename?: string): Promise<string> {
    if (peer.connectionState !== 'connected') {
      throw new Error('Peer not connected — P2P required for file transfer');
    }

    const id = uid();
    const name = filename ?? (file instanceof File ? file.name : 'file');
    const chunkSize = LIMITS.CHUNK_SIZE;
    const totalChunks = Math.ceil(file.size / chunkSize);

    const channelLabel = `${LIMITS.TRANSFER_CHANNEL_PREFIX}${id}`;
    const channel = peer.createDataChannel({
      label: channelLabel,
      ordered: true,
    });

    const offer: TransferControl = {
      _ft: true,
      type: 'offer',
      id,
      filename: name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      chunkSize,
      totalChunks,
    };
    peer.send(offer, 'data');

    return new Promise((resolve, reject) => {
      const active: ActiveSend = {
        id,
        file,
        filename: name,
        peer,
        channel,
        totalChunks,
        chunkSize,
        currentIndex: 0,
        cancelled: false,
        paused: false,
        startTime: Date.now(),
        bytesSent: 0,
        resolve,
        reject,
      };
      this.sending.set(id, active);

      const offData = peer.on('data', (data: any) => {
        if (!data?._ft || data.id !== id) return;
        if (data.type === 'accept') {
          this.startSending(active);
        } else if (data.type === 'cancel') {
          this.cancelSend(id);
        } else if (data.type === 'ack') {
          this.handleAck(id, data.index);
        } else if (data.type === 'resume') {
          active.currentIndex = data.lastIndex + 1;
          this.startSending(active);
        }
      });

      this.channelListeners.set(id, offData);

      const timeout = setTimeout(() => {
        if (this.sending.has(id) && active.currentIndex === 0 && !active.cancelled) {
          this.cleanupSend(id);
          reject(new Error('Transfer offer timeout — peer did not accept'));
        }
      }, 30000);

      const origResolve = active.resolve;
      active.resolve = (rid) => {
        clearTimeout(timeout);
        origResolve(rid);
      };
      const origReject = active.reject;
      active.reject = (e) => {
        clearTimeout(timeout);
        origReject(e);
      };
    });
  }

  accept(id: string): void {
    const recv = this.receiving.get(id);
    if (!recv) return;

    const peer = this.client.getPeer(recv.from);
    if (!peer) return;

    const control: TransferControl = { _ft: true, type: 'accept', id };
    peer.send(control, 'data');
  }

  reject(id: string): void {
    const recv = this.receiving.get(id);
    if (!recv) return;

    const peer = this.client.getPeer(recv.from);
    if (peer) {
      const control: TransferControl = { _ft: true, type: 'cancel', id };
      peer.send(control, 'data');
    }
    this.receiving.delete(id);
  }

  cancel(id: string): void {
    if (this.sending.has(id)) {
      this.cancelSend(id);
    }
    if (this.receiving.has(id)) {
      const recv = this.receiving.get(id)!;
      const peer = this.client.getPeer(recv.from);
      if (peer) {
        const control: TransferControl = { _ft: true, type: 'cancel', id };
        try { peer.send(control, 'data'); } catch {}
      }
      this.receiving.delete(id);
      this.emit('cancelled', id);
    }
  }

  handleIncoming(peer: Peer): () => void {
    const offData = peer.on('data', (data: any, channel: string) => {
      if (data instanceof ArrayBuffer) {
        this.handleBinaryChunk(data, peer.fingerprint, channel);
        return;
      }
      if (data?._ft) {
        this.handleControl(data, peer.fingerprint);
      }
    });
    return offData;
  }

  requestResume(id: string, lastIndex: number): void {
    const recv = this.receiving.get(id);
    if (!recv) return;
    const peer = this.client.getPeer(recv.from);
    if (peer) {
      const control: TransferControl = { _ft: true, type: 'resume', id, lastIndex };
      peer.send(control, 'data');
    }
  }

  getReceiveProgress(id: string): TransferProgress | null {
    const recv = this.receiving.get(id);
    if (!recv) return null;
    return {
      id,
      sent: recv.received,
      total: recv.meta.totalChunks,
      percentage: Math.round((recv.received / recv.meta.totalChunks) * 100),
    };
  }

  private handleControl(data: TransferControl, from: string): void {
    if (data.type === 'offer') {
      const meta: FileMetadata = {
        id: data.id,
        filename: data.filename,
        size: data.size,
        mime: data.mime,
        totalChunks: data.totalChunks,
        chunkSize: data.chunkSize,
      };

      const recv: ActiveReceive = {
        id: data.id,
        meta,
        chunks: new Array(data.totalChunks).fill(null),
        received: 0,
        from,
        startTime: Date.now(),
      };
      this.receiving.set(data.id, recv);
      this.emit('incoming', meta, from);
    } else if (data.type === 'complete') {
      this.assembleFile(data.id);
    } else if (data.type === 'cancel') {
      if (this.sending.has(data.id)) {
        this.cancelSend(data.id);
      }
      if (this.receiving.has(data.id)) {
        this.receiving.delete(data.id);
        this.emit('cancelled', data.id);
      }
    }
  }

  private handleBinaryChunk(buffer: ArrayBuffer, from: string, channel: string): void {
    if (!channel.startsWith(LIMITS.TRANSFER_CHANNEL_PREFIX)) return;
    const transferId = channel.slice(LIMITS.TRANSFER_CHANNEL_PREFIX.length);
    const recv = this.receiving.get(transferId);
    if (!recv || recv.from !== from) return;

    const { index, data } = decodeChunk(buffer);
    if (index >= recv.meta.totalChunks) return;

    if (recv.chunks[index] === null) {
      recv.chunks[index] = data;
      recv.received++;
    }

    const elapsed = (Date.now() - recv.startTime) / 1000 || 1;
    const bytesReceived = recv.received * recv.meta.chunkSize;
    const progress: TransferProgress = {
      id: transferId,
      sent: recv.received,
      total: recv.meta.totalChunks,
      percentage: Math.round((recv.received / recv.meta.totalChunks) * 100),
      bytesPerSecond: Math.round(bytesReceived / elapsed),
    };
    this.emit('progress', progress);

    if (recv.received % LIMITS.ACK_INTERVAL === 0) {
      const peer = this.client.getPeer(from);
      if (peer) {
        const ack: TransferControl = { _ft: true, type: 'ack', id: transferId, index };
        try { peer.send(ack, 'data'); } catch {}
      }
    }
  }

  private async startSending(active: ActiveSend): Promise<void> {
    const { channel } = active;

    if (channel.readyState !== 'open') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Transfer channel open timeout')), 15000);
        channel.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    }

    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LIMITS.BUFFERED_AMOUNT_LOW;

    const sendNext = async (): Promise<void> => {
      while (active.currentIndex < active.totalChunks && !active.cancelled) {
        if (channel.bufferedAmount > LIMITS.BUFFERED_AMOUNT_HIGH) {
          await new Promise<void>((resolve) => {
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              resolve();
            };
          });
          if (active.cancelled) break;
        }

        const start = active.currentIndex * active.chunkSize;
        const end = Math.min(start + active.chunkSize, active.file.size);
        const slice = active.file.slice(start, end);
        const buffer = await new Response(slice).arrayBuffer();
        const encoded = encodeChunk(active.currentIndex, buffer);

        try {
          channel.send(encoded);
        } catch (e) {
          this.cleanupSend(active.id);
          active.reject(new Error(`Send failed at chunk ${active.currentIndex}: ${e}`));
          return;
        }

        active.bytesSent += buffer.byteLength;
        active.currentIndex++;

        const elapsed = (Date.now() - active.startTime) / 1000 || 1;
        const progress: TransferProgress = {
          id: active.id,
          sent: active.currentIndex,
          total: active.totalChunks,
          percentage: Math.round((active.currentIndex / active.totalChunks) * 100),
          bytesPerSecond: Math.round(active.bytesSent / elapsed),
        };
        this.emit('progress', progress);

        if (active.currentIndex % 50 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      if (!active.cancelled && active.currentIndex >= active.totalChunks) {
        // Ensure the buffer is empty before closing the channel and sending completion.
        // This prevents race conditions where 'complete' message arrives before the last chunk.
        try {
          while (channel.bufferedAmount > 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
        } catch (e) {}
        
        // Small safety delay to ensure underlying transport flush
        await new Promise((r) => setTimeout(r, 10));

        const complete: TransferControl = { _ft: true, type: 'complete', id: active.id };
        try { active.peer.send(complete, 'data'); } catch {}
        this.emit('complete', active.id, 'sent');
        this.cleanupSend(active.id);
        active.resolve(active.id);
      }
    };

    sendNext().catch((e) => {
      this.cleanupSend(active.id);
      active.reject(e);
    });
  }

  private handleAck(_id: string, _index: number): void {
  }

  private assembleFile(id: string): void {
    const recv = this.receiving.get(id);
    if (!recv) return;

    const missing = recv.chunks.findIndex((c) => c === null);
    if (missing !== -1 && missing < recv.meta.totalChunks) {
      this.emit('error', { id, message: `Missing chunk ${missing}` });
      return;
    }

    const parts = recv.chunks.filter((c): c is ArrayBuffer => c !== null);
    const blob = new Blob(parts, { type: recv.meta.mime });

    this.receiving.delete(id);
    this.emit('complete', id, blob, recv.meta, recv.from);
  }

  private cancelSend(id: string): void {
    const active = this.sending.get(id);
    if (!active) return;
    active.cancelled = true;
    this.cleanupSend(id);
    this.emit('cancelled', id);
    active.reject(new Error('Transfer cancelled'));
  }

  private cleanupSend(id: string): void {
    const active = this.sending.get(id);
    if (active) {
      try { active.channel.close(); } catch {}
    }
    this.sending.delete(id);
    const offData = this.channelListeners.get(id);
    if (offData) {
      offData();
      this.channelListeners.delete(id);
    }
  }

  destroy(): void {
    this.sending.forEach((_, id) => {
      const active = this.sending.get(id);
      if (active) active.cancelled = true;
    });
    this.sending.forEach((_, id) => this.cleanupSend(id));
    this.receiving.clear();
    this.removeAllListeners();
  }
}

export class JSONTransfer {
  private client: PeerClient;

  constructor(client: PeerClient) {
    this.client = client;
  }

  sendToPeer(fingerprint: string, data: any, channel = 'data'): void {
    const peer = this.client.getPeer(fingerprint);
    if (peer && peer.connectionState === 'connected') {
      try {
        peer.send({ _json_transfer: true, data }, channel);
        return;
      } catch {}
    }
    this.client.relay(fingerprint, { _json_transfer: true, data });
  }

  sendToRoom(roomId: string, data: any): void {
    this.client.broadcast(roomId, { _json_transfer: true, data });
  }

  onReceive(peer: Peer, callback: (data: any, from: string) => void): () => void {
    return peer.on('data', (raw: any) => {
      if (raw?._json_transfer) {
        callback(raw.data, peer.fingerprint);
      }
    });
  }

  onRelayReceive(callback: (data: any, from: string) => void): () => void {
    return this.client.on('relay', (from: string, payload: any) => {
      if (payload?._json_transfer) {
        callback(payload.data, from);
      }
    });
  }

  onBroadcastReceive(roomId: string, callback: (data: any, from: string) => void): () => void {
    return this.client.on('broadcast', (from: string, ns: string, payload: any) => {
      if (ns === roomId && payload?._json_transfer) {
        callback(payload.data, from);
      }
    });
  }
}

export class ImageTransfer extends Emitter<TransferEvent> {
  private ft: FileTransfer;
  private client: PeerClient;

  constructor(client: PeerClient) {
    super();
    this.client = client;
    this.ft = new FileTransfer(client);

    this.ft.on('progress', (...args: any[]) => this.emit('progress', ...args));
    this.ft.on('incoming', (...args: any[]) => this.emit('incoming', ...args));
    this.ft.on('cancelled', (...args: any[]) => this.emit('cancelled', ...args));
    this.ft.on('complete', (...args: any[]) => this.emit('complete', ...args));
    this.ft.on('error', (...args: any[]) => this.emit('error', ...args));
  }

  getFileTransfer(): FileTransfer {
    return this.ft;
  }

  async send(peer: Peer, image: File | Blob, filename?: string): Promise<string> {
    return this.ft.send(peer, image, filename);
  }

  accept(id: string): void {
    this.ft.accept(id);
  }

  reject(id: string): void {
    this.ft.reject(id);
  }

  cancel(id: string): void {
    this.ft.cancel(id);
  }

  handleIncoming(peer: Peer): () => void {
    return this.ft.handleIncoming(peer);
  }

  destroy(): void {
    this.ft.destroy();
    this.removeAllListeners();
  }
}