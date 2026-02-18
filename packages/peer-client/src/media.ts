import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { Peer } from './core/peer';
import type { PeerInfo, MediaConfig } from './core/types';
import { LIMITS } from './core/types';

type MediaEvent =
  | 'local_stream'
  | 'remote_stream'
  | 'remote_stream_removed'
  | 'peer_joined'
  | 'peer_left'
  | 'muted'
  | 'unmuted'
  | 'error'
  | 'closed';

export class DirectMedia extends Emitter<MediaEvent> {
  private client: PeerClient;
  private roomId: string;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remotePeer: Peer | null = null;
  private remoteFingerprint = '';
  private _closed = false;
  private cleanups: (() => void)[] = [];

  constructor(client: PeerClient, roomId: string) {
    super();
    this.client = client;
    this.roomId = roomId;
  }

  async start(config: MediaConfig = { audio: true, video: true }): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: config.audio ?? true,
      video: config.video ?? true,
    });
    this.emit('local_stream', this.localStream);
    return this.localStream;
  }

  async createAndJoin(config?: MediaConfig): Promise<MediaStream> {
    const stream = await this.start(config);
    try {
      await this.client.createRoom(this.roomId, { maxSize: 2 });
    } catch (e) {
      this.emit('error', e);
    }
    this.listen();
    return stream;
  }

  async joinAndStart(config?: MediaConfig): Promise<{ stream: MediaStream; peers: PeerInfo[] }> {
    const stream = await this.start(config);
    const peers = await this.client.joinRoom(this.roomId);
    this.listen();
    const remote = peers.find((p) => p.fingerprint !== this.client.fingerprint);
    if (remote) {
      this.connectTo(remote.fingerprint, remote.alias);
    }
    return { stream, peers };
  }

  private listen(): void {
    const offJoined = this.client.on('peer_joined', (info: PeerInfo) => {
      this.emit('peer_joined', info);
      if (!this.remotePeer) {
        this.connectTo(info.fingerprint, info.alias);
      }
    });

    const offLeft = this.client.on('peer_left', (fp: string) => {
      if (fp === this.remoteFingerprint) {
        this.remotePeer = null;
        this.remoteFingerprint = '';
        this.remoteStream = null;
        this.emit('remote_stream_removed', fp);
        this.emit('peer_left', fp);
      }
    });

    const offKicked = this.client.on('kicked', (payload: any) => {
      if (payload?.room_id === this.roomId) {
        this.close();
      }
    });

    this.cleanups.push(offJoined, offLeft, offKicked);
  }

  private connectTo(fingerprint: string, alias: string): void {
    this.remoteFingerprint = fingerprint;
    const peer = this.client.createPeer(fingerprint, alias);
    this.remotePeer = peer;

    if (this.localStream) {
      peer.addStream(this.localStream);
    }

    peer.on('stream', (stream: MediaStream) => {
      this.remoteStream = stream;
      this.emit('remote_stream', stream, fingerprint);
    });

    peer.on('disconnected', () => {
      this.remoteStream = null;
      this.emit('remote_stream_removed', fingerprint);
      this.emit('peer_left', fingerprint);
    });

    peer.createOffer();
  }

  muteAudio(): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = false));
    this.emit('muted', 'audio');
  }

  unmuteAudio(): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = true));
    this.emit('unmuted', 'audio');
  }

  muteVideo(): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = false));
    this.emit('muted', 'video');
  }

  unmuteVideo(): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = true));
    this.emit('unmuted', 'video');
  }

  isAudioMuted(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    return track ? !track.enabled : true;
  }

  isVideoMuted(): boolean {
    const track = this.localStream?.getVideoTracks()[0];
    return track ? !track.enabled : true;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.remoteStream = null;
    if (this.remotePeer) {
      this.remotePeer.close();
      this.remotePeer = null;
    }
    this.client.leave(this.roomId);
    this.emit('closed');
    this.removeAllListeners();
  }
}

export class GroupMedia extends Emitter<MediaEvent> {
  private client: PeerClient;
  private roomId: string;
  private localStream: MediaStream | null = null;
  private remoteStreams = new Map<string, MediaStream>();
  private mediaPeers = new Map<string, Peer>();
  private _closed = false;
  private cleanups: (() => void)[] = [];

  constructor(client: PeerClient, roomId: string) {
    super();
    this.client = client;
    this.roomId = roomId;
  }

  async start(config: MediaConfig = { audio: true, video: true }): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: config.audio ?? true,
      video: config.video ?? true,
    });
    this.emit('local_stream', this.localStream);
    return this.localStream;
  }

  async createAndJoin(config?: MediaConfig): Promise<MediaStream> {
    const stream = await this.start(config);
    await this.client.createRoom(this.roomId, { maxSize: LIMITS.MAX_MEDIA_PEERS });
    this.listen();
    return stream;
  }

  async joinAndStart(config?: MediaConfig): Promise<{ stream: MediaStream; peers: PeerInfo[] }> {
    const stream = await this.start(config);
    const peers = await this.client.joinRoom(this.roomId);
    this.listen();
    const others = peers.filter((p) => p.fingerprint !== this.client.fingerprint);
    for (const p of others) {
      if (this.mediaPeers.size < LIMITS.MAX_MEDIA_PEERS - 1) {
        this.connectTo(p.fingerprint, p.alias);
      }
    }
    return { stream, peers };
  }

  private listen(): void {
    const offJoined = this.client.on('peer_joined', (info: PeerInfo) => {
      this.emit('peer_joined', info);
      if (this.mediaPeers.size < LIMITS.MAX_MEDIA_PEERS - 1) {
        this.connectTo(info.fingerprint, info.alias);
      }
    });

    const offLeft = this.client.on('peer_left', (fp: string) => {
      const peer = this.mediaPeers.get(fp);
      if (peer) {
        peer.close();
        this.mediaPeers.delete(fp);
      }
      if (this.remoteStreams.has(fp)) {
        this.remoteStreams.delete(fp);
        this.emit('remote_stream_removed', fp);
      }
      this.emit('peer_left', fp);
    });

    const offKicked = this.client.on('kicked', (payload: any) => {
      if (payload?.room_id === this.roomId) {
        this.close();
      }
    });

    this.cleanups.push(offJoined, offLeft, offKicked);
  }

  private connectTo(fingerprint: string, alias: string): void {
    if (this.mediaPeers.has(fingerprint)) return;

    const peer = this.client.createPeer(fingerprint, alias);
    this.mediaPeers.set(fingerprint, peer);

    if (this.localStream) {
      peer.addStream(this.localStream);
    }

    peer.on('stream', (stream: MediaStream) => {
      this.remoteStreams.set(fingerprint, stream);
      this.emit('remote_stream', stream, fingerprint);
    });

    peer.on('disconnected', () => {
      this.mediaPeers.delete(fingerprint);
      if (this.remoteStreams.has(fingerprint)) {
        this.remoteStreams.delete(fingerprint);
        this.emit('remote_stream_removed', fingerprint);
      }
    });

    peer.createOffer();
  }

  muteAudio(): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = false));
    this.emit('muted', 'audio');
  }

  unmuteAudio(): void {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = true));
    this.emit('unmuted', 'audio');
  }

  muteVideo(): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = false));
    this.emit('muted', 'video');
  }

  unmuteVideo(): void {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = true));
    this.emit('unmuted', 'video');
  }

  isAudioMuted(): boolean {
    const track = this.localStream?.getAudioTracks()[0];
    return track ? !track.enabled : true;
  }

  isVideoMuted(): boolean {
    const track = this.localStream?.getVideoTracks()[0];
    return track ? !track.enabled : true;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStreams(): Map<string, MediaStream> {
    return new Map(this.remoteStreams);
  }

  getRemoteStream(fingerprint: string): MediaStream | undefined {
    return this.remoteStreams.get(fingerprint);
  }

  getPeerCount(): number {
    return this.mediaPeers.size;
  }

  kick(fingerprint: string): void {
    this.client.kick(this.roomId, fingerprint);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.mediaPeers.forEach((p) => p.close());
    this.mediaPeers.clear();
    this.remoteStreams.clear();
    this.client.leave(this.roomId);
    this.emit('closed');
    this.removeAllListeners();
  }
}
