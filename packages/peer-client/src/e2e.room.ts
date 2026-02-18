import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { PeerInfo } from './core/types';
import { DirectRoom } from './room';
import { E2E } from './crypto';

type E2ERoomEvent =
  | 'ready'
  | 'data'
  | 'decrypt_error'
  | 'peer_joined'
  | 'peer_left'
  | 'state_changed'
  | 'closed'
  | 'error';

type E2ERoomState = 'connecting' | 'exchanging' | 'ready' | 'closed';

const KEY_EXCHANGE_TIMEOUT = 10000;

export interface E2ERoomOptions {
  e2e?: E2E;
  roomFactory?: (client: PeerClient, roomId: string) => DirectRoom;
}

export class E2EDirectRoom extends Emitter<E2ERoomEvent> {
  private client: PeerClient;
  private roomId: string;
  private room: DirectRoom | null = null;
  private e2e: E2E;
  private remoteFingerprint = '';
  private _state: E2ERoomState = 'connecting';
  private _closed = false;
  private exchangeTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: (() => void)[] = [];
  private createRoom: (client: PeerClient, roomId: string) => DirectRoom;

  constructor(client: PeerClient, roomId: string, options?: E2ERoomOptions) {
    super();
    this.client = client;
    this.roomId = roomId;
    this.e2e = options?.e2e ?? new E2E();
    this.createRoom = options?.roomFactory ?? ((c, id) => new DirectRoom(c, id));
  }

  get state(): E2ERoomState {
    return this._state;
  }

  get fingerprint(): string {
    return this.remoteFingerprint;
  }

  hasEncryption(): boolean {
    return this._state === 'ready' && this.e2e.hasKey(this.remoteFingerprint);
  }

  getRoom(): DirectRoom | null {
    return this.room;
  }

  getE2E(): E2E {
    return this.e2e;
  }

  async create(): Promise<void> {
    if (this._closed) throw new Error('Room is closed');
    await this.initE2E();
    this.room = this.createRoom(this.client, this.roomId);
    this.attachListeners();
    await this.room.create();
  }

  async join(): Promise<PeerInfo[]> {
    if (this._closed) throw new Error('Room is closed');
    await this.initE2E();
    this.room = this.createRoom(this.client, this.roomId);
    this.attachListeners();
    return this.room.join();
  }

    send(data: any): void {
    if (this._closed) return;
    if (!this.room) return;

    if (this._state === 'ready' && this.e2e.hasKey(this.remoteFingerprint)) {
      this.encryptAndSend(data).catch((err) => {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    } else {
      this.room.send({ _plain: true, data });
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.setState('closed');
    this.clearExchangeTimer();
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    if (this.room) {
      this.room.close();
      this.room = null;
    }
    this.emit('closed');
    this.removeAllListeners();
  }

  private async initE2E(): Promise<void> {
    if (!this.e2e.isInitialized()) {
      await this.e2e.init();
    }
  }

  private setState(s: E2ERoomState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit('state_changed', s);
  }

  private attachListeners(): void {
    if (!this.room) return;

    const offData = this.room.on('data', (raw: any, from: string) => {
      this.handleData(raw, from);
    });

    const offJoined = this.room.on('peer_joined', (info: PeerInfo) => {
      this.remoteFingerprint = info.fingerprint;
      this.emit('peer_joined', info);
    });

    const offConnected = this.room.on('peer_connected', (fp: string) => {
      this.remoteFingerprint = fp;
      this.startKeyExchange(fp);
    });

    const offLeft = this.room.on('peer_left', (fp: string) => {
      if (fp === this.remoteFingerprint) {
        this.e2e.removeKey(fp);
        this.remoteFingerprint = '';
        if (this._state !== 'closed') {
          this.setState('connecting');
        }
      }
      this.emit('peer_left', fp);
    });

    const offClosed = this.room.on('closed', () => {
      this.close();
    });

    const offError = this.room.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.cleanups.push(offData, offJoined, offConnected, offLeft, offClosed, offError);
  }

  private startKeyExchange(fingerprint: string): void {
    if (this._closed) return;
    this.setState('exchanging');
    this.clearExchangeTimer();

    this.exchangeTimer = setTimeout(() => {
      if (this._state === 'exchanging') {
        this.emit('error', new Error('Key exchange timeout'));
        this.setState('connecting');
      }
    }, KEY_EXCHANGE_TIMEOUT);

    try {
      const pubKey = this.e2e.getPublicKeyB64();
      this.room!.send({
        _e2e_exchange: true,
        type: 'key_offer',
        publicKey: pubKey,
        fingerprint: this.client.fingerprint,
      });
    } catch (err) {
      this.clearExchangeTimer();
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async handleKeyExchange(payload: any, from: string): Promise<void> {
    if (this._closed) return;

    if (payload.type === 'key_offer') {
      try {
        await this.e2e.deriveKey(from, payload.publicKey);
        const pubKey = this.e2e.getPublicKeyB64();
        this.room!.send({
          _e2e_exchange: true,
          type: 'key_ack',
          publicKey: pubKey,
          fingerprint: this.client.fingerprint,
        });
        this.clearExchangeTimer();
        this.remoteFingerprint = from;
        this.setState('ready');
        this.emit('ready', from);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (payload.type === 'key_ack') {
      try {
        await this.e2e.deriveKey(from, payload.publicKey);
        this.clearExchangeTimer();
        this.remoteFingerprint = from;
        this.setState('ready');
        this.emit('ready', from);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async handleData(raw: any, from: string): Promise<void> {
    if (raw?._e2e_exchange) {
      await this.handleKeyExchange(raw, from);
      return;
    }

    if (raw?._encrypted && this.e2e.hasKey(from)) {
      try {
        const decrypted = await this.e2e.decrypt(from, raw.data);
        const parsed = JSON.parse(decrypted);
        this.emit('data', parsed, from);
      } catch {
        this.emit('decrypt_error', from, raw);
        this.startKeyExchange(from);
      }
      return;
    }

    if (raw?._plain) {
      this.emit('data', raw.data, from);
      return;
    }

    this.emit('data', raw, from);
  }

  private async encryptAndSend(data: any): Promise<void> {
    try {
      const encrypted = await this.e2e.encrypt(
        this.remoteFingerprint,
        JSON.stringify(data),
      );
      this.room!.send({ _encrypted: true, data: encrypted });
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.room!.send({ _plain: true, data });
    }
  }

  private clearExchangeTimer(): void {
    if (this.exchangeTimer) {
      clearTimeout(this.exchangeTimer);
      this.exchangeTimer = null;
    }
  }
}