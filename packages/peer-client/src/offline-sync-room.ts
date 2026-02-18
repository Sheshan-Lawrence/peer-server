import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { PeerInfo, SyncState, HLC, OfflineOperation, OfflineSyncRoomConfig } from './core/types';
import { LIMITS } from './core/types';
import { OfflineStore } from './core/offline-store';
import { E2E } from './crypto';
import { createHLC, mergeHLC, compareHLC } from './sync';

type OfflineSyncEvent =
    | 'ready'
    | 'state_changed'
    | 'synced'
    | 'sync_started'
    | 'sync_complete'
    | 'offline'
    | 'online'
    | 'peer_joined'
    | 'peer_left'
    | 'conflict'
    | 'error'
    | 'closed';

let opCounter = 0;
function genOpId(): string {
    return `${Date.now()}-${++opCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export class OfflineSyncRoom extends Emitter<OfflineSyncEvent> {
    private client: PeerClient;
    private roomId: string;
    private store: OfflineStore;
    private e2e: E2E;
    private state = new Map<string, SyncState>();
    private hlc: HLC;
    private _closed = false;
    private _online = false;
    private _ready = false;
    private _syncing = false;
    private cleanups: (() => void)[] = [];
    private remoteKeys = new Map<string, boolean>();
    private encryptionEnabled: boolean;
    private maxPendingOps: number;
    private syncBatchSize: number;
    private conflictResolution: 'lww' | 'merge';
    private mergeFn?: (local: any, remote: any) => any;
    private onlineHandler: (() => void) | null = null;
    private offlineHandler: (() => void) | null = null;

    constructor(client: PeerClient, roomId: string, config?: OfflineSyncRoomConfig) {
        super();
        this.client = client;
        this.roomId = roomId;
        this.encryptionEnabled = config?.encryptionEnabled ?? true;
        this.maxPendingOps = config?.maxPendingOps ?? LIMITS.MAX_PENDING_OPS;
        this.syncBatchSize = config?.syncBatchSize ?? LIMITS.SYNC_BATCH_SIZE;
        this.conflictResolution = config?.conflictResolution ?? 'lww';
        this.mergeFn = config?.merge;
        this.store = new OfflineStore(config?.dbName ?? `osr-${roomId}`);
        this.e2e = new E2E();
        this.hlc = { ts: Date.now(), counter: 0, node: client.fingerprint || 'local' };

        if (this.conflictResolution === 'merge' && !this.mergeFn) {
            throw new Error('merge conflict resolution requires a merge function');
        }
    }

    async init(): Promise<void> {
        await this.store.open();

        if (this.encryptionEnabled) {
            await this.e2e.init();
        }

        const savedHLC = await this.store.getHLC();
        if (savedHLC) {
            this.hlc = mergeHLC(this.hlc, savedHLC, this.hlc.node);
        }

        const entries = await this.store.getAllState();
        for (const entry of entries) {
            this.state.set(entry.key, entry);
        }

        this.attachListeners();
        this.attachNetworkListeners();
        this._ready = true;
        this.emit('ready');
    }

    async createAndJoin(): Promise<void> {
        try {
            await this.client.createRoom(this.roomId, { maxSize: 20 });
        } catch (e: any) {
            if (!e?.message?.includes('already exists')) {
                throw e;
            }
        }
        await this.client.joinRoom(this.roomId);
        this._online = true;
        this.emit('online');
        await this.flushPendingOps();
    }

    async joinExisting(): Promise<PeerInfo[]> {
        const peers = await this.client.joinRoom(this.roomId);
        this._online = true;
        this.emit('online');
        await this.flushPendingOps();
        return peers;
    }

    async set(key: string, value: any): Promise<void> {
        if (this._closed) return;

        const hlc = this.tick();
        const entry: SyncState = {
            key,
            value,
            hlc,
            from: this.hlc.node,
            version: hlc.counter,
        };

        this.state.set(key, entry);
        await this.store.putState(entry);
        await this.store.setHLC(this.hlc);
        this.emit('state_changed', key, value, 'local');

        if (this._online && this.client.connected) {
            await this.sendOperation('set', key, value, hlc);
        } else {
            await this.queueOperation('set', key, value, hlc);
        }
    }

    async delete(key: string): Promise<void> {
        if (this._closed) return;

        const hlc = this.tick();
        const entry: SyncState = {
            key,
            value: undefined,
            hlc,
            from: this.hlc.node,
            version: hlc.counter,
            deleted: true,
        };

        this.state.set(key, entry);
        await this.store.putState(entry);
        await this.store.setHLC(this.hlc);
        this.emit('state_changed', key, undefined, 'local');

        if (this._online && this.client.connected) {
            await this.sendOperation('delete', key, undefined, hlc);
        } else {
            await this.queueOperation('delete', key, undefined, hlc);
        }
    }

    get(key: string): any {
        const entry = this.state.get(key);
        if (!entry || entry.deleted) return undefined;
        return entry.value;
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

    has(key: string): boolean {
        const entry = this.state.get(key);
        return !!entry && !entry.deleted;
    }

    keys(): string[] {
        const result: string[] = [];
        this.state.forEach((entry, key) => {
            if (!entry.deleted) result.push(key);
        });
        return result;
    }

    get size(): number {
        let count = 0;
        this.state.forEach((entry) => {
            if (!entry.deleted) count++;
        });
        return count;
    }

    get online(): boolean {
        return this._online;
    }

    get ready(): boolean {
        return this._ready;
    }

    get syncing(): boolean {
        return this._syncing;
    }

    async pendingCount(): Promise<number> {
        return this.store.pendingOpCount();
    }

    getE2E(): E2E {
        return this.e2e;
    }

    private tick(): HLC {
        this.hlc = createHLC(this.hlc.node, this.hlc);
        return this.hlc;
    }

    private async sendOperation(type: 'set' | 'delete', key: string, value: any, hlc: HLC): Promise<void> {
        const payload: any = {
            _osr: true,
            type,
            key,
            hlc,
        };

        if (type === 'set') {
            if (this.encryptionEnabled) {
                const json = JSON.stringify(value);
                const targets = this.getEncryptionTargets();
                if (targets.length > 0) {
                    for (const fp of targets) {
                        try {
                            const encrypted = await this.e2e.encrypt(fp, json);
                            this.client.relay(fp, { ...payload, encrypted, roomId: this.roomId });
                        } catch {
                            this.client.relay(fp, { ...payload, value, roomId: this.roomId });
                        }
                    }
                } else {
                    this.client.broadcast(this.roomId, { ...payload, value });
                }
            } else {
                payload.value = value;
                this.client.broadcast(this.roomId, payload);
            }
        } else {
            this.client.broadcast(this.roomId, payload);
        }
    }


    private async queueOperation(type: 'set' | 'delete', key: string, value: any, hlc: HLC): Promise<void> {
        const count = await this.store.pendingOpCount();
        if (count >= this.maxPendingOps) {
            this.emit('error', new Error('Pending operations limit reached'));
            return;
        }

        const op: OfflineOperation = {
            id: genOpId(),
            type,
            key,
            value,
            hlc,
            ts: Date.now(),
        };

        await this.store.addPendingOp(op);
    }

    private async flushPendingOps(): Promise<void> {
        if (this._syncing || !this._online) return;
        this._syncing = true;
        this.emit('sync_started');

        try {
            this.broadcastFullState();

            const ops = await this.store.getAllPendingOps();

            for (let i = 0; i < ops.length; i += this.syncBatchSize) {
                const batch = ops.slice(i, i + this.syncBatchSize);
                for (const op of batch) {
                    await this.sendOperation(op.type, op.key, op.value, op.hlc);
                    await this.store.removePendingOp(op.id);
                }
                if (i + this.syncBatchSize < ops.length) {
                    await new Promise((r) => setTimeout(r, 10));
                }
            }

            await this.store.setLastSyncTime(Date.now());
            this.emit('sync_complete');
        } catch (e) {
            this.emit('error', e);
        } finally {
            this._syncing = false;
        }
    }

    private broadcastFullState(): void {
        const entries = Array.from(this.state.values());
        if (entries.length === 0) return;

        const batches: SyncState[][] = [];
        for (let i = 0; i < entries.length; i += this.syncBatchSize) {
            batches.push(entries.slice(i, i + this.syncBatchSize));
        }

        for (const batch of batches) {
            this.client.broadcast(this.roomId, {
                _osr: true,
                type: 'full_state',
                state: batch,
            });
        }
    }

    private async handleRemoteUpdate(payload: any, from: string): Promise<void> {
        if (this._closed) return;

        if (payload.type === 'full_state' && Array.isArray(payload.state)) {
            for (const remote of payload.state) {
                await this.applyRemoteEntry(remote, from);
            }
            this.emit('synced', from);
            return;
        }

        if (payload.type === 'request_state') {
            this.broadcastFullState();
            return;
        }

        if (payload.type === 'key_exchange') {
            await this.handleKeyExchange(payload, from);
            return;
        }

        let value = payload.value;
        if (payload.encrypted && this.encryptionEnabled && this.e2e.hasKey(from)) {
            try {
                value = JSON.parse(await this.e2e.decrypt(from, payload.encrypted));
            } catch {
                this.emit('error', new Error(`Decryption failed from ${from}`));
                return;
            }
        }

        const remote: SyncState = {
            key: payload.key,
            value: payload.type === 'delete' ? undefined : value,
            hlc: payload.hlc,
            from,
            version: payload.hlc?.counter ?? 0,
            deleted: payload.type === 'delete',
        };

        await this.applyRemoteEntry(remote, from);
        this.emit('synced', from);
    }

    private async applyRemoteEntry(remote: SyncState, from: string): Promise<void> {
        if (!remote?.hlc || !remote.key) return;

        this.hlc = mergeHLC(this.hlc, remote.hlc, this.hlc.node);
        const local = this.state.get(remote.key);

        if (this.conflictResolution === 'merge' && local && !local.deleted && !remote.deleted && this.mergeFn) {
            if (compareHLC(remote.hlc, local.hlc) !== 0) {
                const merged = this.mergeFn(local.value, remote.value);
                const hlc = this.tick();
                const entry: SyncState = {
                    key: remote.key,
                    value: merged,
                    hlc,
                    from: this.hlc.node,
                    version: hlc.counter,
                };
                this.state.set(remote.key, entry);
                await this.store.putState(entry);
                this.emit('conflict', remote.key, local.value, remote.value, merged);
                this.emit('state_changed', remote.key, merged, from);
                return;
            }
        }

        if (!local || compareHLC(remote.hlc, local.hlc) > 0) {
            this.state.set(remote.key, remote);
            await this.store.putState(remote);
            this.emit('state_changed', remote.key, remote.deleted ? undefined : remote.value, from);
        }

        await this.store.setHLC(this.hlc);
    }

    private async handleKeyExchange(payload: any, from: string): Promise<void> {
        if (!this.encryptionEnabled) return;

        if (payload.subtype === 'offer') {
            try {
                await this.e2e.deriveKey(from, payload.publicKey);
                this.remoteKeys.set(from, true);
                this.client.relay(from, {
                    _osr: true,
                    type: 'key_exchange',
                    subtype: 'ack',
                    publicKey: this.e2e.getPublicKeyB64(),
                    roomId: this.roomId,
                });
            } catch (e) {
                this.emit('error', e);
            }
        }

        if (payload.subtype === 'ack') {
            try {
                await this.e2e.deriveKey(from, payload.publicKey);
                this.remoteKeys.set(from, true);
            } catch (e) {
                this.emit('error', e);
            }
        }
    }

    private initiateKeyExchange(fingerprint: string): void {
        if (!this.encryptionEnabled || this.remoteKeys.has(fingerprint)) return;
        this.client.relay(fingerprint, {
            _osr: true,
            type: 'key_exchange',
            subtype: 'offer',
            publicKey: this.e2e.getPublicKeyB64(),
            roomId: this.roomId,
        });
    }

    private getEncryptionTargets(): string[] {
        const targets: string[] = [];
        this.remoteKeys.forEach((_, fp) => targets.push(fp));
        return targets;
    }

    private attachListeners(): void {
        const offBroadcast = this.client.on('broadcast', (from: string, ns: string, payload: any) => {
            if (ns === this.roomId && payload?._osr) {
                this.handleRemoteUpdate(payload, from);
            }
        });

        const offRelay = this.client.on('relay', (from: string, payload: any) => {
            if (payload?._osr && payload?.roomId === this.roomId) {
                this.handleRemoteUpdate(payload, from);
            }
        });

        const offJoined = this.client.on('peer_joined', (info: PeerInfo & { namespace?: string }) => {
            if (info.namespace && info.namespace !== this.roomId) return;
            this.emit('peer_joined', info);
            this.initiateKeyExchange(info.fingerprint);
            setTimeout(() => this.broadcastFullState(), 100);
        });

        const offLeft = this.client.on('peer_left', (fp: string, ns: string) => {
            if (ns && ns !== this.roomId) return;
            this.remoteKeys.delete(fp);
            this.e2e.removeKey(fp);
            this.emit('peer_left', fp);
        });

        const offReconnected = this.client.on('reconnected', () => {
            this._online = true;
            this.emit('online');
            this.client.joinRoom(this.roomId).then(() => {
                this.flushPendingOps();
            }).catch((e) => {
                this.emit('error', e);
            });
        });

        const offDisconnected = this.client.on('disconnected', () => {
            this._online = false;
            this.emit('offline');
        });

        this.cleanups.push(offBroadcast, offRelay, offJoined, offLeft, offReconnected, offDisconnected);
    }

    private attachNetworkListeners(): void {
        if (typeof window === 'undefined') return;

        this.onlineHandler = () => {
            if (this.client.connected) {
                this._online = true;
                this.emit('online');
                this.flushPendingOps();
            }
        };

        this.offlineHandler = () => {
            this._online = false;
            this.emit('offline');
        };

        window.addEventListener('online', this.onlineHandler);
        window.addEventListener('offline', this.offlineHandler);
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this.cleanups.forEach((fn) => fn());
        this.cleanups = [];

        if (typeof window !== 'undefined') {
            if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
            if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler);
        }

        await this.store.setHLC(this.hlc);
        this.store.close();
        this.e2e.destroy();
        this.client.leave(this.roomId);
        this.emit('closed');
        this.removeAllListeners();
    }

    async destroy(): Promise<void> {
        await this.close();
        await this.store.destroy();
    }
}