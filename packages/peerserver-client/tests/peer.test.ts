import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Peer } from '../src/core/peer';
import { MockRTCPeerConnection, MockRTCDataChannel } from './setup';

function createPeer(sendSignal?: (p: any) => void): { peer: Peer; pc: MockRTCPeerConnection } {
  const send = sendSignal ?? vi.fn();
  const peer = new Peer('fp-abc', 'alice', [{ urls: 'stun:stun.l.google.com:19302' }], send);
  const pc = peer.pc as unknown as MockRTCPeerConnection;
  return { peer, pc };
}

describe('Peer', () => {
  it('should store fingerprint and alias', () => {
    const { peer } = createPeer();
    expect(peer.fingerprint).toBe('fp-abc');
    expect(peer.alias).toBe('alice');
  });

  it('should create offer and send signal', async () => {
    const send = vi.fn();
    const { peer } = createPeer(send);
    await peer.createOffer();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ signal_type: 'offer', sdp: 'mock-offer-sdp' }),
    );
  });

  it('should create data channel on offer', async () => {
    const { peer } = createPeer();
    await peer.createOffer({ label: 'test' });
    expect(peer.channelLabels).toContain('test');
  });

  it('should handle offer signal and respond with answer', async () => {
    const send = vi.fn();
    const { peer, pc } = createPeer(send);
    await peer.handleSignal({ signal_type: 'offer', sdp: 'remote-offer' });
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'remote-offer' });
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ signal_type: 'answer', sdp: 'mock-answer-sdp' }),
    );
  });

  it('should handle answer signal', async () => {
    const { peer, pc } = createPeer();
    await peer.handleSignal({ signal_type: 'answer', sdp: 'remote-answer' });
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'remote-answer' });
  });

  it('should buffer candidates before remote description', async () => {
    const { peer, pc } = createPeer();
    await peer.handleSignal({
      signal_type: 'candidate',
      candidate: JSON.stringify({ candidate: 'test', sdpMid: '0' }),
    });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await peer.handleSignal({ signal_type: 'answer', sdp: 'remote-answer' });
    expect(pc.addIceCandidate).toHaveBeenCalled();
  });

  it('should add ice candidate after remote description is set', async () => {
    const { peer, pc } = createPeer();
    await peer.handleSignal({ signal_type: 'offer', sdp: 'offer' });
    await peer.handleSignal({
      signal_type: 'candidate',
      candidate: JSON.stringify({ candidate: 'c1' }),
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'c1' });
  });

  it('should emit connected on connectionState change', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('connected', fn);
    pc.simulateConnected();
    expect(fn).toHaveBeenCalled();
  });

  it('should emit disconnected on failed/disconnected/closed', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('disconnected', fn);
    pc.simulateDisconnected();
    expect(fn).toHaveBeenCalledWith('disconnected');
  });

  it('should emit datachannel:create on incoming channel', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('datachannel:create', fn);
    pc.simulateDataChannel('incoming-ch');
    expect(fn).toHaveBeenCalled();
  });

  it('should emit datachannel:open when channel opens', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('datachannel:open', fn);
    const ch = pc.simulateDataChannel('test-ch');
    ch.simulateOpen();
    expect(fn).toHaveBeenCalledWith('test-ch', ch);
  });

  it('should emit data event on channel message (JSON)', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('data', fn);
    const ch = pc.simulateDataChannel('data');
    ch.simulateOpen();
    ch.simulateMessage(JSON.stringify({ hello: 'world' }));
    expect(fn).toHaveBeenCalledWith({ hello: 'world' }, 'data');
  });

  it('should emit data event on channel message (binary)', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('data', fn);
    const ch = pc.simulateDataChannel('data');
    ch.simulateOpen();
    const buf = new ArrayBuffer(4);
    ch.simulateMessage(buf);
    expect(fn).toHaveBeenCalledWith(buf, 'data');
  });

  it('should emit data for non-JSON string', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('data', fn);
    const ch = pc.simulateDataChannel('data');
    ch.simulateOpen();
    ch.simulateMessage('plain text');
    expect(fn).toHaveBeenCalledWith('plain text', 'data');
  });

  it('should send data on open channel', async () => {
    const { peer, pc } = createPeer();
    const ch = pc.simulateDataChannel('data');
    ch.simulateOpen();
    peer.send({ msg: 'hi' }, 'data');
    expect(ch.send).toHaveBeenCalledWith(JSON.stringify({ msg: 'hi' }));
  });

  it('should send string directly', async () => {
    const { peer, pc } = createPeer();
    const ch = pc.simulateDataChannel('data');
    ch.simulateOpen();
    peer.send('raw string', 'data');
    expect(ch.send).toHaveBeenCalledWith('raw string');
  });

  it('should send binary data', async () => {
    const { peer, pc } = createPeer();
    const ch = pc.simulateDataChannel('data');
    ch.simulateOpen();
    const buf = new ArrayBuffer(8);
    peer.sendBinary(buf, 'data');
    expect(ch.send).toHaveBeenCalledWith(buf);
  });

  it('should throw when sending on closed channel', () => {
    const { peer } = createPeer();
    expect(() => peer.send('test', 'data')).toThrow('Channel "data" not open');
  });

  it('should throw when sending on non-existent channel', () => {
    const { peer } = createPeer();
    expect(() => peer.send('test', 'nope')).toThrow('Channel "nope" not open');
  });

  it('should emit error on malformed signal instead of crashing', async () => {
    const { peer, pc } = createPeer();
    pc.setRemoteDescription.mockRejectedValueOnce(new Error('bad sdp'));
    const fn = vi.fn();
    peer.on('error', fn);
    await peer.handleSignal({ signal_type: 'offer', sdp: 'bad' });
    expect(fn).toHaveBeenCalled();
  });

  it('should not process signals after close', async () => {
    const { peer, pc } = createPeer();
    peer.close();
    await peer.handleSignal({ signal_type: 'offer', sdp: 'test' });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it('should guard against double close', () => {
    const { peer } = createPeer();
    peer.close();
    expect(() => peer.close()).not.toThrow();
    expect(peer.closed).toBe(true);
  });

  it('should return closed state after close', () => {
    const { peer } = createPeer();
    expect(peer.connectionState).toBe('new');
    peer.close();
    expect(peer.connectionState).toBe('closed');
  });

  it('should not emit events after close', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('connected', fn);
    peer.close();
    pc.simulateConnected();
    expect(fn).not.toHaveBeenCalled();
  });

  it('should attempt ICE restart on ICE failure', () => {
    const { peer, pc } = createPeer();
    pc.simulateFailed();
    expect(pc.restartIce).toHaveBeenCalled();
  });

  it('should report buffered amount', () => {
    const { peer, pc } = createPeer();
    const ch = pc.simulateDataChannel('data');
    ch.bufferedAmount = 12345;
    expect(peer.getBufferedAmount('data')).toBe(12345);
  });

  it('should return 0 for non-existent channel buffered amount', () => {
    const { peer } = createPeer();
    expect(peer.getBufferedAmount('nope')).toBe(0);
  });

  it('should emit datachannel:close when channel closes', () => {
    const { peer, pc } = createPeer();
    const fn = vi.fn();
    peer.on('datachannel:close', fn);
    const ch = pc.simulateDataChannel('test');
    ch.simulateClose();
    expect(fn).toHaveBeenCalledWith('test');
    expect(peer.channelLabels).not.toContain('test');
  });

  it('should send ice candidates via signal', () => {
    const send = vi.fn();
    const { pc } = createPeer(send);
    pc.simulateIceCandidate({ candidate: 'c1', sdpMid: '0' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ signal_type: 'candidate' }),
    );
  });

  it('should emit track and stream events', () => {
    const { peer, pc } = createPeer();
    const trackFn = vi.fn();
    const streamFn = vi.fn();
    peer.on('track', trackFn);
    peer.on('stream', streamFn);

    const track = { id: 't1' };
    const stream = { id: 's1' };
    pc.simulateTrack(track, [stream]);

    expect(trackFn).toHaveBeenCalledWith(track, [stream]);
    expect(streamFn).toHaveBeenCalledWith(stream);
  });
});
