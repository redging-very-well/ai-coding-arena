// Regression tests for server review fixes: admin login rate limit and
// password entropy, "New match" during BATTLE applies queued kicks, Skip
// reports only what was shown, zones are re-dealt after a PLACEMENT kick,
// "kick + delete" survives a restart, and the released scoreboard drops
// players kicked during the battle.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyCornerOf, parseConfig, type GameStateDTO, type PlacementDTO } from '@pixel-clash/shared';
import { PASSWORD_WORDS, generatePassword } from '../packages/server/src/services/auth.js';
import { BattleEngine, buildBattleReport, resultAtTick } from '../packages/server/src/sim/engine.js';
import { catchUpFrame, frameAt } from '../packages/server/src/sim/frames.js';
import { RateLimiter } from '../packages/server/src/util/ratelimit.js';
import { SOLDIER, TOWER, design, fakePlayers, soldierBrain, towerBrain } from './helpers/fakeRunner.js';
import { Client, adminClient, bootServer, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;

describe('admin login hardening', () => {
  it('a generated password draws 3 words from a large list', () => {
    expect(new Set(PASSWORD_WORDS).size).toBe(PASSWORD_WORDS.length);
    expect(PASSWORD_WORDS.length).toBeGreaterThanOrEqual(400);
    for (const w of PASSWORD_WORDS) expect(w).toMatch(/^[a-z]+$/);
    expect(generatePassword()).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it('RateLimiter.check reports the wait without recording', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.check('k', 0)).toBe(0);
    rl.hit('k', 0);
    rl.hit('k', 100);
    expect(rl.check('k', 200)).toBe(800);
    expect(rl.check('k', 999)).toBe(1);
    expect(rl.check('k', 1000)).toBe(0);
  });

  it('locks out an address after 10 wrong passwords, even for the right one', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    try {
      const c = new Client(srv.url);
      for (let i = 0; i < 10; i++) expect((await c.post('/admin/login', { password: `guess-${i}` })).body.error.code).toBe('BAD_LOGIN');
      const blocked = await c.post('/admin/login', { password: 'test-admin-pw' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(blocked.body.error.details.retryAfterMs).toBeGreaterThan(0);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('kicks, zones and new match', () => {
  it('"New match" during BATTLE applies the queued kick', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
    try {
      const admin = await adminClient(srv.url);
      const a = await newPlayer(srv.url, 'Ann');
      await newPlayer(srv.url, 'Ben');
      const c = await newPlayer(srv.url, 'Cal');
      await admin.post('/admin/match', { rounds: 2 });
      await admin.post('/admin/phase/next');
      expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
      expect((await admin.post(`/admin/players/${c.id}/kick`, {})).body.effective).toBe('after-battle');
      const s = (await admin.post('/admin/match/new')).body as GameStateDTO;
      expect(s.phase).toBe('LOBBY');
      expect(s.players.map((p) => p.name)).toEqual(['Ann', 'Ben']);
      expect((await c.client.get('/me')).status).toBe(401);
      expect((await a.client.get('/me')).status).toBe(200);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);

  it('kicking in PLACEMENT re-deals zones for the remaining players (2 players → TL/BR)', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
    try {
      const admin = await adminClient(srv.url);
      const a = await newPlayer(srv.url, 'Ada');
      const b = await newPlayer(srv.url, 'Bo');
      const c = await newPlayer(srv.url, 'Cy');
      await admin.post('/admin/match', { rounds: 1 });
      await admin.post('/admin/phase/next');
      expect((await admin.post(`/admin/players/${c.id}/kick`, {})).body.effective).toBe('now');
      const za = ((await a.client.get('/state')).body as GameStateDTO).me!.myZone;
      const zb = ((await b.client.get('/state')).body as GameStateDTO).me!.myZone;
      expect([za, zb].map((z) => legacyCornerOf(z!)).sort()).toEqual(['BR', 'TL']);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);

  it('"kick + delete" during BATTLE survives a restart; the released scoreboard drops kicked players', async () => {
    const dir = tempDataDir();
    let srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
    try {
      const admin = await adminClient(srv.url);
      await newPlayer(srv.url, 'Dee');
      await newPlayer(srv.url, 'Eli');
      const f = await newPlayer(srv.url, 'Fay');
      const g = await newPlayer(srv.url, 'Gus');
      await admin.post('/admin/match', { rounds: 2 });
      await admin.post('/admin/phase/next');
      await admin.post('/admin/start', { force: true });
      await admin.post(`/admin/players/${f.id}/kick`, { deleteData: true });
      await srv.close();

      srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
      const admin2 = new Client(srv.url);
      admin2.cookies = admin.cookies;
      const st = (await admin2.get('/state')).body as GameStateDTO;
      expect(st.phase).toBe('PLACEMENT');
      expect(st.players.map((p) => p.name)).toEqual(['Dee', 'Eli', 'Gus']);
      await srv.close();
      const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { players: Array<{ id: string }> };
      expect(saved.players.map((p) => p.id)).not.toContain(f.id); // purged, not just flagged
      expect(existsSync(join(dir, 'units', f.id))).toBe(false);

      // Kick Gus during the battle: the released scoreboard no longer lists him.
      srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
      const admin3 = new Client(srv.url);
      admin3.cookies = admin.cookies;
      await admin3.post('/admin/start', { force: true });
      await admin3.post(`/admin/players/${g.id}/kick`, {});
      const s = (await admin3.post('/admin/phase/skip')).body as GameStateDTO;
      expect(s.phase).toBe('RESULTS');
      expect(s.lastBattle!.scoreboard.map((e) => e.name).sort()).toEqual(['Dee', 'Eli']);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('kicks during the battle and the released result', () => {
  it('a kick that lands while Skip waits for the sim is left out of the ranking, and the scoreboard places have no gap', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
    try {
      const admin = await adminClient(srv.url);
      const d = await newPlayer(srv.url, 'Dee');
      const e = await newPlayer(srv.url, 'Eli');
      const g = await newPlayer(srv.url, 'Gus');
      await admin.post('/admin/match', { rounds: 2 });
      await admin.post('/admin/phase/next');
      expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
      const game = srv.game;
      // Gus leads the match: he would take 1st on the scoreboard.
      game.store.match.points[d.id] = 5;
      game.store.match.points[e.id] = 2;
      game.store.match.points[g.id] = 100;
      // Skip starts, then the kick lands while it awaits the sim (still BATTLE).
      const skipping = game.battle.skip();
      expect(game.players.kick(g.id, false).ok).toBe(true);
      await skipping;
      expect(game.store.match.phase).toBe('RESULTS');
      const end = game.store.match.results.at(-1)!.end;
      expect(end.ranking.map((r) => r.playerId)).not.toContain(g.id);
      expect(end.scoreboard.map((s) => s.playerId)).not.toContain(g.id);
      expect(end.scoreboard[0]!.place).toBe(1);
      expect(end.scoreboard[0]!.playerId).toBe(d.id);
      expect(end.scoreboard.map((s) => s.place)).toEqual([1, 2]);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('Skip reports what was shown', () => {
  it('resultAtTick trims counters, survival and errors to the shown frame', async () => {
    const config = parseConfig({ timers: { battleTicks: 900 }, suddenDeath: { startTick: 100_000, endTick: 100_001 } });
    const army: PlacementDTO[] = [
      { unitId: 'soldier', col: 0, row: 0 },
      { unitId: 'soldier', col: 1, row: 0 },
      { unitId: 'tower', col: 2, row: 2 },
    ];
    const units = [design('soldier', SOLDIER), design('tower', TOWER)];
    const brains = { soldier: soldierBrain, tower: towerBrain };
    const { setups } = fakePlayers(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units, placements: army, brains },
        { playerId: 'b', seat: 1, zone: 'BR', units, placements: army, brains },
      ],
      3,
    );
    const engine = new BattleEngine({ players: setups, config, seed: 3 });
    const result = await engine.run();
    const full = buildBattleReport(result, 'a', 1);
    expect(full.damageDealt + buildBattleReport(result, 'b', 1).damageDealt).toBeGreaterThan(0);

    // At frame 0 nothing has happened yet.
    const f0 = frameAt(engine.frames, 0)!;
    const at0 = resultAtTick(result, engine.countersAt(0), new Set(f0.units.map((u) => u[0])), 0);
    const r0 = buildBattleReport(at0, 'a', 1);
    expect(r0).toMatchObject({ damageDealt: 0, kills: 0, strikes: 0, disabled: 0, survived: 3 });

    // At the last frame the counters equal the full result.
    const end = result.endTick;
    const fe = frameAt(engine.frames, end)!;
    const atEnd = resultAtTick(result, engine.countersAt(end), new Set(fe.units.map((u) => u[0])), end);
    expect(buildBattleReport(atEnd, 'a', 1)).toEqual(full);

    // Mid-battle: damage summed from the shown 'hit' events matches.
    const mid = engine.frames[Math.floor(engine.frames.length / 2)]!.t;
    const atMid = resultAtTick(result, engine.countersAt(mid), new Set(frameAt(engine.frames, mid)!.units.map((u) => u[0])), mid);
    let hits = 0;
    for (const f of engine.frames) {
      if (f.t > mid) break;
      for (const e of f.events) if (e.type === 'hit' && e.instanceId.startsWith('0-')) hits += e.damage;
    }
    const aIds = new Set(result.units.filter((u) => u.playerId === 'a').map((u) => u.instanceId));
    expect([...aIds].every((id) => id.startsWith('0-'))).toBe(true);
    expect(buildBattleReport(atMid, 'a', 1).damageDealt).toBe(hits);
  });
});

describe('MCP replies', () => {
  it('dry runs predict template protection, name new designs as new, and summarize sprites', async () => {
    const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { fixture } = await import('./helpers/server.js');
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    const mcp = new McpClient({ name: 'fixes', version: '1.0.0' });
    try {
      const p = await newPlayer(srv.url, 'Mia', '1357');
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };
        return { isError: r.isError === true, s: r.structuredContent, text: r.content[0]!.text };
      };
      const tmpl = await call('validate_unit', { source: fixture('good/pixel_bat.js'), unitId: 'basic-soldier', apiKey: p.apiKey });
      expect(tmpl.isError).toBe(true);
      expect(tmpl.s.errors[0].code).toBe('TEMPLATE_PROTECTED');
      expect(tmpl.s.playerHint).not.toContain('Something went wrong');

      const fresh = await call('validate_unit', { source: fixture('good/pixel_bat.js'), apiKey: p.apiKey });
      expect(fresh.isError).toBe(false);
      expect(fresh.text).toContain('submit WITHOUT unitId');
      expect(fresh.s.unit.sprite).toMatchObject({ hasSprite: true });
      expect(fresh.s.unit.sprite.palette).toBeUndefined();
      expect(fresh.text.length).toBeLessThan(4000);

      const badLogin = await call('login', { name: 'Mia', pin: '0000' });
      expect(badLogin.s.playerHint).toContain('PIN');
      const report = await call('get_battle_report', { apiKey: p.apiKey });
      expect(report.s.errors[0].code).toBe('NOT_FOUND');
      expect(report.s.playerHint).toBe('Nothing to show yet!');
    } finally {
      await mcp.close();
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('late joiner catch-up frame (M8.5)', () => {
  const f = (t: number, units: Array<[string, number, number, number, number]>, events: unknown[] = []) =>
    ({ t, units, projectiles: [], safeZoneRadius: 500, events }) as Parameters<typeof catchUpFrame>[0][number];
  const frames = [
    f(0, [['s', 1, 1, 50, 0], ['w1', 100, 100, 400, 0], ['w2', 140, 100, 400, 0], ['w3', 180, 100, 400, 0]]),
    f(2, [['s', 2, 1, 50, 1], ['w1', 100, 100, 300, 0]]),
    f(4, [['s', 3, 1, 50, 1]], [{ type: 'death', instanceId: 'w2' }]),
    f(6, [['s', 4, 1, 50, 1]]),
  ];

  it('lists every living wall at its last hp, and none that fell', () => {
    const c = catchUpFrame(frames, 7)!;
    expect(c.t).toBe(6);
    expect(c.units.map((u) => u[0]).sort()).toEqual(['s', 'w1', 'w3']);
    expect(c.units.find((u) => u[0] === 'w1')![3]).toBe(300);
    // The recorded frame itself is not changed.
    expect(frames[3]!.units).toHaveLength(1);
  });

  it('returns the spawn frame unchanged and nothing before it', () => {
    expect(catchUpFrame(frames, 1)).toBe(frames[0]);
    expect(catchUpFrame(frames, -1)).toBeUndefined();
  });
});
