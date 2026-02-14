import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Emitter } from '../src/core/emitter';
import { FileTransfer, JSONTransfer } from '../src/transfer';
import { MockRTCDataChannel } from './setup';

function mockClient(fp = 'fp-local') {
  const emitter = new Emitter();
  const peers = new Map<string, any>();
  return {
    fingerprint: fp,
    on: (event: string, fn: any) => emitter.on(event as any, fn),
    emit: (event: string, ...args: any[]) => emitter.emit(event as any, ...args),
    getPeer: vi.fn((f: string) => peers.get(f)),
    relay: vi.fn(),
    broadcast: vi.fn(),
    _peers: peers,
    _emitter: emitter,
  } as any;
}

function mockPeer(fp = 'fp-remote') {
  const emitter = new Emitter();
  const channels = new Map<string, MockRTCDataChannel>();
  return {
    fingerprint: fp,
    connectionState: 'connected',
    on: (event: string, fn: any) => emitter.on(event as any, fn),
    emit: (event: string, ...args: any[]) => emitter.emit(event as any, ...args),
    send: vi.fn(),
    sendBinary: vi.fn(),
    createDataChannel: vi.fn((config: any) => {
      const ch = new MockRTCDataChannel(config.label ?? 'data', config);
      channels.set(ch.label, ch);
      setTimeout(() => ch.simulateOpen(), 5);
      return ch;
    }),
    getChannel: (label: string) => channels.get(label),
    close: vi.fn(),
    _channels: channels,
    _emitter: emitter,
  } as any;
}

function createBlob(size: number): Blob {
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) buffer[i] = i % 256;
  return new Blob([buffer]);
}

describe('FileTransfer', () => {
  it('should send offer on send()', async () => {
    const client = mockClient();
    const peer = mockPeer();
    const ft = new FileTransfer(client);
    const blob = createBlob(100);

    const sendPromise = ft.send(peer, blob, 'test.bin');

    await new Promise((r) => setTimeout(r, 10));

    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        _ft: true,
        type: 'offer',
        filename: 'test.bin',
        size: 100,
        totalChunks: 1,
      }),
      'data',
    );

    ft.destroy();
  });

  it('should reject send if peer not connected', async () => {
    const client = mockClient();
    const peer = mockPeer();
    peer.connectionState = 'new';
    const ft = new FileTransfer(client);

    await expect(ft.send(peer, createBlob(10))).rejects.toThrow('Peer not connected');
    ft.destroy();
  });

  it('should calculate correct chunk count', async () => {
    const client = mockClient();
    const peer = mockPeer();
    const ft = new FileTransfer(client);

    const blob = createBlob(65536 * 3 + 100);
    ft.send(peer, blob, 'multi.bin');
    await new Promise((r) => setTimeout(r, 10));

    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ totalChunks: 4 }),
      'data',
    );

    ft.destroy();
  });

  it('should handle incoming offer and emit incoming event', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const fn = vi.fn();
    ft.on('incoming', fn);

    ft.handleIncoming(peer);
    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-1',
      filename: 'photo.jpg',
      size: 5000,
      mime: 'image/jpeg',
      chunkSize: 65536,
      totalChunks: 1,
    }, 'data');

    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tx-1', filename: 'photo.jpg' }),
      'fp-remote',
    );

    ft.destroy();
  });

  it('should accept incoming transfer', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-2',
      filename: 'f.txt',
      size: 100,
      mime: 'text/plain',
      chunkSize: 65536,
      totalChunks: 1,
    }, 'data');

    ft.accept('tx-2');
    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ _ft: true, type: 'accept', id: 'tx-2' }),
      'data',
    );

    ft.destroy();
  });

  it('should reject incoming transfer', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-3',
      filename: 'f.txt',
      size: 100,
      mime: 'text/plain',
      chunkSize: 65536,
      totalChunks: 1,
    }, 'data');

    ft.reject('tx-3');
    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ _ft: true, type: 'cancel', id: 'tx-3' }),
      'data',
    );

    ft.destroy();
  });

  it('should track receive progress', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-4',
      filename: 'f.bin',
      size: 65536 * 3,
      mime: 'application/octet-stream',
      chunkSize: 65536,
      totalChunks: 3,
    }, 'data');

    const progress = ft.getReceiveProgress('tx-4');
    expect(progress).toEqual({
      id: 'tx-4',
      sent: 0,
      total: 3,
      percentage: 0,
    });

    ft.destroy();
  });

  it('should emit progress on binary chunks', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const progressFn = vi.fn();
    ft.on('progress', progressFn);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-5',
      filename: 'f.bin',
      size: 200,
      mime: 'application/octet-stream',
      chunkSize: 100,
      totalChunks: 2,
    }, 'data');

    const chunkData = new Uint8Array(100).fill(0xAA);
    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, 0, true);
    const combined = new Uint8Array(4 + 100);
    combined.set(new Uint8Array(header), 0);
    combined.set(chunkData, 4);

    peer.emit('data', combined.buffer, 'ft-tx-5');

    expect(progressFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tx-5', sent: 1, total: 2 }),
    );

    ft.destroy();
  });

  it('should assemble complete file', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const completeFn = vi.fn();
    ft.on('complete', completeFn);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-6',
      filename: 'small.bin',
      size: 8,
      mime: 'application/octet-stream',
      chunkSize: 65536,
      totalChunks: 1,
    }, 'data');

    const chunkData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, 0, true);
    const combined = new Uint8Array(4 + 8);
    combined.set(new Uint8Array(header), 0);
    combined.set(chunkData, 4);

    peer.emit('data', combined.buffer, 'ft-tx-6');

    peer.emit('data', { _ft: true, type: 'complete', id: 'tx-6' }, 'data');

    expect(completeFn).toHaveBeenCalledWith(
      'tx-6',
      expect.any(Blob),
      expect.objectContaining({ filename: 'small.bin' }),
      'fp-remote',
    );

    ft.destroy();
  });

  it('should report error on missing chunks at complete', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const errorFn = vi.fn();
    ft.on('error', errorFn);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-7',
      filename: 'missing.bin',
      size: 65536 * 2,
      mime: 'application/octet-stream',
      chunkSize: 65536,
      totalChunks: 2,
    }, 'data');

    peer.emit('data', { _ft: true, type: 'complete', id: 'tx-7' }, 'data');

    expect(errorFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tx-7', message: expect.stringContaining('Missing chunk') }),
    );

    ft.destroy();
  });

  it('should cancel receive', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const cancelFn = vi.fn();
    ft.on('cancelled', cancelFn);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-8',
      filename: 'cancel.bin',
      size: 100,
      mime: 'application/octet-stream',
      chunkSize: 65536,
      totalChunks: 1,
    }, 'data');

    ft.cancel('tx-8');
    expect(cancelFn).toHaveBeenCalledWith('tx-8');
    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ _ft: true, type: 'cancel', id: 'tx-8' }),
      'data',
    );

    ft.destroy();
  });

  it('should cancel send from remote', async () => {
    const client = mockClient();
    const peer = mockPeer();
    const ft = new FileTransfer(client);
    const cancelFn = vi.fn();
    ft.on('cancelled', cancelFn);

    const blob = createBlob(65536 * 100);
    const sendP = ft.send(peer, blob, 'big.bin').catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const offerId = peer.send.mock.calls[0]?.[0]?.id;
    if (offerId) {
      peer.emit('data', { _ft: true, type: 'cancel', id: offerId }, 'data');
      await new Promise((r) => setTimeout(r, 10));
      expect(cancelFn).toHaveBeenCalledWith(offerId);
    }

    ft.destroy();
  });

  it('should not double-count duplicate chunks', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-dup',
      filename: 'dup.bin',
      size: 200,
      mime: 'application/octet-stream',
      chunkSize: 100,
      totalChunks: 2,
    }, 'data');

    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, 0, true);
    const combined = new Uint8Array(4 + 100);
    combined.set(new Uint8Array(header), 0);
    combined.set(new Uint8Array(100).fill(1), 4);

    peer.emit('data', combined.buffer, 'ft-tx-dup');
    peer.emit('data', combined.buffer, 'ft-tx-dup');

    const progress = ft.getReceiveProgress('tx-dup');
    expect(progress!.sent).toBe(1);

    ft.destroy();
  });

  it('should ignore chunks with out-of-bounds index', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-oob',
      filename: 'oob.bin',
      size: 100,
      mime: 'application/octet-stream',
      chunkSize: 100,
      totalChunks: 1,
    }, 'data');

    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, 999, true);
    const combined = new Uint8Array(4 + 10);
    combined.set(new Uint8Array(header), 0);

    peer.emit('data', combined.buffer, 'ft-tx-oob');

    const progress = ft.getReceiveProgress('tx-oob');
    expect(progress!.sent).toBe(0);

    ft.destroy();
  });

  it('should ignore binary for wrong channel prefix', () => {
    const client = mockClient();
    const peer = mockPeer();
    const ft = new FileTransfer(client);
    ft.handleIncoming(peer);

    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, 0, true);
    const combined = new Uint8Array(4 + 10);
    combined.set(new Uint8Array(header), 0);

    expect(() => peer.emit('data', combined.buffer, 'other-channel')).not.toThrow();

    ft.destroy();
  });

  it('should handle multi-chunk file assembly in order', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const completeFn = vi.fn();
    ft.on('complete', completeFn);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-multi',
      filename: 'multi.bin',
      size: 6,
      mime: 'application/octet-stream',
      chunkSize: 3,
      totalChunks: 2,
    }, 'data');

    for (let i = 0; i < 2; i++) {
      const chunk = new Uint8Array(i === 0 ? [1, 2, 3] : [4, 5, 6]);
      const header = new ArrayBuffer(4);
      new DataView(header).setUint32(0, i, true);
      const combined = new Uint8Array(4 + chunk.length);
      combined.set(new Uint8Array(header), 0);
      combined.set(chunk, 4);
      peer.emit('data', combined.buffer, 'ft-tx-multi');
    }

    peer.emit('data', { _ft: true, type: 'complete', id: 'tx-multi' }, 'data');

    expect(completeFn).toHaveBeenCalled();
    const blob: Blob = completeFn.mock.calls[0][1];
    expect(blob.size).toBe(6);

    ft.destroy();
  });

  it('should handle out-of-order chunks', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);

    const ft = new FileTransfer(client);
    const completeFn = vi.fn();
    ft.on('complete', completeFn);
    ft.handleIncoming(peer);

    peer.emit('data', {
      _ft: true,
      type: 'offer',
      id: 'tx-ooo',
      filename: 'ooo.bin',
      size: 6,
      mime: 'application/octet-stream',
      chunkSize: 3,
      totalChunks: 2,
    }, 'data');

    for (const i of [1, 0]) {
      const chunk = new Uint8Array(i === 0 ? [1, 2, 3] : [4, 5, 6]);
      const header = new ArrayBuffer(4);
      new DataView(header).setUint32(0, i, true);
      const combined = new Uint8Array(4 + chunk.length);
      combined.set(new Uint8Array(header), 0);
      combined.set(chunk, 4);
      peer.emit('data', combined.buffer, 'ft-tx-ooo');
    }

    peer.emit('data', { _ft: true, type: 'complete', id: 'tx-ooo' }, 'data');

    expect(completeFn).toHaveBeenCalled();

    ft.destroy();
  });

  it('should timeout if peer never accepts', async () => {
    const client = mockClient();
    const peer = mockPeer();
    const ft = new FileTransfer(client);

    vi.useFakeTimers();
    let error: Error | null = null;
    const p = ft.send(peer, createBlob(10), 'timeout.bin').catch((e) => { error = e; });
    await vi.advanceTimersByTimeAsync(31000);
    await p;

    expect(error).toBeTruthy();
    expect(error!.message).toContain('timeout');
    vi.useRealTimers();
    ft.destroy();
  });

  it('should destroy and cancel all active transfers', () => {
    const client = mockClient();
    const ft = new FileTransfer(client);
    ft.destroy();
    expect(ft.getReceiveProgress('nonexistent')).toBeNull();
  });
});

describe('JSONTransfer', () => {
  it('should send to peer via P2P', () => {
    const client = mockClient();
    const peer = mockPeer();
    client._peers.set('fp-remote', peer);
    client.getPeer.mockReturnValue(peer);

    const jt = new JSONTransfer(client);
    jt.sendToPeer('fp-remote', { msg: 'hi' });
    expect(peer.send).toHaveBeenCalledWith(
      expect.objectContaining({ _json_transfer: true, data: { msg: 'hi' } }),
      'data',
    );
  });

  it('should fallback to relay when peer not connected', () => {
    const client = mockClient();
    client.getPeer.mockReturnValue(undefined);

    const jt = new JSONTransfer(client);
    jt.sendToPeer('fp-remote', { msg: 'relay' });
    expect(client.relay).toHaveBeenCalledWith('fp-remote', expect.objectContaining({
      _json_transfer: true,
    }));
  });

  it('should send to room', () => {
    const client = mockClient();
    const jt = new JSONTransfer(client);
    jt.sendToRoom('room1', { msg: 'all' });
    expect(client.broadcast).toHaveBeenCalledWith('room1', expect.objectContaining({
      _json_transfer: true,
    }));
  });

  it('should receive from peer', () => {
    const client = mockClient();
    const peer = mockPeer();
    const jt = new JSONTransfer(client);

    const fn = vi.fn();
    jt.onReceive(peer, fn);
    peer.emit('data', { _json_transfer: true, data: { hello: true } });
    expect(fn).toHaveBeenCalledWith({ hello: true }, 'fp-remote');
  });

  it('should ignore non-json-transfer messages', () => {
    const client = mockClient();
    const peer = mockPeer();
    const jt = new JSONTransfer(client);

    const fn = vi.fn();
    jt.onReceive(peer, fn);
    peer.emit('data', { other: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('should receive relay messages', () => {
    const client = mockClient();
    const jt = new JSONTransfer(client);

    const fn = vi.fn();
    jt.onRelayReceive(fn);
    client.emit('relay', 'fp-sender', { _json_transfer: true, data: { relayed: true } });
    expect(fn).toHaveBeenCalledWith({ relayed: true }, 'fp-sender');
  });

  it('should receive broadcast messages', () => {
    const client = mockClient();
    const jt = new JSONTransfer(client);

    const fn = vi.fn();
    jt.onBroadcastReceive('room1', fn);
    client.emit('broadcast', 'fp-sender', 'room1', { _json_transfer: true, data: { bcast: true } });
    expect(fn).toHaveBeenCalledWith({ bcast: true }, 'fp-sender');
  });

  it('should ignore broadcast from different room', () => {
    const client = mockClient();
    const jt = new JSONTransfer(client);

    const fn = vi.fn();
    jt.onBroadcastReceive('room1', fn);
    client.emit('broadcast', 'fp-sender', 'room2', { _json_transfer: true, data: {} });
    expect(fn).not.toHaveBeenCalled();
  });
});
