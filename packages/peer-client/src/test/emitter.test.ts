import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Emitter, setEmitterErrorHandler } from '../core/emitter';

describe('Emitter', () => {
  let emitter: Emitter<'test' | 'other' | 'error'>;

  beforeEach(() => {
    emitter = new Emitter();
  });

  it('should register and fire a listener', () => {
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.emit('test', 'a', 'b');
    expect(fn).toHaveBeenCalledWith('a', 'b');
  });

  it('should return an unsubscribe function from on()', () => {
    const fn = vi.fn();
    const off = emitter.on('test', fn);
    off();
    emitter.emit('test');
    expect(fn).not.toHaveBeenCalled();
  });

  it('should support multiple listeners on same event', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('test', fn1);
    emitter.on('test', fn2);
    emitter.emit('test', 42);
    expect(fn1).toHaveBeenCalledWith(42);
    expect(fn2).toHaveBeenCalledWith(42);
  });

  it('should not fire listeners for different events', () => {
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.emit('other');
    expect(fn).not.toHaveBeenCalled();
  });

  it('once() should fire only once', () => {
    const fn = vi.fn();
    emitter.once('test', fn);
    emitter.emit('test', 1);
    emitter.emit('test', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('once() returns unsubscribe that works before fire', () => {
    const fn = vi.fn();
    const off = emitter.once('test', fn);
    off();
    emitter.emit('test');
    expect(fn).not.toHaveBeenCalled();
  });

  it('off() removes specific listener', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('test', fn1);
    emitter.on('test', fn2);
    emitter.off('test', fn1);
    emitter.emit('test');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('off() on non-existent listener is a no-op', () => {
    expect(() => emitter.off('test', () => {})).not.toThrow();
  });

  it('listenerCount returns correct count', () => {
    expect(emitter.listenerCount('test')).toBe(0);
    const off1 = emitter.on('test', () => {});
    expect(emitter.listenerCount('test')).toBe(1);
    emitter.on('test', () => {});
    expect(emitter.listenerCount('test')).toBe(2);
    off1();
    expect(emitter.listenerCount('test')).toBe(1);
  });

  it('removeAllListeners(event) clears only that event', () => {
    emitter.on('test', () => {});
    emitter.on('other', () => {});
    emitter.removeAllListeners('test');
    expect(emitter.listenerCount('test')).toBe(0);
    expect(emitter.listenerCount('other')).toBe(1);
  });

  it('removeAllListeners() clears all events', () => {
    emitter.on('test', () => {});
    emitter.on('other', () => {});
    emitter.removeAllListeners();
    expect(emitter.listenerCount('test')).toBe(0);
    expect(emitter.listenerCount('other')).toBe(0);
  });

  it('listener error does not crash other listeners', () => {
    const fn1 = vi.fn(() => { throw new Error('boom'); });
    const fn2 = vi.fn();
    emitter.on('test', fn1);
    emitter.on('test', fn2);
    emitter.emit('test');
    expect(fn2).toHaveBeenCalled();
  });

  it('listener error invokes global error handler', () => {
    const handler = vi.fn();
    setEmitterErrorHandler(handler);
    const err = new Error('oops');
    emitter.on('test', () => { throw err; });
    emitter.emit('test');
    expect(handler).toHaveBeenCalledWith(err, 'test');
    setEmitterErrorHandler((e, ev) => console.error(`[Emitter] Error in "${ev}" listener:`, e));
  });

  it('emit with no listeners is a no-op', () => {
    expect(() => emitter.emit('test', 'data')).not.toThrow();
  });

  it('same function registered twice is only called once per emit', () => {
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.on('test', fn);
    emitter.emit('test');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe during emit does not affect current iteration', () => {
    const results: number[] = [];
    let off2: (() => void) | null = null;
    emitter.on('test', () => {
      results.push(1);
      off2?.();
    });
    off2 = emitter.on('test', () => results.push(2));
    emitter.on('test', () => results.push(3));
    emitter.emit('test');
    expect(results).toContain(1);
    expect(results).toContain(3);
  });

  it('handles rapid subscribe/unsubscribe cycles', () => {
    for (let i = 0; i < 1000; i++) {
      const off = emitter.on('test', () => {});
      off();
    }
    expect(emitter.listenerCount('test')).toBe(0);
  });

  it('emits with zero arguments', () => {
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.emit('test');
    expect(fn).toHaveBeenCalledWith();
  });

  it('emits with many arguments', () => {
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.emit('test', 1, 2, 3, 4, 5);
    expect(fn).toHaveBeenCalledWith(1, 2, 3, 4, 5);
  });

  it('multiple once listeners all fire', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.once('test', fn1);
    emitter.once('test', fn2);
    emitter.emit('test');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('listenerCount for non-registered event returns 0', () => {
    expect(emitter.listenerCount('error')).toBe(0);
  });

  it('removeAllListeners on non-existent event is a no-op', () => {
    expect(() => emitter.removeAllListeners('error')).not.toThrow();
  });

  it('on() after removeAllListeners works', () => {
    emitter.on('test', () => {});
    emitter.removeAllListeners('test');
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.emit('test');
    expect(fn).toHaveBeenCalled();
  });

  it('stress: 10000 listeners fire correctly', () => {
    let count = 0;
    for (let i = 0; i < 10000; i++) {
      emitter.on('test', () => count++);
    }
    emitter.emit('test');
    expect(count).toBe(10000);
  });

  it('async listeners do not block emit', () => {
    const order: number[] = [];
    emitter.on('test', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
    });
    emitter.on('test', () => order.push(1));
    emitter.emit('test');
    expect(order).toEqual([1]);
  });

  it('listener throwing non-Error still caught', () => {
    const handler = vi.fn();
    setEmitterErrorHandler(handler);
    emitter.on('test', () => { throw 'string error'; });
    emitter.emit('test');
    expect(handler).toHaveBeenCalledWith('string error', 'test');
    setEmitterErrorHandler((e, ev) => console.error(`[Emitter] Error in "${ev}" listener:`, e));
  });

  it('off with wrong function does not remove correct one', () => {
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.off('test', () => {});
    emitter.emit('test');
    expect(fn).toHaveBeenCalled();
  });

  it('once unsubscribe returned is idempotent', () => {
    const fn = vi.fn();
    const off = emitter.once('test', fn);
    emitter.emit('test');
    off();
    off();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emit returns undefined', () => {
    const result = emitter.emit('test');
    expect(result).toBeUndefined();
  });

  it('on with same event name different functions', () => {
    const fns = Array.from({ length: 5 }, () => vi.fn());
    fns.forEach((fn) => emitter.on('test', fn));
    emitter.emit('test', 'x');
    fns.forEach((fn) => expect(fn).toHaveBeenCalledWith('x'));
  });

  it('removeAllListeners then re-add works correctly', () => {
    emitter.on('test', () => {});
    emitter.on('other', () => {});
    emitter.removeAllListeners();
    const fn = vi.fn();
    emitter.on('test', fn);
    emitter.emit('test', 99);
    expect(fn).toHaveBeenCalledWith(99);
    expect(emitter.listenerCount('other')).toBe(0);
  });
});