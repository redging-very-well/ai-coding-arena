// WebSocket /ws (plan §10.3). Clients send `{type:'hello', role}`; identity
// comes from the cookies of the upgrade request. Every message carrying game
// data is built per recipient through VisibilityService (§3 privacy).
//
// Pushes: `state` (on change, coalesced, plus 1 Hz timer ticks), `private`
// (own data, coalesced per player), `battle:reveal`, `battle:frames`,
// `battle:end`, `toast`, `kicked`.
//
// Team mode (§9.2): when a member's private data changes, every teammate's
// `private` (with the `team` block) is re-sent too, at most 300 ms later. The
// `state` push leaves `me.team` out (it can carry sprites and goes out at 1 Hz).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ADMIN_COOKIE,
  SESSION_COOKIE,
  type BattleEndDTO,
  type BattleRevealDTO,
  type FrameDTO,
  type PlaybackDTO,
  type ServerWsMessage,
  type ViewerRole,
} from '@pixel-clash/shared';
import type { Game, Notifier, ToastLevel, ToastTarget } from './services/game.js';
import { toPlayerDTO } from './services/players.js';
import type { Viewer } from './services/visibility.js';

/** Skip frame batches for a client whose send buffer is this full. */
const MAX_BUFFERED = 2 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** Teammates' `private` pushes are batched over this window (§9.2 Team privacy). */
const TEAM_PUSH_MS = 300;

interface Client {
  ws: WebSocket;
  /** Undefined until hello. */
  role?: ViewerRole;
  playerId?: string;
  sessionToken?: string;
  adminToken?: string;
  alive: boolean;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export class WsHub implements Notifier {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  private readonly clients = new Set<Client>();
  private statePending = false;
  private readonly privatePending = new Set<string>();
  /** Teammates of changed players, pushed when `teamTimer` fires. */
  private readonly teamPending = new Set<string>();
  private teamTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly game: Game) {}

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      // Cross-site WebSocket hijacking guard: a present Origin must match Host.
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try {
          ok = new URL(origin).host === req.headers.host;
        } catch {
          ok = false;
        }
        if (!ok) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.teamTimer) clearTimeout(this.teamTimer);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const cookies = parseCookies(req.headers.cookie);
    const client: Client = { ws, alive: true };
    if (cookies[SESSION_COOKIE]) client.sessionToken = cookies[SESSION_COOKIE];
    if (cookies[ADMIN_COOKIE]) client.adminToken = cookies[ADMIN_COOKIE];
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data) => this.onMessage(client, data.toString()));
    ws.on('close', () => {
      this.clients.delete(client);
      if (client.playerId) this.stateChanged();
    });
    ws.on('error', () => undefined);
  }

  private onMessage(client: Client, raw: string): void {
    let msg: { type?: unknown; role?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg?.type === 'ping') {
      this.send(client, { type: 'pong' });
      return;
    }
    if (msg?.type !== 'hello') return;
    const wanted = msg.role === 'player' || msg.role === 'admin' || msg.role === 'screen' ? msg.role : 'screen';
    const wasPlayer = client.playerId;
    let role: ViewerRole = 'screen';
    delete client.playerId;
    if (wanted === 'player') {
      const p = this.game.auth.playerForSession(client.sessionToken);
      if (p) {
        role = 'player';
        client.playerId = p.id;
      } else {
        this.send(client, { type: 'toast', level: 'warn', message: 'Please log in again.' });
      }
    } else if (wanted === 'admin') {
      if (this.game.auth.isAdmin(client.adminToken)) role = 'admin';
      else this.send(client, { type: 'toast', level: 'warn', message: 'Admin login needed.' });
    }
    client.role = role;
    const p = client.playerId ? this.game.players.get(client.playerId) : undefined;
    this.send(client, { type: 'hello', role, ...(p ? { player: toPlayerDTO(p) } : {}) });
    this.sendState(client);
    if (client.playerId) this.sendPrivate(client);
    // Late joiners: the running battle (already public after START) or the last result.
    const reveal = this.game.battle.currentReveal();
    if (reveal && this.game.store.match.phase === 'BATTLE') {
      this.send(client, { type: 'battle:reveal', data: reveal });
      const frame = this.game.battle.currentFrame();
      const pb = this.game.battle.playback();
      if (frame && pb) this.send(client, { type: 'battle:frames', frames: [frame], playback: pb });
    }
    if (client.playerId !== wasPlayer) this.stateChanged();
  }

  private viewerOf(c: Client): Viewer {
    if (c.role === 'player' && c.playerId) return { role: 'player', playerId: c.playerId };
    if (c.role === 'admin') return { role: 'admin' };
    return { role: 'screen' };
  }

  private send(c: Client, msg: ServerWsMessage): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(JSON.stringify(msg));
  }

  private sendRaw(c: Client, text: string): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(text);
  }

  private sendState(c: Client): void {
    this.send(c, { type: 'state', state: this.game.visibility.gameState(this.viewerOf(c), { withTeam: false }) });
  }

  private sendPrivate(c: Client): void {
    if (!c.playerId) return;
    const data = this.game.visibility.privateState(c.playerId);
    if (data) this.send(c, { type: 'private', data });
  }

  // -------------------------------------------------------------------------
  // Notifier
  // -------------------------------------------------------------------------

  stateChanged(): void {
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      // Non-player views are identical per role: build each once.
      const cache = new Map<string, string>();
      for (const c of this.clients) {
        if (!c.role) continue;
        const key = c.role === 'player' ? `p:${c.playerId}` : c.role;
        let text = cache.get(key);
        if (text === undefined) {
          const state = this.game.visibility.gameState(this.viewerOf(c), { withTeam: false });
          text = JSON.stringify({ type: 'state', state } satisfies ServerWsMessage);
          cache.set(key, text);
        }
        this.sendRaw(c, text);
      }
    });
  }

  privateChanged(playerId: string): void {
    // Teammates see this player's selection/zone/placement live (§9.2).
    for (const mate of this.game.teams.teammatesOf(playerId)) {
      if (!this.privatePending.has(mate)) this.teamPending.add(mate);
    }
    if (this.teamPending.size > 0 && !this.teamTimer) {
      this.teamTimer = setTimeout(() => {
        this.teamTimer = undefined;
        const ids = [...this.teamPending];
        this.teamPending.clear();
        for (const id of ids) this.pushPrivate(id);
      }, TEAM_PUSH_MS);
      this.teamTimer.unref?.();
    }
    const first = this.privatePending.size === 0;
    this.privatePending.add(playerId);
    if (!first) return;
    setImmediate(() => {
      const ids = [...this.privatePending];
      this.privatePending.clear();
      for (const id of ids) {
        // Sent now with fresh data: a queued teammate push for it is redundant.
        this.teamPending.delete(id);
        this.pushPrivate(id);
      }
    });
  }

  private pushPrivate(playerId: string): void {
    const data = this.game.visibility.privateState(playerId);
    if (!data) return;
    const text = JSON.stringify({ type: 'private', data } satisfies ServerWsMessage);
    for (const c of this.clients) if (c.role === 'player' && c.playerId === playerId) this.sendRaw(c, text);
  }

  toast(target: ToastTarget, level: ToastLevel, message: string): void {
    const text = JSON.stringify({ type: 'toast', level, message } satisfies ServerWsMessage);
    for (const c of this.clients) {
      if (!c.role) continue;
      if ('all' in target || ('admin' in target && c.role === 'admin') || ('playerId' in target && c.playerId === target.playerId)) {
        this.sendRaw(c, text);
      }
    }
  }

  private broadcast(msg: ServerWsMessage, skipBusy = false): void {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (!c.role) continue;
      if (skipBusy && c.ws.bufferedAmount > MAX_BUFFERED) continue;
      this.sendRaw(c, text);
    }
  }

  battleReveal(reveal: BattleRevealDTO): void {
    this.broadcast({ type: 'battle:reveal', data: reveal });
  }

  battleFrames(frames: FrameDTO[], playback: PlaybackDTO): void {
    this.broadcast({ type: 'battle:frames', frames, playback }, true);
  }

  battleEnd(end: BattleEndDTO): void {
    this.broadcast({ type: 'battle:end', data: end });
  }

  playerRevoked(playerId: string): void {
    for (const c of this.clients) {
      if (c.playerId !== playerId) continue;
      this.send(c, { type: 'kicked' });
      delete c.playerId;
      c.role = 'screen';
      c.ws.close(4001, 'session ended');
    }
  }

  isConnected(playerId: string): boolean {
    for (const c of this.clients) if (c.role === 'player' && c.playerId === playerId) return true;
    return false;
  }

  /** Test/diagnostic helper. */
  clientCount(): number {
    return this.clients.size;
  }
}
