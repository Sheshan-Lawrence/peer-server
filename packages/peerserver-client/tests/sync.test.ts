import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Emitter } from '../src/core/emitter';
import { StateSync } from '../src/sync';

function mockClient(fp = 'fp-local') {
  const emitter = new Emitter();
  return {
    fingerprint: fp,
    on: (event: string, fn: any) => emitter.on(event as any, fn),
    emit: (event: string, ...args: any[]) => emitter.emit(event as any, ...args),
    broadcast: vi.fn(),
    relay: vi.fn(),
  } as any;
}

describe('StateSync', () => {
  it('should set and get values', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('key1', 'value1');
    expect(sync.get('key1')).toBe('value1');
  });

  it('should broadcast on set', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('key1', 'value1');
    expect(client.broadcast).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ _sync: true, type: 'update' }),
    );
  });

  it('should getAll values', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('a', 1);
    sync.set('b', 2);
    expect(sync.getAll()).toEqual({ a: 1, b: 2 });
  });

  it('should emit state_changed on set', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    const fn = vi.fn();
    sync.on('state_changed', fn);
    sync.set('k', 'v');
    expect(fn).toHaveBeenCalledWith('k', 'v', 'fp-local');
  });

  it('should delete values with tombstone', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('k', 'v');
    sync.delete('k');
    expect(sync.get('k')).toBeUndefined();
    expect(sync.getAll()).toEqual({});
  });

  it('should handle remote LWW update (newer wins)', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();

    sync.set('k', 'local');

    const fn = vi.fn();
    sync.on('state_changed', fn);

    const futureTs = Date.now() + 10000;
    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'k',
        value: 'remote',
        hlc: { ts: futureTs, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 1,
      },
    });

    expect(sync.get('k')).toBe('remote');
    expect(fn).toHaveBeenCalledWith('k', 'remote', 'fp-remote');
  });

  it('should reject older LWW update', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('k', 'local');

    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'k',
        value: 'old-remote',
        hlc: { ts: 1, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 0,
      },
    });

    expect(sync.get('k')).toBe('local');
  });

  it('should handle remote delete with tombstone', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('k', 'v');

    const fn = vi.fn();
    sync.on('state_changed', fn);

    const futureTs = Date.now() + 10000;
    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'delete',
      entry: {
        key: 'k',
        value: undefined,
        hlc: { ts: futureTs, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 1,
        deleted: true,
      },
    });

    expect(sync.get('k')).toBeUndefined();
  });

  it('should not resurrect deleted key with old update', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('k', 'v');
    sync.delete('k');

    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'k',
        value: 'old',
        hlc: { ts: 1, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 0,
      },
    });

    expect(sync.get('k')).toBeUndefined();
  });

  it('should handle operational mode with merge', () => {
    const merge = vi.fn((local, remote) => [...local, ...remote]);
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'operational', merge });
    sync.start();
    sync.set('list', [1, 2]);

    const futureTs = Date.now() + 10000;
    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'list',
        value: [3, 4],
        hlc: { ts: futureTs, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 1,
      },
    });

    expect(merge).toHaveBeenCalledWith([1, 2], [3, 4]);
    expect(sync.get('list')).toEqual([1, 2, 3, 4]);
  });

  it('should emit conflict on operational merge', () => {
    const merge = (a: any, b: any) => ({ ...a, ...b });
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'operational', merge });
    sync.start();
    sync.set('obj', { a: 1 });

    const fn = vi.fn();
    sync.on('conflict', fn);

    const futureTs = Date.now() + 10000;
    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'obj',
        value: { b: 2 },
        hlc: { ts: futureTs, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 1,
      },
    });

    expect(fn).toHaveBeenCalledWith('obj', { a: 1 }, { b: 2 }, { a: 1, b: 2 });
  });

  it('should throw if operational mode without merge', () => {
    const client = mockClient();
    expect(() => new StateSync(client, 'r', { mode: 'operational' })).toThrow(
      'merge function',
    );
  });

  it('should broadcast full state on peer join', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('a', 1);
    sync.set('b', 2);

    client.emit('peer_joined', { fingerprint: 'fp-new' });
    expect(client.broadcast).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ _sync: true, type: 'full_state' }),
    );
  });

  it('should handle full state from remote', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();

    const fn = vi.fn();
    sync.on('state_changed', fn);

    const ts = Date.now() + 10000;
    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'full_state',
      state: [
        { key: 'x', value: 10, hlc: { ts, counter: 0, node: 'fp-remote' }, from: 'fp-remote', version: 0 },
        { key: 'y', value: 20, hlc: { ts, counter: 1, node: 'fp-remote' }, from: 'fp-remote', version: 1 },
      ],
    });

    expect(sync.get('x')).toBe(10);
    expect(sync.get('y')).toBe(20);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should handle relay updates', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();

    const ts = Date.now() + 10000;
    client.emit('relay', 'fp-remote', {
      _sync: true,
      _room: 'room1',
      type: 'update',
      entry: {
        key: 'r',
        value: 'relayed',
        hlc: { ts, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 0,
      },
    });

    expect(sync.get('r')).toBe('relayed');
  });

  it('should request full state from specific peer', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.requestFullState('fp-target');
    expect(client.relay).toHaveBeenCalledWith('fp-target', expect.objectContaining({
      _sync: true,
      type: 'request_state',
    }));
  });

  it('should respond to request_state via relay', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('a', 1);

    client.emit('relay', 'fp-requester', {
      _sync: true,
      _room: 'room1',
      type: 'request_state',
    });

    expect(client.relay).toHaveBeenCalledWith('fp-requester', expect.objectContaining({
      _sync: true,
      type: 'full_state',
    }));
  });

  it('should emit synced event', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();

    const fn = vi.fn();
    sync.on('synced', fn);

    const ts = Date.now() + 10000;
    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'k',
        value: 'v',
        hlc: { ts, counter: 0, node: 'fp-remote' },
        from: 'fp-remote',
        version: 0,
      },
    });

    expect(fn).toHaveBeenCalledWith('fp-remote');
  });

  it('should destroy and cleanup', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();
    sync.set('a', 1);
    sync.destroy();
    expect(sync.getAll()).toEqual({});
  });

  it('should ignore updates without hlc', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();

    client.emit('broadcast', 'fp-remote', 'room1', {
      _sync: true,
      type: 'update',
      entry: { key: 'k', value: 'v', from: 'fp-remote', version: 0 },
    });

    expect(sync.get('k')).toBeUndefined();
  });

  it('should use HLC counter to break timestamp ties', () => {
    const client = mockClient();
    const sync = new StateSync(client, 'room1', { mode: 'lww' });
    sync.start();

    const ts = Date.now() + 100000;
    client.emit('broadcast', 'fp-a', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'k',
        value: 'first',
        hlc: { ts, counter: 0, node: 'fp-a' },
        from: 'fp-a',
        version: 0,
      },
    });

    client.emit('broadcast', 'fp-b', 'room1', {
      _sync: true,
      type: 'update',
      entry: {
        key: 'k',
        value: 'second',
        hlc: { ts, counter: 1, node: 'fp-b' },
        from: 'fp-b',
        version: 0,
      },
    });

    expect(sync.get('k')).toBe('second');
  });
});
