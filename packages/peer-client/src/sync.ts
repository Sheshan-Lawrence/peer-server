import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { SyncConfig, SyncMode, SyncState, HLC, PeerInfo } from './core/types';
import { LIMITS } from './core/types';
import { arrayToBase64, base64ToArray } from './crypto';

type SyncEvent = 'state_changed' | 'conflict' | 'synced' | 'error';

function createHLC(node: string, existing?: HLC): HLC {
  const now = Date.now();
  if (!existing) return { ts: now, counter: 0, node };
  const ts = Math.max(now, existing.ts);
  const counter = ts === existing.ts ? existing.counter + 1 : 0;
  return { ts, counter, node };
}

function mergeHLC(local: HLC, remote: HLC, node: string): HLC {
  const now = Date.now();
  const maxTs = Math.max(now, local.ts, remote.ts);
  let counter = 0;
  if (maxTs === local.ts && maxTs === remote.ts) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (maxTs === local.ts) {
    counter = local.counter + 1;
  } else if (maxTs === remote.ts) {
    counter = remote.counter + 1;
  }
  return { ts: maxTs, counter, node };
}

export function compareHLC(a: HLC, b: HLC): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

export { createHLC, mergeHLC };

export class StateSync extends Emitter<SyncEvent> {
  private client: PeerClient;
  private state = new Map<string, SyncState>();
  private mode: SyncMode;
  private merge?: (local: any, remote: any) => any;
  private hlc: HLC;
  private roomId: string;
  private cleanups: (() => void)[] = [];
  private tombstoneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: PeerClient, roomId: string, config: SyncConfig) {
    super();
    this.client = client;
    this.roomId = roomId;
    this.mode = config.mode;
    this.merge = config.merge;
    this.hlc = { ts: Date.now(), counter: 0, node: client.fingerprint };

    if (this.mode === 'operational' && !this.merge) {
      throw new Error('Operational sync requires a merge function');
    }
  }

  start(): void {
    const offBroadcast = this.client.on('broadcast', (from: string, ns: string, payload: any) => {
      if (ns === this.roomId && payload?._sync) {
        this.handleRemoteUpdate(payload, from);
      }
    });

    const offRelay = this.client.on('relay', (from: string, payload: any) => {
      if (payload?._sync && payload?._room === this.roomId) {
        this.handleRemoteUpdate(payload, from);
      }
    });

    const offJoined = this.client.on('peer_joined', () => {
      this.broadcastFullState();
    });

    this.tombstoneTimer = setInterval(() => this.purgeTombstones(), LIMITS.TOMBSTONE_TTL);

    this.cleanups.push(offBroadcast, offRelay, offJoined);
  }

  private tick(): HLC {
    this.hlc = createHLC(this.client.fingerprint, this.hlc);
    return this.hlc;
  }

  set(key: string, value: any): void {
    const hlc = this.tick();
    const entry: SyncState = {
      key,
      value,
      hlc,
      from: this.client.fingerprint,
      version: hlc.counter,
    };
    this.state.set(key, entry);
    this.emit('state_changed', key, value, this.client.fingerprint);

    this.client.broadcast(this.roomId, {
      _sync: true,
      type: 'update',
      entry,
    });
  }

  get(key: string): any {
    const entry = this.state.get(key);
    if (entry?.deleted) return undefined;
    return entry?.value;
  }

  getAll(): Record<string, any> {
    const result: Record<string, any> = {};
    this.state.forEach((entry, key) => {
      if (!entry.deleted) {
        result[key] = entry.value;
      }
    });
    return result;
  }

  getState(): Map<string, SyncState> {
    return new Map(this.state);
  }

  getHLC(): HLC {
    return { ...this.hlc };
  }

  delete(key: string): void {
    const hlc = this.tick();
    const entry: SyncState = {
      key,
      value: undefined,
      hlc,
      from: this.client.fingerprint,
      version: hlc.counter,
      deleted: true,
    };
    this.state.set(key, entry);

    this.client.broadcast(this.roomId, {
      _sync: true,
      type: 'delete',
      entry,
    });
    this.emit('state_changed', key, undefined, this.client.fingerprint);
  }

  private handleRemoteUpdate(payload: any, from: string): void {
    if (payload.type === 'full_state') {
      this.handleFullState(payload.state, from);
      return;
    }

    if (payload.type === 'request_state') {
      this.sendStateTo(from);
      return;
    }

    if (payload.type === 'delete') {
      const remote: SyncState = payload.entry;
      if (!remote?.hlc) return;
      this.hlc = mergeHLC(this.hlc, remote.hlc, this.client.fingerprint);
      const local = this.state.get(remote.key);
      if (!local || compareHLC(remote.hlc, local.hlc) > 0) {
        this.state.set(remote.key, remote);
        this.emit('state_changed', remote.key, undefined, from);
      }
      this.emit('synced', from);
      return;
    }

    if (payload.type !== 'update' || !payload.entry) return;

    const remote: SyncState = payload.entry;
    if (!remote?.hlc) return;
    this.hlc = mergeHLC(this.hlc, remote.hlc, this.client.fingerprint);
    const local = this.state.get(remote.key);

    switch (this.mode) {
      case 'lww': {
        if (!local || compareHLC(remote.hlc, local.hlc) > 0) {
          this.state.set(remote.key, remote);
          this.emit('state_changed', remote.key, remote.value, from);
        }
        break;
      }

      case 'operational': {
        if (!local || local.deleted) {
          this.state.set(remote.key, remote);
          this.emit('state_changed', remote.key, remote.value, from);
        } else {
          const merged = this.merge!(local.value, remote.value);
          const hlc = this.tick();
          const entry: SyncState = {
            key: remote.key,
            value: merged,
            hlc,
            from: this.client.fingerprint,
            version: hlc.counter,
          };
          this.state.set(remote.key, entry);
          this.emit('state_changed', remote.key, merged, from);
          this.emit('conflict', remote.key, local.value, remote.value, merged);
        }
        break;
      }

      case 'crdt': {
        this.emit('error', new Error('CRDT mode requires CRDTSync class'));
        break;
      }
    }

    this.emit('synced', from);
  }

  handleFullState(remoteState: SyncState[], from: string): void {
    for (const remote of remoteState) {
      if (!remote?.hlc) continue;
      this.hlc = mergeHLC(this.hlc, remote.hlc, this.client.fingerprint);
      const local = this.state.get(remote.key);
      if (!local || compareHLC(remote.hlc, local.hlc) > 0) {
        this.state.set(remote.key, remote);
        if (!remote.deleted) {
          this.emit('state_changed', remote.key, remote.value, from);
        }
      }
    }
    this.emit('synced', from);
  }

  loadState(entries: SyncState[]): void {
    for (const entry of entries) {
      const local = this.state.get(entry.key);
      if (!local || compareHLC(entry.hlc, local.hlc) > 0) {
        this.state.set(entry.key, entry);
      }
      if (entry.hlc) {
        this.hlc = mergeHLC(this.hlc, entry.hlc, this.client.fingerprint);
      }
    }
  }

  private broadcastFullState(): void {
    const entries = Array.from(this.state.values());
    if (entries.length === 0) return;
    this.client.broadcast(this.roomId, {
      _sync: true,
      type: 'full_state',
      state: entries,
    });
  }

  private sendStateTo(fingerprint: string): void {
    const entries = Array.from(this.state.values());
    if (entries.length === 0) return;
    this.client.relay(fingerprint, {
      _sync: true,
      _room: this.roomId,
      type: 'full_state',
      state: entries,
    });
  }

  requestFullState(fingerprint: string): void {
    this.client.relay(fingerprint, {
      _sync: true,
      _room: this.roomId,
      type: 'request_state',
    });
  }

  private purgeTombstones(): void {
    const now = Date.now();
    for (const [key, entry] of this.state) {
      if (entry.deleted && now - entry.hlc.ts > LIMITS.TOMBSTONE_TTL) {
        this.state.delete(key);
      }
    }
  }

  destroy(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    if (this.tombstoneTimer) {
      clearInterval(this.tombstoneTimer);
      this.tombstoneTimer = null;
    }
    this.state.clear();
    this.removeAllListeners();
  }
}

export class CRDTSync extends Emitter<SyncEvent> {
  private client: PeerClient;
  private roomId: string;
  private doc: any = null;
  private cleanups: (() => void)[] = [];
  private Yjs: any = null;

  constructor(client: PeerClient, roomId: string, yjsModule: any) {
    super();
    this.client = client;
    this.roomId = roomId;
    this.Yjs = yjsModule;
    this.doc = new yjsModule.Doc();
  }

  getDoc(): any {
    return this.doc;
  }

  getMap(name = 'shared'): any {
    return this.doc.getMap(name);
  }

  getText(name = 'text'): any {
    return this.doc.getText(name);
  }

  getArray(name = 'array'): any {
    return this.doc.getArray(name);
  }

  start(): void {
    this.doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== 'remote') {
        const encoded = arrayToBase64(update);
        this.client.broadcast(this.roomId, {
          _crdt_sync: true,
          update: encoded,
        });
      }
    });

    const offBroadcast = this.client.on('broadcast', (from: string, ns: string, payload: any) => {
      if (ns === this.roomId && payload?._crdt_sync && payload.update) {
        const bytes = base64ToArray(payload.update);
        this.Yjs.applyUpdate(this.doc, bytes, 'remote');
        this.emit('synced', from);
      }
    });

    const offRelay = this.client.on('relay', (from: string, payload: any) => {
      if (payload?._crdt_sync && payload._room === this.roomId) {
        if (payload.update) {
          const bytes = base64ToArray(payload.update);
          this.Yjs.applyUpdate(this.doc, bytes, 'remote');
          this.emit('synced', from);
        }
        if (payload.type === 'request_state') {
          this.sendStateTo(from);
        }
      }
    });

    const offJoined = this.client.on('peer_joined', (info: any) => {
      this.sendStateTo(info.fingerprint);
    });

    this.cleanups.push(offBroadcast, offRelay, offJoined);
  }

  private sendStateTo(fingerprint: string): void {
    const state = this.Yjs.encodeStateAsUpdate(this.doc);
    const encoded = arrayToBase64(state);
    this.client.relay(fingerprint, {
      _crdt_sync: true,
      _room: this.roomId,
      update: encoded,
    });
  }

  requestFullState(fingerprint: string): void {
    this.client.relay(fingerprint, {
      _crdt_sync: true,
      _room: this.roomId,
      type: 'request_state',
    });
  }

  destroy(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.doc?.destroy();
    this.doc = null;
    this.removeAllListeners();
  }
}