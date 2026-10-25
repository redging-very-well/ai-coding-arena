// Seat terminal proxy (plan §11.2 b): where a Claude seat's ttyd lives, the
// injected basic auth, and the request/response header rules shared by the
// HTTP proxy, the WebSocket relay and the seat probe.

import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { CLAUDE_SEAT_BASE_PORT } from '../services/claudeSeats.js';

export interface Upstream {
  host: string;
  port: number;
}

/** Address of seat N's ttyd. Tests inject a fake ttyd here. */
export type ResolveUpstream = (seat: number, boxHost: string) => Upstream;

export const defaultResolveUpstream: ResolveUpstream = (seat, boxHost) => ({ host: boxHost, port: CLAUDE_SEAT_BASE_PORT + seat });

/** ttyd's basic-auth user (`-c player:$TTYD_PASS`, §11.1). */
export const TTYD_USER = 'player';

/** What the proxy answers on `/terminal/N/token` instead of ttyd's base64 `user:password`. */
export const PLACEHOLDER_TOKEN = 'pixel-clash';

/**
 * Which player a seat's terminal serves (plan §11.2 e): 32 hex digits, a hash
 * of the seat and the player's id. The proxy appends `?arg=<token>` to the
 * ttyd WebSocket only for the seat's assigned player; ttyd (`-a`) passes it to
 * the seat's agent-loop, which starts a fresh conversation with the first
 * prompt when the token differs from the last one it saw. Deterministic, so a
 * reload or the same player coming back resumes their conversation.
 */
export function seatPlayerToken(seat: number, playerId: string): string {
  return createHash('sha256').update(`pixel-clash seat player\n${seat}\n${playerId}`).digest('hex').slice(0, 32);
}

/** ttyd's WebSocket path for seat N, with the player token for the seat's player only. */
export function upstreamWsPath(seat: number, playerId: string | null): string {
  const base = `/terminal/${seat}/ws`;
  return playerId === null ? base : `${base}?arg=${seatPlayerToken(seat, playerId)}`;
}

export interface TerminalTimeouts {
  /** TCP connect to the Claude box. */
  connectMs: number;
  /** First response byte of an HTTP request. */
  responseMs: number;
  /** WebSocket handshake with ttyd. */
  handshakeMs: number;
  /** Seat probe request (connect + response). */
  probeMs: number;
  /** Ping the browser this often; drop it after two missed pongs. */
  pingMs: number;
  /** Probe tick (seats in use are probed every tick, the rest every `probeIdleMs`). */
  probeTickMs: number;
  probeIdleMs: number;
}

export const DEFAULT_TIMEOUTS: TerminalTimeouts = {
  connectMs: 3000,
  responseMs: 15_000,
  handshakeMs: 5000,
  probeMs: 3000,
  pingMs: 30_000,
  probeTickMs: 10_000,
  probeIdleMs: 60_000,
};

/** `base64("player:" + secret)`: the Basic credential and ttyd's WS `AuthToken`. */
export function basicCredential(secret: string): string {
  return Buffer.from(`${TTYD_USER}:${secret}`).toString('base64');
}

/** `<host>:<port>` as ttyd sees it in Host (and, rewritten, in Origin). */
export function hostHeader(u: Upstream): string {
  return `${u.host.includes(':') ? `[${u.host}]` : u.host}:${u.port}`;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Hop-by-hop headers: the fixed set plus every header `Connection` names. */
function hopByHop(headers: IncomingHttpHeaders): Set<string> {
  const out = new Set(HOP_BY_HOP);
  const conn = headers.connection;
  for (const v of Array.isArray(conn) ? conn : conn ? [conn] : []) {
    for (const name of v.split(',')) if (name.trim()) out.add(name.trim().toLowerCase());
  }
  return out;
}

/** Request headers dropped on the way to ttyd, besides hop-by-hop ones. */
const DROP_REQUEST = new Set(['host', 'cookie', 'authorization', 'origin', 'referer']);

export interface ForwardOptions {
  upstream: Upstream;
  secret: string;
  /** The browser's address. */
  clientIp: string | undefined;
  /** The Host the browser used (the game server). */
  originalHost: string | undefined;
  /** WebSocket: the `ws` client sets its own upgrade headers; Origin is rewritten for ttyd's -O check. */
  ws?: boolean;
}

/**
 * Headers for the request to ttyd: no hop-by-hop headers, no cookies, no
 * client Authorization/Origin/Referer/X-Forwarded-*; the seat's Basic auth,
 * `Host: <box>:<port>` (and on WS `Origin: http://<box>:<port>`, so ttyd's
 * same-origin check passes), and informational X-Forwarded-*.
 */
export function forwardRequestHeaders(incoming: IncomingHttpHeaders, opts: ForwardOptions): OutgoingHttpHeaders {
  const drop = hopByHop(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    const name = k.toLowerCase();
    if (v === undefined || drop.has(name) || DROP_REQUEST.has(name) || name.startsWith('x-forwarded-') || name === 'forwarded') continue;
    if (opts.ws && name.startsWith('sec-websocket-')) continue;
    out[name] = v;
  }
  const host = hostHeader(opts.upstream);
  out.host = host;
  out.authorization = `Basic ${basicCredential(opts.secret)}`;
  if (opts.ws) out.origin = `http://${host}`;
  if (opts.clientIp) out['x-forwarded-for'] = opts.clientIp.replace(/^::ffff:/, '');
  out['x-forwarded-proto'] = 'http';
  if (opts.originalHost) out['x-forwarded-host'] = opts.originalHost;
  return out;
}

/** Response headers dropped on the way back, besides hop-by-hop ones. */
const DROP_RESPONSE = new Set(['set-cookie', 'www-authenticate', 'x-frame-options', 'content-security-policy']);

/** Headers every proxied (or proxy-made) terminal response carries. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self'",
  'referrer-policy': 'no-referrer',
};

/**
 * ttyd's response headers for the browser: no hop-by-hop headers, no
 * Set-Cookie (the box never sets cookies on the game origin), no
 * WWW-Authenticate (no browser password dialog), framing allowed only by the
 * game's own pages.
 */
export function filterResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const drop = hopByHop(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(incoming)) {
    const name = k.toLowerCase();
    if (v === undefined || drop.has(name) || DROP_RESPONSE.has(name)) continue;
    out[name] = v;
  }
  Object.assign(out, SECURITY_HEADERS);
  const type = String(out['content-type'] ?? '');
  if (type.startsWith('text/html')) out['cache-control'] = 'no-store';
  return out;
}

/** A short, secret-free reason for a failed connection ("ECONNREFUSED", "timeout"). */
export function errorReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{2,32}$/.test(code)) return code;
  const msg = err instanceof Error ? err.message : String(err);
  return /timed? ?out/i.test(msg) ? 'timeout' : 'error';
}
