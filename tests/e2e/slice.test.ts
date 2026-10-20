// M3 vertical slice, end to end against the BUILT production server (plan §16 M3):
//   `node --no-node-snapshot packages/server/dist/index.js` in a child process
//   on a free port with a temp DATA_DIR, the built client pages, two players
//   via REST, a custom unit WITH a sprite submitted over MCP (login + apiKey
//   argument, like the generic kit), the WS `private` push, then a full
//   2-round match (selection, placement, ready, START, playback to RESULTS)
//   to MATCH_RESULTS, asserting nothing leaks before START.
//
// Needs `npm run build` first; skipped (with a note) when the build is missing.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BattleEndDTO, BattleRevealDTO, GameStateDTO, PrivateStateDTO, ServerWsMessage } from '@pixel-clash/shared';
import { Client, WsRecorder, fixture, removeDir, sleep, tempDataDir, waitForState } from '../helpers/server.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = `${ROOT}packages/server/dist/index.js`;
const PUBLIC = `${ROOT}packages/server/dist/public`;
const BUILT = existsSync(ENTRY) && existsSync(`${PUBLIC}/play.html`);
const ADMIN_PW = 'e2e-slice-pw';
const T = 90_000;

/** Strings that identify Alice's secret custom unit (name, id, sprite palette). */
const SECRET = ['Pixel Bat', 'pixel-bat', '#33CC66', 'oggwgwgo'];
const leaks = (payload: string) => SECRET.filter((n) => payload.includes(n));

/** Start the built server; resolve with its base URL once it prints its banner. */
function startBuilt(dataDir: string): Promise<{ proc: ChildProcess; url: string; output: () => string }> {
  const proc = spawn(process.execPath, ['--no-node-snapshot', ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: ADMIN_PW, UV_THREADPOOL_SIZE: '8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = /Projector: http:\/\/[^:\s]+:(\d+)\/screen/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, url: `http://127.0.0.1:${m[1]}`, output: () => out });
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}):\n${out}`));
    });
  });
}

async function mcpCall(mcp: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: JSON.stringify(r) };
}

/** A state payload without the owner-only `me` block. */
function publicPart(s: GameStateDTO): string {
  const { me: _me, ...rest } = s;
  return JSON.stringify(rest);
}

describe.skipIf(!BUILT)('M3 vertical slice on the built production server', () => {
  let dir: string;
  let srv: Awaited<ReturnType<typeof startBuilt>>;
  let admin: Client;
  let alice: Client;
  let bob: Client;
  let anon: Client;
  let aliceId: string;
  let bobId: string;
  let wsAlice: WsRecorder;
  let wsBob: WsRecorder;
  let wsScreen: WsRecorder;
  let wsAdmin: WsRecorder;
  let mcp: McpClient;

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await startBuilt(dir);
    admin = new Client(srv.url);
    anon = new Client(srv.url);
    expect((await admin.post('/admin/login', { password: ADMIN_PW })).status).toBe(200);
  }, T);

  afterAll(async () => {
    for (const ws of [wsAlice, wsBob, wsScreen, wsAdmin]) ws?.close();
    await mcp?.close().catch(() => undefined);
    if (srv && srv.proc.exitCode === null) {
      const exited = new Promise((r) => srv.proc.once('exit', r));
      srv.proc.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
      if (srv.proc.exitCode === null) srv.proc.kill('SIGKILL');
    }
    if (dir) removeDir(dir);
  });

  it('serves the built /play, /screen, /admin and /setup pages and their assets', async () => {
    expect(srv.output()).toContain('Sandbox: isolated-vm');
    const health = await anon.get('/health');
    expect(health.body).toMatchObject({ ok: true, phase: 'LOBBY' });
    for (const page of ['play', 'screen', 'admin', 'setup']) {
      const res = await fetch(`${srv.url}/${page}`);
      expect(res.status, page).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
      expect(assets.some((a) => a.endsWith('.js')), `${page} references a built script`).toBe(true);
      expect(html).not.toContain('/src/'); // not the dev entry
      for (const a of assets) {
        const r = await fetch(srv.url + a);
        expect(r.status, a).toBe(200);
        expect(r.headers.get('content-type') ?? '').toMatch(a.endsWith('.js') ? /javascript/ : a.endsWith('.css') ? /css/ : /./);
      }
    }
    expect((await fetch(`${srv.url}/`, { redirect: 'manual' })).headers.get('location')).toBe('/play');
    expect((await fetch(`${srv.url}/api/setup/kit.zip`)).status).toBe(200);
  }, T);

  it('two players join via REST; the facilitator sets short timers', async () => {
    alice = new Client(srv.url);
    bob = new Client(srv.url);
    const a = await alice.post('/players', { name: 'Alice', pin: '1111' });
    const b = await bob.post('/players', { name: 'Bob', pin: '2222' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    aliceId = a.body.player.id;
    bobId = b.body.player.id;
    expect(a.body.apiKey).toMatch(/^pc_/);

    const cfg = await admin.put('/admin/config', {
      timers: { battleTicks: 300, planLaterRoundsSec: 2 },
      suddenDeath: { startTick: 150, endTick: 300 },
      rateLimits: { submitMinIntervalMs: 1 },
    });
    expect(cfg.status, cfg.text).toBe(200);

    wsAlice = await WsRecorder.open(srv.url, 'player', alice.cookieHeader());
    wsBob = await WsRecorder.open(srv.url, 'player', bob.cookieHeader());
    wsScreen = await WsRecorder.open(srv.url, 'screen');
    wsAdmin = await WsRecorder.open(srv.url, 'admin', admin.cookieHeader());
    const lobby = (await anon.get('/state')).body as GameStateDTO;
    expect(lobby.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
  }, T);

  it('Claude (MCP, generic kit: login then apiKey argument) submits a unit with a sprite; /play gets `private`', async () => {
    mcp = new McpClient({ name: 'slice-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    const contract = await mcpCall(mcp, 'get_unit_contract');
    expect(contract.s.typescript).toContain('sprite');
    const login = await mcpCall(mcp, 'login', { name: 'alice', pin: '1111' });
    expect(login.isError).toBe(false);
    const apiKey = login.s.apiKey as string;

    const source = fixture('good/pixel_bat.js');
    const v = await mcpCall(mcp, 'validate_unit', { source, apiKey });
    expect(v.isError, v.text).toBe(false);
    expect(v.s.ok).toBe(true);

    // LOBBY: submit is closed.
    expect((await mcpCall(mcp, 'submit_unit', { source, apiKey })).s.errors[0].code).toBe('PHASE_CLOSED');

    const plan = await admin.post('/admin/match', { rounds: 2 });
    expect(plan.body.phase).toBe('PLAN');

    const pushed = wsAlice.next(
      (m) => m.type === 'private' && (m.data as PrivateStateDTO).roster.some((u) => u.unitId === 'pixel-bat'),
      5000,
    );
    const t0 = Date.now();
    const sub = await mcpCall(mcp, 'submit_unit', { source, apiKey });
    expect(sub.isError, sub.text).toBe(false);
    expect(sub.s).toMatchObject({ ok: true, unitId: 'pixel-bat', version: 1 });
    const msg = (await pushed) as { data: PrivateStateDTO };
    expect(Date.now() - t0).toBeLessThan(1500);
    const card = msg.data.roster.find((u) => u.unitId === 'pixel-bat')!;
    expect(card).toMatchObject({ name: 'Pixel Bat', status: 'valid', spriteHidden: false });
    expect(card.sprite).toMatchObject({ grid: 8 });
    expect(Object.keys(card.sprite!.frames)).toEqual(expect.arrayContaining(['idle', 'walk']));
    // Also on REST for the owner.
    const mine = (await alice.get('/units')).body as Array<{ unitId: string }>;
    expect(mine.map((u) => u.unitId)).toContain('pixel-bat');
  }, T);

  it('round 1: selection, placement, ready, START with nothing leaked before START', async () => {
    expect((await alice.put('/round/selection', { unitIds: ['pixel-bat', 'basic-soldier'] })).status).toBe(200);
    expect((await bob.put('/round/selection', { unitIds: ['basic-soldier', 'basic-tower'] })).status).toBe(200);
    // PLACEMENT is a closed gate for selection; PLAN for placement.
    expect((await alice.put('/round/placement', { placements: [] })).body.error.code).toBe('PHASE_CLOSED');
    expect((await admin.post('/admin/phase/next')).body.phase).toBe('PLACEMENT');

    const aState = (await alice.get('/state')).body as GameStateDTO;
    expect(aState.me!.myZone).toBeTruthy();
    expect(aState.me!.selection).toEqual(['pixel-bat', 'basic-soldier']);
    const pa = await alice.put('/round/placement', {
      placements: [
        { unitId: 'pixel-bat', col: 1, row: 1 },
        { unitId: 'pixel-bat', col: 2, row: 1 },
        { unitId: 'basic-soldier', col: 3, row: 2 },
      ],
    });
    expect(pa.status, pa.text).toBe(200);
    const pb = await bob.put('/round/placement', {
      placements: [
        { unitId: 'basic-soldier', col: 1, row: 1 },
        { unitId: 'basic-tower', col: 2, row: 2 },
      ],
    });
    expect(pb.status, pb.text).toBe(200);
    await alice.post('/round/ready', { ready: true });
    // Not everyone is Ready yet.
    expect((await admin.post('/admin/start', {})).body.error.code).toBe('NOT_ALL_READY');
    await bob.post('/round/ready', { ready: true });
    await sleep(200);

    // No leak to Bob, the projector, or anonymous REST before START.
    for (const ws of [wsBob, wsScreen]) {
      expect(leaks(ws.raw.join('\n'))).toEqual([]);
      expect(ws.messages.some((m) => m.type === 'battle:reveal')).toBe(false);
      for (const m of ws.messages) if (m.type === 'private') expect(m.data.player.id).toBe(bobId);
    }
    for (const s of [(await bob.get('/state')).body, (await anon.get('/state')).body] as GameStateDTO[]) {
      const text = publicPart(s);
      expect(leaks(text)).toEqual([]);
      for (const key of ['"selection"', '"placement"', '"myZone"', '"roster"']) expect(text).not.toContain(key);
    }
    expect(leaks(JSON.stringify((await anon.get('/join')).body ?? ''))).toEqual([]);
    expect((await bob.get('/units/pixel-bat')).status).toBe(404);
    expect((await anon.get('/battles/1/replay')).status).not.toBe(200);
    // Status ticks are public.
    const bs = (await bob.get('/state')).body as GameStateDTO;
    expect(bs.players.find((p) => p.id === aliceId)).toMatchObject({ submitted: true, selected: true, ready: true });

    const reveal = wsScreen.next((m) => m.type === 'battle:reveal', 10_000);
    const started = await admin.post('/admin/start', {});
    expect(started.body.phase, started.text).toBe('BATTLE');
    const r = ((await reveal) as { data: BattleRevealDTO }).data;
    const ra = r.players.find((p) => p.playerId === aliceId)!;
    expect(ra.units.map((u) => u.unitId).sort()).toEqual(['basic-soldier', 'pixel-bat']);
    expect(ra.units.find((u) => u.unitId === 'pixel-bat')!.sprite).toMatchObject({ grid: 8 });
    expect(ra.instances).toHaveLength(3);
    expect(r.players.find((p) => p.playerId === bobId)!.instances).toHaveLength(2);
  }, T);

  it('round 1: battle playback streams frames, then RESULTS with a ranking', async () => {
    const end = (await wsScreen.find((m) => m.type === 'battle:end', 30_000)) as { data: BattleEndDTO };
    expect(wsScreen.messages.filter((m) => m.type === 'battle:frames').length).toBeGreaterThan(5);
    expect(end.data.round).toBe(1);
    expect(end.data.ranking).toHaveLength(2);
    for (const r of end.data.ranking) {
      expect(r.pointsGained).toBe(r.placePoints + r.damageBonus + r.valueBonus);
      expect(end.data.scoreboard.find((e) => e.playerId === r.playerId)).toMatchObject({ points: r.pointsGained, damage: r.damage });
    }
    const s = await waitForState(anon, (x) => x.phase === 'RESULTS', 10_000);
    expect(s.lastBattle?.round).toBe(1);
    expect(s.scoreboard.reduce((sum, e) => sum + e.points, 0)).toBeGreaterThan(0);
    const rep = await alice.get('/battles/1/report');
    expect(rep.status).toBe(200);
    const mine = end.data.ranking.find((r) => r.playerId === aliceId);
    expect(rep.body.score).toEqual(
      mine
        ? {
            playerId: aliceId,
            place: mine.place,
            placePoints: mine.placePoints,
            damage: mine.damage,
            damageBonus: mine.damageBonus,
            valueDestroyed: mine.valueDestroyed,
            valueBonus: mine.valueBonus,
            total: mine.pointsGained,
            badges: mine.badges,
          }
        : null,
    );
    const replay = await anon.get('/battles/1/replay');
    expect(replay.status).toBe(200);
    expect(replay.body.frames.length).toBeGreaterThan(0);
  }, T);

  it('round 2: PLAN auto-advances on its timer, force START, 2x playback, MATCH_RESULTS', async () => {
    const plan2 = await admin.post('/admin/phase/next');
    expect(plan2.body).toMatchObject({ phase: 'PLAN', round: 2 });
    // planLaterRoundsSec = 2 → PLACEMENT without the host.
    await waitForState(anon, (x) => x.phase === 'PLACEMENT', 10_000);
    const a2 = (await alice.get('/state')).body as GameStateDTO;
    expect(a2.me!.selection).toEqual(['pixel-bat', 'basic-soldier']); // carried over
    expect(a2.me!.ready).toBe(false);
    expect((await alice.put('/round/placement', { placements: [{ unitId: 'pixel-bat', col: 0, row: 0 }] })).status).toBe(200);
    // Bob places nothing: force START auto-places him.
    const reveal = wsBob.next((m) => m.type === 'battle:reveal', 10_000);
    const started = await admin.post('/admin/start', { force: true });
    expect(started.body.phase, started.text).toBe('BATTLE');
    const r = ((await reveal) as { data: BattleRevealDTO }).data;
    expect(r.round).toBe(2);
    expect(r.players.find((p) => p.playerId === bobId)!.instances.length).toBeGreaterThan(0);
    expect((await admin.post('/admin/battle', { speed: 2 })).status).toBe(200);
    // A projector that (re)connects mid-battle gets the reveal and frames.
    const late = await WsRecorder.open(srv.url, 'screen');
    try {
      expect(((await late.find((m) => m.type === 'battle:reveal', 5000)) as { data: BattleRevealDTO }).data.round).toBe(2);
      await late.find((m) => m.type === 'battle:frames', 5000);
    } finally {
      late.close();
    }
    const end = (await wsBob.find((m) => m.type === 'battle:end' && m.data.round === 2, 30_000)) as Extract<
      ServerWsMessage,
      { type: 'battle:end' }
    >;
    expect(end.data.ranking).toHaveLength(2);
    await waitForState(anon, (x) => x.phase === 'RESULTS' && x.round === 2, 10_000);
    const fin = await admin.post('/admin/phase/next');
    expect(fin.body.phase).toBe('MATCH_RESULTS');
    const s = (await anon.get('/state')).body as GameStateDTO;
    expect(s.scoreboard).toHaveLength(2);
    // Match standings: total points, then total damage, then a shared place.
    const [first, second] = s.scoreboard;
    expect(first!.points > second!.points || (first!.points === second!.points && first!.damage >= second!.damage)).toBe(true);
    expect(first!.place).toBe(1);
    expect(second!.place).toBe(first!.points === second!.points && first!.damage === second!.damage ? 1 : 2);
    // The server stayed healthy throughout.
    expect(srv.proc.exitCode).toBeNull();
    expect(srv.output()).not.toMatch(/\bERROR\b|request failed|Unhandled/i);
  }, T);
});
