import { vi } from 'vitest';

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(data: any): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateError(): void {
    this.onerror?.({});
  }

  send = vi.fn();

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }
}

export class MockRTCDataChannel {
  label: string;
  ordered = true;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;

  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onbufferedamountlow: ((ev: any) => void) | null = null;

  constructor(label: string, opts?: any) {
    this.label = label;
    if (opts?.ordered !== undefined) this.ordered = opts.ordered;
    if (opts?.maxRetransmits !== undefined) this.maxRetransmits = opts.maxRetransmits;
    if (opts?.maxPacketLifeTime !== undefined) this.maxPacketLifeTime = opts.maxPacketLifeTime;
  }

  send = vi.fn((data: any) => {
    if (this.readyState !== 'open') throw new Error('Channel not open');
  });

  close(): void {
    this.readyState = 'closed';
    this.onclose?.({});
  }

  simulateOpen(): void {
    this.readyState = 'open';
    this.onopen?.({});
  }

  simulateMessage(data: any): void {
    this.onmessage?.({ data });
  }

  simulateClose(): void {
    this.readyState = 'closed';
    this.onclose?.({});
  }
}

export class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;

  onicecandidate: ((ev: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ondatachannel: ((ev: any) => void) | null = null;
  ontrack: ((ev: any) => void) | null = null;

  private channels: MockRTCDataChannel[] = [];
  private senders: any[] = [];

  constructor(_config?: any) {}

  createDataChannel(label: string, opts?: any): MockRTCDataChannel {
    const ch = new MockRTCDataChannel(label, opts);
    this.channels.push(ch);
    return ch;
  }

  createOffer = vi.fn(async () => ({
    type: 'offer' as RTCSdpType,
    sdp: 'mock-offer-sdp',
  }));

  createAnswer = vi.fn(async () => ({
    type: 'answer' as RTCSdpType,
    sdp: 'mock-answer-sdp',
  }));

  setLocalDescription = vi.fn(async (desc: any) => {
    this.localDescription = desc;
  });

  setRemoteDescription = vi.fn(async (_desc: any) => {});

  addIceCandidate = vi.fn(async (_candidate: any) => {});

  addTrack = vi.fn((track: any, stream: any) => {
    const sender = { track, replaceTrack: vi.fn() };
    this.senders.push(sender);
    return sender;
  });

  removeTrack = vi.fn((sender: any) => {
    const idx = this.senders.indexOf(sender);
    if (idx >= 0) this.senders.splice(idx, 1);
  });

  getSenders(): any[] {
    return [...this.senders];
  }

  restartIce = vi.fn();

  close = vi.fn(() => {
    this.connectionState = 'closed';
  });

  simulateConnected(): void {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }

  simulateDisconnected(): void {
    this.connectionState = 'disconnected';
    this.onconnectionstatechange?.();
  }

  simulateFailed(): void {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
    this.iceConnectionState = 'failed';
    this.oniceconnectionstatechange?.();
  }

  simulateDataChannel(label: string): MockRTCDataChannel {
    const ch = new MockRTCDataChannel(label);
    this.ondatachannel?.({ channel: ch });
    return ch;
  }

  simulateIceCandidate(candidate: any): void {
    this.onicecandidate?.({ candidate });
  }

  simulateTrack(track: any, streams: any[]): void {
    this.ontrack?.({ track, streams });
  }
}

export class MockMediaStreamTrack {
  kind: string;
  enabled = true;
  id = Math.random().toString(36).slice(2);

  constructor(kind: string) {
    this.kind = kind;
  }

  stop = vi.fn();
}

export class MockMediaStream {
  id = Math.random().toString(36).slice(2);
  private tracks: MockMediaStreamTrack[] = [];

  constructor(tracks?: MockMediaStreamTrack[]) {
    if (tracks) this.tracks = tracks;
  }

  getTracks(): MockMediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio');
  }

  getVideoTracks(): MockMediaStreamTrack[] {
    return this.tracks.filter((t) => t.kind === 'video');
  }

  addTrack(track: MockMediaStreamTrack): void {
    this.tracks.push(track);
  }
}

export function installGlobalMocks(): void {
  (globalThis as any).WebSocket = MockWebSocket;
  (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
  (globalThis as any).RTCDataChannel = MockRTCDataChannel;
  (globalThis as any).MediaStream = MockMediaStream;
  (globalThis as any).MediaStreamTrack = MockMediaStreamTrack;
}

installGlobalMocks();
