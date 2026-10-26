// Seat terminal proxy (plan §11.2, §14 terminal-proxy.test.ts) against a fake
// ttyd: a node `http` + `ws` server that, like `ttyd -W -O -b /terminal/N -c
// player:<secret>`, requires Basic auth on every request, serves only under
// the base path, accepts only same-origin WebSockets (Origin host = Host),
// checks the first message's AuthToken, echoes terminal input, and records
// every header it received. The upstream address is injected
// (`terminalUpstream`), so no Docker.

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { posix } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { AdminClaudeSeatsDTO, ClaudeSeatsDTO, MeResponse, ServerWsMessage, SetupInfoDTO, TerminalDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { parseTarget } from '../packages/server/src/terminal/proxy.js';
import { seatPlayerToken, upstreamWsPath } from '../packages/server/src/terminal/upstream.js';
import { Client, WsRecorder, adminClient, bootServer, newPlayer, removeDir, sleep, tempDataDir } from './helpers/server.js';

const T = 60_000;
const SECRET = 'otter-lamp-quartz-ninety';
const CREDENTIAL = Buffer.from(`player:${SECRET}`).toString('base64');

interface FakeConn {
  seat: number;
  url: string;
  headers: IncomingHttpHeaders;
  ws: WebSocket;
  /** Messages after the auth hello. */
  received: Array<{ data: Buffer; isBinary: boolean }>;
  hello: Record<string, unknown> | null;
  closed: boolean;
}

/** A fake ttyd for all 8 seats (paths /terminal/N/...). */
class FakeTtyd {
  readonly http: Server;
  readonly wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('tty') ? 'tty' : false) });
  readonly requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
  readonly conns: FakeConn[] = [];
  port = 0;

  constructor(readonly secret: string) {
    this.http = createServer((req, res) => {
      this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      if (req.headers.authorization !== `Basic ${Buffer.from(`player:${this.secret}`).toString('base64')}`) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="ttyd"', 'content-type': 'text/html' });
        res.end('401 Unauthorized');
        return;
      }
      // Like libwebsockets under ttyd: percent-decode, then collapse `//`, `/./` and `/../`.
      let path = (req.url ?? '').split('?')[0]!;
      try {
        path = decodeURIComponent(path);
      } catch {
        /* left as is */
      }
      const m = /^\/terminal\/(\d)\/(.*)$/.exec(posix.normalize(path));
      if (!m) {
        res.writeHead(404);
        res.end('outside the base path');
        return;
      }
      if ((m[2] === '' || m[2] === 'index.html') && req.method === 'HEAD') {
        // Like the real ttyd 1.7.7: a HEAD answer still carries the body.
        const body = `<html><title>ttyd seat ${m[1]}</title></html>`;
        req.socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
        return;
      }
      if (m[2] === '' || m[2] === 'index.html') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'ttyd=evil; Path=/',
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'",
        });
        res.end(req.method === 'HEAD' ? undefined : `<html><title>ttyd seat ${m[1]}</title></html>`);
        return;
      }
      if (m[2] === 'token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token: Buffer.from(`player:${this.secret}`).toString('base64') }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    this.http.on('upgrade', (req, socket, head) => {
      const deny = (status: number) => {
        socket.write(`HTTP/1.1 ${status} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        socket.destroy();
      };
      if (req.headers.authorization !== `Basic ${Buffer.from(`player:${this.secret}`).toString('base64')}`) return deny(401);
      // ttyd -O: the Origin's host must equal Host.
      let originHost = '';
      try {
        originHost = new URL(req.headers.origin ?? '').host;
      } catch {
        /* none */
      }
      if (!originHost || originHost !== req.headers.host) return deny(403);
      // ttyd -a: `?arg=` values become the command's arguments (recorded in conn.url).
      const m = /^\/terminal\/(\d)\/ws$/.exec((req.url ?? '').split('?')[0]!);
      if (!m) return deny(404);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const conn: FakeConn = { seat: Number(m[1]), url: req.url ?? '', headers: req.headers, ws, received: [], hello: null, closed: false };
        this.conns.push(conn);
        ws.on('close', () => {
          conn.closed = true;
        });
        ws.on('message', (data: Buffer, isBinary) => {
          if (!conn.hello) {
            const hello = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
            if (hello.AuthToken !== Buffer.from(`player:${this.secret}`).toString('base64')) {
              ws.close(1008, 'bad AuthToken');
              return;
            }
            conn.hello = hello;
            return;
          }
          conn.received.push({ data, isBinary });
          if (data.toString() === 'die') {
            ws.close(1000, 'seat restarting');
            return;
          }
          // Echo, as ttyd output ('0' + data) for binary, plain for text.
          ws.send(isBinary ? Buffer.concat([Buffer.from('0'), data]) : `echo:${data.toString()}`, { binary: isBinary });
        });
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.http.address() as AddressInfo).port;
  }

  /** Requests that came through the proxy (the probe sends no X-Forwarded-Host). */
  proxied() {
    return this.requests.filter((r) => r.headers['x-forwarded-host']);
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** A browser-side terminal WebSocket that records everything. */
class Term {
  readonly messages: Array<{ data: Buffer; isBinary: boolean }> = [];
  closeCode: number | null = null;
  closeReason = '';
  private waiters: Array<() => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary) => {
      this.messages.push({ data, isBinary });
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closeCode = code;
      this.closeReason = reason.toString();
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs) throw new Error('timed out');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  hello(): void {
    // ttyd's page sends its hello as a binary JSON frame with the token from /token.
    this.ws.send(Buffer.from(JSON.stringify({ AuthToken: 'pixel-clash', columns: 80, rows: 24 })), { binary: true });
  }

  text(): string {
    return this.messages.map((m) => m.data.toString('utf8')).join('');
  }
}

type OpenResult = { ok: true; term: Term } | { ok: false; status: number; body: string };

async function openTerm(base: string, seat: number | string, cookie: string | undefined, opts: { origin?: string | null; pane?: string } = {}): Promise<OpenResult> {
  const origin = opts.origin === undefined ? base : opts.origin;
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const url = `${base.replace(/^http/, 'ws')}/terminal/${seat}/ws${opts.pane ? `?pane=${opts.pane}` : ''}`;
  const ws = new WebSocket(url, 'tty', { headers });
  return new Promise<OpenResult>((resolve) => {
    ws.once('open', () => resolve({ ok: true, term: new Term(ws) }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ ok: false, status: res.statusCode ?? 0, body }));
    });
    ws.once('error', (err) => resolve({ ok: false, status: -1, body: String(err) }));
  });
}

async function openOk(base: string, seat: number, cookie: string | undefined, opts: { origin?: string | null; pane?: string } = {}): Promise<Term> {
  const r = await openTerm(base, seat, cookie, opts);
  if (!r.ok) throw new Error(`terminal ${seat}: ${r.status} ${r.body}`);
  r.term.hello();
  return r.term;
}

async function raw(base: string, path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const HTML = { accept: 'text/html,application/xhtml+xml' };

describe('seat terminal proxy', () => {
  let srv: RunningServer;
  let dir: string;
  let fake: FakeTtyd;
  let dead: number;
  let admin: Client;
  let sam: Awaited<ReturnType<typeof newPlayer>>;
  let zoe: Awaited<ReturnType<typeof newPlayer>>;

  beforeAll(async () => {
    fake = new FakeTtyd(SECRET);
    await fake.listen();
    dead = await deadPort();
    dir = tempDataDir();
    srv = await bootServer({
      dataDir: dir,
      terminalUpstream: (seat) => ({ host: '127.0.0.1', port: seat === 8 ? dead : fake.port }),
    });
    admin = await adminClient(srv.url);
    sam = await newPlayer(srv.url, 'Sam');
    zoe = await newPlayer(srv.url, 'Zoe');
  }, T);
  afterAll(async () => {
    await srv.close();
    await fake.close();
    removeDir(dir);
  });

  it('parses only /terminal/1-8 targets', () => {
    expect(parseTarget('/terminal/3/')).toMatchObject({ kind: 'seat', seat: 3, rest: '/' });
    expect(parseTarget('/terminal/3/../4/token')).toMatchObject({ kind: 'seat', seat: 4, rest: '/token' });
    expect(parseTarget('/terminal/3?pane=x')).toEqual({ kind: 'redirect', location: '/terminal/3/?pane=x' });
    for (const bad of ['/terminal/0/', '/terminal/9/', '/terminal/03/', '/terminal/x/', '/terminal', '/terminal/']) {
      expect(parseTarget(bad).kind).toBe('bad');
    }
  });

  it('is not configured until the AI session host address and the seat password are set', async () => {
    expect((await sam.client.put('/me/claude-seat', { seat: 1 })).body).toEqual({ claudeSeat: 1 });
    const page = await raw(srv.url, '/terminal/1/', { headers: { ...HTML, cookie: sam.client.cookieHeader() } });
    expect(page.status).toBe(503);
    expect(page.text).toContain('connected the AI computer yet');
    expect(page.headers.get('www-authenticate')).toBeNull();
    const ws = await openTerm(srv.url, 1, sam.client.cookieHeader());
    expect(ws).toMatchObject({ ok: false, status: 503 });
    expect((ws as { body: string }).body).toContain('AI_SESSION_HOST_NOT_SET');

    const seats = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body;
    expect(seats.seats[0]).toMatchObject({ seat: 1, status: 'no-box', playerName: 'Sam' });

    const bad = await admin.put('/admin/setup', { seatSecret: 'has spaces in it' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_SEAT_SECRET');
    expect((await admin.put('/admin/setup', { seatSecret: 'short' })).body.error.code).toBe('BAD_SEAT_SECRET');
    expect((await admin.put('/admin/setup', { seatSecret: 'a:b-c-d-e-f-g-h' })).body.error.code).toBe('BAD_SEAT_SECRET');

    const ok = await admin.put<SetupInfoDTO & { seatSecretSet: boolean }>('/admin/setup', { aiSessionHost: 'claude-box.test', seatSecret: SECRET });
    expect(ok.status).toBe(200);
    expect(ok.body.seatSecretSet).toBe(true);
    expect(ok.text).not.toContain(SECRET);
    expect(ok.body).not.toHaveProperty('seatCards');
  }, T);

  it('refuses requests without a session, with no password dialog', async () => {
    const page = await raw(srv.url, '/terminal/1/', { headers: HTML });
    expect(page.status).toBe(401);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('www-authenticate')).toBeNull();
    expect(page.text).toContain('Log in on the game page first');
    expect(page.text).toContain('href="/play"');
    expect(page.text).not.toContain('?seat=');
    const json = await raw(srv.url, '/terminal/1/token');
    expect(json.status).toBe(401);
    expect(JSON.parse(json.text).error.code).toBe('TERMINAL_LOGIN_REQUIRED');
    const ws = await openTerm(srv.url, 1, undefined);
    expect(ws).toMatchObject({ ok: false, status: 401 });
    expect(fake.proxied()).toHaveLength(0);
  });

  it("refuses another player's seat", async () => {
    expect((await zoe.client.put('/me/claude-seat', { seat: 2 })).body).toEqual({ claudeSeat: 2 });
    const page = await raw(srv.url, '/terminal/2/', { headers: { ...HTML, cookie: sam.client.cookieHeader() } });
    expect(page.status).toBe(403);
    expect(page.text).toContain('This is AI seat 2');
    expect(page.text).toContain('/terminal/1/');
    const json = await raw(srv.url, '/terminal/2/', { headers: { cookie: sam.client.cookieHeader() } });
    expect(JSON.parse(json.text).error).toMatchObject({ code: 'CLAUDE_SEAT_NOT_YOURS', details: { seat: 2, mySeat: 1 } });
    expect(await openTerm(srv.url, 2, sam.client.cookieHeader())).toMatchObject({ ok: false, status: 403 });
    expect(fake.proxied()).toHaveLength(0);
  });

  it('proxies the own seat with injected auth, no cookies and rewritten headers', async () => {
    const before = fake.requests.length;
    const page = await raw(srv.url, '/terminal/1/?pane=abc', {
      headers: {
        ...HTML,
        cookie: `${sam.client.cookieHeader()}; other=1`,
        authorization: 'Basic bm9wZTpub3Bl',
        'x-forwarded-for': '6.6.6.6',
        referer: 'http://elsewhere/',
      },
    });
    expect(page.status).toBe(200);
    expect(page.text).toContain('ttyd seat 1');
    // Response: no cookies from the box, framing only by our own pages.
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('www-authenticate')).toBeNull();

    const got = fake.requests.slice(before).find((r) => r.url === '/terminal/1/?pane=abc')!;
    expect(got).toBeDefined();
    expect(got.headers.authorization).toBe(`Basic ${CREDENTIAL}`);
    expect(got.headers.host).toBe(`127.0.0.1:${fake.port}`);
    expect(got.headers.cookie).toBeUndefined();
    expect(got.headers.referer).toBeUndefined();
    expect(got.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(got.headers['x-forwarded-host']).toBe(new URL(srv.url).host);

    // HEAD works, other methods don't.
    expect((await raw(srv.url, '/terminal/1/', { method: 'HEAD', headers: { cookie: sam.client.cookieHeader() } })).status).toBe(200);
    const post = await raw(srv.url, '/terminal/1/', { method: 'POST', headers: { cookie: sam.client.cookieHeader() } });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    // Redirect and bad seats.
    const redirect = await raw(srv.url, '/terminal/1?pane=abc', { headers: { cookie: sam.client.cookieHeader() } });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/terminal/1/?pane=abc');
    expect((await raw(srv.url, '/terminal/0/', { headers: HTML })).status).toBe(404);
    expect((await raw(srv.url, '/terminal/9/', { headers: HTML })).status).toBe(404);
  });

  it('answers /token itself and never leaks the seat password', async () => {
    const before = fake.proxied().length;
    const token = await raw(srv.url, '/terminal/1/token', { headers: { cookie: sam.client.cookieHeader() } });
    expect(token.status).toBe(200);
    expect(JSON.parse(token.text)).toEqual({ token: 'pixel-clash' });
    expect(fake.proxied().length).toBe(before);
    for (const r of [token, await raw(srv.url, '/terminal/1/', { headers: { cookie: sam.client.cookieHeader() } })]) {
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain(CREDENTIAL);
      let headerText = '';
      r.headers.forEach((v, k) => (headerText += `${k}: ${v}\n`));
      expect(headerText).not.toContain(CREDENTIAL);
    }
  });

  it('forwards only the page: encoded or doubled /token paths never reach ttyd', async () => {
    const sneaky = ['/terminal/1/%74oken', '/terminal/1//token', '/terminal/1/x%2f..%2ftoken', '/terminal/1/x/%2e%2e/token', '/terminal/1/./token', '/terminal/1/other.js'];
    // The fake decodes like ttyd's libwebsockets: straight to it, these are the credential.
    for (const path of sneaky.slice(0, 3)) {
      const direct = await fetch(`http://127.0.0.1:${fake.port}${path}`, { headers: { authorization: `Basic ${CREDENTIAL}` } });
      expect(await direct.text()).toContain(CREDENTIAL);
    }
    const before = fake.proxied().length;
    for (const path of sneaky) {
      const r = await raw(srv.url, path, { headers: { cookie: sam.client.cookieHeader() } });
      expect(r.text).not.toContain(CREDENTIAL);
      expect(r.text).not.toContain(SECRET);
      if (r.status === 200) expect(JSON.parse(r.text)).toEqual({ token: 'pixel-clash' });
      else expect(r.status).toBe(404);
    }
    expect(fake.proxied().length).toBe(before);
    // The page itself (and index.html) still goes through.
    expect((await raw(srv.url, '/terminal/1/index.html', { headers: { cookie: sam.client.cookieHeader() } })).text).toContain('ttyd seat 1');
  });

  it('survives an upgrade request whose target does not parse', async () => {
    const port = Number(new URL(srv.url).port);
    for (const target of ['http://[', 'http://a:99999/terminal/1/ws']) {
      const answer = await new Promise<string>((resolve) => {
        const sock = connect(port, '127.0.0.1', () => {
          sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        });
        let got = '';
        sock.on('data', (c) => (got += c.toString()));
        sock.on('close', () => resolve(got));
        sock.on('error', () => resolve(got));
      });
      expect(answer === '' || /^HTTP\/1\.1 4\d\d/.test(answer)).toBe(true);
    }
    expect((await sam.client.get('/state')).status).toBe(200);
  });

  it('relays the WebSocket: AuthToken rewritten, text and binary echoed, headers rewritten', async () => {
    const term = await openOk(srv.url, 1, sam.client.cookieHeader(), { pane: 'pane1' });
    await sleep(50);
    const conn = fake.conns[fake.conns.length - 1]!;
    expect(conn.seat).toBe(1);
    // The seat's player: ttyd gets their token (and nothing from the browser's query).
    expect(conn.url).toBe(`/terminal/1/ws?arg=${seatPlayerToken(1, sam.id)}`);
    expect(conn.headers.cookie).toBeUndefined();
    expect(conn.headers.authorization).toBe(`Basic ${CREDENTIAL}`);
    expect(conn.headers.origin).toBe(`http://127.0.0.1:${fake.port}`);
    expect(conn.headers.host).toBe(`127.0.0.1:${fake.port}`);
    expect(conn.headers['sec-websocket-protocol']).toBe('tty');
    await term.until(() => conn.hello !== null);
    expect(conn.hello).toEqual({ AuthToken: CREDENTIAL, columns: 80, rows: 24 });
    expect(term.ws.protocol).toBe('tty');

    term.ws.send('hello');
    term.ws.send(Buffer.from([0x31, 0x01, 0x02]), { binary: true });
    await term.until(() => term.messages.length >= 2);
    expect(term.messages[0]).toMatchObject({ isBinary: false });
    expect(term.messages[0]!.data.toString()).toBe('echo:hello');
    expect(term.messages[1]!.isBinary).toBe(true);
    expect([...term.messages[1]!.data]).toEqual([0x30, 0x31, 0x01, 0x02]);
    expect(conn.received.map((m) => m.isBinary)).toEqual([false, true]);

    // The live terminal shows up for the player and the admin.
    const me = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats[0]!;
    expect(me.live).toMatchObject({ by: 'player', pane: 'pane1', playerName: 'Sam' });
    term.ws.close();
    await term.until(() => term.closeCode !== null);
    await sleep(100);
    expect(conn.closed).toBe(true);
  });

  it('names the seat player to ttyd with an opaque token the browser cannot set (§11.2 e)', async () => {
    const t = seatPlayerToken(1, sam.id);
    expect(t).toMatch(/^[a-f0-9]{32}$/);
    expect(seatPlayerToken(1, sam.id)).toBe(t); // a reload resumes
    expect(seatPlayerToken(1, zoe.id)).not.toBe(t); // another player starts fresh
    expect(seatPlayerToken(2, sam.id)).not.toBe(t);
    expect(t).not.toContain(sam.id.replace(/^p_/, ''));
    expect(upstreamWsPath(3, null)).toBe('/terminal/3/ws');
    expect(upstreamWsPath(3, 'p_x')).toBe(`/terminal/3/ws?arg=${seatPlayerToken(3, 'p_x')}`);

    // A browser can't pick the token (or add arguments): its query never reaches ttyd.
    const before = fake.conns.length;
    const ws = new WebSocket(`${srv.url.replace(/^http/, 'ws')}/terminal/1/ws?arg=${'0'.repeat(32)}&arg=x&pane=p`, 'tty', { headers: { cookie: sam.client.cookieHeader(), origin: srv.url } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const term = new Term(ws);
    term.hello();
    await term.until(() => fake.conns.length > before && fake.conns.at(-1)!.hello !== null);
    expect(fake.conns.at(-1)!.url).toBe(`/terminal/1/ws?arg=${t}`);
    ws.close();
    await term.until(() => term.closeCode !== null);
  });

  it('refuses a foreign or missing Origin', async () => {
    expect(await openTerm(srv.url, 1, sam.client.cookieHeader(), { origin: 'http://evil.example' })).toMatchObject({ ok: false, status: 403 });
    const none = await openTerm(srv.url, 1, sam.client.cookieHeader(), { origin: null });
    expect(none).toMatchObject({ ok: false, status: 403 });
    expect((none as { body: string }).body).toContain('TERMINAL_BAD_ORIGIN');
  });

  it('keeps one live terminal per seat: a new tab takes over the embedded pane', async () => {
    const ws = await WsRecorder.open(srv.url, 'player', sam.client.cookieHeader());
    const embedded = await openOk(srv.url, 1, sam.client.cookieHeader(), { pane: 'emb' });
    const upEmbedded = await (async () => {
      await sleep(50);
      return fake.conns[fake.conns.length - 1]!;
    })();
    const live1 = (await ws.find((m) => m.type === 'terminal' && m.data.live?.pane === 'emb')) as Extract<ServerWsMessage, { type: 'terminal' }>;
    expect(live1.data).toMatchObject({ seat: 1, boxReady: true, live: { by: 'player', pane: 'emb' } });

    // "Open in new tab": the standalone page has no pane id.
    const standalone = await openOk(srv.url, 1, sam.client.cookieHeader());
    await embedded.until(() => embedded.closeCode !== null);
    expect(embedded.closeCode).toBe(1000);
    expect(embedded.closeReason).toBe('taken-over');
    expect(embedded.text()).toContain('opened in another tab');
    expect(embedded.messages.at(-1)!.data[0]).toBe(0x30); // a ttyd output frame
    await embedded.until(() => upEmbedded.closed);
    const live2 = (await ws.find((m) => m.type === 'terminal' && m.data.live !== null && m.data.live.pane === null)) as Extract<ServerWsMessage, { type: 'terminal' }>;
    expect(live2.data.live?.by).toBe('player');

    // "Use it here instead": the embedded pane takes it back.
    const back = await openOk(srv.url, 1, sam.client.cookieHeader(), { pane: 'emb' });
    await standalone.until(() => standalone.closeCode !== null);
    expect(standalone.closeCode).toBe(1000);
    back.ws.close();
    ws.close();
  });

  it('lets the admin open any seat (rescue) and tells the player', async () => {
    const page = await raw(srv.url, '/terminal/2/', { headers: { cookie: admin.cookieHeader() } });
    expect(page.status).toBe(200);
    const zoeTerm = await openOk(srv.url, 2, zoe.client.cookieHeader(), { pane: 'z' });
    await sleep(50);
    const adminTerm = await openOk(srv.url, 2, admin.cookieHeader());
    await zoeTerm.until(() => zoeTerm.closeCode !== null);
    expect(zoeTerm.closeCode).toBe(1000);
    expect(zoeTerm.text()).toContain('A grown-up opened your terminal');
    const seats = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body;
    expect(seats.seats[1]!.live).toMatchObject({ by: 'admin', pane: null });
    // Admin rescue: no player token, so the seat resumes Zoe's conversation.
    expect(fake.conns.filter((c) => c.seat === 2).map((c) => c.url)).toEqual([`/terminal/2/ws?arg=${seatPlayerToken(2, zoe.id)}`, '/terminal/2/ws']);
    adminTerm.ws.send('ping');
    await adminTerm.until(() => adminTerm.messages.length > 0);
    expect(adminTerm.messages[0]!.data.toString()).toBe('echo:ping');
    adminTerm.ws.close();
  });

  it('closes a live terminal when the seat is unassigned, reassigned or the player is kicked', async () => {
    const term = await openOk(srv.url, 1, sam.client.cookieHeader(), { pane: 'p' });
    await sleep(50);
    const r = await admin.put<AdminClaudeSeatsDTO>('/admin/claude-seats/1', { playerId: null });
    expect(r.status).toBe(200);
    await term.until(() => term.closeCode !== null);
    expect(term.closeCode).toBe(1000);
    expect(term.closeReason).toBe('access-revoked');
    expect((await raw(srv.url, '/terminal/1/', { headers: { cookie: sam.client.cookieHeader() } })).status).toBe(403);

    // Reassign seat 1 to Zoe: she moves off seat 2.
    const zoeTerm = await openOk(srv.url, 2, zoe.client.cookieHeader());
    await sleep(50);
    const moved = await admin.put<AdminClaudeSeatsDTO>('/admin/claude-seats/1', { playerId: zoe.id });
    expect(moved.body.seats[0]).toMatchObject({ playerName: 'Zoe' });
    expect(moved.body.seats[1]).toMatchObject({ playerName: null });
    await zoeTerm.until(() => zoeTerm.closeCode !== null);
    expect(zoeTerm.closeCode).toBe(1000);

    // Kick closes it too, and frees the seat.
    const zoe1 = await openOk(srv.url, 1, zoe.client.cookieHeader());
    await sleep(50);
    expect((await admin.post(`/admin/players/${zoe.id}/kick`, {})).status).toBe(200);
    await zoe1.until(() => zoe1.closeCode !== null);
    expect(zoe1.closeCode).toBe(1000);
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats[0]!.playerId).toBeNull();
    expect((await admin.put('/admin/claude-seats/1', { playerId: zoe.id })).body.error.code).toBe('NOT_FOUND');
    expect((await admin.put('/admin/claude-seats/9', { playerId: null })).body.error.code).toBe('BAD_CLAUDE_SEAT');
    // Sam gets seat 1 back for the rest of the suite.
    expect((await admin.put('/admin/claude-seats/1', { playerId: sam.id })).status).toBe(200);
  });

  it('refuses new terminals for a while when tabs keep stealing a seat', async () => {
    // A seat of its own, so earlier takeovers don't count.
    const max = await newPlayer(srv.url, 'Max');
    expect((await max.client.put('/me/claude-seat', { seat: 6 })).body).toEqual({ claudeSeat: 6 });
    const terms: Term[] = [];
    // 1 open + 5 takeovers within 10 s: the 5th takeover trips the guard.
    for (let i = 0; i < 6; i++) terms.push(await openOk(srv.url, 6, max.client.cookieHeader()));
    const refused = await openTerm(srv.url, 6, max.client.cookieHeader(), {});
    expect(refused).toMatchObject({ ok: false, status: 503 });
    expect((refused as { body: string }).body).toContain('TERMINAL_BUSY');
    const page = await raw(srv.url, '/terminal/6/', { headers: { cookie: max.client.cookieHeader() } });
    expect(page.status).toBe(200); // the page itself still loads; only new terminals wait
    for (const t of terms) t.ws.close();
    await sleep(5200);
    const after = await openOk(srv.url, 6, max.client.cookieHeader());
    after.ws.close();
  }, T);

  it('closes the browser with 1011 when the AI session host drops the terminal (ttyd reconnects)', async () => {
    const term = await openOk(srv.url, 1, sam.client.cookieHeader());
    await sleep(50);
    term.ws.send('die');
    await term.until(() => term.closeCode !== null);
    expect(term.closeCode).toBe(1011);
  });

  it('shows a friendly page when the AI session host is down', async () => {
    const kim = await newPlayer(srv.url, 'Kim');
    expect((await kim.client.put('/me/claude-seat', { seat: 8 })).body).toEqual({ claudeSeat: 8 });
    const t0 = Date.now();
    const page = await raw(srv.url, '/terminal/8/', { headers: { ...HTML, cookie: kim.client.cookieHeader() } });
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(page.status).toBe(502);
    expect(page.text).toContain('answering yet');
    expect(page.text).toContain('Pixel Clash · AI helper · seat 8');
    expect(await openTerm(srv.url, 8, kim.client.cookieHeader())).toMatchObject({ ok: false, status: 502 });
    const seats = (await admin.post<AdminClaudeSeatsDTO>('/admin/claude-seats/check')).body;
    expect(seats.seats[7]).toMatchObject({ status: 'down', playerName: 'Kim' });
    expect(seats.seats[7]!.reason).toBe('ECONNREFUSED');
    expect(seats.seats[0]!.status).toBe('up');
    const mine = (await kim.client.get<ClaudeSeatsDTO>('/claude-seats')).body;
    expect(mine.seats[7]).toMatchObject({ seat: 8, mine: true, status: 'down', takenBy: 'Kim' });
  });

  it("surfaces a seat password that doesn't match the AI session host", async () => {
    expect((await admin.put('/admin/setup', { seatSecret: 'wrong-wrong-wrong-wrong' })).status).toBe(200);
    const page = await raw(srv.url, '/terminal/1/', { headers: { ...HTML, cookie: sam.client.cookieHeader() } });
    expect(page.status).toBe(502);
    expect(page.text).toContain('needs a grown-up');
    expect(page.headers.get('www-authenticate')).toBeNull();
    expect(await openTerm(srv.url, 1, sam.client.cookieHeader())).toMatchObject({ ok: false, status: 502 });
    const seats = (await admin.post<AdminClaudeSeatsDTO>('/admin/claude-seats/check')).body;
    expect(seats.seats[0]!.status).toBe('wrong-password');
    expect(seats.seats[1]!.status).toBe('wrong-password');
    // Players never see the adults' statuses.
    const mine = (await sam.client.get<ClaudeSeatsDTO>('/claude-seats')).body;
    expect(mine.seats[0]!.status).toBe('unknown');
    expect((await admin.put('/admin/setup', { seatSecret: SECRET })).status).toBe(200);
    await admin.post('/admin/claude-seats/check');
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats[0]!.status).toBe('up');
  });

  it('tells a logged-out player to log in again (PIN reset keeps the seat)', async () => {
    const lee = await newPlayer(srv.url, 'Lee');
    expect((await lee.client.put('/me/claude-seat', { seat: 7 })).body).toEqual({ claudeSeat: 7 });
    const term = await openOk(srv.url, 7, lee.client.cookieHeader());
    await sleep(50);
    expect((await admin.post(`/admin/players/${lee.id}/pin`, { pin: '4321' })).status).toBe(200);
    await term.until(() => term.closeCode !== null);
    expect(term.closeReason).toBe('access-revoked');
    expect(term.text()).toContain('You were logged out');
    expect(term.text()).not.toContain("isn't yours");
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats[6]!.playerName).toBe('Lee');
    // Unassigning is still "not yours any more".
    const back = new Client(srv.url);
    await back.post('/login', { name: 'Lee', pin: '4321' });
    const again = await openOk(srv.url, 7, back.cookieHeader());
    await sleep(50);
    await admin.put('/admin/claude-seats/7', { playerId: null });
    await again.until(() => again.closeCode !== null);
    expect(again.text()).toContain("isn't yours any more");
  });

  it('never puts the seat password in player, public or default admin payloads', async () => {
    const ws = await WsRecorder.open(srv.url, 'player', sam.client.cookieHeader());
    const screen = await WsRecorder.open(srv.url, 'screen');
    const adminWs = await WsRecorder.open(srv.url, 'admin', admin.cookieHeader());
    await ws.find((m) => m.type === 'terminal');
    await adminWs.find((m) => m.type === 'terminals');
    await admin.post('/admin/claude-seats/check');
    await sleep(100);
    const texts = [
      (await sam.client.get('/me')).text,
      (await sam.client.get('/state')).text,
      (await sam.client.get('/claude-seats')).text,
      (await new Client(srv.url).get('/setup')).text,
      (await admin.get('/admin/claude-seats')).text,
      (await admin.get('/admin/overview')).text,
      ...ws.raw,
      ...screen.raw,
      ...adminWs.raw,
    ];
    for (const t of texts) {
      expect(t).not.toContain(SECRET);
      expect(t).not.toContain(CREDENTIAL);
    }
    const details = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body;
    expect(details.seatSecret).toBe(SECRET);
    expect(details.seats[2]!.directUrl).toBe('http://claude-box.test:7783/terminal/3/');
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats[2]!.directUrl).toBeUndefined();
    // The screen gets no terminal pushes at all.
    expect(screen.messages.some((m) => m.type === 'terminal' || m.type === 'terminals')).toBe(false);
    ws.close();
    screen.close();
    adminWs.close();
  });
});

describe('Claude seat assignment', () => {
  let srv: RunningServer;
  let dir: string;

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('assigns one player per seat, releases on change, and pushes only to the seat holder', async () => {
    const a = await newPlayer(srv.url, 'Ava');
    const b = await newPlayer(srv.url, 'Ben');
    const aWs = await WsRecorder.open(srv.url, 'player', a.client.cookieHeader());
    const bWs = await WsRecorder.open(srv.url, 'player', b.client.cookieHeader());
    expect((await aWs.find((m) => m.type === 'terminal')) as unknown).toMatchObject({ data: { seat: null, live: null, boxReady: false } });

    expect((await a.client.get<MeResponse>('/me')).body.claudeSeat).toBeNull();
    expect((await a.client.put('/me/claude-seat', { seat: 3 })).body).toEqual({ claudeSeat: 3 });
    expect((await a.client.get<MeResponse>('/me')).body.claudeSeat).toBe(3);
    const pushed = (await aWs.find((m) => m.type === 'terminal' && m.data.seat === 3)) as { data: TerminalDTO };
    expect(pushed.data.status).toBe('unknown');
    await sleep(50);
    // Ben's pushes are about his own seat (none), never Ava's.
    expect(bWs.messages.filter((m) => m.type === 'terminal').every((m) => (m as { data: TerminalDTO }).data.seat === null)).toBe(true);

    // Taken by someone else.
    const taken = await b.client.put('/me/claude-seat', { seat: 3 });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: 'CLAUDE_SEAT_TAKEN', details: { seat: 3, takenBy: 'Ava' } });
    for (const bad of [0, 9, 'x', 2.5]) expect((await b.client.put('/me/claude-seat', { seat: bad })).body.error.code).toBe('BAD_CLAUDE_SEAT');
    expect((await b.client.put('/me/claude-seat', {})).status).toBe(400);
    // Own seat again: a no-op. Unauthenticated: refused.
    expect((await a.client.put('/me/claude-seat', { seat: 3 })).body).toEqual({ claudeSeat: 3 });
    expect((await new Client(srv.url).put('/me/claude-seat', { seat: 1 })).status).toBe(401);

    // Changing releases the old seat (1 change per second).
    expect((await a.client.put('/me/claude-seat', { seat: 4 })).body.error.code).toBe('RATE_LIMITED');
    await sleep(1050);
    expect((await a.client.put('/me/claude-seat', { seat: 4 })).body).toEqual({ claudeSeat: 4 });
    expect((await b.client.put('/me/claude-seat', { seat: 3 })).body).toEqual({ claudeSeat: 3 });

    const list = (await b.client.get<ClaudeSeatsDTO>('/claude-seats')).body;
    expect(list.mySeat).toBe(3);
    expect(list.boxReady).toBe(false);
    expect(list.seats).toHaveLength(8);
    expect(list.seats[2]).toEqual({ seat: 3, takenBy: 'Ben', mine: true, status: 'unknown' });
    expect(list.seats[3]).toEqual({ seat: 4, takenBy: 'Ava', mine: false, status: 'unknown' });

    // null = not at a Claude laptop.
    await sleep(1050);
    expect((await a.client.put('/me/claude-seat', { seat: null })).body).toEqual({ claudeSeat: null });
    const overview = (await (await adminClient(srv.url)).get('/admin/overview')).body;
    expect(overview.players.map((p: { name: string; claudeSeat: number | null }) => [p.name, p.claudeSeat])).toEqual([
      ['Ava', null],
      ['Ben', 3],
    ]);
    aWs.close();
    bWs.close();
  });

  it('admin reassignment moves and unassigns; logout and PIN reset keep the seat; it survives a restart; wipe frees it', async () => {
    const admin = await adminClient(srv.url);
    const c = await newPlayer(srv.url, 'Cat');
    const ben = (await admin.get('/admin/overview')).body.players.find((p: { name: string }) => p.name === 'Ben');
    // Seat 3 is Ben's: giving it to Cat unassigns Ben.
    const r = await admin.put<AdminClaudeSeatsDTO>('/admin/claude-seats/3', { playerId: c.id });
    expect(r.body.seats[2]).toMatchObject({ playerId: c.id, playerName: 'Cat', status: 'no-box', live: null });
    expect(r.body.seatSecretSet).toBe(true); // made up on the first start (tests/seat-secret-setup.test.ts)
    expect(r.body.seatSecret).toBeUndefined();
    // Moving Cat to seat 5 frees seat 3.
    const moved = await admin.put<AdminClaudeSeatsDTO>('/admin/claude-seats/5', { playerId: c.id });
    expect(moved.body.seats[2]!.playerId).toBeNull();
    expect(moved.body.seats[4]!.playerName).toBe('Cat');
    await admin.put('/admin/claude-seats/3', { playerId: ben.id });
    expect((await admin.put('/admin/claude-seats/3', {})).status).toBe(400);

    // Logout and PIN reset keep it.
    await c.client.post('/logout');
    await admin.post(`/admin/players/${c.id}/pin`, { pin: '4321' });
    const back = new Client(srv.url);
    await back.post('/login', { name: 'Cat', pin: '4321' });
    expect((await back.get<MeResponse>('/me')).body.claudeSeat).toBe(5);

    // Restart.
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    const again = await adminClient(srv.url);
    const seats = (await again.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats;
    expect(seats[2]!.playerName).toBe('Ben');
    expect(seats[4]!.playerName).toBe('Cat');

    // Seat password: saved, survives a wipe (venue setting), only with details.
    await again.put('/admin/setup', { aiSessionHost: '10.0.0.5', seatSecret: SECRET });
    expect((await again.post('/admin/wipe', { confirm: 'WIPE' })).status).toBe(200);
    const after = (await again.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body;
    expect(after.seats.every((s) => s.playerId === null)).toBe(true);
    expect(after.seatSecret).toBe(SECRET);
    expect(after.seatSecretSet).toBe(true);
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    const d = (await (await adminClient(srv.url)).get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body;
    expect(d.seatSecret).toBe(SECRET);
    expect(d.boxHost).toBe('10.0.0.5');
    // Clearing it.
    const cleared = await (await adminClient(srv.url)).put('/admin/setup', { seatSecret: null });
    expect(cleared.body.seatSecretSet).toBe(false);
  }, T);
});
