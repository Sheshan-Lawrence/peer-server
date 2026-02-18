import { Emitter } from './core/emitter';
import type { PeerClient } from './core/client';
import type { Peer } from './core/peer';

type E2EEvent = 'key_exchanged' | 'error';

export class E2E extends Emitter<E2EEvent> {
  private keys = new Map<string, CryptoKey>();
  private keyPair: CryptoKeyPair | null = null;
  private publicKeyRaw: ArrayBuffer | null = null;

  async init(): Promise<void> {
    this.keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const raw = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);
    this.publicKeyRaw = new Uint8Array(raw).buffer as ArrayBuffer;
  }

  isInitialized(): boolean {
    return this.publicKeyRaw !== null;
  }

  getPublicKeyB64(): string {
    if (!this.publicKeyRaw) throw new Error('E2E not initialized');
    return btoa(String.fromCharCode(...new Uint8Array(this.publicKeyRaw)));
  }

  getPublicKeyRaw(): ArrayBuffer {
    if (!this.publicKeyRaw) throw new Error('E2E not initialized');
    return this.publicKeyRaw;
  }

  async deriveKey(peerFingerprint: string, remotePublicKeyB64: string): Promise<void> {
    if (!this.keyPair) throw new Error('E2E not initialized');
    const raw = Uint8Array.from(atob(remotePublicKeyB64), (c) => c.charCodeAt(0));
    const remoteKey = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: remoteKey },
      this.keyPair.privateKey,
      256,
    );
    const aesKey = await crypto.subtle.importKey(
      'raw',
      bits,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    this.keys.set(peerFingerprint, aesKey);
    this.emit('key_exchanged', peerFingerprint);
  }

  async encrypt(peerFingerprint: string, data: string): Promise<string> {
    const key = this.keys.get(peerFingerprint);
    if (!key) throw new Error(`No key for ${peerFingerprint}`);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(data);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded,
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return arrayToBase64(combined);
  }

  async decrypt(peerFingerprint: string, data: string): Promise<string> {
    const key = this.keys.get(peerFingerprint);
    if (!key) throw new Error(`No key for ${peerFingerprint}`);
    const combined = base64ToArray(data);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  }

  hasKey(peerFingerprint: string): boolean {
    return this.keys.has(peerFingerprint);
  }

  removeKey(peerFingerprint: string): void {
    this.keys.delete(peerFingerprint);
  }

  destroy(): void {
    this.keys.clear();
    this.keyPair = null;
    this.publicKeyRaw = null;
    this.removeAllListeners();
  }
}

export function arrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToArray(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class GroupKeyManager {
  private e2e: E2E;
  private client: PeerClient;

  constructor(client: PeerClient) {
    this.client = client;
    this.e2e = new E2E();
  }

  getE2E(): E2E {
    return this.e2e;
  }

  async init(): Promise<void> {
    await this.e2e.init();
  }

  async exchangeWith(peer: Peer): Promise<void> {
    if (peer.connectionState !== 'connected') {
      await this.waitForConnection(peer);
    }

    const pubKey = this.e2e.getPublicKeyB64();
    const identity = this.client.getIdentity();
    let signature: string | undefined;

    if (identity.getPrivateKey()) {
      const sigRaw = await identity.sign(this.e2e.getPublicKeyRaw());
      signature = arrayToBase64(new Uint8Array(sigRaw));
    }

    peer.send({
      _e2e_key_exchange: true,
      publicKey: pubKey,
      signature,
      fingerprint: this.client.fingerprint,
    }, 'data');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error('Key exchange timeout'));
      }, 10000);

      const off = peer.on('data', async (data: any) => {
        if (data?._e2e_key_exchange && data.publicKey) {
          off();
          clearTimeout(timeout);
          try {
            await this.e2e.deriveKey(peer.fingerprint, data.publicKey);
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      });
    });
  }

  async handleIncomingKeyExchange(peer: Peer, data: any): Promise<void> {
    if (data?._e2e_key_exchange && data.publicKey) {
      await this.e2e.deriveKey(peer.fingerprint, data.publicKey);

      if (peer.connectionState !== 'connected') {
        await this.waitForConnection(peer);
      }

      const pubKey = this.e2e.getPublicKeyB64();
      const identity = this.client.getIdentity();
      let signature: string | undefined;

      if (identity.getPrivateKey()) {
        const sigRaw = await identity.sign(this.e2e.getPublicKeyRaw());
        signature = arrayToBase64(new Uint8Array(sigRaw));
      }

      peer.send({
        _e2e_key_exchange: true,
        publicKey: pubKey,
        signature,
        fingerprint: this.client.fingerprint,
      }, 'data');
    }
  }

  async encryptForPeer(fingerprint: string, data: any): Promise<string> {
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    return this.e2e.encrypt(fingerprint, json);
  }

  async decryptFromPeer(fingerprint: string, data: string): Promise<any> {
    const json = await this.e2e.decrypt(fingerprint, data);
    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  }

  private waitForConnection(peer: Peer, timeout = 10000): Promise<void> {
    if (peer.connectionState === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Connection timeout for key exchange'));
      }, timeout);
      const off = peer.on('connected', () => {
        off();
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.e2e.destroy();
  }
}