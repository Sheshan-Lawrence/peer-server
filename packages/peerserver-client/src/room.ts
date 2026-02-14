import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { Peer } from './core/peer';
import type { PeerInfo } from './core/types';
import { LIMITS } from './core/types';

type RoomEvent =
  | 'peer_joined'
  | 'peer_left'
  | 'peer_connected'
  | 'data'
  | 'closed'
  | 'error';

export class DirectRoom extends Emitter<RoomEvent> {
  private client: PeerClient;
  private roomId: string;
  private remotePeer: Peer | null = null;
  private remoteFingerprint = '';
  private _closed = false;
  private cleanups: (() => void)[] = [];

  constructor(client: PeerClient, roomId: string) {
    super();
    this.client = client;
    this.roomId = roomId;
  }

  async create(): Promise<void> {
    await this.client.createRoom(this.roomId, { maxSize: 2 });
    this.listen();
  }

  async join(): Promise<PeerInfo[]> {
    const peers = await this.client.joinRoom(this.roomId);
    this.listen();
    const remote = peers.find((p) => p.fingerprint !== this.client.fingerprint);
    if (remote) {
      this.connectTo(remote.fingerprint, remote.alias);
    }
    return peers;
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
        this.emit('peer_left', fp);
      }
    });

    const offRelay = this.client.on('relay', (from: string, payload: any) => {
      if (from === this.remoteFingerprint && payload?._room === this.roomId) {
        this.emit('data', payload.data, from);
      }
    });

    const offKicked = this.client.on('kicked', (payload: any) => {
      if (payload?.room_id === this.roomId) {
        this.close();
      }
    });

    this.cleanups.push(offJoined, offLeft, offRelay, offKicked);
  }

  private connectTo(fingerprint: string, alias: string): void {
    this.remoteFingerprint = fingerprint;
    const peer = this.client.connectToPeer(fingerprint, alias);
    this.remotePeer = peer;

    peer.on('connected', () => this.emit('peer_connected', fingerprint));
    peer.on('data', (data: any) => this.emit('data', data, fingerprint));
    peer.on('disconnected', () => {
      this.emit('peer_left', fingerprint);
    });
  }

  send(data: any): void {
    if (this._closed) return;
    if (this.remotePeer && this.remotePeer.connectionState === 'connected') {
      try {
        this.remotePeer.send(data);
        return;
      } catch {}
    }
    if (this.remoteFingerprint) {
      this.client.relay(this.remoteFingerprint, { _room: this.roomId, data });
    }
  }

  getPeer(): Peer | null {
    return this.remotePeer;
  }

  getRemoteFingerprint(): string {
    return this.remoteFingerprint;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    if (this.remotePeer) {
      this.remotePeer.close();
    }
    this.client.leave(this.roomId);
    this.emit('closed');
    this.removeAllListeners();
  }
}

export class GroupRoom extends Emitter<RoomEvent> {
  private client: PeerClient;
  private roomId: string;
  private maxSize: number;
  private connectedPeers = new Map<string, Peer>();
  private relayPeers = new Set<string>();
  private _closed = false;
  private cleanups: (() => void)[] = [];

  constructor(client: PeerClient, roomId: string, maxSize: number = LIMITS.MAX_GROUP_SIZE) {
    super();
    this.client = client;
    this.roomId = roomId;
    this.maxSize = Math.min(maxSize, LIMITS.MAX_GROUP_SIZE);
  }

  async create(): Promise<void> {
    await this.client.createRoom(this.roomId, { maxSize: this.maxSize });
    this.listen();
  }

  async join(): Promise<PeerInfo[]> {
    const peers = await this.client.joinRoom(this.roomId);
    this.listen();
    const others = peers.filter((p) => p.fingerprint !== this.client.fingerprint);
    for (const p of others) {
      this.connectTo(p.fingerprint, p.alias);
    }
    return peers;
  }

  private listen(): void {
    const offJoined = this.client.on('peer_joined', (info: PeerInfo) => {
      this.emit('peer_joined', info);
      this.connectTo(info.fingerprint, info.alias);
    });

    const offLeft = this.client.on('peer_left', (fp: string) => {
      const hadP2P = this.connectedPeers.has(fp);
      this.connectedPeers.delete(fp);
      this.relayPeers.delete(fp);
      if (hadP2P) {
        this.promoteRelayPeers();
      }
      this.emit('peer_left', fp);
    });

    const offRelay = this.client.on('relay', (from: string, payload: any) => {
      if (payload?._room === this.roomId) {
        this.emit('data', payload.data, from);
      }
    });

    const offBroadcast = this.client.on('broadcast', (from: string, ns: string, payload: any) => {
      if (ns === this.roomId) {
        this.emit('data', payload, from);
      }
    });

    const offKicked = this.client.on('kicked', (payload: any) => {
      if (payload?.room_id === this.roomId) {
        this.close();
      }
    });

    this.cleanups.push(offJoined, offLeft, offRelay, offBroadcast, offKicked);
  }

  private connectTo(fingerprint: string, alias: string): void {
    if (this.connectedPeers.has(fingerprint) || this.relayPeers.has(fingerprint)) return;

    if (this.connectedPeers.size >= LIMITS.RELAY_THRESHOLD) {
      this.relayPeers.add(fingerprint);
      return;
    }

    const peer = this.client.connectToPeer(fingerprint, alias);
    this.connectedPeers.set(fingerprint, peer);

    peer.on('connected', () => this.emit('peer_connected', fingerprint));
    peer.on('data', (data: any) => this.emit('data', data, fingerprint));
    peer.on('disconnected', () => {
      this.connectedPeers.delete(fingerprint);
      this.relayPeers.add(fingerprint);
    });
  }

  private promoteRelayPeers(): void {
    if (this.connectedPeers.size >= LIMITS.RELAY_THRESHOLD) return;
    const available = LIMITS.RELAY_THRESHOLD - this.connectedPeers.size;
    const toPromote = [...this.relayPeers].slice(0, available);
    for (const fp of toPromote) {
      this.relayPeers.delete(fp);
      const peer = this.client.connectToPeer(fp);
      this.connectedPeers.set(fp, peer);

      peer.on('connected', () => this.emit('peer_connected', fp));
      peer.on('data', (data: any) => this.emit('data', data, fp));
      peer.on('disconnected', () => {
        this.connectedPeers.delete(fp);
        this.relayPeers.add(fp);
      });
    }
  }

  send(data: any, to?: string): void {
    if (this._closed) return;

    if (to) {
      const peer = this.connectedPeers.get(to);
      if (peer && peer.connectionState === 'connected') {
        try {
          peer.send(data);
          return;
        } catch {}
      }
      this.client.relay(to, { _room: this.roomId, data });
      return;
    }

    this.connectedPeers.forEach((peer, fp) => {
      if (peer.connectionState === 'connected') {
        try {
          peer.send(data);
        } catch {
          this.client.relay(fp, { _room: this.roomId, data });
        }
      } else {
        this.client.relay(fp, { _room: this.roomId, data });
      }
    });

    this.relayPeers.forEach((fp) => {
      this.client.relay(fp, { _room: this.roomId, data });
    });
  }

  broadcastViaServer(data: any): void {
    this.client.broadcast(this.roomId, data);
  }

  kick(fingerprint: string): void {
    this.client.kick(this.roomId, fingerprint);
  }

  getPeers(): Map<string, Peer> {
    return new Map(this.connectedPeers);
  }

  getPeerCount(): number {
    return this.connectedPeers.size + this.relayPeers.size;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.connectedPeers.forEach((p) => p.close());
    this.connectedPeers.clear();
    this.relayPeers.clear();
    this.client.leave(this.roomId);
    this.emit('closed');
    this.removeAllListeners();
  }
}
