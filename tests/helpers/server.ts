// Test helpers for the M3 server: boot a real server (real validator and
// isolated-vm sandboxes) on a free port with a temp data dir and a
// fast-forward config, a tiny cookie-aware REST client, and a WS client that
// records every message.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { deepMerge, type DeepPartial, type GameConfig, type GameStateDTO, type ServerWsMessage, type ViewerRole } from '@pixel-clash/shared';
import { startServer, type RunningServer, type ServerOptions } from '../../packages/server/src/server.js';
import { setLogLevel } from '../../packages/server/src/util/log.js';

setLogLevel('silent');

export const ADMIN_PASSWORD = 'test-admin-pw';

/** Short battles, generous rate limits, unchanged economy. */
export const FAST_CONFIG: DeepPartial<GameConfig> = {
  timers: { battleTicks: 240, planFirstRoundSec: 600, planLaterRoundsSec: 600, placementSec: 600 },
  suddenDeath: { startTick: 120, endTick: 240 },
  rateLimits: { loginPerMinute: 1000, validatePerSecond: 1000, submitMinIntervalMs: 1 },
};

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'pixel-clash-test-'));
}

export async function bootServer(opts: Partial<ServerOptions> = {}): Promise<RunningServer> {
  return startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: opts.dataDir ?? tempDataDir(),
    adminPassword: ADMIN_PASSWORD,
    playbackRate: 20,
    revealDelayMs: 0,
    saveDebounceMs: 5,
    publicDir: join(tmpdir(), 'pixel-clash-no-client'),
    ...opts,
    // `config` is merged over FAST_CONFIG (not replaced).
    config: deepMerge(FAST_CONFIG, opts.config ?? {}),
  });
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function fixture(path: string): string {
  return readFileSync(new URL(`../fixtures/units/${path}`, import.meta.url), 'utf8');
}

export function template(file: 'basic_soldier' | 'basic_tower'): string {
  return readFileSync(new URL(`../../packages/starter-kit/units/${file}.js`, import.meta.url), 'utf8');
}

/** A unit source with a custom name (based on the Big Tank fixture). */
export function namedUnit(name: string, extra: { damage?: number } = {}): string {
  return fixture('good/big_tank.js')
    .replace(/this\.name\s*=\s*['"][^'"]*['"]/, `this.name = ${JSON.stringify(name)}`)
    .replace(/this\.damage\s*=\s*\d+/, `this.damage = ${extra.damage ?? 100}`);
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
}

/** A REST client with its own cookie jar (one per simulated browser). */
export class Client {
  cookies = new Map<string, string>();
  bearer: string | undefined;

  constructor(readonly base: string) {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    const res = await fetch(this.base + path, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      const k = kv!.slice(0, i);
      const v = kv!.slice(i + 1);
      if (v === '' || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T, text };
  }

  get<T = any>(path: string) {
    return this.req<T>('GET', `/api${path}`);
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.req<T>('POST', `/api${path}`, body);
  }
  put<T = any>(path: string, body: unknown = {}) {
    return this.req<T>('PUT', `/api${path}`, body);
  }
  del<T = any>(path: string) {
    return this.req<T>('DELETE', `/api${path}`);
  }
}

export async function newPlayer(base: string, name: string, pin = '1234') {
  const c = new Client(base);
  const r = await c.post('/players', { name, pin });
  if (r.status !== 200) throw new Error(`create ${name}: ${r.status} ${r.text}`);
  return { client: c, id: r.body.player.id as string, apiKey: r.body.apiKey as string, seat: r.body.player.seat as number };
}

export async function adminClient(base: string): Promise<Client> {
  const c = new Client(base);
  const r = await c.post('/admin/login', { password: ADMIN_PASSWORD });
  if (r.status !== 200) throw new Error(`admin login: ${r.status} ${r.text}`);
  return c;
}

/** Poll GET /state until `pred` holds. */
export async function waitForState(client: Client, pred: (s: GameStateDTO) => boolean, timeoutMs = 15_000): Promise<GameStateDTO> {
  const t0 = Date.now();
  for (;;) {
    const s = (await client.get<GameStateDTO>('/state')).body;
    if (pred(s)) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for state; last: ${JSON.stringify(s).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A WebSocket client that records every message (raw text and parsed). */
export class WsRecorder {
  readonly ws: WebSocket;
  readonly raw: string[] = [];
  readonly messages: ServerWsMessage[] = [];
  private waiters: Array<{ pred: (m: ServerWsMessage) => boolean; resolve: (m: ServerWsMessage) => void }> = [];

  constructor(url: string, cookie?: string) {
    this.ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws', cookie ? { headers: { cookie } } : {});
    this.ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerWsMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }

  static async open(url: string, role: ViewerRole, cookie?: string): Promise<WsRecorder> {
    const r = new WsRecorder(url, cookie);
    await new Promise<void>((resolve, reject) => {
      r.ws.once('open', () => resolve());
      r.ws.once('error', reject);
    });
    const hello = r.next((m) => m.type === 'hello');
    r.ws.send(JSON.stringify({ type: 'hello', role }));
    await hello;
    return r;
  }

  /** Resolve with the first FUTURE message matching `pred`. */
  next(pred: (m: ServerWsMessage) => boolean, timeoutMs = 5000): Promise<ServerWsMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a WS message')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** The first message (already received or future) matching `pred`. */
  async find(pred: (m: ServerWsMessage) => boolean, timeoutMs = 5000): Promise<ServerWsMessage> {
    const have = this.messages.find(pred);
    if (have) return have;
    return this.next(pred, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
