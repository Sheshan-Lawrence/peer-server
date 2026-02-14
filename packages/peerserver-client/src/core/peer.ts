import { Emitter } from './emitter';
import type { PeerEvent, DataChannelConfig } from './types';

export class Peer extends Emitter<PeerEvent> {
  readonly fingerprint: string;
  readonly alias: string;
  readonly pc: RTCPeerConnection;
  private channels = new Map<string, RTCDataChannel>();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;
  private _closed = false;
  private _sendSignal: (payload: any) => void;

  constructor(
    fingerprint: string,
    alias: string,
    iceServers: RTCIceServer[],
    sendSignal: (payload: any) => void,
  ) {
    super();
    this.fingerprint = fingerprint;
    this.alias = alias;
    this._sendSignal = sendSignal;
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._sendSignal({
          signal_type: 'candidate',
          candidate: JSON.stringify(e.candidate),
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this._closed) return;
      const state = this.pc.connectionState;
      if (state === 'connected') this.emit('connected');
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.emit('disconnected', state);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this._closed) return;
      const state = this.pc.iceConnectionState;
      if (state === 'failed') {
        this.restartIce();
      }
    };

    this.pc.onnegotiationneeded = async () => {
      if (this._closed) return;
      try {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this._sendSignal({ signal_type: 'offer', sdp: offer.sdp });
      } catch (e) {
        this.emit('error', e);
      }
    };

    this.pc.ondatachannel = (e) => {
      this.setupChannel(e.channel);
      this.emit('datachannel:create', e.channel);
    };

    this.pc.ontrack = (e) => {
      this.emit('track', e.track, e.streams);
      if (e.streams[0]) this.emit('stream', e.streams[0]);
    };
  }

  async createOffer(channelConfig?: DataChannelConfig): Promise<void> {
    const label = channelConfig?.label ?? 'data';
    const ch = this.pc.createDataChannel(label, {
      ordered: channelConfig?.ordered ?? true,
      maxRetransmits: channelConfig?.maxRetransmits,
      maxPacketLifeTime: channelConfig?.maxPacketLifeTime,
    });
    this.setupChannel(ch);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this._sendSignal({ signal_type: 'offer', sdp: offer.sdp });
  }

  async handleSignal(payload: any): Promise<void> {
    if (this._closed) return;
    const { signal_type, sdp, candidate } = payload;

    try {
      if (signal_type === 'offer') {
        await this.pc.setRemoteDescription({ type: 'offer', sdp });
        this.remoteDescSet = true;
        await this.flushCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSignal({ signal_type: 'answer', sdp: answer.sdp });
      } else if (signal_type === 'answer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp });
        this.remoteDescSet = true;
        await this.flushCandidates();
      } else if (signal_type === 'candidate') {
        const parsed = JSON.parse(candidate);
        if (this.remoteDescSet) {
          await this.pc.addIceCandidate(parsed);
        } else {
          this.pendingCandidates.push(parsed);
        }
      }
    } catch (e) {
      this.emit('error', e);
    }
  }

  send(data: any, channel?: string): void {
    const label = channel ?? 'data';
    const ch = this.channels.get(label);
    if (!ch || ch.readyState !== 'open') {
      throw new Error(`Channel "${label}" not open`);
    }
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      ch.send(data as unknown as ArrayBufferView<ArrayBuffer>);
    } else {
      ch.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }

  sendBinary(data: ArrayBuffer, channel?: string): void {
    const label = channel ?? 'data';
    const ch = this.channels.get(label);
    if (!ch || ch.readyState !== 'open') {
      throw new Error(`Channel "${label}" not open`);
    }
    ch.send(data);
  }

  addStream(stream: MediaStream): void {
    stream.getTracks().forEach((track) => {
      this.pc.addTrack(track, stream);
    });
  }

  removeStream(stream: MediaStream): void {
    const senders = this.pc.getSenders();
    stream.getTracks().forEach((track) => {
      const sender = senders.find((s) => s.track === track);
      if (sender) this.pc.removeTrack(sender);
    });
  }

  createDataChannel(config: DataChannelConfig): RTCDataChannel {
    const ch = this.pc.createDataChannel(config.label ?? 'extra', {
      ordered: config.ordered ?? true,
      maxRetransmits: config.maxRetransmits,
      maxPacketLifeTime: config.maxPacketLifeTime,
    });
    this.setupChannel(ch);
    return ch;
  }

  getChannel(label: string): RTCDataChannel | undefined {
    return this.channels.get(label);
  }

  getBufferedAmount(channel?: string): number {
    const ch = this.channels.get(channel ?? 'data');
    return ch?.bufferedAmount ?? 0;
  }

  get connectionState(): string {
    return this._closed ? 'closed' : this.pc.connectionState;
  }

  get channelLabels(): string[] {
    return [...this.channels.keys()];
  }

  get closed(): boolean {
    return this._closed;
  }

  restartIce(): void {
    if (this._closed) return;
    try {
      this.pc.restartIce();
    } catch (e) {
      this.emit('error', e);
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.channels.forEach((ch) => {
      try {
        ch.close();
      } catch {}
    });
    this.channels.clear();
    try {
      this.pc.close();
    } catch {}
    this.removeAllListeners();
  }

  private setupChannel(ch: RTCDataChannel): void {
    this.channels.set(ch.label, ch);

    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      this.emit('datachannel:open', ch.label, ch);
    };

    ch.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.emit('data', e.data, ch.label);
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        parsed = e.data;
      }
      this.emit('data', parsed, ch.label);
    };

    ch.onclose = () => {
      this.channels.delete(ch.label);
      this.emit('datachannel:close', ch.label);
    };

    ch.onerror = (e) => {
      this.emit('error', e);
    };
  }

  private async flushCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (e) {
        this.emit('error', e);
      }
    }
    this.pendingCandidates = [];
  }
}
