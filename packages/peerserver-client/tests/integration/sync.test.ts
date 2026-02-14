import { describe, it, expect, afterEach } from 'vitest';
import { connectPair, cleanup, waitForEvent, TIMEOUT, delay } from './setup';
import { StateSync } from '../../src/sync';
import type { PeerClient } from '../../src/core/client';

let clients: PeerClient[] = [];

afterEach(() => {
  cleanup(...clients);
  clients = [];
});

describe('StateSync Integration', { timeout: TIMEOUT }, () => {
  async function setupSyncPair(mode: 'lww' | 'operational', merge?: (a: any, b: any) => any) {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await a.join(ns);
    await b.join(ns);
    await delay(500);

    const syncA = new StateSync(a, ns, { mode, merge });
    const syncB = new StateSync(b, ns, { mode, merge });
    syncA.start();
    syncB.start();

    return { a, b, syncA, syncB, ns };
  }

  it('should sync a value from A to B (LWW)', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    const changedPromise = waitForEvent(syncB, 'state_changed');
    syncA.set('color', 'red');
    const [key, value, from] = await changedPromise;

    expect(key).toBe('color');
    expect(value).toBe('red');
    expect(syncB.get('color')).toBe('red');

    syncA.destroy();
    syncB.destroy();
  });

  it('should sync a value from B to A (LWW)', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    const changedPromise = waitForEvent(syncA, 'state_changed');
    syncB.set('name', 'bob');
    const [key, value] = await changedPromise;

    expect(key).toBe('name');
    expect(value).toBe('bob');
    expect(syncA.get('name')).toBe('bob');

    syncA.destroy();
    syncB.destroy();
  });

  it('should sync multiple keys', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    let count = 0;
    const allReceived = new Promise<void>((resolve) => {
      syncB.on('state_changed', () => {
        count++;
        if (count >= 3) resolve();
      });
    });

    syncA.set('x', 1);
    syncA.set('y', 2);
    syncA.set('z', 3);

    await allReceived;

    expect(syncB.get('x')).toBe(1);
    expect(syncB.get('y')).toBe(2);
    expect(syncB.get('z')).toBe(3);

    syncA.destroy();
    syncB.destroy();
  });

  it('should sync delete with tombstone', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    const setPromise = waitForEvent(syncB, 'state_changed');
    syncA.set('temp', 'exists');
    await setPromise;
    expect(syncB.get('temp')).toBe('exists');

    const deletePromise = waitForEvent(syncB, 'state_changed');
    syncA.delete('temp');
    await deletePromise;

    expect(syncB.get('temp')).toBeUndefined();
    expect(syncB.getAll()).not.toHaveProperty('temp');

    syncA.destroy();
    syncB.destroy();
  });

  it('should not resurrect deleted key with old update', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    const setPromise = waitForEvent(syncB, 'state_changed');
    syncA.set('key', 'value');
    await setPromise;

    syncB.delete('key');
    await delay(500);

    expect(syncA.get('key')).toBeUndefined();

    syncA.destroy();
    syncB.destroy();
  });

  it('should LWW newer update wins', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    syncA.set('score', 10);
    await delay(200);
    syncB.set('score', 20);
    await delay(1000);

    const valA = syncA.get('score');
    const valB = syncB.get('score');
    expect(valA).toBe(valB);

    syncA.destroy();
    syncB.destroy();
  });

  it('should getAll returns consistent state', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    syncA.set('a', 1);
    syncA.set('b', 2);
    syncA.set('c', 3);
    await delay(1500);

    const allB = syncB.getAll();
    expect(allB).toEqual({ a: 1, b: 2, c: 3 });

    syncA.destroy();
    syncB.destroy();
  });

  it('should sync full state on new peer join', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);

    const ns = `fullsync-${Date.now()}`;
    await a.join(ns);

    const syncA = new StateSync(a, ns, { mode: 'lww' });
    syncA.start();
    syncA.set('pre1', 'val1');
    syncA.set('pre2', 'val2');

    await delay(500);

    await b.join(ns);
    const syncB = new StateSync(b, ns, { mode: 'lww' });
    syncB.start();

    await delay(2000);

    expect(syncB.get('pre1')).toBe('val1');
    expect(syncB.get('pre2')).toBe('val2');

    syncA.destroy();
    syncB.destroy();
  });

  it('should operational mode merge concurrent updates', async () => {
    const merge = (local: number[], remote: number[]) => [...new Set([...local, ...remote])].sort();

    const { syncA, syncB } = await setupSyncPair('operational', merge);

    syncA.set('tags', [1, 2, 3]);
    await delay(500);

    const conflictPromise = waitForEvent(syncA, 'conflict');
    syncB.set('tags', [3, 4, 5]);
    const [key, localVal, remoteVal, merged] = await conflictPromise;

    expect(key).toBe('tags');
    expect(merged).toEqual([1, 2, 3, 4, 5]);

    syncA.destroy();
    syncB.destroy();
  });

  it('should emit synced event on remote update', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    const syncedPromise = waitForEvent(syncB, 'synced');
    syncA.set('trigger', true);
    const from = await syncedPromise;

    expect(from).toBe(clients[0].fingerprint);

    syncA.destroy();
    syncB.destroy();
  });

  it('should handle complex object values', async () => {
    const { syncA, syncB } = await setupSyncPair('lww');

    const obj = {
      users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
      settings: { theme: 'dark', nested: { deep: true } },
    };

    const changedPromise = waitForEvent(syncB, 'state_changed');
    syncA.set('config', obj);
    await changedPromise;

    expect(syncB.get('config')).toEqual(obj);

    syncA.destroy();
    syncB.destroy();
  });
});
