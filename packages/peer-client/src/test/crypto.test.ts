import { describe, it, expect, beforeEach } from 'vitest';
import { E2E, arrayToBase64, base64ToArray } from '../crypto';

describe('E2E Encryption', () => {
    let e2eA: E2E;
    let e2eB: E2E;

    beforeEach(async () => {
        e2eA = new E2E();
        e2eB = new E2E();
        await e2eA.init();
        await e2eB.init();
    });

    it('init sets initialized state', () => {
        expect(e2eA.isInitialized()).toBe(true);
    });

    it('isInitialized returns false before init', () => {
        const e = new E2E();
        expect(e.isInitialized()).toBe(false);
    });

    it('getPublicKeyB64 returns base64 string', () => {
        const key = e2eA.getPublicKeyB64();
        expect(key).toBeTruthy();
        expect(() => atob(key)).not.toThrow();
    });

    it('getPublicKeyB64 throws before init', () => {
        const e = new E2E();
        expect(() => e.getPublicKeyB64()).toThrow('not initialized');
    });

    it('getPublicKeyRaw returns ArrayBuffer', () => {
        const raw = e2eA.getPublicKeyRaw();
        expect(raw.byteLength).toBeGreaterThan(0);
    });

    it('getPublicKeyRaw throws before init', () => {
        const e = new E2E();
        expect(() => e.getPublicKeyRaw()).toThrow('not initialized');
    });

    it('deriveKey establishes shared secret', async () => {
        await e2eA.deriveKey('peer-b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('peer-a', e2eA.getPublicKeyB64());
        expect(e2eA.hasKey('peer-b')).toBe(true);
        expect(e2eB.hasKey('peer-a')).toBe(true);
    });

    it('encrypt/decrypt roundtrip works', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('a', e2eA.getPublicKeyB64());

        const encrypted = await e2eA.encrypt('b', 'hello world');
        const decrypted = await e2eB.decrypt('a', encrypted);
        expect(decrypted).toBe('hello world');
    });

    it('encrypt produces different ciphertext each time (random IV)', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        const c1 = await e2eA.encrypt('b', 'same message');
        const c2 = await e2eA.encrypt('b', 'same message');
        expect(c1).not.toBe(c2);
    });

    it('decrypt with wrong key fails', async () => {
        const e2eC = new E2E();
        await e2eC.init();

        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eC.deriveKey('a', e2eA.getPublicKeyB64());

        const encrypted = await e2eA.encrypt('b', 'secret');
        await expect(e2eC.decrypt('a', encrypted)).rejects.toThrow();
    });

    it('encrypt without key throws', async () => {
        await expect(e2eA.encrypt('unknown', 'data')).rejects.toThrow('No key');
    });

    it('decrypt without key throws', async () => {
        await expect(e2eA.decrypt('unknown', 'data')).rejects.toThrow('No key');
    });

    it('hasKey returns false for unknown peer', () => {
        expect(e2eA.hasKey('nobody')).toBe(false);
    });

    it('removeKey removes the key', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        expect(e2eA.hasKey('b')).toBe(true);
        e2eA.removeKey('b');
        expect(e2eA.hasKey('b')).toBe(false);
    });

    it('removeKey on non-existent is a no-op', () => {
        expect(() => e2eA.removeKey('nope')).not.toThrow();
    });

    it('destroy clears all state', () => {
        e2eA.destroy();
        expect(e2eA.isInitialized()).toBe(false);
    });

    it('encrypt after destroy throws', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        e2eA.destroy();
        await expect(e2eA.encrypt('b', 'x')).rejects.toThrow();
    });

    it('encrypt/decrypt empty string', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('a', e2eA.getPublicKeyB64());
        const enc = await e2eA.encrypt('b', '');
        const dec = await e2eB.decrypt('a', enc);
        expect(dec).toBe('');
    });

    it('encrypt/decrypt unicode text', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('a', e2eA.getPublicKeyB64());
        const text = '日本語テスト 🎉 émojis';
        const enc = await e2eA.encrypt('b', text);
        const dec = await e2eB.decrypt('a', enc);
        expect(dec).toBe(text);
    });

    it('encrypt/decrypt large payload', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('a', e2eA.getPublicKeyB64());
        const large = 'x'.repeat(1024 * 100);
        const enc = await e2eA.encrypt('b', large);
        const dec = await e2eB.decrypt('a', enc);
        expect(dec).toBe(large);
    });

    it('encrypt/decrypt JSON payload', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('a', e2eA.getPublicKeyB64());
        const obj = { name: 'test', arr: [1, 2, 3], nested: { ok: true } };
        const enc = await e2eA.encrypt('b', JSON.stringify(obj));
        const dec = JSON.parse(await e2eB.decrypt('a', enc));
        expect(dec).toEqual(obj);
    });

    it('stress: 100 encrypt/decrypt cycles', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eB.deriveKey('a', e2eA.getPublicKeyB64());
        for (let i = 0; i < 100; i++) {
            const msg = `message-${i}`;
            const enc = await e2eA.encrypt('b', msg);
            const dec = await e2eB.decrypt('a', enc);
            expect(dec).toBe(msg);
        }
    });

    it('multiple peer keys coexist', async () => {
        const e2eC = new E2E();
        await e2eC.init();
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        await e2eA.deriveKey('c', e2eC.getPublicKeyB64());
        expect(e2eA.hasKey('b')).toBe(true);
        expect(e2eA.hasKey('c')).toBe(true);
    });

    it('re-derive key for same peer overwrites', async () => {
        await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
        const e2eB2 = new E2E();
        await e2eB2.init();
        await e2eA.deriveKey('b', e2eB2.getPublicKeyB64());
        expect(e2eA.hasKey('b')).toBe(true);
    });

    it('deriveKey with invalid base64 throws', async () => {
        await expect(e2eA.deriveKey('x', '!!!invalid!!!')).rejects.toThrow();
    });

    it('deriveKey before init throws', async () => {
        const e = new E2E();
        await expect(e.deriveKey('x', e2eB.getPublicKeyB64())).rejects.toThrow('not initialized');
    });
});

describe('arrayToBase64 / base64ToArray', () => {
    it('roundtrip for small buffer', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const b64 = arrayToBase64(original);
        const restored = base64ToArray(b64);
        expect(Array.from(restored)).toEqual(Array.from(original));
    });

    it('roundtrip for empty buffer', () => {
        const original = new Uint8Array(0);
        const b64 = arrayToBase64(original);
        const restored = base64ToArray(b64);
        expect(restored.length).toBe(0);
    });

    it('roundtrip for large buffer', () => {
        const original = new Uint8Array(100000);
        for (let i = 0; i < original.length; i++) original[i] = i % 256;
        const b64 = arrayToBase64(original);
        const restored = base64ToArray(b64);
        expect(restored.length).toBe(original.length);
        for (let i = 0; i < original.length; i++) {
            expect(restored[i]).toBe(original[i]);
        }
    });

    it('produces valid base64', () => {
        const data = new Uint8Array([255, 0, 128, 64]);
        const b64 = arrayToBase64(data);
        expect(() => atob(b64)).not.toThrow();
    });

    it('handles all byte values', () => {
        const all = new Uint8Array(256);
        for (let i = 0; i < 256; i++) all[i] = i;
        const b64 = arrayToBase64(all);
        const restored = base64ToArray(b64);
        expect(Array.from(restored)).toEqual(Array.from(all));
    });

    it('handles chunk boundary (8192 bytes)', () => {
        const data = new Uint8Array(8192);
        crypto.getRandomValues(data);
        const b64 = arrayToBase64(data);
        const restored = base64ToArray(b64);
        expect(restored.length).toBe(8192);
    });
});