import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Emitter, setEmitterErrorHandler } from '../src/core/emitter';

describe('Emitter', () => {
  let emitter: Emitter<'a' | 'b' | 'c'>;

  beforeEach(() => {
    emitter = new Emitter();
  });

  it('should register and emit events', () => {
    const fn = vi.fn();
    emitter.on('a', fn);
    emitter.emit('a', 1, 2);
    expect(fn).toHaveBeenCalledWith(1, 2);
  });

  it('should support multiple listeners', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('a', fn1);
    emitter.on('a', fn2);
    emitter.emit('a', 'x');
    expect(fn1).toHaveBeenCalledWith('x');
    expect(fn2).toHaveBeenCalledWith('x');
  });

  it('should not fire listeners for other events', () => {
    const fn = vi.fn();
    emitter.on('a', fn);
    emitter.emit('b');
    expect(fn).not.toHaveBeenCalled();
  });

  it('should return unsubscribe function from on()', () => {
    const fn = vi.fn();
    const off = emitter.on('a', fn);
    off();
    emitter.emit('a');
    expect(fn).not.toHaveBeenCalled();
  });

  it('should remove specific listener with off()', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('a', fn1);
    emitter.on('a', fn2);
    emitter.off('a', fn1);
    emitter.emit('a');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('should fire once listener only once', () => {
    const fn = vi.fn();
    emitter.once('a', fn);
    emitter.emit('a', 1);
    emitter.emit('a', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('should return unsubscribe from once()', () => {
    const fn = vi.fn();
    const off = emitter.once('a', fn);
    off();
    emitter.emit('a');
    expect(fn).not.toHaveBeenCalled();
  });

  it('should removeAllListeners for specific event', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('a', fn1);
    emitter.on('b', fn2);
    emitter.removeAllListeners('a');
    emitter.emit('a');
    emitter.emit('b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('should removeAllListeners for all events', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('a', fn1);
    emitter.on('b', fn2);
    emitter.removeAllListeners();
    emitter.emit('a');
    emitter.emit('b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('should report listenerCount', () => {
    expect(emitter.listenerCount('a')).toBe(0);
    const off1 = emitter.on('a', () => {});
    expect(emitter.listenerCount('a')).toBe(1);
    emitter.on('a', () => {});
    expect(emitter.listenerCount('a')).toBe(2);
    off1();
    expect(emitter.listenerCount('a')).toBe(1);
  });

  it('should not crash when emitting with no listeners', () => {
    expect(() => emitter.emit('a')).not.toThrow();
  });

  it('should call error handler on listener error instead of swallowing', () => {
    const errorHandler = vi.fn();
    setEmitterErrorHandler(errorHandler);

    const good = vi.fn();
    emitter.on('a', () => { throw new Error('boom'); });
    emitter.on('a', good);
    emitter.emit('a');

    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error), 'a');
    expect(good).toHaveBeenCalled();

    setEmitterErrorHandler(() => {});
  });

  it('should handle removing listener during emit', () => {
    const fn2 = vi.fn();
    let off: () => void;
    const fn1 = vi.fn(() => { off(); });
    off = emitter.on('a', fn1);
    emitter.on('a', fn2);
    emitter.emit('a');
    expect(fn1).toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('should handle off for non-existent listener gracefully', () => {
    expect(() => emitter.off('a', () => {})).not.toThrow();
  });

  it('should not add duplicate references', () => {
    const fn = vi.fn();
    emitter.on('a', fn);
    emitter.on('a', fn);
    emitter.emit('a');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
