import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transport } from '../src/core/transport';
import { MockWebSocket } from './setup';

let lastWs: MockWebSocket;
const origWS = globalThis.WebSocket;

beforeEach(() => {
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      lastWs = this;
    }
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createTransport(opts: Partial<{
  url: string; auto: boolean; delay: number; maxDelay: number; maxAttempts: number; ping: number;
}> = {}): Transport {
  return new Transport(
    opts.url ?? 'ws://test',
    opts.auto ?? false,
    opts.delay ?? 100,
    opts.maxDelay ?? 5000,
    opts.maxAttempts ?? 3,
    opts.ping ?? 25000,
  );
}

describe('Transport', () => {
  it('should connect and resolve promise', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await expect(p).resolves.toBeUndefined();
    expect(t.connected).toBe(true);
  });

  it('should reject on close before open', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateClose(1006, 'error');
    await expect(p).rejects.toThrow();
  });

  it('should emit message events', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    const fn = vi.fn();
    t.on('message', fn);
    lastWs.simulateMessage({ type: 'registered', payload: {} });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ type: 'registered' }));
  });

  it('should auto-respond to ping with pong', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    lastWs.simulateMessage({ type: 'ping' });
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
  });

  it('should not emit message for pong', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    const fn = vi.fn();
    t.on('message', fn);
    lastWs.simulateMessage({ type: 'pong' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('should send messages when connected', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    t.send({ type: 'register', payload: {} });
    expect(lastWs.send).toHaveBeenCalledWith(expect.stringContaining('register'));
  });

  it('should queue messages when disconnected', () => {
    const t = createTransport();
    t.send({ type: 'register', payload: {} });
    expect(t.getQueueSize()).toBe(1);
  });

  it('should flush queue on connect', async () => {
    const t = createTransport();
    t.send({ type: 'register', payload: {} });
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    expect(lastWs.send).toHaveBeenCalledWith(expect.stringContaining('register'));
    expect(t.getQueueSize()).toBe(0);
  });

  it('should limit queue size', () => {
    const t = createTransport();
    for (let i = 0; i < 600; i++) {
      t.send({ type: 'ping' });
    }
    expect(t.getQueueSize()).toBe(500);
  });

  it('should emit close event', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    const fn = vi.fn();
    t.on('close', fn);
    lastWs.simulateClose(1000, 'bye');
    expect(fn).toHaveBeenCalledWith(1000, 'bye');
    expect(t.connected).toBe(false);
  });

  it('should close cleanly', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    t.close();
    expect(t.connected).toBe(false);
  });

  it('should clear queue on close', async () => {
    const t = createTransport();
    t.send({ type: 'ping' });
    t.close();
    expect(t.getQueueSize()).toBe(0);
  });

  it('should attempt reconnect on unexpected close', async () => {
    const t = createTransport({ auto: true, delay: 10 });
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    const fn = vi.fn();
    t.on('reconnecting', fn);
    lastWs.simulateClose(1006, 'unexpected');

    await new Promise((r) => setTimeout(r, 50));
    expect(fn).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it('should not reconnect after intentional close', async () => {
    const t = createTransport({ auto: true, delay: 10 });
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    const fn = vi.fn();
    t.on('reconnecting', fn);
    t.close();

    await new Promise((r) => setTimeout(r, 50));
    expect(fn).not.toHaveBeenCalled();
  });

  it('should stop reconnecting after max attempts', async () => {
    const t = createTransport({ auto: true, delay: 5, maxAttempts: 2 });
    const fn = vi.fn();
    t.on('reconnecting', fn);

    const p = t.connect();
    lastWs.simulateOpen();
    await p;
    lastWs.simulateClose(1006);

    await new Promise((r) => setTimeout(r, 20));
    lastWs.simulateClose(1006);
    await new Promise((r) => setTimeout(r, 40));
    lastWs.simulateClose(1006);
    await new Promise((r) => setTimeout(r, 80));

    expect(fn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('should handle invalid JSON gracefully', async () => {
    const t = createTransport();
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    const errFn = vi.fn();
    t.on('error', errFn);
    lastWs.onmessage?.({ data: 'not json {{{' });
    expect(errFn).toHaveBeenCalled();
  });

  it('should start ping interval on connect', async () => {
    vi.useFakeTimers();
    const t = createTransport({ ping: 100 });
    const p = t.connect();
    lastWs.simulateOpen();
    await p;

    vi.advanceTimersByTime(100);
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    t.close();
    vi.useRealTimers();
  });
});
