import { Emitter } from './emitter';
import type { ServerMessage } from './types';
import { LIMITS } from './types';

type TransportEvent = 'open' | 'close' | 'message' | 'error' | 'reconnecting';

export class Transport extends Emitter<TransportEvent> {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private lastPongTime = 0;
  private messageQueue: Partial<ServerMessage>[] = [];
  private _connected = false;

  constructor(
    private url: string,
    private autoReconnect: boolean,
    private reconnectDelay: number,
    private reconnectMaxDelay: number,
    private maxReconnectAttempts: number,
    private pingInterval: number,
  ) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      let settled = false;

      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }

      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        settled = true;
        this._connected = true;
        this.reconnectAttempts = 0;
        this.lastPongTime = Date.now();
        this.startPing();
        this.flushQueue();
        this.emit('open');
        resolve();
      };

      this.ws.onclose = (ev) => {
        this._connected = false;
        this.cleanup();
        this.emit('close', ev.code, ev.reason);
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed: ${ev.code} ${ev.reason}`));
          return;
        }
        if (!this.intentionalClose && this.autoReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (ev) => {
        this.emit('error', ev);
      };

      this.ws.onmessage = (ev) => {
        try {
          const msg: ServerMessage = JSON.parse(ev.data);
          if (msg.type === 'pong') {
            this.lastPongTime = Date.now();
            return;
          }
          if (msg.type === 'ping') {
            this.sendRaw({ type: 'pong' });
            return;
          }
          this.emit('message', msg);
        } catch {
          this.emit('error', new Error('Failed to parse message'));
        }
      };
    });
  }

  send(msg: Partial<ServerMessage>): void {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else if (this.messageQueue.length < LIMITS.MESSAGE_QUEUE_MAX) {
      this.messageQueue.push(msg);
    }
  }

  private sendRaw(msg: Partial<ServerMessage>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.intentionalClose = true;
    this._connected = false;
    this.cleanup();
    this.messageQueue = [];
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this._connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getQueueSize(): number {
    return this.messageQueue.length;
  }

  clearQueue(): void {
    this.messageQueue = [];
  }

  private flushQueue(): void {
    const queue = this.messageQueue.splice(0);
    for (const msg of queue) {
      this.send(msg);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' });
      this.schedulePongCheck();
    }, this.pingInterval);
  }

  private schedulePongCheck(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    const timeout = this.pingInterval * LIMITS.PONG_TIMEOUT_MULTIPLIER;
    this.pongTimer = setTimeout(() => {
      const elapsed = Date.now() - this.lastPongTime;
      if (elapsed > timeout) {
        this._connected = false;
        if (this.ws) {
          this.ws.close(4000, 'pong timeout');
        }
      }
    }, timeout);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private cleanup(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.reconnectMaxDelay,
    );
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts, delay);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }
}
