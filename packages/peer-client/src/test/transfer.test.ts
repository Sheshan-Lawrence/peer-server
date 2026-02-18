import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerClient } from '../core/client';
import { FileTransfer, JSONTransfer, ImageTransfer } from '../transfer';
import { MockSignalServer, delay, waitForEvent, REAL_SERVER } from './setup';

describe('JSONTransfer — Mock Server', () => {
    let server: MockSignalServer;

    beforeEach(async () => {
        server = new MockSignalServer();
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it('sendToRoom delivers via broadcast', async () => {
        const c1 = new PeerClient({ url: server.url, autoReconnect: false });
        const c2 = new PeerClient({ url: server.url, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        const ns = 'json-bc';
        await c1.join(ns);
        await c2.join(ns);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const dataPromise = new Promise<any>((resolve) => {
            jt2.onBroadcastReceive(ns, (data) => resolve(data));
        });

        jt1.sendToRoom(ns, { hello: 'json' });
        const data = await dataPromise;
        expect(data.hello).toBe('json');

        c1.disconnect();
        c2.disconnect();
    });

    it('sendToPeer via relay', async () => {
        const c1 = new PeerClient({ url: server.url, autoReconnect: false });
        const c2 = new PeerClient({ url: server.url, autoReconnect: false });
        await c1.connect();
        await c2.connect();

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const dataPromise = new Promise<any>((resolve) => {
            jt2.onRelayReceive((data) => resolve(data));
        });

        jt1.sendToPeer(c2.fingerprint, { peer: 'msg' });
        const data = await dataPromise;
        expect(data.peer).toBe('msg');

        c1.disconnect();
        c2.disconnect();
    });

    it('sendToRoom with complex object', async () => {
        const c1 = new PeerClient({ url: server.url, autoReconnect: false });
        const c2 = new PeerClient({ url: server.url, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        const ns = 'json-complex';
        await c1.join(ns);
        await c2.join(ns);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const obj = { nested: { arr: [1, 2, 3], flag: true }, str: 'test' };
        const dataPromise = new Promise<any>((resolve) => {
            jt2.onBroadcastReceive(ns, (data) => resolve(data));
        });

        jt1.sendToRoom(ns, obj);
        const data = await dataPromise;
        expect(data).toEqual(obj);

        c1.disconnect();
        c2.disconnect();
    });

    it('onBroadcastReceive returns unsubscribe', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const jt = new JSONTransfer(c);
        const fn = vi.fn();
        const off = jt.onBroadcastReceive('ns', fn);
        expect(typeof off).toBe('function');
        off();
        c.disconnect();
    });

    it('onRelayReceive returns unsubscribe', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const jt = new JSONTransfer(c);
        const fn = vi.fn();
        const off = jt.onRelayReceive(fn);
        expect(typeof off).toBe('function');
        off();
        c.disconnect();
    });

    it('stress: 50 JSON messages via broadcast', async () => {
        const c1 = new PeerClient({ url: server.url, autoReconnect: false });
        const c2 = new PeerClient({ url: server.url, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        const ns = 'json-stress';
        await c1.join(ns);
        await c2.join(ns);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const received: any[] = [];
        jt2.onBroadcastReceive(ns, (data) => received.push(data));

        for (let i = 0; i < 50; i++) {
            jt1.sendToRoom(ns, { idx: i });
        }
        await delay(1000);
        expect(received.length).toBeGreaterThanOrEqual(40);

        c1.disconnect();
        c2.disconnect();
    });
});

describe('FileTransfer — Unit', () => {
    let server: MockSignalServer;

    beforeEach(async () => {
        server = new MockSignalServer();
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it('constructor creates instance', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        expect(ft).toBeTruthy();
        ft.destroy();
        c.disconnect();
    });

    it('send throws if peer not connected', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        const peer = c.connectToPeer('fake-fp');
        const blob = new Blob(['test'], { type: 'text/plain' });
        await expect(ft.send(peer, blob)).rejects.toThrow('Peer not connected');
        ft.destroy();
        c.disconnect();
    });

    it('accept on non-existent transfer is a no-op', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        expect(() => ft.accept('nonexist')).not.toThrow();
        ft.destroy();
        c.disconnect();
    });

    it('reject on non-existent transfer is a no-op', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        expect(() => ft.reject('nonexist')).not.toThrow();
        ft.destroy();
        c.disconnect();
    });

    it('cancel on non-existent transfer is a no-op', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        expect(() => ft.cancel('nonexist')).not.toThrow();
        ft.destroy();
        c.disconnect();
    });

    it('getReceiveProgress returns null for unknown', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        expect(ft.getReceiveProgress('unknown')).toBeNull();
        ft.destroy();
        c.disconnect();
    });

    it('handleIncoming returns cleanup function', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        const peer = c.connectToPeer('fp-handle');
        const off = ft.handleIncoming(peer);
        expect(typeof off).toBe('function');
        off();
        ft.destroy();
        c.disconnect();
    });

    it('destroy clears all state', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        ft.destroy();
        c.disconnect();
    });

    it('requestResume on non-existent is a no-op', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const ft = new FileTransfer(c);
        expect(() => ft.requestResume('nope', 5)).not.toThrow();
        ft.destroy();
        c.disconnect();
    });
});

describe('ImageTransfer — Unit', () => {
    let server: MockSignalServer;

    beforeEach(async () => {
        server = new MockSignalServer();
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    it('constructor creates instance', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        expect(it).toBeTruthy();
        it.destroy();
        c.disconnect();
    });

    it('getFileTransfer returns underlying FileTransfer', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        expect(it.getFileTransfer()).toBeTruthy();
        it.destroy();
        c.disconnect();
    });

    it('send throws if peer not connected', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        const peer = c.connectToPeer('img-fp');
        const blob = new Blob(['fake-image'], { type: 'image/png' });
        await expect(it.send(peer, blob)).rejects.toThrow('Peer not connected');
        it.destroy();
        c.disconnect();
    });

    it('accept delegates to FileTransfer', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        expect(() => it.accept('nope')).not.toThrow();
        it.destroy();
        c.disconnect();
    });

    it('reject delegates to FileTransfer', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        expect(() => it.reject('nope')).not.toThrow();
        it.destroy();
        c.disconnect();
    });

    it('cancel delegates to FileTransfer', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        expect(() => it.cancel('nope')).not.toThrow();
        it.destroy();
        c.disconnect();
    });

    it('handleIncoming returns cleanup function', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        const peer = c.connectToPeer('img-handle');
        const off = it.handleIncoming(peer);
        expect(typeof off).toBe('function');
        off();
        it.destroy();
        c.disconnect();
    });

    it('destroy clears all state', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        it.destroy();
        c.disconnect();
    });

    it('events propagate from FileTransfer', async () => {
        const c = new PeerClient({ url: server.url, autoReconnect: false });
        await c.connect();
        const it = new ImageTransfer(c);
        const fn = vi.fn();
        it.on('progress', fn);
        it.on('incoming', fn);
        it.on('cancelled', fn);
        it.on('complete', fn);
        it.on('error', fn);
        it.destroy();
        c.disconnect();
    });
});

describe('JSONTransfer — Real Server', () => {
    it('relay between two peers on real server', async () => {
        const ns = 'vitest-jt-relay-' + Date.now();
        const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        await c1.join(ns);
        await c2.join(ns);
        await delay(200);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const dataPromise = new Promise<any>((resolve) => {
            jt2.onRelayReceive((data) => resolve(data));
        });

        jt1.sendToPeer(c2.fingerprint, { real: 'server' });
        const data = await dataPromise;
        expect(data.real).toBe('server');

        c1.disconnect();
        c2.disconnect();
    }, 15000);

    it('broadcast on real server', async () => {
        const ns = 'vitest-jt-bc-' + Date.now();
        const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        await c1.join(ns);
        await c2.join(ns);
        await delay(300);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const dataPromise = new Promise<any>((resolve) => {
            jt2.onBroadcastReceive(ns, (data) => resolve(data));
        });

        jt1.sendToRoom(ns, { broadcast: true });
        const data = await dataPromise;
        expect(data.broadcast).toBe(true);

        c1.disconnect();
        c2.disconnect();
    }, 20000);

    it('stress: 30 relay messages on real server', async () => {
        const ns = 'vitest-jt-stress30-' + Date.now();
        const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        await c1.join(ns);
        await c2.join(ns);
        await delay(200);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const received: any[] = [];
        jt2.onRelayReceive((data) => received.push(data));

        for (let i = 0; i < 30; i++) {
            jt1.sendToPeer(c2.fingerprint, { i });
        }
        await delay(3000);
        expect(received.length).toBeGreaterThanOrEqual(25);

        c1.disconnect();
        c2.disconnect();
    }, 20000);

    it('stress: 20 rapid relay messages on real server', async () => {
        const ns = 'vitest-jt-stress20-' + Date.now();
        const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        await c1.join(ns);
        await c2.join(ns);
        await delay(200);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const received: any[] = [];
        jt2.onRelayReceive((data) => received.push(data));

        const msgs = Array.from({ length: 20 }, (_, i) => ({ rapid: i }));
        msgs.forEach((m) => jt1.sendToPeer(c2.fingerprint, m));
        await delay(3000);
        expect(received.length).toBeGreaterThanOrEqual(15);

        c1.disconnect();
        c2.disconnect();
    }, 20000);

    it('multiple onRelayReceive listeners', async () => {
        const c = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        await c.connect();
        const jt = new JSONTransfer(c);
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        const off1 = jt.onRelayReceive(fn1);
        const off2 = jt.onRelayReceive(fn2);
        off1();
        off2();
        c.disconnect();
    }, 15000);

    it('broadcast large JSON on real server', async () => {
        const ns = 'vitest-jt-large-' + Date.now();
        const c1 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        const c2 = new PeerClient({ url: REAL_SERVER, autoReconnect: false });
        await c1.connect();
        await c2.connect();
        await c1.join(ns);
        await c2.join(ns);
        await delay(300);

        const jt1 = new JSONTransfer(c1);
        const jt2 = new JSONTransfer(c2);

        const large = { data: 'x'.repeat(10000) };
        const dataP = new Promise<any>((resolve) => {
            jt2.onBroadcastReceive(ns, (d) => resolve(d));
        });

        jt1.sendToRoom(ns, large);
        const data = await dataP;
        expect(data.data.length).toBe(10000);

        c1.disconnect();
        c2.disconnect();
    }, 20000);
});