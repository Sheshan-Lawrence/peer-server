import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PeerClient } from '../src/core/client';
import { MockWebSocket } from './setup';

let lastWs: MockWebSocket;

beforeEach(() => {
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      lastWs = this;
    }
  };
});

function createClient(url = 'ws://test'): PeerClient {
  return new PeerClient({
    url,
    autoReconnect: false,
    pingInterval: 60000,
  });
}

async function connectClient(client: PeerClient): Promise<void> {
  const p = client.connect();
  lastWs.simulateOpen();
  await new Promise((r) => setTimeout(r, 50));
  lastWs.simulateMessage({
    type: 'registered',
    payload: { fingerprint: 'fp-123', alias: 'test-alias' },
  });
  await p;
}

describe('PeerClient', () => {
  it('should connect and register', async () => {
    const client = createClient();
    await connectClient(client);
    expect(client.fingerprint).toBe('fp-123');
    expect(client.alias).toBe('test-alias');
    expect(client.connected).toBe(true);
  });

  it('should emit registered event', async () => {
    const client = createClient();
    const fn = vi.fn();
    client.on('registered', fn);
    await connectClient(client);
    expect(fn).toHaveBeenCalledWith('fp-123', 'test-alias');
  });

  it('should join namespace and receive peer_list', async () => {
    const client = createClient();
    await connectClient(client);

    const joinP = client.join('chat', 'chat', '1.0');
    lastWs.simulateMessage({
      type: 'peer_list',
      namespace: 'chat',
      payload: { peers: [{ fingerprint: 'fp-other', alias: 'bob' }] },
    });

    const peers = await joinP;
    expect(peers).toHaveLength(1);
    expect(peers[0].fingerprint).toBe('fp-other');
  });

  it('should leave namespace', async () => {
    const client = createClient();
    await connectClient(client);
    client.leave('chat');
    expect(lastWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"leave"'),
    );
  });

  it('should discover peers', async () => {
    const client = createClient();
    await connectClient(client);

    const p = client.discover('lobby', 10);
    lastWs.simulateMessage({
      type: 'peer_list',
      namespace: 'lobby',
      payload: { peers: [{ fingerprint: 'fp-x', alias: 'x' }] },
    });

    const peers = await p;
    expect(peers).toHaveLength(1);
  });

  it('should handle match', async () => {
    const client = createClient();
    await connectClient(client);

    const p = client.match('game', { skill: 'beginner' });
    lastWs.simulateMessage({
      type: 'matched',
      payload: {
        namespace: 'game',
        session_id: 'sess-1',
        peers: [{ fingerprint: 'fp-opp', alias: 'opp' }],
      },
    });

    const result = await p;
    expect(result.session_id).toBe('sess-1');
  });

  it('should emit peer_joined', async () => {
    const client = createClient();
    await connectClient(client);

    const fn = vi.fn();
    client.on('peer_joined', fn);
    lastWs.simulateMessage({
      type: 'peer_joined',
      payload: { fingerprint: 'fp-new', alias: 'newbie' },
    });
    expect(fn).toHaveBeenCalledWith({ fingerprint: 'fp-new', alias: 'newbie' });
  });

  it('should emit peer_left and clean up peer', async () => {
    const client = createClient();
    await connectClient(client);

    lastWs.simulateMessage({
      type: 'signal',
      from: 'fp-peer',
      payload: { signal_type: 'offer', sdp: 'test' },
    });
    expect(client.getPeer('fp-peer')).toBeDefined();

    const fn = vi.fn();
    client.on('peer_left', fn);
    lastWs.simulateMessage({ type: 'peer_left', from: 'fp-peer' });
    expect(fn).toHaveBeenCalledWith('fp-peer');
    expect(client.getPeer('fp-peer')).toBeUndefined();
  });

  it('should create peer on incoming signal', async () => {
    const client = createClient();
    await connectClient(client);

    lastWs.simulateMessage({
      type: 'signal',
      from: 'fp-remote',
      payload: { signal_type: 'offer', sdp: 'remote-sdp' },
    });

    const peer = client.getPeer('fp-remote');
    expect(peer).toBeDefined();
    expect(peer!.fingerprint).toBe('fp-remote');
  });

  it('should reuse existing peer on duplicate signal', async () => {
    const client = createClient();
    await connectClient(client);

    lastWs.simulateMessage({
      type: 'signal',
      from: 'fp-x',
      payload: { signal_type: 'offer', sdp: 'sdp1' },
    });
    const p1 = client.getPeer('fp-x');

    lastWs.simulateMessage({
      type: 'signal',
      from: 'fp-x',
      payload: { signal_type: 'candidate', candidate: '{}' },
    });
    const p2 = client.getPeer('fp-x');
    expect(p1).toBe(p2);
  });

  it('should relay messages', async () => {
    const client = createClient();
    await connectClient(client);

    client.relay('fp-target', { hello: true });
    expect(lastWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"relay"'),
    );
  });

  it('should broadcast messages', async () => {
    const client = createClient();
    await connectClient(client);

    client.broadcast('room1', { msg: 'hi' });
    expect(lastWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"broadcast"'),
    );
  });

  it('should emit relay event', async () => {
    const client = createClient();
    await connectClient(client);

    const fn = vi.fn();
    client.on('relay', fn);
    lastWs.simulateMessage({
      type: 'relay',
      from: 'fp-sender',
      payload: { data: 'test' },
    });
    expect(fn).toHaveBeenCalledWith('fp-sender', { data: 'test' });
  });

  it('should emit broadcast event', async () => {
    const client = createClient();
    await connectClient(client);

    const fn = vi.fn();
    client.on('broadcast', fn);
    lastWs.simulateMessage({
      type: 'broadcast',
      from: 'fp-sender',
      namespace: 'room1',
      payload: { data: { msg: 'hi' } },
    });
    expect(fn).toHaveBeenCalled();
  });

  it('should handle error and reject register', async () => {
    const client = createClient();
    const p = client.connect();
    lastWs.simulateOpen();
    await new Promise((r) => setTimeout(r, 50));
    lastWs.simulateMessage({ type: 'error', payload: 'registration failed' });
    await expect(p).rejects.toThrow('registration failed');
  });

  it('should create room', async () => {
    const client = createClient();
    await connectClient(client);

    const p = client.createRoom('room-1', { maxSize: 5 });
    lastWs.simulateMessage({
      type: 'room_created',
      payload: { room_id: 'room-1', max_size: 5, owner: 'fp-123' },
    });

    const result = await p;
    expect(result.room_id).toBe('room-1');
  });

  it('should join room', async () => {
    const client = createClient();
    await connectClient(client);

    const p = client.joinRoom('room-1');
    lastWs.simulateMessage({
      type: 'peer_list',
      namespace: 'room-1',
      payload: { peers: [] },
    });

    const peers = await p;
    expect(peers).toEqual([]);
  });

  it('should handle room_closed', async () => {
    const client = createClient();
    await connectClient(client);

    const fn = vi.fn();
    client.on('room_closed', fn);
    lastWs.simulateMessage({
      type: 'room_closed',
      payload: { room_id: 'room-1' },
    });
    expect(fn).toHaveBeenCalled();
  });

  it('should handle kicked', async () => {
    const client = createClient();
    await connectClient(client);

    const fn = vi.fn();
    client.on('kicked', fn);
    lastWs.simulateMessage({
      type: 'kick',
      payload: { room_id: 'room-1' },
    });
    expect(fn).toHaveBeenCalled();
  });

  it('should disconnect and clear state', async () => {
    const client = createClient();
    await connectClient(client);

    client.createPeer('fp-x', 'x');
    expect(client.peerMap.size).toBe(1);

    client.disconnect();
    expect(client.peerMap.size).toBe(0);
    expect(client.connected).toBe(false);
  });

  it('should close specific peer', async () => {
    const client = createClient();
    await connectClient(client);

    client.createPeer('fp-x', 'x');
    expect(client.getPeer('fp-x')).toBeDefined();

    client.closePeer('fp-x');
    expect(client.getPeer('fp-x')).toBeUndefined();
  });

  it('should update metadata', async () => {
    const client = createClient();
    await connectClient(client);

    client.updateMetadata({ role: 'admin' });
    expect(lastWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"metadata"'),
    );
  });

  it('should expose identity and transport', async () => {
    const client = createClient();
    await connectClient(client);
    expect(client.getIdentity()).toBeDefined();
    expect(client.getTransport()).toBeDefined();
  });

  it('roomInfo should resolve and clean up listener', async () => {
    const client = createClient();
    await connectClient(client);

    const p = client.roomInfo('room-1');

    lastWs.simulateMessage({
      type: 'room_info' as any,
      payload: { room_id: 'room-1', peer_count: 3, max_size: 10, owner: 'fp-123' },
    });

    const info = await p;
    expect(info.room_id).toBe('room-1');
    expect(info.peer_count).toBe(3);
  });
});
