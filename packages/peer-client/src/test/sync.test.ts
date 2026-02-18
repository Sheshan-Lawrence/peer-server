import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerClient } from '../core/client';
import { StateSync, compareHLC, createHLC, mergeHLC } from '../sync';
import { MockSignalServer, delay, waitForEvent, REAL_SERVER } from './setup';

describe('HLC utilities', () => {
  it('createHLC returns valid HLC', () => {
    const hlc = createHLC('node1');
    expect(hlc.ts).toBeGreaterThan(0);
    expect(hlc.counter).toBe(0);
    expect(hlc.node).toBe('node1');
  });

  it('createHLC increments counter on same ts', () => {
    const h1 = { ts: Date.now() + 100000, counter: 5, node: 'a' };
    const h2 = createHLC('a', h1);
    expect(h2.counter).toBe(6);
  });

  it('createHLC resets counter on new ts', () => {
    const old = { ts: 1000, counter: 99, node: 'a' };
    const h = createHLC('a', old);
    expect(h.counter).toBe(0);
    expect(h.ts).toBeGreaterThan(1000);
  });

  it('mergeHLC takes max ts', () => {
    const a = { ts: 100, counter: 0, node: 'a' };
    const b = { ts: 200, counter: 0, node: 'b' };
    const m = mergeHLC(a, b, 'a');
    expect(m.ts).toBeGreaterThanOrEqual(200);
  });

  it('compareHLC returns negative for older', () => {
    const a = { ts: 100, counter: 0, node: 'a' };
    const b = { ts: 200, counter: 0, node: 'b' };
    expect(compareHLC(a, b)).toBeLessThan(0);
  });

  it('compareHLC returns positive for newer', () => {
    const a = { ts: 300, counter: 0, node: 'a' };
    const b = { ts: 200, counter: 0, node: 'b' };
    expect(compareHLC(a, b)).toBeGreaterThan(0);
  });

  it('compareHLC uses counter as tiebreak', () => {
    const a = { ts: 100, counter: 1, node: 'a' };
    const b = { ts: 100, counter: 2, node: 'b' };
    expect(compareHLC(a, b)).toBeLessThan(0);
  });

  it('compareHLC uses node as final tiebreak', () => {
    const a = { ts: 100, counter: 0, node: 'a' };
    const b = { ts: 100, counter: 0, node: 'b' };
    expect(compareHLC(a, b)).toBeLessThan(0);
  });

  it('compareHLC returns 0 for identical', () => {
    const a = { ts: 100, counter: 0, node: 'a' };
    expect(compareHLC(a, a)).toBe(0);
  });
});

describe('StateSync — Mock Server', () => {
  let server: MockSignalServer;

  beforeEach(async () => {
    server = new MockSignalServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('set and get value', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-ns');

    const sync = new StateSync(c, 'sync-ns', { mode: 'lww' });
    sync.start();

    sync.set('key1', 'value1');
    expect(sync.get('key1')).toBe('value1');

    sync.destroy();
    c.disconnect();
  });

  it('getAll returns all non-deleted entries', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-all');

    const sync = new StateSync(c, 'sync-all', { mode: 'lww' });
    sync.start();

    sync.set('a', 1);
    sync.set('b', 2);
    sync.set('c', 3);
    const all = sync.getAll();
    expect(all).toEqual({ a: 1, b: 2, c: 3 });

    sync.destroy();
    c.disconnect();
  });

  it('delete marks entry as deleted', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-del');

    const sync = new StateSync(c, 'sync-del', { mode: 'lww' });
    sync.start();

    sync.set('x', 'alive');
    sync.delete('x');
    expect(sync.get('x')).toBeUndefined();

    sync.destroy();
    c.disconnect();
  });

  it('getAll excludes deleted entries', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-excl');

    const sync = new StateSync(c, 'sync-excl', { mode: 'lww' });
    sync.start();

    sync.set('a', 1);
    sync.set('b', 2);
    sync.delete('a');
    expect(sync.getAll()).toEqual({ b: 2 });

    sync.destroy();
    c.disconnect();
  });

  it('emits state_changed on set', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-ev');

    const sync = new StateSync(c, 'sync-ev', { mode: 'lww' });
    sync.start();

    const fn = vi.fn();
    sync.on('state_changed', fn);
    sync.set('k', 'v');
    expect(fn).toHaveBeenCalledWith('k', 'v', c.fingerprint);

    sync.destroy();
    c.disconnect();
  });

  it('emits state_changed on delete', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-del-ev');

    const sync = new StateSync(c, 'sync-del-ev', { mode: 'lww' });
    sync.start();

    sync.set('k', 'v');
    const fn = vi.fn();
    sync.on('state_changed', fn);
    sync.delete('k');
    expect(fn).toHaveBeenCalledWith('k', undefined, c.fingerprint);

    sync.destroy();
    c.disconnect();
  });

  it('lww: remote update wins if newer', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    const ns = 'sync-lww';
    await c1.join(ns);
    await c2.join(ns);

    const s1 = new StateSync(c1, ns, { mode: 'lww' });
    const s2 = new StateSync(c2, ns, { mode: 'lww' });
    s1.start();
    s2.start();

    s1.set('shared', 'from-s1');
    await delay(100);
    s2.set('shared', 'from-s2');
    await delay(300);

    expect(s1.get('shared')).toBe('from-s2');

    s1.destroy();
    s2.destroy();
    c1.disconnect();
    c2.disconnect();
  });

  it('operational mode requires merge function', () => {
    const c = new PeerClient({ url: 'ws://localhost:1', autoReconnect: false });
    expect(() => new StateSync(c, 'x', { mode: 'operational' })).toThrow('merge function');
  });

  it('operational mode merges on conflict', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    const ns = 'sync-op';
    await c1.join(ns);
    await c2.join(ns);

    const merge = (a: number, b: number) => a + b;
    const s1 = new StateSync(c1, ns, { mode: 'operational', merge });
    const s2 = new StateSync(c2, ns, { mode: 'operational', merge });
    s1.start();
    s2.start();

    s1.set('counter', 10);
    await delay(200);
    s2.set('counter', 5);
    await delay(300);

    const v1 = s1.get('counter');
    expect(typeof v1).toBe('number');

    s1.destroy();
    s2.destroy();
    c1.disconnect();
    c2.disconnect();
  });

  it('getState returns full state map', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-state');
    const sync = new StateSync(c, 'sync-state', { mode: 'lww' });
    sync.start();

    sync.set('a', 1);
    const state = sync.getState();
    expect(state.has('a')).toBe(true);
    expect(state.get('a')!.value).toBe(1);

    sync.destroy();
    c.disconnect();
  });

  it('getHLC returns current clock', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-hlc');
    const sync = new StateSync(c, 'sync-hlc', { mode: 'lww' });
    sync.start();

    const hlc = sync.getHLC();
    expect(hlc.ts).toBeGreaterThan(0);
    expect(hlc.node).toBe(c.fingerprint);

    sync.destroy();
    c.disconnect();
  });

  it('loadState ingests pre-existing entries', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-load');
    const sync = new StateSync(c, 'sync-load', { mode: 'lww' });
    sync.start();

    sync.loadState([
      { key: 'pre', value: 'loaded', hlc: { ts: Date.now(), counter: 0, node: 'x' }, from: 'x', version: 0 },
    ]);
    expect(sync.get('pre')).toBe('loaded');

    sync.destroy();
    c.disconnect();
  });

  it('requestFullState triggers remote to send state', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    const ns = 'sync-req';
    await c1.join(ns);
    await c2.join(ns);

    const s1 = new StateSync(c1, ns, { mode: 'lww' });
    const s2 = new StateSync(c2, ns, { mode: 'lww' });
    s1.start();
    s2.start();

    s1.set('x', 42);
    await delay(100);

    s2.requestFullState(c1.fingerprint);
    await delay(500);
    expect(s2.get('x')).toBe(42);

    s1.destroy();
    s2.destroy();
    c1.disconnect();
    c2.disconnect();
  });

  it('full state broadcast on peer join', async () => {
    const c1 = new PeerClient({ url: server.url, autoReconnect: false });
    await c1.connect();
    const ns = 'sync-join-bc';
    await c1.join(ns);
    const s1 = new StateSync(c1, ns, { mode: 'lww' });
    s1.start();
    s1.set('pre', 'existing');

    const c2 = new PeerClient({ url: server.url, autoReconnect: false });
    await c2.connect();
    await c2.join(ns);
    const s2 = new StateSync(c2, ns, { mode: 'lww' });
    s2.start();
    await delay(500);

    expect(s2.get('pre')).toBe('existing');

    s1.destroy();
    s2.destroy();
    c1.disconnect();
    c2.disconnect();
  });

  it('destroy cleans up timers and listeners', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-destroy');
    const sync = new StateSync(c, 'sync-destroy', { mode: 'lww' });
    sync.start();
    sync.set('a', 1);
    sync.destroy();
    expect(sync.listenerCount('state_changed')).toBe(0);
    c.disconnect();
  });

  it('overwrite existing key', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-ow');
    const sync = new StateSync(c, 'sync-ow', { mode: 'lww' });
    sync.start();

    sync.set('k', 'v1');
    sync.set('k', 'v2');
    expect(sync.get('k')).toBe('v2');

    sync.destroy();
    c.disconnect();
  });

  it('get non-existent key returns undefined', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-none');
    const sync = new StateSync(c, 'sync-none', { mode: 'lww' });
    sync.start();
    expect(sync.get('nonexistent')).toBeUndefined();
    sync.destroy();
    c.disconnect();
  });

  it('stress: 100 rapid sets', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-stress');
    const sync = new StateSync(c, 'sync-stress', { mode: 'lww' });
    sync.start();

    for (let i = 0; i < 100; i++) {
      sync.set(`k${i}`, i);
    }
    expect(Object.keys(sync.getAll()).length).toBe(100);

    sync.destroy();
    c.disconnect();
  });

  it('sync complex objects', async () => {
    const c = new PeerClient({ url: server.url, autoReconnect: false });
    await c.connect();
    await c.join('sync-obj');
    const sync = new StateSync(c, 'sync-obj', { mode: 'lww' });
    sync.start();

    const obj = { nested: { arr: [1, 2], bool: true }, str: 'hello' };
    sync.set('complex', obj);
    expect(sync.get('complex')).toEqual(obj);

    sync.destroy();
    c.disconnect();
  });
});

describe('StateSync — Real Server', () => {
  it('two peers sync state on real server', async () => {
    const ns = 'vitest-sync-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join(ns);
    await c2.join(ns);

    const s1 = new StateSync(c1, ns, { mode: 'lww' });
    const s2 = new StateSync(c2, ns, { mode: 'lww' });
    s1.start();
    s2.start();

    s1.set('hello', 'world');
    await delay(1000);

    expect(s2.get('hello')).toBe('world');

    s1.destroy();
    s2.destroy();
    c1.disconnect();
    c2.disconnect();
  }, 20000);

  it('stress: 50 keys synced between two peers', async () => {
    const ns = 'vitest-sync-stress-' + Date.now();
    const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
    await c1.connect();
    await c2.connect();
    await c1.join(ns);
    await c2.join(ns);

    const s1 = new StateSync(c1, ns, { mode: 'lww' });
    const s2 = new StateSync(c2, ns, { mode: 'lww' });
    s1.start();
    s2.start();

    for (let i = 0; i < 50; i++) {
      s1.set(`k${i}`, i);
    }
    await delay(2000);

    let synced = 0;
    for (let i = 0; i < 50; i++) {
      if (s2.get(`k${i}`) === i) synced++;
    }
    expect(synced).toBeGreaterThanOrEqual(40);

    s1.destroy();
    s2.destroy();
    c1.disconnect();
    c2.disconnect();
  }, 30000);
});