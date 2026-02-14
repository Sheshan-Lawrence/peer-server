import { describe, it, expect, vi, afterEach } from 'vitest';
import { Emitter } from '../src/core/emitter';
import { DirectMedia, GroupMedia } from '../src/media';
import { MockMediaStream, MockMediaStreamTrack } from './setup';

function mockClient(fp = 'fp-me') {
  const emitter = new Emitter();
  return {
    fingerprint: fp,
    on: (event: string, fn: any) => emitter.on(event as any, fn),
    emit: (event: string, ...args: any[]) => emitter.emit(event as any, ...args),
    createRoom: vi.fn(async () => ({ room_id: 'media-r', max_size: 2, owner: fp })),
    joinRoom: vi.fn(async () => []),
    createPeer: vi.fn((_fp: string, _alias: string) => mockPeer(_fp)),
    connectToPeer: vi.fn((_fp: string, _alias?: string) => mockPeer(_fp)),
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
    addStream: vi.fn(),
    removeStream: vi.fn(),
    createOffer: vi.fn(),
    close: vi.fn(),
  } as any;
}

function mockGetUserMedia() {
  const audioTrack = new MockMediaStreamTrack('audio');
  const videoTrack = new MockMediaStreamTrack('video');
  const stream = new MockMediaStream([audioTrack, videoTrack]);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  });
  return { stream, audioTrack, videoTrack };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DirectMedia', () => {
  it('should start and return local stream', async () => {
    const { stream } = mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    const fn = vi.fn();
    media.on('local_stream', fn);
    const result = await media.start();
    expect(result).toBe(stream);
    expect(fn).toHaveBeenCalledWith(stream);
  });

  it('should create room and listen', async () => {
    mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    await media.createAndJoin();
    expect(client.createRoom).toHaveBeenCalledWith('room-1', { maxSize: 2 });
  });

  it('should mute/unmute audio', async () => {
    const { audioTrack } = mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    await media.start();
    expect(media.isAudioMuted()).toBe(false);
    media.muteAudio();
    expect(audioTrack.enabled).toBe(false);
    expect(media.isAudioMuted()).toBe(true);
    media.unmuteAudio();
    expect(audioTrack.enabled).toBe(true);
  });

  it('should mute/unmute video', async () => {
    const { videoTrack } = mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    await media.start();
    media.muteVideo();
    expect(videoTrack.enabled).toBe(false);
    media.unmuteVideo();
    expect(videoTrack.enabled).toBe(true);
  });

  it('should close and stop tracks', async () => {
    const { audioTrack, videoTrack } = mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    await media.start();
    const fn = vi.fn();
    media.on('closed', fn);
    media.close();
    expect(audioTrack.stop).toHaveBeenCalled();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(fn).toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith('room-1');
  });

  it('should not double-close', async () => {
    mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    await media.start();
    media.close();
    expect(() => media.close()).not.toThrow();
  });

  it('should report muted when no stream', () => {
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    expect(media.isAudioMuted()).toBe(true);
    expect(media.isVideoMuted()).toBe(true);
  });

  it('should return null streams before start', () => {
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    expect(media.getLocalStream()).toBeNull();
    expect(media.getRemoteStream()).toBeNull();
  });

  it('should emit muted/unmuted events', async () => {
    mockGetUserMedia();
    const client = mockClient();
    const media = new DirectMedia(client, 'room-1');
    await media.start();
    const muteFn = vi.fn();
    const unmuteFn = vi.fn();
    media.on('muted', muteFn);
    media.on('unmuted', unmuteFn);
    media.muteAudio();
    expect(muteFn).toHaveBeenCalledWith('audio');
    media.unmuteAudio();
    expect(unmuteFn).toHaveBeenCalledWith('audio');
    media.muteVideo();
    expect(muteFn).toHaveBeenCalledWith('video');
    media.unmuteVideo();
    expect(unmuteFn).toHaveBeenCalledWith('video');
  });
});

describe('GroupMedia', () => {
  it('should create room', async () => {
    mockGetUserMedia();
    const client = mockClient();
    const media = new GroupMedia(client, 'room-g');
    await media.createAndJoin();
    expect(client.createRoom).toHaveBeenCalled();
  });

  it('should join and connect to peers', async () => {
    mockGetUserMedia();
    const client = mockClient();
    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-a', alias: 'a' },
    ]);
    const media = new GroupMedia(client, 'room-g');
    await media.joinAndStart();
    expect(client.createPeer).toHaveBeenCalledWith('fp-a', 'a');
  });

  it('should track peer count', async () => {
    mockGetUserMedia();
    const client = mockClient();
    client.joinRoom.mockResolvedValue([
      { fingerprint: 'fp-me', alias: 'me' },
      { fingerprint: 'fp-a', alias: 'a' },
      { fingerprint: 'fp-b', alias: 'b' },
    ]);
    const media = new GroupMedia(client, 'room-g');
    await media.joinAndStart();
    expect(media.getPeerCount()).toBe(2);
  });

  it('should close and stop all tracks', async () => {
    const { audioTrack, videoTrack } = mockGetUserMedia();
    const client = mockClient();
    const media = new GroupMedia(client, 'room-g');
    await media.start();
    media.close();
    expect(audioTrack.stop).toHaveBeenCalled();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(client.leave).toHaveBeenCalledWith('room-g');
  });

  it('should kick peer', async () => {
    mockGetUserMedia();
    const client = mockClient();
    const media = new GroupMedia(client, 'room-g');
    await media.createAndJoin();
    media.kick('fp-bad');
    expect(client.kick).toHaveBeenCalledWith('room-g', 'fp-bad');
  });

  it('should return empty streams map before joining', () => {
    const client = mockClient();
    const media = new GroupMedia(client, 'room-g');
    expect(media.getRemoteStreams().size).toBe(0);
    expect(media.getRemoteStream('fp-x')).toBeUndefined();
  });
});
