import { WebSocketServer, WebSocket as WS } from 'ws';
import wrtc from 'wrtc';

if (typeof RTCPeerConnection === 'undefined') {
    (globalThis as any).RTCPeerConnection = wrtc.RTCPeerConnection;
    (globalThis as any).RTCSessionDescription = wrtc.RTCSessionDescription;
    (globalThis as any).RTCIceCandidate = wrtc.RTCIceCandidate;
}

export const REAL_SERVER = 'wss://peer.fewclicks.org/ws';
export function nextPort(): number { return 0; }

export interface MockPeer {
    fingerprint: string;
    alias: string;
    ws: WS;
    publicKey?: string;
}

export class MockSignalServer {
    private wss: WebSocketServer | null = null;
    private peers = new Map<string, MockPeer>();
    private namespaces = new Map<string, Set<string>>();
    private rooms = new Map<string, { owner: string; maxSize: number; members: Set<string> }>();
    port: number;
    url: string;

    constructor() {
        this.port = 0;
        this.url = '';
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocketServer({ port: 0 }, () => {
                this.port = (this.wss!.address() as any).port;
                this.url = `ws://127.0.0.1:${this.port}`;
                resolve();
            });
            this.wss.on('error', reject);
            this.wss.on('connection', (ws) => this.handleConnection(ws as unknown as WS));
        });
    }

    private handleConnection(ws: WS): void {
        let peerFp = '';

        ws.on('message', (raw: Buffer) => {
            let msg: any;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            if (msg.type === 'pong') return;

            switch (msg.type) {
                case 'register': {
                    const pub = msg.payload?.public_key ?? '';
                    peerFp = 'fp_' + Math.random().toString(36).slice(2, 10);
                    const alias = msg.payload?.alias ?? '';
                    this.peers.set(peerFp, { fingerprint: peerFp, alias, ws, publicKey: pub });
                    ws.send(JSON.stringify({
                        type: 'registered',
                        payload: { fingerprint: peerFp, alias },
                    }));
                    break;
                }

                case 'join': {
                    const ns = msg.payload?.namespace;
                    if (!ns) break;
                    if (!this.namespaces.has(ns)) this.namespaces.set(ns, new Set());
                    const members = this.namespaces.get(ns)!;

                    members.forEach((fp) => {
                        const p = this.peers.get(fp);
                        if (p && p.ws.readyState === WS.OPEN) {
                            p.ws.send(JSON.stringify({
                                type: 'peer_joined',
                                namespace: ns,
                                payload: { fingerprint: peerFp, alias: this.peers.get(peerFp)?.alias ?? '' },
                            }));
                        }
                    });

                    members.add(peerFp);
                    const peerList = Array.from(members).map((fp) => ({
                        fingerprint: fp,
                        alias: this.peers.get(fp)?.alias ?? '',
                    }));
                    ws.send(JSON.stringify({
                        type: 'peer_list',
                        namespace: ns,
                        payload: { namespace: ns, peers: peerList },
                    }));
                    break;
                }

                case 'leave': {
                    const ns = msg.payload?.namespace;
                    if (!ns) break;
                    const members = this.namespaces.get(ns);
                    if (members) {
                        members.delete(peerFp);
                        members.forEach((fp) => {
                            const p = this.peers.get(fp);
                            if (p && p.ws.readyState === WS.OPEN) {
                                p.ws.send(JSON.stringify({
                                    type: 'peer_left',
                                    namespace: ns,
                                    from: peerFp,
                                }));
                            }
                        });
                    }
                    break;
                }

                case 'discover': {
                    const ns = msg.payload?.namespace;
                    const limit = msg.payload?.limit ?? 20;
                    const members = this.namespaces.get(ns);
                    const peerList = members
                        ? Array.from(members).slice(0, limit).map((fp) => ({
                            fingerprint: fp,
                            alias: this.peers.get(fp)?.alias ?? '',
                        }))
                        : [];
                    ws.send(JSON.stringify({
                        type: 'peer_list',
                        namespace: ns,
                        payload: { namespace: ns, peers: peerList },
                    }));
                    break;
                }

                case 'signal': {
                    const to = msg.to;
                    const target = this.peers.get(to);
                    if (target && target.ws.readyState === WS.OPEN) {
                        target.ws.send(JSON.stringify({
                            type: 'signal',
                            from: peerFp,
                            payload: msg.payload,
                        }));
                    }
                    break;
                }

                case 'relay': {
                    const to = msg.to;
                    const target = this.peers.get(to);
                    if (target && target.ws.readyState === WS.OPEN) {
                        target.ws.send(JSON.stringify({
                            type: 'relay',
                            from: peerFp,
                            payload: msg.payload,
                        }));
                    }
                    break;
                }

                case 'broadcast': {
                    const ns = msg.payload?.namespace;
                    const data = msg.payload?.data;
                    const members = this.namespaces.get(ns);
                    if (members) {
                        members.forEach((fp) => {
                            if (fp === peerFp) return;
                            const p = this.peers.get(fp);
                            if (p && p.ws.readyState === WS.OPEN) {
                                p.ws.send(JSON.stringify({
                                    type: 'broadcast',
                                    from: peerFp,
                                    namespace: ns,
                                    payload: { namespace: ns, data },
                                }));
                            }
                        });
                    }
                    break;
                }

                case 'create_room': {
                    const roomId = msg.payload?.room_id;
                    const maxSize = msg.payload?.max_size ?? 20;
                    if (this.rooms.has(roomId)) {
                        ws.send(JSON.stringify({ type: 'error', payload: 'Room already exists' }));
                        break;
                    }
                    this.rooms.set(roomId, { owner: peerFp, maxSize, members: new Set() });
                    if (!this.namespaces.has(roomId)) this.namespaces.set(roomId, new Set());
                    this.namespaces.get(roomId)!.add(peerFp);
                    this.rooms.get(roomId)!.members.add(peerFp);
                    ws.send(JSON.stringify({
                        type: 'room_created',
                        payload: { room_id: roomId, max_size: maxSize, owner: peerFp },
                    }));
                    break;
                }

                case 'join_room': {
                    const roomId = msg.payload?.room_id;
                    const room = this.rooms.get(roomId);
                    if (!room) {
                        ws.send(JSON.stringify({ type: 'error', payload: 'Room not found' }));
                        break;
                    }
                    if (room.members.size >= room.maxSize) {
                        ws.send(JSON.stringify({ type: 'error', payload: 'Room full' }));
                        break;
                    }

                    if (!this.namespaces.has(roomId)) this.namespaces.set(roomId, new Set());
                    const nsMembers = this.namespaces.get(roomId)!;

                    nsMembers.forEach((fp) => {
                        const p = this.peers.get(fp);
                        if (p && p.ws.readyState === WS.OPEN) {
                            p.ws.send(JSON.stringify({
                                type: 'peer_joined',
                                namespace: roomId,
                                payload: { fingerprint: peerFp, alias: this.peers.get(peerFp)?.alias ?? '' },
                            }));
                        }
                    });

                    nsMembers.add(peerFp);
                    room.members.add(peerFp);

                    const peerList = Array.from(nsMembers).map((fp) => ({
                        fingerprint: fp,
                        alias: this.peers.get(fp)?.alias ?? '',
                    }));
                    ws.send(JSON.stringify({
                        type: 'peer_list',
                        namespace: roomId,
                        payload: { namespace: roomId, peers: peerList },
                    }));
                    break;
                }

                case 'room_info': {
                    const roomId = msg.payload?.room_id;
                    const room = this.rooms.get(roomId);
                    if (!room) {
                        ws.send(JSON.stringify({ type: 'error', payload: 'Room not found' }));
                        break;
                    }
                    ws.send(JSON.stringify({
                        type: 'room_info',
                        payload: {
                            room_id: roomId,
                            peer_count: room.members.size,
                            max_size: room.maxSize,
                            owner: room.owner,
                        },
                    }));
                    break;
                }

                case 'kick': {
                    const roomId = msg.payload?.room_id;
                    const targetFp = msg.payload?.fingerprint;
                    const room = this.rooms.get(roomId);
                    if (!room || room.owner !== peerFp) break;
                    room.members.delete(targetFp);
                    this.namespaces.get(roomId)?.delete(targetFp);
                    const target = this.peers.get(targetFp);
                    if (target && target.ws.readyState === WS.OPEN) {
                        target.ws.send(JSON.stringify({
                            type: 'kick',
                            payload: { room_id: roomId },
                        }));
                    }
                    break;
                }

                case 'match': {
                    const ns = msg.payload?.namespace;
                    const groupSize = msg.payload?.group_size ?? 2;
                    const waiting = this.namespaces.get(`_match_${ns}`) ?? new Set();
                    waiting.add(peerFp);
                    this.namespaces.set(`_match_${ns}`, waiting);
                    if (waiting.size >= groupSize) {
                        const matched = Array.from(waiting).slice(0, groupSize);
                        const sessionId = 'sess_' + Math.random().toString(36).slice(2);
                        const result = {
                            namespace: ns,
                            session_id: sessionId,
                            peers: matched.map((fp) => ({
                                fingerprint: fp,
                                alias: this.peers.get(fp)?.alias ?? '',
                            })),
                        };
                        for (const fp of matched) {
                            waiting.delete(fp);
                            const p = this.peers.get(fp);
                            if (p && p.ws.readyState === WS.OPEN) {
                                p.ws.send(JSON.stringify({ type: 'matched', payload: result }));
                            }
                        }
                    }
                    break;
                }

                case 'metadata': {
                    break;
                }
            }
        });

        ws.on('close', () => {
            if (peerFp) {
                this.namespaces.forEach((members, ns) => {
                    if (members.has(peerFp)) {
                        members.delete(peerFp);
                        members.forEach((fp) => {
                            const p = this.peers.get(fp);
                            if (p && p.ws.readyState === WS.OPEN) {
                                p.ws.send(JSON.stringify({
                                    type: 'peer_left',
                                    namespace: ns,
                                    from: peerFp,
                                }));
                            }
                        });
                    }
                });
                this.peers.delete(peerFp);
            }
        });
    }

    getPeerCount(): number {
        return this.peers.size;
    }

    getNamespaceMembers(ns: string): string[] {
        return Array.from(this.namespaces.get(ns) ?? []);
    }

    async stop(): Promise<void> {
        if (this.wss) {
            for (const client of this.wss.clients) {
                client.close(1000, 'server shutdown');
            }
            await new Promise(r => setTimeout(r, 100));
            for (const client of this.wss.clients) {
                client.terminate();
            }
        }
        this.peers.clear();
        this.namespaces.clear();
        this.rooms.clear();
        return new Promise((resolve) => {
            if (this.wss) {
                this.wss.close(() => resolve());
            } else {
                resolve();
            }
        });
    }
}

export function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export function waitForEvent(emitter: any, event: string, timeout = 10000): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            off();
            reject(new Error(`Timeout waiting for "${event}"`));
        }, timeout);
        const off = emitter.on(event, (...args: any[]) => {
            clearTimeout(timer);
            off();
            resolve(args);
        });
    });
}