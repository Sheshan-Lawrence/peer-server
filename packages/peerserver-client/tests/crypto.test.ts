import { describe, it, expect, vi } from 'vitest';
import { E2E } from '../src/crypto';

describe('E2E', () => {
  it('should initialize and generate keys', async () => {
    const e2e = new E2E();
    await e2e.init();
    expect(e2e.getPublicKeyB64()).toBeTruthy();
    expect(e2e.getPublicKeyRaw()).toBeInstanceOf(ArrayBuffer);
  });

  it('should throw before init', () => {
    const e2e = new E2E();
    expect(() => e2e.getPublicKeyB64()).toThrow('not initialized');
    expect(() => e2e.getPublicKeyRaw()).toThrow('not initialized');
  });

  it('should derive shared key between two instances', async () => {
    const alice = new E2E();
    const bob = new E2E();
    await alice.init();
    await bob.init();

    await alice.deriveKey('bob', bob.getPublicKeyB64());
    await bob.deriveKey('alice', alice.getPublicKeyB64());

    expect(alice.hasKey('bob')).toBe(true);
    expect(bob.hasKey('alice')).toBe(true);
  });

  it('should encrypt and decrypt between two instances', async () => {
    const alice = new E2E();
    const bob = new E2E();
    await alice.init();
    await bob.init();

    await alice.deriveKey('bob', bob.getPublicKeyB64());
    await bob.deriveKey('alice', alice.getPublicKeyB64());

    const encrypted = await alice.encrypt('bob', 'secret message');
    const decrypted = await bob.decrypt('alice', encrypted);
    expect(decrypted).toBe('secret message');
  });

  it('should handle unicode text', async () => {
    const alice = new E2E();
    const bob = new E2E();
    await alice.init();
    await bob.init();

    await alice.deriveKey('bob', bob.getPublicKeyB64());
    await bob.deriveKey('alice', alice.getPublicKeyB64());

    const text = '你好世界 🌍 مرحبا';
    const encrypted = await alice.encrypt('bob', text);
    const decrypted = await bob.decrypt('alice', encrypted);
    expect(decrypted).toBe(text);
  });

  it('should produce different ciphertext each time (random IV)', async () => {
    const alice = new E2E();
    const bob = new E2E();
    await alice.init();
    await bob.init();
    await alice.deriveKey('bob', bob.getPublicKeyB64());

    const e1 = await alice.encrypt('bob', 'same text');
    const e2 = await alice.encrypt('bob', 'same text');
    expect(e1).not.toBe(e2);
  });

  it('should throw encrypt without key', async () => {
    const e2e = new E2E();
    await e2e.init();
    await expect(e2e.encrypt('unknown', 'test')).rejects.toThrow('No key');
  });

  it('should throw decrypt without key', async () => {
    const e2e = new E2E();
    await e2e.init();
    await expect(e2e.decrypt('unknown', 'dGVzdA==')).rejects.toThrow('No key');
  });

  it('should fail to decrypt with wrong key', async () => {
    const alice = new E2E();
    const bob = new E2E();
    const eve = new E2E();
    await alice.init();
    await bob.init();
    await eve.init();

    await alice.deriveKey('bob', bob.getPublicKeyB64());
    await eve.deriveKey('alice', alice.getPublicKeyB64());

    const encrypted = await alice.encrypt('bob', 'for bob only');
    await expect(eve.decrypt('alice', encrypted)).rejects.toThrow();
  });

  it('should remove key', async () => {
    const e2e = new E2E();
    await e2e.init();
    const other = new E2E();
    await other.init();
    await e2e.deriveKey('other', other.getPublicKeyB64());
    expect(e2e.hasKey('other')).toBe(true);
    e2e.removeKey('other');
    expect(e2e.hasKey('other')).toBe(false);
  });

  it('should emit key_exchanged event', async () => {
    const e2e = new E2E();
    await e2e.init();
    const other = new E2E();
    await other.init();

    const fn = vi.fn();
    e2e.on('key_exchanged', fn);
    await e2e.deriveKey('other', other.getPublicKeyB64());
    expect(fn).toHaveBeenCalledWith('other');
  });

  it('should destroy and clear state', async () => {
    const e2e = new E2E();
    await e2e.init();
    const other = new E2E();
    await other.init();
    await e2e.deriveKey('other', other.getPublicKeyB64());

    e2e.destroy();
    expect(e2e.hasKey('other')).toBe(false);
    expect(() => e2e.getPublicKeyB64()).toThrow('not initialized');
  });

  it('should throw deriveKey before init', async () => {
    const e2e = new E2E();
    await expect(e2e.deriveKey('x', 'dGVzdA==')).rejects.toThrow('not initialized');
  });

  it('should handle empty string encryption', async () => {
    const alice = new E2E();
    const bob = new E2E();
    await alice.init();
    await bob.init();
    await alice.deriveKey('bob', bob.getPublicKeyB64());
    await bob.deriveKey('alice', alice.getPublicKeyB64());

    const encrypted = await alice.encrypt('bob', '');
    const decrypted = await bob.decrypt('alice', encrypted);
    expect(decrypted).toBe('');
  });

  it('should handle large payload', async () => {
    const alice = new E2E();
    const bob = new E2E();
    await alice.init();
    await bob.init();
    await alice.deriveKey('bob', bob.getPublicKeyB64());
    await bob.deriveKey('alice', alice.getPublicKeyB64());

    const large = 'x'.repeat(100000);
    const encrypted = await alice.encrypt('bob', large);
    const decrypted = await bob.decrypt('alice', encrypted);
    expect(decrypted).toBe(large);
  });
});
