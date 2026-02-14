export type MessageType =
  | 'register'
  | 'registered'
  | 'join'
  | 'leave'
  | 'signal'
  | 'discover'
  | 'peer_list'
  | 'match'
  | 'matched'
  | 'relay'
  | 'broadcast'
  | 'peer_joined'
  | 'peer_left'
  | 'metadata'
  | 'ping'
  | 'pong'
  | 'error'
  | 'create_room'
  | 'room_created'
  | 'join_room'
  | 'room_info'
  | 'room_closed'
  | 'kick';

export interface ServerMessage {
  type: MessageType;
  from?: string;
  to?: string;
  namespace?: string;
  payload?: any;
  ts?: number;
}

export interface PeerInfo {
  fingerprint: string;
  alias: string;
  meta?: Record<string, any>;
  app_type?: string;
}

export interface MatchResult {
  namespace: string;
  session_id: string;
  peers: PeerInfo[];
}

export interface RoomCreatedResult {
  room_id: string;
  max_size: number;
  owner: string;
}

export interface RoomInfoResult {
  room_id: string;
  peer_count: number;
  max_size: number;
  owner: string;
}

export interface IdentityKeys {
  fingerprint: string;
  alias: string;
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
}

export interface ClientConfig {
  url: string;
  iceServers?: RTCIceServer[];
  alias?: string;
  meta?: Record<string, any>;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  reconnectMaxDelay?: number;
  pingInterval?: number;
  maxReconnectAttempts?: number;
  identityKeys?: IdentityKeys;
}

export interface DataChannelConfig {
  label?: string;
  ordered?: boolean;
  maxRetransmits?: number;
  maxPacketLifeTime?: number;
}

export interface RoomConfig {
  maxSize?: number;
}

export interface MediaConfig {
  audio?: boolean | MediaTrackConstraints;
  video?: boolean | MediaTrackConstraints;
}

export interface FileChunk {
  id: string;
  index: number;
  total: number;
  data: ArrayBuffer;
}

export interface FileMetadata {
  id: string;
  filename: string;
  size: number;
  mime: string;
  totalChunks: number;
  chunkSize: number;
}

export interface TransferOffer {
  _ft: true;
  type: 'offer';
  id: string;
  filename: string;
  size: number;
  mime: string;
  chunkSize: number;
  totalChunks: number;
}

export interface TransferAccept {
  _ft: true;
  type: 'accept';
  id: string;
}

export interface TransferAck {
  _ft: true;
  type: 'ack';
  id: string;
  index: number;
}

export interface TransferComplete {
  _ft: true;
  type: 'complete';
  id: string;
}

export interface TransferCancel {
  _ft: true;
  type: 'cancel';
  id: string;
}

export interface TransferResume {
  _ft: true;
  type: 'resume';
  id: string;
  lastIndex: number;
}

export interface TransferError {
  _ft: true;
  type: 'error';
  id: string;
  message: string;
}

export type TransferControl =
  | TransferOffer
  | TransferAccept
  | TransferAck
  | TransferComplete
  | TransferCancel
  | TransferResume
  | TransferError;

export interface TransferProgress {
  id: string;
  sent: number;
  total: number;
  percentage: number;
  bytesPerSecond?: number;
}

export interface TransferState {
  id: string;
  filename: string;
  size: number;
  mime: string;
  totalChunks: number;
  chunkSize: number;
  lastAckedIndex: number;
}

export type SyncMode = 'lww' | 'operational' | 'crdt';

export interface HLC {
  ts: number;
  counter: number;
  node: string;
}

export interface SyncConfig {
  mode: SyncMode;
  merge?: (local: any, remote: any) => any;
}

export interface SyncState {
  key: string;
  value: any;
  hlc: HLC;
  from: string;
  version: number;
  deleted?: boolean;
}

export type PeerClientEvent =
  | 'connected'
  | 'disconnected'
  | 'registered'
  | 'peer_joined'
  | 'peer_left'
  | 'peer_list'
  | 'matched'
  | 'broadcast'
  | 'relay'
  | 'error'
  | 'reconnecting'
  | 'reconnected'
  | 'room_created'
  | 'room_closed'
  | 'kicked';

export type PeerEvent =
  | 'connected'
  | 'disconnected'
  | 'data'
  | 'stream'
  | 'track'
  | 'datachannel:create'
  | 'datachannel:open'
  | 'datachannel:close'
  | 'error';

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export const DEFAULT_CONFIG: Required<Omit<ClientConfig, 'url' | 'identityKeys'>> = {
  iceServers: DEFAULT_ICE_SERVERS,
  alias: '',
  meta: {},
  autoReconnect: true,
  reconnectDelay: 1000,
  reconnectMaxDelay: 30000,
  pingInterval: 25000,
  maxReconnectAttempts: Infinity,
};

export const LIMITS = {
  MAX_MEDIA_PEERS: 10,
  MAX_DATA_PEERS: 30,
  MAX_GROUP_SIZE: 20,
  RELAY_THRESHOLD: 30,
  CHUNK_SIZE: 65536,
  BUFFERED_AMOUNT_HIGH: 4 * 1024 * 1024,
  BUFFERED_AMOUNT_LOW: 1 * 1024 * 1024,
  ACK_INTERVAL: 100,
  TRANSFER_CHANNEL_PREFIX: 'ft-',
  TOMBSTONE_TTL: 60000,
  PONG_TIMEOUT_MULTIPLIER: 2.5,
  MESSAGE_QUEUE_MAX: 500,
} as const;
