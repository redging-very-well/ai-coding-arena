// Seat terminal proxy (plan §11.2): the game server reverse-proxies each
// Claude seat's ttyd at the same-origin path /terminal/<N>/ (ttyd runs with
// `-b /terminal/<N>`), so /play can embed it in an iframe and the terminal
// also works as its own browser tab, with the player's session cookie and no
// seat password.
//
//   /terminal/<N>          → 301 /terminal/<N>/
//   /terminal/<N>/         → http://<box>:778N/terminal/<N>/ (GET/HEAD only; also index.html)
//   /terminal/<N>/token    → answered here (ttyd's answer is base64 user:password)
//   anything else          → 404 here, never forwarded: libwebsockets percent-decodes
//                            and collapses `//`, `/./`, `/../` before ttyd matches its
//                            routes, so `/%74oken` or `//token` would reach ttyd's /token
//   /terminal/<N>/ws       → WebSocket relay (relay.ts), one live terminal per seat
//
// Access (every request): the player whose `claudeSeat` is N (session cookie
// `pc_session`), or the admin (`pc_admin`, any seat, for rescue). The proxy
// drops the browser's cookies and Authorization, injects the seat's basic
// auth, and rewrites Host/Origin for ttyd's -O check (upstream.ts).
//
// Only Node's `http` and the existing `ws` package; no proxy dependency.

import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ADMIN_COOKIE, SESSION_COOKIE } from '@pixel-clash/shared';
import type { LiveTerminal, ProbeStatus, TerminalControl } from '../services/claudeSeats.js';
import { parseClaudeSeat } from '../services/claudeSeats.js';
import type { Game } from '../services/game.js';
import type { PlayerRecord } from '../services/store.js';
import { log } from '../util/log.js';
import { parseCookies } from '../ws.js';
import { sendProxyError, upgradeErrorResponse, type ProxyErrorCode, type ProxyErrorContext } from './pages.js';
import { SeatProbe } from './probe.js';
import { TerminalRegistry } from './registry.js';
import { MAX_BUFFERED, Relay, type RelayInfo } from './relay.js';
import {
  DEFAULT_TIMEOUTS,
  PLACEHOLDER_TOKEN,
  SECURITY_HEADERS,
  basicCredential,
  defaultResolveUpstream,
  errorReason,
  filterResponseHeaders,
  forwardRequestHeaders,
  type ResolveUpstream,
  type TerminalTimeouts,
  type Upstream,
} from './upstream.js';

export interface TerminalProxyOptions {
  /** Where seat N's ttyd is (tests: a fake ttyd). Default `<claudeBoxHost>:778N`. */
  resolveUpstream?: ResolveUpstream;
  timeouts?: Partial<TerminalTimeouts>;
}

/** The /play iframe's pane id (`?pane=`). */
const PANE_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Paths under /terminal/<N> forwarded to ttyd (its page is one self-contained index.html). */
const FORWARDED_PATHS = new Set(['/', '/index.html']);

const PLAYER_REVOKED_TEXT = "\r\n\r\n  This Claude terminal isn't yours any more.\r\n  Go back to the game page (or ask a grown-up).\r\n";
/** Logout or PIN reset: the seat is still theirs (§11.2 c), only the login ended. */
const PLAYER_LOGGED_OUT_TEXT = '\r\n\r\n  You were logged out.\r\n  Log in again on the game page (/play), then press Enter.\r\n';
const ADMIN_REVOKED_TEXT = '\r\n\r\n  Your admin login ended. Log in on /admin again.\r\n';

type Access =
  | { ok: true; by: 'player'; player: PlayerRecord; sessionToken: string; adminToken?: string }
  | { ok: true; by: 'admin'; adminToken: string; sessionToken?: string }
  | { ok: false; code: 'TERMINAL_LOGIN_REQUIRED' | 'CLAUDE_SEAT_NOT_YOURS'; player?: PlayerRecord; mySeat?: number | null };

/** `/terminal…` request target → seat and the rest of the path, or an error. */
type Target =
  | { kind: 'redirect'; location: string }
  | { kind: 'seat'; seat: number; rest: string; path: string; search: string }
  | { kind: 'bad' };

export function parseTarget(rawUrl: string | undefined): Target {
  let url: URL;
  try {
    // WHATWG parsing also resolves `..` (plain and %2e), so the seat checked is the seat forwarded to.
    url = new URL(rawUrl ?? '/', 'http://proxy.invalid');
  } catch {
    return { kind: 'bad' };
  }
  const m = /^\/terminal\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const seat = m ? parseClaudeSeat(m[1]) : null;
  if (!m || seat === null || m[1] !== String(seat)) return { kind: 'bad' };
  if (m[2] === undefined) return { kind: 'redirect', location: `/terminal/${seat}/${url.search}` };
  return { kind: 'seat', seat, rest: m[2], path: url.pathname, search: url.search };
}

export class TerminalProxy implements TerminalControl {
  readonly registry: TerminalRegistry;
  readonly probe: SeatProbe;
  private readonly resolve: ResolveUpstream;
  private readonly timeouts: TerminalTimeouts;
  private readonly wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_BUFFERED,
    handleProtocols: (protocols) => (protocols.has('tty') ? 'tty' : false),
  });
  /** Refused-access log lines: at most one a minute per who+seat. */
  private readonly refusedLogged = new Map<string, number>();
  private recheckPending = false;
  private stopped = false;

  constructor(
    private readonly game: Game,
    opts: TerminalProxyOptions = {},
  ) {
    this.resolve = opts.resolveUpstream ?? defaultResolveUpstream;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.registry = new TerminalRegistry(game, this.timeouts.pingMs);
    this.probe = new SeatProbe(game, this.resolve, this.timeouts, (seat) => !!this.registry.get(seat));
  }

  start(): void {
    this.registry.start();
    this.probe.start();
  }

  stop(): void {
    this.stopped = true;
    this.probe.stop();
    this.registry.stop();
    this.wss.close();
  }

  /** Requests the proxy answers (mounted before the Express app). */
  handles(rawUrl: string | undefined): boolean {
    const u = rawUrl ?? '';
    return u === '/terminal' || u.startsWith('/terminal/') || u.startsWith('/terminal?');
  }

  // -------------------------------------------------------------------------
  // TerminalControl
  // -------------------------------------------------------------------------

  live(seat: number): LiveTerminal | null {
    return this.registry.liveOf(seat);
  }

  probeStatus(seat: number): ProbeStatus {
    return this.probe.get(seat);
  }

  probeAll(): Promise<void> {
    return this.probe.probeAll();
  }

  /** Close live terminals that lost access (kick, unassign, reassign, seat change, logout, PIN reset). */
  recheck(): void {
    if (this.recheckPending) return;
    this.recheckPending = true;
    setImmediate(() => {
      this.recheckPending = false;
      for (const relay of this.registry.relays()) {
        const i = relay.info;
        const still =
          i.by === 'admin'
            ? this.game.auth.isAdmin(i.adminToken)
            : (() => {
                const p = this.game.auth.playerForSession(i.sessionToken);
                return !!p && p.id === i.playerId && this.game.claudeSeats.seatOf(p) === i.seat;
              })();
        if (still) continue;
        log.info(`[terminal] ${relay.label}: access ended, closing`);
        const loggedOut = i.by === 'player' && !this.game.auth.playerForSession(i.sessionToken) && this.game.claudeSeats.holder(i.seat)?.id === i.playerId;
        relay.end(1000, 'access-revoked', i.by === 'admin' ? ADMIN_REVOKED_TEXT : loggedOut ? PLAYER_LOGGED_OUT_TEXT : PLAYER_REVOKED_TEXT);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  private access(seat: number, cookieHeader: string | undefined): Access {
    const cookies = parseCookies(cookieHeader);
    const sessionToken = cookies[SESSION_COOKIE];
    const adminToken = cookies[ADMIN_COOKIE];
    const player = this.game.auth.playerForSession(sessionToken);
    const isAdmin = this.game.auth.isAdmin(adminToken);
    if (player && sessionToken && this.game.claudeSeats.seatOf(player) === seat) {
      return { ok: true, by: 'player', player, sessionToken, ...(isAdmin && adminToken ? { adminToken } : {}) };
    }
    if (isAdmin && adminToken) return { ok: true, by: 'admin', adminToken, ...(sessionToken ? { sessionToken } : {}) };
    if (player) return { ok: false, code: 'CLAUDE_SEAT_NOT_YOURS', player, mySeat: this.game.claudeSeats.seatOf(player) };
    return { ok: false, code: 'TERMINAL_LOGIN_REQUIRED' };
  }

  private logRefused(seat: number, a: Extract<Access, { ok: false }>, ip: string | undefined): void {
    const who = a.player ? `player "${a.player.name}"` : `anonymous ${ip ?? '?'}`;
    const key = `${a.player?.id ?? ip ?? '?'}:${seat}`;
    const now = Date.now();
    if (now - (this.refusedLogged.get(key) ?? 0) < 60_000) return;
    this.refusedLogged.set(key, now);
    if (this.refusedLogged.size > 1000) this.refusedLogged.clear();
    log.info(`[terminal] seat ${seat} refused ${who}: ${a.code}${a.player ? ` (their seat: ${a.mySeat ?? 'none'})` : ''}`);
  }

  private config(seat: number): { upstream: Upstream; secret: string } | null {
    const { claudeBoxHost, seatSecret } = this.game.store.setup;
    if (!claudeBoxHost || !seatSecret) return null;
    return { upstream: this.resolve(seat, claudeBoxHost), secret: seatSecret };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const fail = (code: ProxyErrorCode, ctx: ProxyErrorContext) => sendProxyError(res, req.method, req.headers.accept, code, ctx);
    const target = parseTarget(req.url);
    if (target.kind === 'bad') return fail('BAD_CLAUDE_SEAT', { seat: null });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail('BAD_REQUEST', { seat: target.kind === 'seat' ? target.seat : null });
    }
    if (target.kind === 'redirect') {
      res.writeHead(301, { location: target.location, 'cache-control': 'no-store', 'content-length': 0 });
      res.end();
      return;
    }
    const { seat } = target;
    const a = this.access(seat, req.headers.cookie);
    if (!a.ok) {
      this.logRefused(seat, a, req.socket.remoteAddress);
      return fail(a.code, { seat, ...(a.code === 'CLAUDE_SEAT_NOT_YOURS' ? { mySeat: a.mySeat ?? null } : {}) });
    }
    const cfg = this.config(seat);
    if (!cfg) return fail('CLAUDE_BOX_NOT_SET', { seat });

    if (target.rest === '/token') {
      // Never forwarded: ttyd's real token is base64("player:<secret>").
      const text = JSON.stringify({ token: PLACEHOLDER_TOKEN });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json;charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : text);
      return;
    }
    if (!FORWARDED_PATHS.has(target.rest)) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'cache-control': 'no-store', 'content-length': 0 });
      res.end();
      return;
    }

    const headers = forwardRequestHeaders(req.headers, {
      upstream: cfg.upstream,
      secret: cfg.secret,
      clientIp: req.socket.remoteAddress,
      originalHost: req.headers.host,
    });
    const up = request({
      host: cfg.upstream.host,
      port: cfg.upstream.port,
      method: req.method,
      path: target.path + target.search,
      headers,
      agent: false,
    });
    let done = false;
    const boxDown = (reason: string) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      up.destroy();
      this.probe.observe(seat, 'down', reason);
      fail('CLAUDE_BOX_DOWN', { seat });
    };
    // 3 s to connect, then 15 s for the response head.
    const connectTimer = setTimeout(() => boxDown('connect timeout'), this.timeouts.connectMs);
    let responseTimer: NodeJS.Timeout | undefined;
    up.on('socket', (s: Socket) => {
      const connected = () => {
        clearTimeout(connectTimer);
        responseTimer = setTimeout(() => boxDown('response timeout'), this.timeouts.responseMs);
      };
      if (s.connecting) s.once('connect', connected);
      else connected();
    });
    up.on('error', (err) => {
      if (!done) boxDown(errorReason(err));
      else if (!res.writableEnded) res.destroy();
    });
    up.on('response', (upRes) => {
      if (done) {
        upRes.resume();
        return;
      }
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      if (upRes.statusCode === 401) {
        upRes.resume();
        this.probe.observe(seat, 'wrong-password');
        return fail('SEAT_PASSWORD_WRONG', { seat });
      }
      this.probe.observe(seat, 'up');
      res.writeHead(upRes.statusCode ?? 502, filterResponseHeaders(upRes.headers));
      if (req.method === 'HEAD') {
        // ttyd 1.7.7 sends the body after a HEAD answer too, which Node's parser
        // rejects (HPE_INVALID_CONSTANT): the headers are all a HEAD needs.
        res.end();
        up.destroy();
        return;
      }
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    // The browser went away: stop the upstream request.
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    up.end();
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    const reject = (code: ProxyErrorCode, ctx: ProxyErrorContext) => {
      if (socket.writable) socket.write(upgradeErrorResponse(code, ctx));
      socket.destroy();
    };
    if (this.stopped) return reject('CLAUDE_BOX_DOWN', { seat: null });
    const target = parseTarget(req.url);
    if (target.kind !== 'seat' || target.rest !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const { seat } = target;
    const a = this.access(seat, req.headers.cookie);
    if (!a.ok) {
      this.logRefused(seat, a, req.socket.remoteAddress);
      return reject(a.code, { seat, ...(a.code === 'CLAUDE_SEAT_NOT_YOURS' ? { mySeat: a.mySeat ?? null } : {}) });
    }
    // Cross-site WebSocket hijacking guard: Origin must be this server's own origin.
    const origin = req.headers.origin;
    if (!origin || !req.headers.host || origin !== `http://${req.headers.host}`) return reject('TERMINAL_BAD_ORIGIN', { seat });
    const cfg = this.config(seat);
    if (!cfg) return reject('CLAUDE_BOX_NOT_SET', { seat });
    if (this.registry.busy(seat)) return reject('TERMINAL_BUSY', { seat });

    const paneParam = new URLSearchParams(target.search).get('pane');
    const pane = paneParam && PANE_RE.test(paneParam) ? paneParam : null;
    const { upstream: addr, secret } = cfg;
    // The query (pane id) stays here: nothing in it is for ttyd.
    const upstream = new WebSocket(`ws://${addr.host}:${addr.port}/terminal/${seat}/ws`, 'tty', {
      headers: forwardRequestHeaders(req.headers, {
        upstream: addr,
        secret,
        clientIp: req.socket.remoteAddress,
        originalHost: req.headers.host,
        ws: true,
      }) as Record<string, string>,
      handshakeTimeout: this.timeouts.handshakeMs,
      perMessageDeflate: false,
      maxPayload: MAX_BUFFERED,
      followRedirects: false,
    });
    upstream.on('error', () => undefined);
    let settled = false;
    const browserGone = () => {
      if (settled) return;
      settled = true;
      upstream.terminate();
    };
    socket.once('close', browserGone);
    upstream.once('unexpected-response', (upReq, upRes) => {
      upRes.resume();
      upReq.destroy();
      if (settled) return;
      settled = true;
      socket.off('close', browserGone);
      if (upRes.statusCode === 401) {
        this.probe.observe(seat, 'wrong-password');
        return reject('SEAT_PASSWORD_WRONG', { seat });
      }
      log.warn(`[terminal] seat ${seat}: ttyd refused the WebSocket with HTTP ${upRes.statusCode}`);
      reject('CLAUDE_BOX_DOWN', { seat });
    });
    upstream.once('error', (err) => {
      if (settled) return;
      settled = true;
      socket.off('close', browserGone);
      this.probe.observe(seat, 'down', errorReason(err));
      reject('CLAUDE_BOX_DOWN', { seat });
    });
    upstream.once('open', () => {
      if (settled) return;
      settled = true;
      socket.off('close', browserGone);
      // Access may have changed while ttyd answered.
      const again = this.access(seat, req.headers.cookie);
      if (!again.ok || this.stopped) {
        upstream.close(1000, 'access changed');
        return reject(again.ok ? 'CLAUDE_BOX_DOWN' : again.code, { seat });
      }
      this.probe.observe(seat, 'up');
      this.wss.handleUpgrade(req, socket, head, (browser) => {
        const info: RelayInfo = {
          seat,
          pane,
          by: again.by,
          clientIp: (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, ''),
          ...(again.sessionToken ? { sessionToken: again.sessionToken } : {}),
          ...(again.adminToken ? { adminToken: again.adminToken } : {}),
          ...(again.by === 'player' ? { playerId: again.player.id, playerName: again.player.name } : {}),
        };
        const relay = new Relay(info, browser, upstream, basicCredential(secret), (r, why) => this.registry.finished(r, why));
        relay.start();
        this.registry.register(relay);
      });
    });
  }
}
