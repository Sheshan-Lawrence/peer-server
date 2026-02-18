import type { SyncState, OfflineOperation, HLC } from './types';

const DB_VERSION = 1;

export class OfflineStore {
  private db: IDBDatabase | null = null;
  private dbName: string;

  constructor(dbName: string) {
    this.dbName = dbName;
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('state')) {
          db.createObjectStore('state', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('pending')) {
          const store = db.createObjectStore('pending', { keyPath: 'id' });
          store.createIndex('ts', 'ts', { unique: false });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${this.dbName}`));
      };
    });
  }

  async getState(key: string): Promise<SyncState | null> {
    return this.get<SyncState>('state', key);
  }

  async putState(entry: SyncState): Promise<void> {
    return this.put('state', entry);
  }

  async getAllState(): Promise<SyncState[]> {
    return this.getAll<SyncState>('state');
  }

  async deleteState(key: string): Promise<void> {
    return this.del('state', key);
  }

  async clearState(): Promise<void> {
    return this.clear('state');
  }

  async addPendingOp(op: OfflineOperation): Promise<void> {
    return this.put('pending', op);
  }

  async getAllPendingOps(): Promise<OfflineOperation[]> {
    const ops = await this.getAll<OfflineOperation>('pending');
    return ops.sort((a, b) => a.ts - b.ts);
  }

  async removePendingOp(id: string): Promise<void> {
    return this.del('pending', id);
  }

  async clearPendingOps(): Promise<void> {
    return this.clear('pending');
  }

  async pendingOpCount(): Promise<number> {
    return this.count('pending');
  }

  async getMeta(id: string): Promise<any> {
    return this.get('meta', id);
  }

  async putMeta(id: string, value: any): Promise<void> {
    return this.put('meta', { id, ...value });
  }

  async getLastSyncTime(): Promise<number> {
    const meta = await this.getMeta('lastSync');
    return meta?.ts ?? 0;
  }

  async setLastSyncTime(ts: number): Promise<void> {
    return this.putMeta('lastSync', { ts });
  }

  async getHLC(): Promise<HLC | null> {
    const meta = await this.getMeta('hlc');
    return meta?.hlc ?? null;
  }

  async setHLC(hlc: HLC): Promise<void> {
    return this.putMeta('hlc', { hlc });
  }

  private get<T>(storeName: string, key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return; }
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  private put(storeName: string, value: any): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return; }
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private del(storeName: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return; }
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private getAll<T>(storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return; }
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  private clear(storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return; }
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private count(storeName: string): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.db) { reject(new Error('DB not open')); return; }
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async destroy(): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}