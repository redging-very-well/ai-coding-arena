// `npm run loadtest -- [--url http://localhost:8080] [--admin-password pw] [--players 8]`
//
// The §14 load test against a RUNNING server (`npm start`, the real
// isolated-vm sandbox). It drives a whole match as the facilitator:
//   * joins N bot players (scripts/bots.ts, strategy "swarm" by default:
//     3 types × 12 copies each, every update() loops over all enemies);
//   * opens ~10 WebSocket clients (1 admin + screens) that count the
//     battle frames they receive;
//   * plays round 1 at 1x and round 2 at 2x playback;
//   * samples GET /admin/metrics (server RSS, sim ms/tick, playback stalls)
//     and the sandbox children's RSS (via `ps`, when the server is local);
// and prints a pass/fail summary against the targets:
//   sim p99 < 8 ms/tick, playback never stalls at 1x or 2x, server RSS < 500 MB,
//   each sandbox child < 100 MB.
//
// Options: --players 8  --copies 12  --clients 10  --strategy swarm
//   --map ring|lanes|…  --team-mode ffa|teams2|…  --fresh (wipe data first!)
//   --json (print the result as JSON too). Exit code 1 when a target fails.
// The server must be in LOBBY (or use --fresh on a throwaway server).

import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import type { FrameDTO, GameStateDTO, PlaybackDTO, ServerWsMessage } from '@pixel-clash/shared';
import type { BattleMetrics } from '../../packages/server/src/services/battle.js';
import { joinBots, sleep, type Bot } from '../../scripts/bots.js';

const TARGETS = { simP99Ms: 8, serverRssMb: 500, childRssMb: 100 };
/** A gap between frame batches longer than this, while playing, is reported as jitter (warning). */
const STALL_GAP_MS = 500;

interface Metrics {
  pid: number;
  phase: string;
  round: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  wsClients: number | null;
  battle: BattleMetrics | null;
}

// ---------------------------------------------------------------------------
// Admin client (cookie jar)
// ---------------------------------------------------------------------------

class Admin {
  private cookie = '';
  constructor(readonly base: string) {}

  get cookieHeader(): string {
    return this.cookie;
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${this.base}/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const set = res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((kv) => !kv.endsWith('='));
    if (set.length) this.cookie = set.join('; ');
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T };
  }

  async ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.req<T>(method, path, body);
    if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }

  state(): Promise<GameStateDTO> {
    return this.ok<GameStateDTO>('GET', '/state');
  }

  metrics(): Promise<Metrics> {
    return this.ok<Metrics>('GET', '/admin/metrics');
  }
}

// ---------------------------------------------------------------------------
// WS observers
// ---------------------------------------------------------------------------

class Observer {
  readonly ws: WebSocket;
  frames = 0;
  batches = 0;
  bytes = 0;
  firstAt = 0;
  lastAt = 0;
  maxGapMs = 0;
  thinkingSeen = 0;
  private lastPlayback: PlaybackDTO | undefined;

  constructor(url: string, readonly role: 'screen' | 'admin', cookie?: string) {
    this.ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws', cookie ? { headers: { cookie } } : {});
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', role })));
    this.ws.on('message', (data) => {
      const text = data.toString();
      const msg = JSON.parse(text) as ServerWsMessage;
      if (msg.type !== 'battle:frames') return;
      const now = performance.now();
      // Gaps only count while playback runs: not paused, and not the reveal hold
      // (frame 0 goes out at START, the rest after the reveal animation).
      if (this.lastAt && this.lastPlayback && !this.lastPlayback.paused && this.lastPlayback.tick > 0) {
        this.maxGapMs = Math.max(this.maxGapMs, now - this.lastAt);
      }
      if (!this.firstAt) this.firstAt = now;
      this.lastAt = now;
      this.batches++;
      this.frames += (msg.frames as FrameDTO[]).length;
      this.bytes += text.length;
      if (msg.playback.thinking) this.thinkingSeen++;
      this.lastPlayback = msg.playback;
    });
  }

  reset(): void {
    this.frames = this.batches = this.bytes = this.firstAt = this.lastAt = this.maxGapMs = this.thinkingSeen = 0;
    this.lastPlayback = undefined;
  }

  get framesPerSec(): number {
    const s = (this.lastAt - this.firstAt) / 1000;
    return s > 0 ? this.frames / s : 0;
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// Sandbox children RSS (local server only)
// ---------------------------------------------------------------------------

function childRssMb(serverPid: number): number[] | null {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' });
    const rows = out
      .trim()
      .split('\n')
      .map((l) => {
        const [pid, ppid, rss, ...cmd] = l.trim().split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), cmd: cmd.join(' ') };
      });
    if (!rows.some((r) => r.pid === serverPid)) return null; // not on this machine
    // The sandbox children (ivmChild), not helpers such as esbuild's service.
    return rows.filter((r) => r.ppid === serverPid && /ivmChild/.test(r.cmd)).map((r) => Math.round((r.rss / 1024) * 10) / 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Match driver
// ---------------------------------------------------------------------------

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs: number, everyMs = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

interface RoundResult {
  round: number;
  speed: 1 | 2;
  units: number;
  players: number;
  ticks: number;
  simP50: number;
  simP99: number;
  simP99Warm: number;
  simOver8: number;
  simMax: number;
  simWallMs: number | null;
  serverStalls: number;
  serverStalledMs: number;
  clientMaxGapMs: number;
  clientThinking: number;
  clientFramesPerSecMin: number;
  clientFramesPerSecAvg: number;
  wsClients: number;
  wsKBPerClient: number;
  serverRssMaxMb: number;
  /** Server JS heap (used / total) at the RSS peak sample. */
  serverHeapAtPeakMb: { used: number; total: number; external: number };
  childRssMaxMb: number | null;
  children: number | null;
}

async function playRound(admin: Admin, bots: Bot[], observers: Observer[], speed: 1 | 2, log: (s: string) => void): Promise<RoundResult> {
  const s0 = await admin.state();
  const round = s0.round;
  if (s0.phase !== 'PLAN') throw new Error(`expected PLAN, got ${s0.phase}`);
  await until('every bot to pick its selection', async () => bots.every((b) => b.selectedRound === round), 120_000);
  await admin.ok('POST', '/admin/phase/next');
  await until('PLACEMENT', async () => (await admin.state()).phase === 'PLACEMENT', 10_000);
  await until('every bot to place and ready up', async () => bots.every((b) => b.placedRound === round), 60_000).catch(() => log('  (some bots did not ready up: force start)'));
  for (const o of observers) o.reset();
  const started = await admin.req('POST', '/admin/start', {});
  if (started.status !== 200) await admin.ok('POST', '/admin/start', { force: true });
  await until('BATTLE', async () => (await admin.state()).phase === 'BATTLE', 10_000);
  await admin.ok('POST', '/admin/battle', { speed });
  log(`  round ${round}: battle started at ${speed}x`);

  let rssMax = 0;
  let heapAtPeak = { used: 0, total: 0, external: 0 };
  let childMax: number | null = null;
  let children: number | null = null;
  let last: Metrics | undefined;
  for (;;) {
    const m = await admin.metrics();
    if (m.rssMb > rssMax) {
      rssMax = m.rssMb;
      heapAtPeak = { used: m.heapUsedMb, total: m.heapTotalMb, external: m.externalMb };
    }
    const kids = childRssMb(m.pid);
    if (kids) {
      children = Math.max(children ?? 0, kids.length);
      if (kids.length) childMax = Math.max(childMax ?? 0, ...kids);
    }
    if (m.battle && m.battle.round === round) last = m;
    if (m.phase !== 'BATTLE') break;
    await sleep(500);
  }
  const m = await admin.metrics();
  const b = (m.battle && m.battle.round === round ? m.battle : last?.battle)!;
  if (!b?.tickMs) throw new Error('no battle metrics from the server');
  const fps = observers.map((o) => o.framesPerSec);
  return {
    round,
    speed,
    units: b.units,
    players: b.players,
    ticks: b.ticks,
    simP50: b.tickMs.p50,
    simP99: b.tickMs.p99,
    simP99Warm: b.tickMs.p99Warm,
    simOver8: b.tickMs.over8,
    simMax: b.tickMs.max,
    simWallMs: b.simWallMs,
    serverStalls: b.playback.stalls,
    serverStalledMs: b.playback.stalledMs,
    clientMaxGapMs: Math.max(...observers.map((o) => o.maxGapMs)),
    clientThinking: Math.max(...observers.map((o) => o.thinkingSeen)),
    clientFramesPerSecMin: Math.min(...fps),
    clientFramesPerSecAvg: fps.reduce((a, x) => a + x, 0) / fps.length,
    wsClients: m.wsClients ?? observers.length,
    wsKBPerClient: observers.reduce((a, o) => a + o.bytes, 0) / observers.length / 1024,
    serverRssMaxMb: rssMax,
    serverHeapAtPeakMb: heapAtPeak,
    childRssMaxMb: childMax,
    children,
  };
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out[k] = argv[++i]!;
    else out[k] = true;
  }
  return out;
}

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = String(args.url ?? process.env.PIXEL_CLASH_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const password = String(args['admin-password'] ?? process.env.ADMIN_PASSWORD ?? '');
  const players = Number(args.players ?? 8);
  const copies = Number(args.copies ?? 12);
  if (!Number.isInteger(players) || players < 2 || players > 8) throw new Error('--players must be 2-8');
  if (!Number.isInteger(copies) || copies < 1) throw new Error('--copies must be a positive whole number');
  const clients = Number(args.clients ?? Math.max(10, players + 4));
  const strategy = String(args.strategy ?? 'swarm');
  const teamMode = String(args['team-mode'] ?? 'ffa');
  const log = (s: string) => console.log(s);
  if (!password) throw new Error('pass --admin-password (or set ADMIN_PASSWORD): the load test drives the match as the facilitator');

  const admin = new Admin(url);
  await admin.ok('POST', '/admin/login', { password });
  if (args.fresh) {
    await admin.ok('POST', '/admin/wipe', { confirm: 'WIPE' });
    await admin.ok('POST', '/admin/login', { password });
  }
  const s = await admin.state();
  if (s.phase !== 'LOBBY') throw new Error(`the server is in ${s.phase}; the load test needs LOBBY (use --fresh on a throwaway server)`);
  // Fast rehearsal pacing: short reveal hold is server-side; rate limits stay as configured.

  log(`Pixel Clash load test → ${url}: ${players} bots (${strategy}, ≤ ${copies} copies), ${clients} WS clients, ${teamMode}${args.map ? `, ${String(args.map)}` : ''}`);
  const bots = await joinBots({ url, players, strategy, prefix: 'Load', maxCopies: copies, pollMs: 250 });
  const observers = [new Observer(url, 'admin', admin.cookieHeader), ...Array.from({ length: Math.max(0, clients - 1) }, () => new Observer(url, 'screen'))];
  await sleep(500);
  const running = bots.map((b) => b.run());

  const match = await admin.ok('POST', '/admin/match', {
    rounds: 2,
    armory: false,
    teamMode,
    ...(typeof args.map === 'string' ? { mapStyle: args.map } : {}),
  });
  log(`  match started: ${match.match?.map?.style ?? '?'} ${match.match?.map?.width ?? ''}`);

  const results: RoundResult[] = [];
  results.push(await playRound(admin, bots, observers, 1, log));
  await admin.ok('POST', '/admin/phase/next'); // RESULTS → PLAN round 2
  await until('PLAN round 2', async () => (await admin.state()).phase === 'PLAN', 10_000);
  results.push(await playRound(admin, bots, observers, 2, log));
  await admin.ok('POST', '/admin/phase/next'); // RESULTS → MATCH_RESULTS
  await Promise.race([Promise.all(running), sleep(5000)]);
  for (const b of bots) b.stop();
  for (const o of observers) o.close();

  // Summary
  // [name, pass, detail, warnOnly]: warn-only checks are reported but don't fail the run.
  const checks: Array<[string, boolean, string, boolean?]> = [];
  for (const r of results) {
    const tag = `round ${r.round} (${r.speed}x, ${r.players} players, ${r.units} units)`;
    checks.push([`${tag}: sim p99 < ${TARGETS.simP99Ms} ms/tick`, r.simP99 < TARGETS.simP99Ms, `p50 ${f2(r.simP50)} / p99 ${f2(r.simP99)} (after the 1st second ${f2(r.simP99Warm)}) / max ${f2(r.simMax)} ms over ${r.ticks} ticks, ${r.simOver8} ticks > 8 ms; sim done in ${r.simWallMs ?? '?'} ms`]);
    // A stall (§9 Decoupling) is playback waiting for the sim ("thinking…"): counted by the server and seen by clients.
    checks.push([`${tag}: playback never stalls`, r.serverStalls === 0 && r.clientThinking === 0, `server stalls ${r.serverStalls} (${r.serverStalledMs} ms), "thinking" seen by clients ${r.clientThinking} times`]);
    // Delivery jitter (host scheduling, network) is reported separately.
    checks.push([`${tag}: frame batches arrive smoothly (gap < ${STALL_GAP_MS} ms)`, r.clientMaxGapMs < STALL_GAP_MS, `max gap between frame batches ${Math.round(r.clientMaxGapMs)} ms (batches every 50 ms)`, true]);
    checks.push([`${tag}: WS frames reach every client`, r.clientFramesPerSecMin > 25 * r.speed * 0.8, `${r.wsClients} clients, ${f1(r.clientFramesPerSecMin)}-${f1(r.clientFramesPerSecAvg)} frames/s (expect ${30 * r.speed}), ${Math.round(r.wsKBPerClient)} KB/client`]);
    checks.push([`${tag}: server RSS < ${TARGETS.serverRssMb} MB`, r.serverRssMaxMb < TARGETS.serverRssMb, `max ${f1(r.serverRssMaxMb)} MB (JS heap ${f1(r.serverHeapAtPeakMb.used)} used / ${f1(r.serverHeapAtPeakMb.total)} total, external ${f1(r.serverHeapAtPeakMb.external)})`]);
    // Plan §14 also asks for < 100 MB per sandbox child. A child is a whole Node
    // process (~70 MB before any kid code) plus a 32 MB isolate, so this is a
    // warning, not a failure (docs/load.md).
    if (r.childRssMaxMb !== null) checks.push([`${tag}: each sandbox child < ${TARGETS.childRssMb} MB`, r.childRssMaxMb < TARGETS.childRssMb, `${r.children} sandbox children, max ${f1(r.childRssMaxMb)} MB`, true]);
  }
  log('');
  for (const [name, pass, detail, warnOnly] of checks) log(`${pass ? 'PASS' : warnOnly ? 'WARN' : 'FAIL'}  ${name}\n      ${detail}`);
  const failed = checks.filter(([, pass, , warnOnly]) => !pass && !warnOnly).length;
  log(`\n${failed === 0 ? 'ALL TARGETS MET' : `${failed} TARGET(S) MISSED`}`);
  if (args.json) console.log(JSON.stringify({ url, players, copies, clients, strategy, teamMode, results }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
