// Reconnecting WebSocket to /ws (plan §10.3). Sends `{type:'hello', role}` on
// every (re)connect, pings every 15 s, and dispatches typed ServerWsMessages.
// A liveness watchdog drops a socket that has been silent for 2 pings (a
// half-open TCP connection after laptop sleep or a Wi-Fi drop stays OPEN for
// minutes) and probes at once when the tab becomes visible again.
// The server replays 'state' / 'private' / 'battle:reveal' + current frame on
// hello, so a reconnect needs no extra fetching. After 'kicked' it stops.
//
//   const sock = new GameSocket('screen');
//   const off = sock.on('state', (m) => render(m.state));
//   sock.onStatus((s) => …);  sock.close();

import type { ClientWsMessage, ServerWsMessage, ViewerRole } from '@pixel-clash/shared';

export type WsMessageType = ServerWsMessage['type'];
export type WsMessageOf<T extends WsMessageType> = Extract<ServerWsMessage, { type: T }>;
export type WsStatus = 'connecting' | 'open' | 'closed' | 'kicked';

export interface GameSocketOptions {
  /** Default: same host, ws(s) by page protocol, path /ws. */
  url?: string;
  /** Backoff bounds for reconnects (ms). */
  minDelayMs?: number;
  maxDelayMs?: number;
  pingEveryMs?: number;
}

type Handler<T extends WsMessageType> = (msg: WsMessageOf<T>) => void;

/**
 * Close a socket we no longer want. One still CONNECTING is closed once it
 * opens: closing it mid-handshake makes the browser log "WebSocket is closed
 * before the connection is established" (e.g. the /play socket replaced at login).
 */
function shut(ws: WebSocket | null | undefined): void {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
    else ws.close();
  } catch {
    /* ignore */
  }
}

/** Next reconnect delay: doubling backoff with ±20% jitter, capped. Pure (tested). */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, rand: () => number = Math.random): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + rand() * 0.4));
}

/** Probe timeout after the tab becomes visible with an OPEN socket. */
export const WAKE_PROBE_MS = 3000;

/** True when a socket has heard nothing (not even a pong) for 2 ping periods. Pure (tested). */
export function isStale(lastMessageAt: number, now: number, pingEveryMs: number): boolean {
  return now - lastMessageAt > 2 * pingEveryMs;
}

/** Parse a server message; null for anything that isn't `{type: string}`. */
export function parseServerMessage(raw: unknown): ServerWsMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const m = JSON.parse(raw) as unknown;
    return typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string' ? (m as ServerWsMessage) : null;
  } catch {
    return null;
  }
}

export class GameSocket {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<WsMessageType, Set<(msg: ServerWsMessage) => void>>();
  private readonly anyHandlers = new Set<(msg: ServerWsMessage) => void>();
  private readonly statusHandlers = new Set<(s: WsStatus) => void>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall time of the last message from the server (pongs included). */
  private lastMessageAt = 0;
  private closed = false;
  private _status: WsStatus = 'connecting';
  private readonly opts: Required<GameSocketOptions>;

  constructor(
    private role: ViewerRole,
    opts: GameSocketOptions = {},
  ) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.opts = {
      url: opts.url ?? `${proto}//${location.host}/ws`,
      minDelayMs: opts.minDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 5000,
      pingEveryMs: opts.pingEveryMs ?? 15000,
    };
    this.connect();
    // Reconnect at once when the tab wakes up or the network comes back.
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.kick);
  }

  get status(): WsStatus {
    return this._status;
  }

  /** Subscribe to one message type. Returns an unsubscribe function. */
  on<T extends WsMessageType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    const h = handler as (msg: ServerWsMessage) => void;
    set.add(h);
    return () => set.delete(h);
  }

  /** Subscribe to every message. */
  onAny(handler: (msg: ServerWsMessage) => void): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /** Connection status changes (called at once with the current status). */
  onStatus(handler: (s: WsStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this._status);
    return () => this.statusHandlers.delete(handler);
  }

  /** Change role (e.g. after logging in) and say hello again. */
  setRole(role: ViewerRole): void {
    this.role = role;
    this.send({ type: 'hello', role });
  }

  /** Reconnect now (e.g. after login, so the new cookie is used for identity). */
  reconnect(): void {
    if (this.closed) return;
    this.attempt = 0;
    shut(this.ws);
    this.ws = null;
    this.clearTimers();
    this.connect();
  }

  send(msg: ClientWsMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.kick);
    shut(this.ws);
    this.ws = null;
    if (this._status !== 'kicked') this.setStatus('closed');
  }

  private readonly kick = (): void => {
    if (this.closed || document.visibilityState === 'hidden') return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.attempt = 0;
      this.clearTimers();
      this.connect();
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN && !this.probeTimer) {
      // Woke up (or back online) with an "open" socket: it may be half-open.
      // Ping now and reconnect unless anything arrives within a few seconds.
      const ws = this.ws;
      const sentAt = Date.now();
      this.send({ type: 'ping' });
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        if (this.ws === ws && this.lastMessageAt < sentAt) this.dropDead();
      }, WAKE_PROBE_MS);
    }
  };

  /** The socket looks dead without having closed: drop it and reconnect. */
  private dropDead(): void {
    const ws = this.ws;
    this.ws = null;
    this.clearTimers();
    shut(ws);
    if (this.closed) return;
    this.attempt = 0;
    this.scheduleReconnect();
  }

  private setStatus(s: WsStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.probeTimer = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.setStatus('open');
      this.send({ type: 'hello', role: this.role });
      this.pingTimer = setInterval(() => {
        if (isStale(this.lastMessageAt, Date.now(), this.opts.pingEveryMs)) this.dropDead();
        else this.send({ type: 'ping' });
      }, this.opts.pingEveryMs);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      const msg = parseServerMessage(ev.data);
      if (!msg) return;
      if (msg.type === 'kicked') {
        this.dispatch(msg);
        this.setStatus('kicked');
        this.close();
        return;
      }
      this.dispatch(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do.
    };
  }

  private scheduleReconnect(): void {
    this.setStatus('closed');
    const delay = backoffDelay(this.attempt++, this.opts.minDelayMs, this.opts.maxDelayMs);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private dispatch(msg: ServerWsMessage): void {
    for (const h of this.handlers.get(msg.type) ?? []) {
      try {
        h(msg);
      } catch (err) {
        console.error(`[ws] handler for ${msg.type} failed`, err);
      }
    }
    for (const h of this.anyHandlers) h(msg);
  }
}
