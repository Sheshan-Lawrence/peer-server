import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Emitter } from '../src/core/emitter';
import { DirectRoom, GroupRoom } from '../src/room';

function mockClient() {
  const emitter = new Emitter();
  return {
    fingerprint: 'fp-me',
    on: (event: string, fn: any) => emitter.on(event as any, fn),
    emit: (event: string, ...args: any[]) => emitter.emit(event as any, ...args),
    createRoom: vi.fn(async () => ({ room_id: 'r1', max_size: 20, owner: 'fp-me' })),
    joinRoom: vi.fn(async () => []),
    connectToPeer: vi.fn((_fp: string, _alias?: string) => mockPeer(_fp)),
    createPeer: vi.fn((_fp: string, _alias: string) => mockPeer(_fp)),
    getPeer: vi.fn(),
    relay: vi.fn(),
    broadcast: vi.fn(),
    leave: vi.fn(),
    kick: vi.fn(),
  } as any;
}

function mockPeer(fp = 'fp-remote') {
  const emitter = new Emitter();
  return {
    fingerprint: fp,
    connectionState: 'connected',
    on: (event: string, fn: any) => emitter.on(event as any, fn),
    emit: (event: string, ...args: any[]) => emitter.emit(event as any, ...args),
    send: vi.fn(),
    close: vi.fn(),
    createOffer: vi.fn(),
  } as any;
}

describe('DirectRoom', () => {
  it('should create room', async () => {
    const client = mockClient();
    const room = new DirectRoom(client, 'r1');
    await room.create();
    expect(client.createRoom).toHaveBeenCalledWith('r1', { maxSize: 2 });
  });

  it('should join room and connect to existing peer', async () => {
    const client = mockClient();
    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-other', alias: 'other' },
    ]);

    const room = new DirectRoom(client, 'r1');
    await room.join();
    expect(client.connectToPeer).toHaveBeenCalledWith('fp-other', 'other');
  });

  it('should emit peer_joined on new peer', async () => {
    const client = mockClient();
    const room = new DirectRoom(client, 'r1');
    await room.create();

    const fn = vi.fn();
    room.on('peer_joined', fn);
    client.emit('peer_joined', { fingerprint: 'fp-new', alias: 'new' });
    expect(fn).toHaveBeenCalled();
  });

  it('should send via P2P when connected', async () => {
    const client = mockClient();
    const peer = mockPeer();
    client.connectToPeer.mockReturnValue(peer);

    const room = new DirectRoom(client, 'r1');
    await room.create();
    client.emit('peer_joined', { fingerprint: 'fp-new', alias: 'new' });

    room.send({ msg: 'hello' });
    expect(peer.send).toHaveBeenCalledWith({ msg: 'hello' });
  });

  it('should fallback to relay when P2P fails', async () => {
    const client = mockClient();
    const peer = mockPeer();
    peer.connectionState = 'disconnected';
    client.connectToPeer.mockReturnValue(peer);

    const room = new DirectRoom(client, 'r1');
    await room.create();
    client.emit('peer_joined', { fingerprint: 'fp-new', alias: 'new' });

    room.send({ msg: 'hello' });
    expect(client.relay).toHaveBeenCalled();
  });

  it('should handle relay data', async () => {
    const client = mockClient();
    const peer = mockPeer();
    client.connectToPeer.mockReturnValue(peer);

    const room = new DirectRoom(client, 'r1');
    await room.create();
    client.emit('peer_joined', { fingerprint: 'fp-new', alias: 'new' });

    const fn = vi.fn();
    room.on('data', fn);
    client.emit('relay', 'fp-new', { _room: 'r1', data: { msg: 'hi' } });
    expect(fn).toHaveBeenCalledWith({ msg: 'hi' }, 'fp-new');
  });

  it('should close and cleanup', async () => {
    const client = mockClient();
    const room = new DirectRoom(client, 'r1');
    await room.create();

    const fn = vi.fn();
    room.on('closed', fn);
    room.close();
    expect(fn).toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith('r1');
  });

  it('should close on kick', async () => {
    const client = mockClient();
    const room = new DirectRoom(client, 'r1');
    await room.create();

    const fn = vi.fn();
    room.on('closed', fn);
    client.emit('kicked', { room_id: 'r1' });
    expect(fn).toHaveBeenCalled();
  });

  it('should not double close', async () => {
    const client = mockClient();
    const room = new DirectRoom(client, 'r1');
    await room.create();
    room.close();
    expect(() => room.close()).not.toThrow();
  });
});

describe('GroupRoom', () => {
  it('should create room', async () => {
    const client = mockClient();
    const room = new GroupRoom(client, 'r1', 10);
    await room.create();
    expect(client.createRoom).toHaveBeenCalledWith('r1', { maxSize: 10 });
  });

  it('should join and connect to existing peers', async () => {
    const client = mockClient();
    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-a', alias: 'a' },
      { fingerprint: 'fp-b', alias: 'b' },
    ]);

    const room = new GroupRoom(client, 'r1');
    await room.join();
    expect(client.connectToPeer).toHaveBeenCalledTimes(2);
  });

  it('should send to all peers', async () => {
    const client = mockClient();
    const peerA = mockPeer('fp-a');
    const peerB = mockPeer('fp-b');
    let callCount = 0;
    client.connectToPeer.mockImplementation((fp: string) => {
      return fp === 'fp-a' ? peerA : peerB;
    });

    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-a', alias: 'a' },
      { fingerprint: 'fp-b', alias: 'b' },
    ]);

    const room = new GroupRoom(client, 'r1');
    await room.join();

    room.send({ msg: 'hi' });
    expect(peerA.send).toHaveBeenCalled();
    expect(peerB.send).toHaveBeenCalled();
  });

  it('should send to specific peer', async () => {
    const client = mockClient();
    const peer = mockPeer('fp-a');
    client.connectToPeer.mockReturnValue(peer);
    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-a', alias: 'a' },
    ]);

    const room = new GroupRoom(client, 'r1');
    await room.join();
    room.send({ msg: 'dm' }, 'fp-a');
    expect(peer.send).toHaveBeenCalledWith({ msg: 'dm' });
  });

  it('should report peer count', async () => {
    const client = mockClient();
    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-a', alias: 'a' },
    ]);

    const room = new GroupRoom(client, 'r1');
    await room.join();
    expect(room.getPeerCount()).toBe(1);
  });

  it('should broadcast via server', async () => {
    const client = mockClient();
    const room = new GroupRoom(client, 'r1');
    await room.create();
    room.broadcastViaServer({ msg: 'all' });
    expect(client.broadcast).toHaveBeenCalledWith('r1', { msg: 'all' });
  });

  it('should handle broadcast data event', async () => {
    const client = mockClient();
    const room = new GroupRoom(client, 'r1');
    await room.create();

    const fn = vi.fn();
    room.on('data', fn);
    client.emit('broadcast', 'fp-x', 'r1', { msg: 'test' });
    expect(fn).toHaveBeenCalledWith({ msg: 'test' }, 'fp-x');
  });

  it('should kick peer', async () => {
    const client = mockClient();
    const room = new GroupRoom(client, 'r1');
    await room.create();
    room.kick('fp-bad');
    expect(client.kick).toHaveBeenCalledWith('r1', 'fp-bad');
  });

  it('should close and cleanup', async () => {
    const client = mockClient();
    const room = new GroupRoom(client, 'r1');
    await room.create();
    const fn = vi.fn();
    room.on('closed', fn);
    room.close();
    expect(fn).toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith('r1');
  });

  it('should promote relay peers when P2P peer leaves', async () => {
    const client = mockClient();
    const peers = new Map();
    let connectCount = 0;
    client.connectToPeer.mockImplementation((fp: string) => {
      connectCount++;
      const p = mockPeer(fp);
      peers.set(fp, p);
      return p;
    });

    client.joinRoom.mockResolvedValue([{ fingerprint: 'fp-me', alias: 'me' }]);
    const room = new GroupRoom(client, 'r1');
    await room.join();

    for (let i = 0; i < 31; i++) {
      client.emit('peer_joined', { fingerprint: `fp-${i}`, alias: `p${i}` });
    }

    expect(room.getPeerCount()).toBe(31);

    client.emit('peer_left', 'fp-0');
    expect(room.getPeerCount()).toBe(30);
  });
});
