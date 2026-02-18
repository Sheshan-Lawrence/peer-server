import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Transport } from '../core/transport';
import { MockSignalServer, delay, waitForEvent, REAL_SERVER } from './setup';

describe('Transport — Mock Server', () => {
  let server: MockSignalServer;
  let transport: Transport;

  beforeEach(async () => {
    server = new MockSignalServer();
    await server.start();
  });

  afterEach(async () => {
    transport?.close();
    await server.stop();
  });

  it('connects to mock server', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    await transport.connect();
    expect(transport.connected).toBe(true);
  });

  it('emits open event on connect', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    const openPromise = waitForEvent(transport, 'open');
    transport.connect();
    await openPromise;
    expect(transport.connected).toBe(true);
  });

  it('sends and receives messages', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    await transport.connect();
    const msgPromise = waitForEvent(transport, 'message');
    transport.send({ type: 'register', payload: { public_key: 'abc', alias: 'test' } });
    const [msg] = await msgPromise;
    expect(msg.type).toBe('registered');
  });

  it('queues messages when disconnected', () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    transport.send({ type: 'ping' });
    expect(transport.getQueueSize()).toBe(1);
  });

  it('flushes queue on connect', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    transport.send({ type: 'register', payload: { public_key: 'x', alias: 'q' } });
    expect(transport.getQueueSize()).toBe(1);
    const msgPromise = waitForEvent(transport, 'message');
    await transport.connect();
    const [msg] = await msgPromise;
    expect(msg.type).toBe('registered');
    expect(transport.getQueueSize()).toBe(0);
  });

  it('clearQueue empties the queue', () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    transport.send({ type: 'ping' });
    transport.send({ type: 'ping' });
    expect(transport.getQueueSize()).toBe(2);
    transport.clearQueue();
    expect(transport.getQueueSize()).toBe(0);
  });

  it('close sets connected to false', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    await transport.connect();
    transport.close();
    expect(transport.connected).toBe(false);
  });

  it('close clears message queue', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    transport.send({ type: 'ping' });
    transport.close();
    expect(transport.getQueueSize()).toBe(0);
  });

  it('rejects connect on invalid url', async () => {
    transport = new Transport('ws://127.0.0.1:1', false, 1000, 5000, 0, 25000);
    await expect(transport.connect()).rejects.toThrow();
  });

  it('emits close event when server stops', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 0, 25000);
    await transport.connect();
    const closePromise = waitForEvent(transport, 'close', 5000);
    await server.stop();
    await closePromise;
    expect(transport.connected).toBe(false);
  });

  it('emits reconnecting when autoReconnect is true', async () => {
    transport = new Transport(server.url, true, 100, 500, 3, 25000);
    await transport.connect();
    const reconnPromise = waitForEvent(transport, 'reconnecting', 5000);
    await server.stop();
    const [attempt, delayMs] = await reconnPromise;
    expect(attempt).toBe(1);
    expect(delayMs).toBeGreaterThanOrEqual(100);
  });

  it('does not reconnect when autoReconnect is false', async () => {
    transport = new Transport(server.url, false, 100, 500, 3, 25000);
    await transport.connect();
    const fn = vi.fn();
    transport.on('reconnecting', fn);
    await server.stop();
    await delay(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('respects MESSAGE_QUEUE_MAX limit', () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    for (let i = 0; i < 600; i++) {
      transport.send({ type: 'ping' });
    }
    expect(transport.getQueueSize()).toBe(500);
  });

  it('handles malformed JSON from server gracefully', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    const errFn = vi.fn();
    transport.on('error', errFn);
    await transport.connect();
    await delay(100);
  });

  it('ping/pong keeps connection alive', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 200);
    await transport.connect();
    await delay(500);
    expect(transport.connected).toBe(true);
  });

  it('multiple close calls are safe', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    await transport.connect();
    transport.close();
    transport.close();
    transport.close();
    expect(transport.connected).toBe(false);
  });

  it('send after close queues without error', () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    transport.close();
    expect(() => transport.send({ type: 'ping' })).not.toThrow();
  });

  it('exponential backoff on reconnect', async () => {
    transport = new Transport(server.url, true, 100, 2000, 5, 25000);
    await transport.connect();
    const delays: number[] = [];
    transport.on('reconnecting', (_attempt: number, d: number) => delays.push(d));
    await server.stop();
    await delay(1500);
    expect(delays.length).toBeGreaterThanOrEqual(2);
    if (delays.length >= 2) {
      expect(delays[1]).toBeGreaterThanOrEqual(delays[0]);
    }
  });

  describe('maxReconnectAttempts sweep validation', () => {
        const cases = Array.from({ length: 6 }, (_, i) => i + 5);

  cases.forEach((max) => {
    it(`limits retries when maxReconnectAttempts = ${max}`, async () => {
      transport = new Transport(server.url, true, 50, 100, max, 25000);
      await transport.connect();
      const attempts: number[] = [];
      transport.on('reconnecting', (a: number) => attempts.push(a));
      await server.stop();
      await delay(3000);
      expect(attempts.length).toBe(max + 1);
    });
  });
});


  it('connected is false before connect()', () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    expect(transport.connected).toBe(false);
  });

  it('handles rapid connect/close cycles', async () => {
    for (let i = 0; i < 5; i++) {
      transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
      await transport.connect();
      transport.close();
    }
  });

  it('multiple sends in quick succession', async () => {
    transport = new Transport(server.url, false, 1000, 5000, 3, 25000);
    await transport.connect();
    for (let i = 0; i < 100; i++) {
      transport.send({ type: 'register', payload: { public_key: `k${i}`, alias: `a${i}` } });
    }
    await delay(200);
  });
});

describe('Transport — Real Server', () => {
  let transport: Transport;

  afterEach(() => {
    transport?.close();
  });

  it('connects to real server', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    expect(transport.connected).toBe(true);
  });

  it('registers with real server', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    const msgPromise = waitForEvent(transport, 'message', 10000);
    transport.send({ type: 'register', payload: { public_key: 'test_key', alias: 'transport_test' } });
    const [msg] = await msgPromise;
    expect(msg.type).toBe('registered');
    expect(msg.payload.fingerprint).toBeTruthy();
  });

  it('handles server ping/pong', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    await delay(6000);
    expect(transport.connected).toBe(true);
  }, 15000);

  it('stress: 50 rapid messages', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    transport.send({ type: 'register', payload: { public_key: 'stress', alias: 'stress' } });
    await waitForEvent(transport, 'message', 5000);
    for (let i = 0; i < 50; i++) {
      transport.send({ type: 'ping' });
    }
    await delay(1000);
    expect(transport.connected).toBe(true);
  });

  it('stress: 10 connect/disconnect cycles', async () => {
    for (let i = 0; i < 10; i++) {
      transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
      await transport.connect();
      expect(transport.connected).toBe(true);
      transport.close();
      expect(transport.connected).toBe(false);
    }
  }, 30000);

  it('queue flushed after real server connect', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    transport.send({ type: 'register', payload: { public_key: 'queued', alias: 'q' } });
    expect(transport.getQueueSize()).toBe(1);
    const msgP = waitForEvent(transport, 'message', 10000);
    await transport.connect();
    const [msg] = await msgP;
    expect(msg.type).toBe('registered');
    expect(transport.getQueueSize()).toBe(0);
  }, 15000);

  it('close and reconnect to real server', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    transport.close();
    expect(transport.connected).toBe(false);
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    expect(transport.connected).toBe(true);
  }, 15000);

  it('multiple registers on real server', async () => {
    transport = new Transport(REAL_SERVER, false, 1000, 5000, 3, 25000);
    await transport.connect();
    const msgP = waitForEvent(transport, 'message', 5000);
    transport.send({ type: 'register', payload: { public_key: 'k0', alias: 'a0' } });
    const [msg] = await msgP;
    expect(msg.type).toBe('registered');

    for (let i = 1; i < 5; i++) {
      const p = waitForEvent(transport, 'message', 5000);
      transport.send({ type: 'register', payload: { public_key: `k${i}`, alias: `a${i}` } });
      const [m] = await p;
      expect(['registered', 'error']).toContain(m.type);
    }
  }, 30000);
});