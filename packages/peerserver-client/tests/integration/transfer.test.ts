import { describe, it, expect, afterEach } from 'vitest';
import { connectPair, establishP2P, cleanup, waitForEvent, TIMEOUT, delay } from './setup';
import { FileTransfer } from '../../src/transfer';
import type { PeerClient } from '../../src/core/client';
import type { FileMetadata, TransferProgress } from '../../src/core/types';

if (typeof Blob === 'undefined') {
  const { Blob: NodeBlob } = require('buffer');
  (globalThis as any).Blob = NodeBlob;
}

function createTestBlob(sizeBytes: number, fill = 0xAB): Blob {
  const buf = new Uint8Array(sizeBytes);
  buf.fill(fill);
  return new Blob([buf]);
}

function createTestFile(sizeBytes: number, name: string, fill = 0xAB): File {
  const buf = new Uint8Array(sizeBytes);
  buf.fill(fill);
  if (typeof File !== 'undefined') {
    return new File([buf], name, { type: 'application/octet-stream' });
  }
  const blob = new Blob([buf]) as any;
  blob.name = name;
  blob.lastModified = Date.now();
  return blob as File;
}

let clients: PeerClient[] = [];

afterEach(() => {
  cleanup(...clients);
  clients = [];
});

describe('FileTransfer Integration', { timeout: 30000 }, () => {
  it('should transfer a small file (1KB)', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const file = createTestFile(1024, 'small.bin', 0xCD);

    const offIncoming = ftReceiver.handleIncoming(peerB);

    const completePromise = new Promise<{ blob: Blob; meta: FileMetadata }>((resolve) => {
      ftReceiver.on('incoming', (meta: FileMetadata) => {
        ftReceiver.accept(meta.id);
      });
      ftReceiver.on('complete', (id: string, blob: Blob, meta: FileMetadata) => {
        resolve({ blob, meta });
      });
    });

    await ftSender.send(peerA, file, 'small.bin');
    const result = await completePromise;

    expect(result.meta.filename).toBe('small.bin');
    expect(result.meta.size).toBe(1024);
    expect(result.blob.size).toBe(1024);

    const received = new Uint8Array(await result.blob.arrayBuffer());
    expect(received.every((b) => b === 0xCD)).toBe(true);

    offIncoming();
    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should transfer a medium file (256KB)', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const size = 256 * 1024;
    const file = createTestFile(size, 'medium.bin', 0xEF);

    ftReceiver.handleIncoming(peerB);

    const completePromise = new Promise<Blob>((resolve) => {
      ftReceiver.on('incoming', (meta: FileMetadata) => ftReceiver.accept(meta.id));
      ftReceiver.on('complete', (_id: string, blob: Blob) => resolve(blob));
    });

    await ftSender.send(peerA, file, 'medium.bin');
    const blob = await completePromise;

    expect(blob.size).toBe(size);
    const received = new Uint8Array(await blob.arrayBuffer());
    expect(received.every((b) => b === 0xEF)).toBe(true);

    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should transfer a 1MB file', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const size = 1024 * 1024;
    const file = createTestFile(size, 'one-mb.bin', 0x42);

    ftReceiver.handleIncoming(peerB);

    const completePromise = new Promise<Blob>((resolve) => {
      ftReceiver.on('incoming', (meta: FileMetadata) => ftReceiver.accept(meta.id));
      ftReceiver.on('complete', (_id: string, blob: Blob) => resolve(blob));
    });

    await ftSender.send(peerA, file, 'one-mb.bin');
    const blob = await completePromise;

    expect(blob.size).toBe(size);

    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should emit progress events', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const file = createTestFile(128 * 1024, 'progress.bin');
    const progressEvents: TransferProgress[] = [];

    ftSender.on('progress', (p: TransferProgress) => progressEvents.push(p));

    ftReceiver.handleIncoming(peerB);
    ftReceiver.on('incoming', (meta: FileMetadata) => ftReceiver.accept(meta.id));

    const completePromise = new Promise<void>((resolve) => {
      ftReceiver.on('complete', () => resolve());
    });

    await ftSender.send(peerA, file, 'progress.bin');
    await completePromise;

    expect(progressEvents.length).toBeGreaterThan(0);
    const last = progressEvents[progressEvents.length - 1];
    expect(last.percentage).toBe(100);
    expect(last.bytesPerSecond).toBeGreaterThan(0);

    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should reject incoming transfer', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const file = createTestFile(1024, 'reject.bin');

    ftReceiver.handleIncoming(peerB);
    ftReceiver.on('incoming', (meta: FileMetadata) => {
      ftReceiver.reject(meta.id);
    });

    const cancelledPromise = new Promise<string>((resolve) => {
      ftSender.on('cancelled', (id: string) => resolve(id));
    });

    const sendPromise = ftSender.send(peerA, file, 'reject.bin');

    const [cancelId] = await Promise.all([
      cancelledPromise,
      sendPromise.catch(() => {}),
    ]);

    expect(cancelId).toBeTruthy();

    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should cancel ongoing transfer from sender side', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const file = createTestFile(512 * 1024, 'cancel.bin');
    let transferId = '';

    ftReceiver.handleIncoming(peerB);
    ftReceiver.on('incoming', (meta: FileMetadata) => {
      transferId = meta.id;
      ftReceiver.accept(meta.id);
    });

    const cancelledPromise = new Promise<string>((resolve) => {
      ftSender.on('cancelled', (id: string) => resolve(id));
    });

    ftSender.on('progress', (p: TransferProgress) => {
      if (p.percentage > 10 && transferId) {
        ftSender.cancel(transferId);
      }
    });

    const sendResult = ftSender.send(peerA, file, 'cancel.bin').catch(() => 'cancelled');
    const [cancelId, result] = await Promise.all([cancelledPromise, sendResult]);

    expect(cancelId).toBeTruthy();
    expect(result).toBe('cancelled');

    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should include correct metadata', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const file = createTestFile(2048, 'meta-test.dat', 0x01);

    ftReceiver.handleIncoming(peerB);

    const metaPromise = new Promise<FileMetadata>((resolve) => {
      ftReceiver.on('incoming', (meta: FileMetadata) => {
        resolve(meta);
        ftReceiver.accept(meta.id);
      });
    });

    const completePromise = new Promise<void>((resolve) => {
      ftReceiver.on('complete', () => resolve());
    });

    ftSender.send(peerA, file, 'meta-test.dat');
    const meta = await metaPromise;
    await completePromise;

    expect(meta.filename).toBe('meta-test.dat');
    expect(meta.size).toBe(2048);
    expect(meta.totalChunks).toBeGreaterThan(0);
    expect(meta.chunkSize).toBe(65536);

    ftSender.destroy();
    ftReceiver.destroy();
  });

  it('should verify data integrity across transfer', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const ftSender = new FileTransfer(a);
    const ftReceiver = new FileTransfer(b);

    const pattern = new Uint8Array(4096);
    for (let i = 0; i < pattern.length; i++) pattern[i] = i % 256;
    const file = createTestFile(0, 'integrity.bin');
    const realFile = new Blob([pattern]) as any;
    realFile.name = 'integrity.bin';
    realFile.lastModified = Date.now();

    ftReceiver.handleIncoming(peerB);

    const completePromise = new Promise<Blob>((resolve) => {
      ftReceiver.on('incoming', (meta: FileMetadata) => ftReceiver.accept(meta.id));
      ftReceiver.on('complete', (_id: string, blob: Blob) => resolve(blob));
    });

    await ftSender.send(peerA, realFile, 'integrity.bin');
    const blob = await completePromise;

    const received = new Uint8Array(await blob.arrayBuffer());
    expect(received.length).toBe(pattern.length);
    for (let i = 0; i < pattern.length; i++) {
      expect(received[i]).toBe(pattern[i]);
    }

    ftSender.destroy();
    ftReceiver.destroy();
  });
});
