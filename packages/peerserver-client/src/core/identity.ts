import type { IdentityKeys } from './types';

export class Identity {
  fingerprint = '';
  alias = '';
  publicKeyB64 = '';
  private keyPair: CryptoKeyPair | null = null;

  async generate(): Promise<string> {
    this.keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const raw = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
    this.publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
    return this.publicKeyB64;
  }

  async restore(keys: IdentityKeys): Promise<void> {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      keys.privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign'],
    );
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      keys.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    this.keyPair = { privateKey, publicKey };
    this.fingerprint = keys.fingerprint;
    this.alias = keys.alias;
    this.publicKeyB64 = keys.publicKeyB64;
  }

  async export(): Promise<IdentityKeys> {
    if (!this.keyPair) throw new Error('No keypair generated');
    const [privateKeyJwk, publicKeyJwk] = await Promise.all([
      crypto.subtle.exportKey('jwk', this.keyPair.privateKey),
      crypto.subtle.exportKey('jwk', this.keyPair.publicKey),
    ]);
    return {
      fingerprint: this.fingerprint,
      alias: this.alias,
      publicKeyB64: this.publicKeyB64,
      privateKeyJwk,
      publicKeyJwk,
    };
  }

  setRegistered(fingerprint: string, alias: string): void {
    this.fingerprint = fingerprint;
    this.alias = alias;
  }

  async sign(data: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.keyPair) throw new Error('No keypair generated');
    const result = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.keyPair.privateKey,
      data,
    );
    return new Uint8Array(result).buffer as ArrayBuffer;
  }

  async verify(publicKey: CryptoKey, signature: ArrayBuffer, data: ArrayBuffer): Promise<boolean> {
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      data,
    );
  }

  getPublicKey(): CryptoKey | null {
    return this.keyPair?.publicKey ?? null;
  }

  getPrivateKey(): CryptoKey | null {
    return this.keyPair?.privateKey ?? null;
  }
}
