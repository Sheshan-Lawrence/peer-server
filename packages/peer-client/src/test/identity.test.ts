import { describe, it, expect, beforeEach } from 'vitest';
import { Identity } from '../core/identity';

describe('Identity', () => {
  let identity: Identity;

  beforeEach(() => {
    identity = new Identity();
  });

  it('initial state has empty fields', () => {
    expect(identity.fingerprint).toBe('');
    expect(identity.alias).toBe('');
    expect(identity.publicKeyB64).toBe('');
  });

  it('generate() produces a public key', async () => {
    const key = await identity.generate();
    expect(key).toBeTruthy();
    expect(identity.publicKeyB64).toBe(key);
  });

  it('generate() produces valid base64', async () => {
    const key = await identity.generate();
    expect(() => atob(key)).not.toThrow();
  });

  it('generate() produces different keys each time', async () => {
    const id1 = new Identity();
    const id2 = new Identity();
    await id1.generate();
    await id2.generate();
    expect(id1.publicKeyB64).not.toBe(id2.publicKeyB64);
  });

  it('setRegistered updates fingerprint and alias', async () => {
    await identity.generate();
    identity.setRegistered('fp123', 'alice');
    expect(identity.fingerprint).toBe('fp123');
    expect(identity.alias).toBe('alice');
  });

  it('export() returns full key material', async () => {
    await identity.generate();
    identity.setRegistered('fp1', 'bob');
    const exported = await identity.export();
    expect(exported.fingerprint).toBe('fp1');
    expect(exported.alias).toBe('bob');
    expect(exported.publicKeyB64).toBe(identity.publicKeyB64);
    expect(exported.privateKeyJwk).toBeTruthy();
    expect(exported.publicKeyJwk).toBeTruthy();
    expect(exported.privateKeyJwk.kty).toBe('EC');
  });

  it('export() without generate throws', async () => {
    await expect(identity.export()).rejects.toThrow('No keypair');
  });

  it('restore() recovers identity from exported keys', async () => {
    await identity.generate();
    identity.setRegistered('fpR', 'restored');
    const keys = await identity.export();

    const restored = new Identity();
    await restored.restore(keys);
    expect(restored.fingerprint).toBe('fpR');
    expect(restored.alias).toBe('restored');
    expect(restored.publicKeyB64).toBe(identity.publicKeyB64);
  });

  it('sign() produces a signature', async () => {
    await identity.generate();
    const data = new TextEncoder().encode('test data');
    const sig = await identity.sign(data.buffer as ArrayBuffer);
    expect(sig.byteLength).toBeGreaterThan(0);
  });

  it('sign() without keypair throws', async () => {
    const data = new TextEncoder().encode('test');
    await expect(identity.sign(data.buffer as ArrayBuffer)).rejects.toThrow('No keypair');
  });

  it('verify() validates correct signature', async () => {
    await identity.generate();
    const data = new TextEncoder().encode('hello world');
    const sig = await identity.sign(data.buffer as ArrayBuffer);
    const pubKey = identity.getPublicKey()!;
    const valid = await identity.verify(pubKey, sig, data.buffer as ArrayBuffer);
    expect(valid).toBe(true);
  });

  it('verify() rejects tampered data', async () => {
    await identity.generate();
    const data = new TextEncoder().encode('original');
    const sig = await identity.sign(data.buffer as ArrayBuffer);
    const tampered = new TextEncoder().encode('tampered');
    const pubKey = identity.getPublicKey()!;
    const valid = await identity.verify(pubKey, sig, tampered.buffer as ArrayBuffer);
    expect(valid).toBe(false);
  });

  it('verify() rejects wrong key', async () => {
    await identity.generate();
    const data = new TextEncoder().encode('msg');
    const sig = await identity.sign(data.buffer as ArrayBuffer);

    const other = new Identity();
    await other.generate();
    const otherPub = other.getPublicKey()!;
    const valid = await identity.verify(otherPub, sig, data.buffer as ArrayBuffer);
    expect(valid).toBe(false);
  });

  it('getPublicKey() returns null before generate', () => {
    expect(identity.getPublicKey()).toBeNull();
  });

  it('getPrivateKey() returns null before generate', () => {
    expect(identity.getPrivateKey()).toBeNull();
  });

  it('getPublicKey() returns CryptoKey after generate', async () => {
    await identity.generate();
    const key = identity.getPublicKey();
    expect(key).toBeTruthy();
    expect(key!.type).toBe('public');
  });

  it('getPrivateKey() returns CryptoKey after generate', async () => {
    await identity.generate();
    const key = identity.getPrivateKey();
    expect(key).toBeTruthy();
    expect(key!.type).toBe('private');
  });

  it('restored identity can sign and verify', async () => {
    await identity.generate();
    identity.setRegistered('fp', 'a');
    const keys = await identity.export();

    const restored = new Identity();
    await restored.restore(keys);

    const data = new TextEncoder().encode('roundtrip');
    const sig = await restored.sign(data.buffer as ArrayBuffer);
    const valid = await restored.verify(restored.getPublicKey()!, sig, data.buffer as ArrayBuffer);
    expect(valid).toBe(true);
  });

  it('cross-identity verification works', async () => {
    const id1 = new Identity();
    const id2 = new Identity();
    await id1.generate();
    await id2.generate();

    const data = new TextEncoder().encode('cross');
    const sig = await id1.sign(data.buffer as ArrayBuffer);
    const valid = await id2.verify(id1.getPublicKey()!, sig, data.buffer as ArrayBuffer);
    expect(valid).toBe(true);
  });

  it('export/restore roundtrip preserves signing ability', async () => {
    await identity.generate();
    identity.setRegistered('rt', 'rt');
    const keys = await identity.export();

    for (let i = 0; i < 5; i++) {
      const id = new Identity();
      await id.restore(keys);
      const data = new TextEncoder().encode(`iter-${i}`);
      const sig = await id.sign(data.buffer as ArrayBuffer);
      expect(sig.byteLength).toBeGreaterThan(0);
    }
  });

  it('sign produces different signatures for different data', async () => {
    await identity.generate();
    const sig1 = await identity.sign(new TextEncoder().encode('a').buffer as ArrayBuffer);
    const sig2 = await identity.sign(new TextEncoder().encode('b').buffer as ArrayBuffer);
    const arr1 = new Uint8Array(sig1);
    const arr2 = new Uint8Array(sig2);
    let same = arr1.length === arr2.length;
    if (same) {
      for (let i = 0; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) { same = false; break; }
      }
    }
    expect(same).toBe(false);
  });

  it('sign empty buffer works', async () => {
    await identity.generate();
    const sig = await identity.sign(new ArrayBuffer(0));
    expect(sig.byteLength).toBeGreaterThan(0);
  });

  it('sign large buffer works', async () => {
    await identity.generate();
    const large = new Uint8Array(1024 * 1024);
    for (let offset = 0; offset < large.length; offset += 65536) {
        crypto.getRandomValues(large.subarray(offset, Math.min(offset + 65536, large.length)));
    }
    const sig = await identity.sign(large.buffer as ArrayBuffer);
    expect(sig.byteLength).toBeGreaterThan(0);
});

  it('stress: 100 generate calls', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = new Identity();
      const k = await id.generate();
      keys.add(k);
    }
    expect(keys.size).toBe(100);
  });

  it('stress: 100 sign/verify cycles', async () => {
    await identity.generate();
    const pubKey = identity.getPublicKey()!;
    for (let i = 0; i < 100; i++) {
      const data = new TextEncoder().encode(`msg-${i}`);
      const sig = await identity.sign(data.buffer as ArrayBuffer);
      const valid = await identity.verify(pubKey, sig, data.buffer as ArrayBuffer);
      expect(valid).toBe(true);
    }
  });

  it('multiple setRegistered calls override', () => {
    identity.setRegistered('a', 'alice');
    identity.setRegistered('b', 'bob');
    expect(identity.fingerprint).toBe('b');
    expect(identity.alias).toBe('bob');
  });

  it('restore with mismatched curve throws', async () => {
    const badKeys = {
      fingerprint: 'x',
      alias: 'x',
      publicKeyB64: 'abc',
      privateKeyJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b', d: 'c' },
      publicKeyJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' },
    };
    await expect(identity.restore(badKeys as any)).rejects.toThrow();
  });

  it('publicKeyB64 decodes to 65 bytes (uncompressed P-256)', async () => {
    await identity.generate();
    const raw = atob(identity.publicKeyB64);
    expect(raw.length).toBe(65);
  });

  it('exported keys have correct JWK curve', async () => {
    await identity.generate();
    identity.setRegistered('fp', 'a');
    const keys = await identity.export();
    expect(keys.privateKeyJwk.crv).toBe('P-256');
    expect(keys.publicKeyJwk.crv).toBe('P-256');
  });

  it('generate then export then restore preserves publicKeyB64', async () => {
    await identity.generate();
    identity.setRegistered('orig', 'orig');
    const keys = await identity.export();
    const restored = new Identity();
    await restored.restore(keys);
    expect(restored.publicKeyB64).toBe(identity.publicKeyB64);
  });

  it('sign produces DER-encoded ECDSA signature', async () => {
    await identity.generate();
    const data = new TextEncoder().encode('der-test');
    const sig = await identity.sign(data.buffer as ArrayBuffer);
    expect(sig.byteLength).toBeGreaterThanOrEqual(64);
    expect(sig.byteLength).toBeLessThanOrEqual(72);
  });
});