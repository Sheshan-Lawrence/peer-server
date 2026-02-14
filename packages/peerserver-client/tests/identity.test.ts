import { describe, it, expect } from 'vitest';
import { Identity } from '../src/core/identity';

describe('Identity', () => {
  it('should generate keypair and publicKeyB64', async () => {
    const id = new Identity();
    const pubKey = await id.generate();
    expect(pubKey).toBeTruthy();
    expect(id.publicKeyB64).toBe(pubKey);
    expect(id.publicKeyB64.length).toBeGreaterThan(10);
  });

  it('should start with empty fingerprint and alias', () => {
    const id = new Identity();
    expect(id.fingerprint).toBe('');
    expect(id.alias).toBe('');
  });

  it('should setRegistered', async () => {
    const id = new Identity();
    await id.generate();
    id.setRegistered('fp-test', 'alice');
    expect(id.fingerprint).toBe('fp-test');
    expect(id.alias).toBe('alice');
  });

  it('should export and restore keys', async () => {
    const id1 = new Identity();
    await id1.generate();
    id1.setRegistered('fp-1', 'bob');
    const exported = await id1.export();

    expect(exported.fingerprint).toBe('fp-1');
    expect(exported.alias).toBe('bob');
    expect(exported.publicKeyB64).toBe(id1.publicKeyB64);
    expect(exported.privateKeyJwk).toBeTruthy();
    expect(exported.publicKeyJwk).toBeTruthy();

    const id2 = new Identity();
    await id2.restore(exported);
    expect(id2.fingerprint).toBe('fp-1');
    expect(id2.alias).toBe('bob');
    expect(id2.publicKeyB64).toBe(id1.publicKeyB64);
  });

  it('should sign data', async () => {
    const id = new Identity();
    await id.generate();
    const data = new TextEncoder().encode('hello world');
    const sig = await id.sign(data.buffer);
    expect(sig).toBeInstanceOf(ArrayBuffer);
    expect(sig.byteLength).toBeGreaterThan(0);
  });

  it('should verify signature', async () => {
    const id = new Identity();
    await id.generate();
    const data = new TextEncoder().encode('test data');
    const sig = await id.sign(data.buffer);
    const pubKey = id.getPublicKey()!;
    const valid = await id.verify(pubKey, sig, data.buffer);
    expect(valid).toBe(true);
  });

  it('should fail verification with wrong data', async () => {
    const id = new Identity();
    await id.generate();
    const data = new TextEncoder().encode('original');
    const sig = await id.sign(data.buffer);
    const wrong = new TextEncoder().encode('tampered');
    const valid = await id.verify(id.getPublicKey()!, sig, wrong.buffer);
    expect(valid).toBe(false);
  });

  it('should throw on sign without keypair', async () => {
    const id = new Identity();
    await expect(id.sign(new ArrayBuffer(0))).rejects.toThrow('No keypair');
  });

  it('should throw on export without keypair', async () => {
    const id = new Identity();
    await expect(id.export()).rejects.toThrow('No keypair');
  });

  it('should return null keys before generate', () => {
    const id = new Identity();
    expect(id.getPublicKey()).toBeNull();
    expect(id.getPrivateKey()).toBeNull();
  });

  it('should return keys after generate', async () => {
    const id = new Identity();
    await id.generate();
    expect(id.getPublicKey()).toBeTruthy();
    expect(id.getPrivateKey()).toBeTruthy();
  });

  it('should produce different keys on each generate', async () => {
    const id1 = new Identity();
    const id2 = new Identity();
    const k1 = await id1.generate();
    const k2 = await id2.generate();
    expect(k1).not.toBe(k2);
  });
});
