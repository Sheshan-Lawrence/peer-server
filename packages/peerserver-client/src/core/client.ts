import { Emitter } from './emitter';
import { Transport } from './transport';
import { Identity } from './identity';
import { Peer } from './peer';
import type {
  ClientConfig,
  PeerClientEvent,
  PeerInfo,
  MatchResult,
  ServerMessage,
  DataChannelConfig,
  RoomCreatedResult,
  RoomInfoResult,
  RoomConfig,
} from './types';
import { DEFAULT_ICE_SERVERS } from './types';

export class PeerClient extends Emitter<PeerClientEvent> {
  private transport: Transport;
  private identity: Identity;
  private config: Required<Omit<ClientConfig, 'identityKeys'>> & Pick<ClientConfig, 'identityKeys'>;
  private peers = new Map<string, Peer>();
  private namespaces = new Set<string>();
  private matchResolvers = new Map<string, (result: MatchResult) => void>();
  private registerPromise: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private registerAbort: AbortController | null = null;

  constructor(config: ClientConfig) {
    super();
    this.config = {
      url: config.url,
      iceServers: config.iceServers ?? DEFAULT_ICE_SERVERS,
      alias: config.alias ?? '',
      meta: config.meta ?? {},
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? 1000,
      reconnectMaxDelay: config.reconnectMaxDelay ?? 30000,
      pingInterval: config.pingInterval ?? 25000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? Infinity,
      identityKeys: config.identityKeys,
    };

    this.identity = new Identity();
    this.transport = new Transport(
      this.config.url,
      this.config.autoReconnect,
      this.config.reconnectDelay,
      this.config.reconnectMaxDelay,
      this.config.maxReconnectAttempts,
      this.config.pingInterval,
    );

    this.transport.on('message', (msg: ServerMessage) => this.handleMessage(msg));
    this.transport.on('close', () => this.emit('disconnected'));
    this.transport.on('reconnecting', (attempt: number, delay: number) => {
      this.emit('reconnecting', attempt, delay);
    });
    this.transport.on('open', () => {
      if (this.identity.fingerprint) {
        this.doRegister().then(() => {
          this.namespaces.forEach((ns) => {
            this.transport.send({
              type: 'join',
              payload: { namespace: ns },
            });
          });
          this.emit('reconnected');
        }).catch(() => {});
      }
    });
  }

  get fingerprint(): string {
    return this.identity.fingerprint;
  }

  get alias(): string {
    return this.identity.alias;
  }

  get connected(): boolean {
    return this.transport.connected;
  }

  get peerMap(): ReadonlyMap<string, Peer> {
    return this.peers;
  }

  getIdentity(): Identity {
    return this.identity;
  }

  getTransport(): Transport {
    return this.transport;
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    await this.doRegister();
  }

  async join(namespace: string, appType?: string, version?: string): Promise<PeerInfo[]> {
    this.namespaces.add(namespace);
    return new Promise((resolve) => {
      const off = this.on('peer_list', (ns: string, peers: PeerInfo[]) => {
        if (ns === namespace) {
          off();
          resolve(peers);
        }
      });
      this.transport.send({
        type: 'join',
        payload: { namespace, app_type: appType, version },
      });
    });
  }

  leave(namespace: string): void {
    this.namespaces.delete(namespace);
    this.transport.send({ type: 'leave', payload: { namespace } });
  }

  async discover(namespace: string, limit = 20): Promise<PeerInfo[]> {
    return new Promise((resolve) => {
      const off = this.on('peer_list', (ns: string, peers: PeerInfo[]) => {
        if (ns === namespace) {
          off();
          resolve(peers);
        }
      });
      this.transport.send({
        type: 'discover',
        payload: { namespace, limit },
      });
    });
  }

  async match(namespace: string, criteria?: Record<string, any>, groupSize?: number): Promise<MatchResult> {
    return new Promise((resolve) => {
      this.matchResolvers.set(namespace, resolve);
      this.transport.send({
        type: 'match',
        payload: { namespace, criteria, group_size: groupSize },
      });
    });
  }

  async createRoom(roomId: string, config?: RoomConfig): Promise<RoomCreatedResult> {
    return new Promise((resolve, reject) => {
      let offCreated: (() => void) | null = null;
      let offError: (() => void) | null = null;

      const cleanup = () => {
        offCreated?.();
        offError?.();
      };

      offCreated = this.on('room_created', (result: RoomCreatedResult) => {
        if (result.room_id === roomId) {
          cleanup();
          resolve(result);
        }
      });
      offError = this.on('error', (err: any) => {
        cleanup();
        reject(new Error(typeof err === 'string' ? err : err?.message ?? 'create_room failed'));
      });
      this.transport.send({
        type: 'create_room',
        payload: { room_id: roomId, max_size: config?.maxSize ?? 20 },
      });
    });
  }

  async joinRoom(roomId: string): Promise<PeerInfo[]> {
    this.namespaces.add(roomId);
    return new Promise((resolve, reject) => {
      let offList: (() => void) | null = null;
      let offError: (() => void) | null = null;

      const cleanup = () => {
        offList?.();
        offError?.();
      };

      offList = this.on('peer_list', (ns: string, peers: PeerInfo[]) => {
        if (ns === roomId) {
          cleanup();
          resolve(peers);
        }
      });
      offError = this.on('error', (err: any) => {
        cleanup();
        this.namespaces.delete(roomId);
        reject(new Error(typeof err === 'string' ? err : err?.message ?? 'join_room failed'));
      });
      this.transport.send({
        type: 'join_room',
        payload: { room_id: roomId },
      });
    });
  }

  async roomInfo(roomId: string): Promise<RoomInfoResult> {
    return new Promise((resolve, reject) => {
      let offMsg: (() => void) | null = null;
      const timeout = setTimeout(() => {
        offMsg?.();
        reject(new Error('room_info timeout'));
      }, 10000);

      offMsg = this.transport.on('message', (msg: ServerMessage) => {
        if (msg.type === 'room_info') {
          const info = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
          if (info.room_id === roomId) {
            clearTimeout(timeout);
            offMsg?.();
            resolve(info);
          }
        }
      });

      this.transport.send({
        type: 'room_info',
        payload: { room_id: roomId },
      });
    });
  }

  kick(roomId: string, fingerprint: string): void {
    this.transport.send({
      type: 'kick',
      payload: { room_id: roomId, fingerprint },
    });
  }

  connectToPeer(fingerprint: string, alias = '', channelConfig?: DataChannelConfig): Peer {
    const existing = this.peers.get(fingerprint);
    if (existing) return existing;

    const peer = this.createPeer(fingerprint, alias);
    peer.createOffer(channelConfig);
    return peer;
  }

  getPeer(fingerprint: string): Peer | undefined {
    return this.peers.get(fingerprint);
  }

  relay(to: string, payload: any): void {
    this.transport.send({ type: 'relay', to, payload });
  }

  broadcast(namespace: string, data: any): void {
    this.transport.send({
      type: 'broadcast',
      payload: { namespace, data },
    });
  }

  updateMetadata(meta: Record<string, any>): void {
    this.transport.send({ type: 'metadata', payload: meta });
  }

  closePeer(fingerprint: string): void {
    const peer = this.peers.get(fingerprint);
    if (peer) {
      peer.close();
      this.peers.delete(fingerprint);
    }
  }

  disconnect(): void {
    this.peers.forEach((p) => p.close());
    this.peers.clear();
    this.namespaces.clear();
    this.matchResolvers.clear();
    if (this.registerPromise) {
      this.registerPromise.reject(new Error('Disconnected'));
      this.registerPromise = null;
    }
    this.transport.close();
  }

  private async doRegister(): Promise<void> {
    if (this.registerPromise) {
      this.registerPromise.reject(new Error('Register superseded'));
      this.registerPromise = null;
    }

    if (!this.identity.publicKeyB64) {
      if (this.config.identityKeys) {
        await this.identity.restore(this.config.identityKeys);
      } else {
        await this.identity.generate();
      }
    }
    return new Promise((resolve, reject) => {
      this.registerPromise = { resolve, reject };
      this.transport.send({
        type: 'register',
        payload: {
          public_key: this.identity.publicKeyB64,
          alias: this.config.alias,
          meta: this.config.meta,
        },
      });
    });
  }

  createPeer(fingerprint: string, alias: string): Peer {
    const existing = this.peers.get(fingerprint);
    if (existing) return existing;

    const peer = new Peer(fingerprint, alias, this.config.iceServers, (payload) => {
      this.transport.send({ type: 'signal', to: fingerprint, payload });
    });

    peer.on('disconnected', () => {
      this.peers.delete(fingerprint);
    });

    this.peers.set(fingerprint, peer);
    return peer;
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'registered': {
        const reg = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        this.identity.setRegistered(reg.fingerprint, reg.alias);
        this.registerPromise?.resolve();
        this.registerPromise = null;
        this.emit('registered', reg.fingerprint, reg.alias);
        break;
      }

      case 'peer_list': {
        const ns = msg.namespace ?? msg.payload?.namespace ?? '';
        const peers: PeerInfo[] = msg.payload?.peers ?? msg.payload ?? [];
        this.emit('peer_list', ns, peers);
        break;
      }

      case 'peer_joined': {
        const info: PeerInfo = msg.payload ?? { fingerprint: msg.from ?? '', alias: '' };
        this.emit('peer_joined', info);
        break;
      }

      case 'peer_left': {
        const fp = msg.from ?? msg.payload?.fingerprint ?? '';
        const peer = this.peers.get(fp);
        if (peer) {
          peer.close();
          this.peers.delete(fp);
        }
        this.emit('peer_left', fp);
        break;
      }

      case 'signal': {
        const from = msg.from ?? '';
        let peer = this.peers.get(from);
        if (!peer) {
          peer = this.createPeer(from, '');
        }
        peer.handleSignal(msg.payload);
        break;
      }

      case 'matched': {
        const result: MatchResult =
          typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        const resolver = this.matchResolvers.get(result.namespace);
        if (resolver) {
          this.matchResolvers.delete(result.namespace);
          resolver(result);
        }
        this.emit('matched', result);
        break;
      }

      case 'relay': {
        this.emit('relay', msg.from, msg.payload);
        break;
      }

      case 'broadcast': {
        const ns = msg.namespace ?? msg.payload?.namespace ?? '';
        const data = msg.payload?.data ?? msg.payload;
        this.emit('broadcast', msg.from, ns, data);
        break;
      }

      case 'room_created': {
        const result = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        this.emit('room_created', result);
        break;
      }

      case 'room_closed': {
        const result = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        if (result?.room_id) {
          this.namespaces.delete(result.room_id);
        }
        this.emit('room_closed', result);
        break;
      }

      case 'kick': {
        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        if (payload?.room_id) {
          this.namespaces.delete(payload.room_id);
        }
        this.emit('kicked', payload);
        break;
      }

      case 'error': {
        this.emit('error', msg.payload);
        this.registerPromise?.reject(
          new Error(typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)),
        );
        this.registerPromise = null;
        break;
      }
    }
  }
}
