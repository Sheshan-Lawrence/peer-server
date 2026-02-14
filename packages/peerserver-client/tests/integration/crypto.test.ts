import { describe, it, expect, afterEach } from 'vitest';
import { connectPair, establishP2P, cleanup, waitForEvent, TIMEOUT, delay } from './setup';
import { E2E, GroupKeyManager } from '../../src/crypto';
import type { PeerClient } from '../../src/core/client';

let clients: PeerClient[] = [];

afterEach(() => {
  cleanup(...clients);
  clients = [];
});

describe('E2E Crypto Integration', { timeout: TIMEOUT }, () => {
  it('should initialize E2E and generate keys', async () => {
    const e2e = new E2E();
    await e2e.init();
    const pubKey = e2e.getPublicKeyB64();
    expect(pubKey).toBeTruthy();
    expect(pubKey.length).toBeGreaterThan(10);
    e2e.destroy();
  });

  it('should derive shared key from two E2E instances', async () => {
    const e2eA = new E2E();
    const e2eB = new E2E();
    await e2eA.init();
    await e2eB.init();

    await e2eA.deriveKey('peer-b', e2eB.getPublicKeyB64());
    await e2eB.deriveKey('peer-a', e2eA.getPublicKeyB64());

    expect(e2eA.hasKey('peer-b')).toBe(true);
    expect(e2eB.hasKey('peer-a')).toBe(true);

    e2eA.destroy();
    e2eB.destroy();
  });

  it('should encrypt and decrypt roundtrip', async () => {
    const e2eA = new E2E();
    const e2eB = new E2E();
    await e2eA.init();
    await e2eB.init();

    await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
    await e2eB.deriveKey('a', e2eA.getPublicKeyB64());

    const plaintext = 'Hello secret world!';
    const encrypted = await e2eA.encrypt('b', plaintext);
    expect(encrypted).not.toBe(plaintext);

    const decrypted = await e2eB.decrypt('a', encrypted);
    expect(decrypted).toBe(plaintext);

    e2eA.destroy();
    e2eB.destroy();
  });

  it('should encrypt and decrypt JSON objects', async () => {
    const e2eA = new E2E();
    const e2eB = new E2E();
    await e2eA.init();
    await e2eB.init();

    await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
    await e2eB.deriveKey('a', e2eA.getPublicKeyB64());

    const obj = { secret: 'data', num: 42, nested: { arr: [1, 2, 3] } };
    const encrypted = await e2eA.encrypt('b', JSON.stringify(obj));
    const decrypted = JSON.parse(await e2eB.decrypt('a', encrypted));
    expect(decrypted).toEqual(obj);

    e2eA.destroy();
    e2eB.destroy();
  });

  it('should fail decrypt with wrong key', async () => {
    const e2eA = new E2E();
    const e2eB = new E2E();
    const e2eC = new E2E();
    await e2eA.init();
    await e2eB.init();
    await e2eC.init();

    await e2eA.deriveKey('b', e2eB.getPublicKeyB64());
    await e2eC.deriveKey('a', e2eA.getPublicKeyB64());

    const encrypted = await e2eA.encrypt('b', 'secret message');

    await expect(e2eC.decrypt('a', encrypted)).rejects.toThrow();

    e2eA.destroy();
    e2eB.destroy();
    e2eC.destroy();
  });

  it('should produce different ciphertext for same plaintext (IV randomness)', async () => {
    const e2eA = new E2E();
    const e2eB = new E2E();
    await e2eA.init();
    await e2eB.init();
    await e2eA.deriveKey('b', e2eB.getPublicKeyB64());

    const enc1 = await e2eA.encrypt('b', 'same message');
    const enc2 = await e2eA.encrypt('b', 'same message');
    expect(enc1).not.toBe(enc2);

    e2eA.destroy();
    e2eB.destroy();
  });

  it('should exchange keys over real P2P data channel', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const kmA = new GroupKeyManager(a);
    const kmB = new GroupKeyManager(b);
    await kmA.init();
    await kmB.init();

    peerB.on('data', async (data: any) => {
      if (data?._e2e_key_exchange) {
        await kmB.handleIncomingKeyExchange(peerB, data);
      }
    });

    await kmA.exchangeWith(peerA);

    expect(kmA.getE2E().hasKey(b.fingerprint)).toBe(true);
    expect(kmB.getE2E().hasKey(a.fingerprint)).toBe(true);

    kmA.destroy();
    kmB.destroy();
  });

  it('should encrypt/decrypt over real P2P after key exchange', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const kmA = new GroupKeyManager(a);
    const kmB = new GroupKeyManager(b);
    await kmA.init();
    await kmB.init();

    peerB.on('data', async (data: any) => {
      if (data?._e2e_key_exchange) {
        await kmB.handleIncomingKeyExchange(peerB, data);
      }
    });

    await kmA.exchangeWith(peerA);

    const secret = { password: 'hunter2', codes: [1, 2, 3] };
    const encrypted = await kmA.encryptForPeer(b.fingerprint, secret);

    const receivedPromise = new Promise<any>((resolve) => {
      peerB.on('data', async (data: any) => {
        if (data?._encrypted) {
          const decrypted = await kmB.decryptFromPeer(a.fingerprint, data.payload);
          resolve(decrypted);
        }
      });
    });

    peerA.send({ _encrypted: true, payload: encrypted }, 'data');
    const decrypted = await receivedPromise;

    expect(decrypted).toEqual(secret);

    kmA.destroy();
    kmB.destroy();
  });

  it('should encrypt large payload over real P2P', async () => {
    const [a, b] = await connectPair();
    clients.push(a, b);
    const [peerA, peerB] = await establishP2P(a, b);

    const kmA = new GroupKeyManager(a);
    const kmB = new GroupKeyManager(b);
    await kmA.init();
    await kmB.init();

    peerB.on('data', async (data: any) => {
      if (data?._e2e_key_exchange) {
        await kmB.handleIncomingKeyExchange(peerB, data);
      }
    });

    await kmA.exchangeWith(peerA);

    const largeData = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, val: 'x'.repeat(50) })) };
    const encrypted = await kmA.encryptForPeer(b.fingerprint, largeData);

    const receivedPromise = new Promise<any>((resolve) => {
      peerB.on('data', async (data: any) => {
        if (data?._encrypted_large) {
          const decrypted = await kmB.decryptFromPeer(a.fingerprint, data.payload);
          resolve(decrypted);
        }
      });
    });

    peerA.send({ _encrypted_large: true, payload: encrypted }, 'data');
    const decrypted = await receivedPromise;

    expect(decrypted.items.length).toBe(500);

    kmA.destroy();
    kmB.destroy();
  });

  it('should removeKey and fail on subsequent decrypt', async () => {
    const e2eA = new E2E();
    const e2eB = new E2E();
    await e2eA.init();
    await e2eB.init();
    await e2eA.deriveKey('b', e2eB.getPublicKeyB64());

    const encrypted = await e2eA.encrypt('b', 'test');
    e2eA.removeKey('b');
    expect(e2eA.hasKey('b')).toBe(false);
    await expect(e2eA.encrypt('b', 'test')).rejects.toThrow();

    e2eA.destroy();
    e2eB.destroy();
  });
});
