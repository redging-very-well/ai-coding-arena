// REST API: auth, phase gates, rate limits,
// round rules (selection, placement, ready, START), a scripted 2-player
// 2-round match to MATCH_RESULTS, and restart recovery.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyCornerOf, type GameStateDTO, type PrivateStateDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import {
  Client,
  adminClient,
  bootServer,
  fixture,
  namedUnit,
  newPlayer,
  removeDir,
  tempDataDir,
  waitForState,
} from './helpers/server.js';

const T = 60_000;

describe('auth and public endpoints', () => {
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

  it('serves health, rules and the contract without auth', async () => {
    const c = new Client(srv.url);
    expect((await c.get('/health')).body).toMatchObject({ ok: true, phase: 'LOBBY' });
    const rules = (await c.get('/rules')).body;
    expect(rules.budget).toBe(10000);
    expect(rules.coefficients.base).toBe(50);
    expect(rules.coefficients.curveK).toBe(1);
    expect(rules.coefficients.powerFactor).toBe(2);
    expect(rules.elements.fire).toContain('50%');
    expect(rules.support.heal).toContain('4% of max HP per second');
    expect(rules.costFormula).toContain('curveK');
    const contract = (await c.get('/contract')).body;
    expect(contract.typescript).toContain('export interface UnitStats');
    expect(contract.typescript).not.toContain('BEGIN CONTRACT');
    expect(contract.templates.basic_soldier).toContain('Basic Soldier');
    expect(contract.templates.basic_tower).toContain('Basic Tower');
    // The $10,000 redesign: caps and bounds, the coefficients, one line per effect, the medic and per-element minion prices.
    expect(rules.caps).toMatchObject({ budget: 10000, unitCost: 3000, maxCopies: 12, maxFactoryCopies: 5, maxWallCopies: 16 });
    // The copy ramp has its own block (caps stays numbers only).
    expect(rules.caps).not.toHaveProperty('copyRamp');
    expect(rules.copyRamp).toMatchObject({ freeCopies: 3, pctPerCopy: 15 });
    expect(rules.copyRamp.text).toContain('15%');
    expect(rules.bounds.maxHealth).toEqual({ min: 80, max: 4000 });
    expect(rules.bounds.soldierRange).toEqual({ min: 20, max: 160 });
    expect(rules.bounds.splashRadius).toEqual({ min: 0, max: 80 });
    expect(rules.bounds.support.shield.power).toEqual({ min: 5, max: 40 });
    expect(rules.coefficients).toMatchObject({ splash: 0.8, element: { fire: 1.3, ice: 1.75 }, heal: 3.5, aura: { might: 8 } });
    for (const k of ['ice', 'lightning', 'shatter', 'overload', 'splash', 'walls']) expect(typeof rules.elements[k], k).toBe('string');
    for (const k of ['haste', 'might', 'shield', 'fighters']) expect(typeof rules.support[k], k).toBe('string');
    expect(rules.unitTypes.factories.minionKinds.medic).toMatchObject({ heal: 60, reach: 60, minionValue: 248 });
    expect(rules.unitTypes.fighters).toMatch(/damage-0 support/);
    expect(rules.costFormula).toContain('powerFactor');
    const notes = (contract.notes as string[]).join('\n');
    expect(notes).toContain('Price: Each stat costs its normal price');
    expect(notes).toContain('$10,000 per army, up to $3,000 per unit, up to 12 fighters, HP 80-4,000, damage 0-240;');
    expect(notes).toMatch(/SHATTER/);
    expect(notes).toContain("{ action: 'heal', targetId: ally.id }");
    expect(notes).toContain('this.minionElement gives every minion of a factory that element');
    expect(notes).not.toContain('weak (40 HP)');
    expect(contract.templates.basic_soldier).toContain('this.maxHealth = 1400');
  });

  it('creates players, checks formats and name uniqueness', async () => {
    const c = new Client(srv.url);
    expect((await c.post('/players', { name: 'Zoe', pin: '12' })).body.error.code).toBe('BAD_PIN_FORMAT');
    expect((await c.post('/players', { name: 'Bad<Name>', pin: '1234' })).body.error.code).toBe('BAD_NAME_FORMAT');
    const ok = await c.post('/players', { name: 'Zoe', pin: '1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.apiKey).toMatch(/^pc_[a-z2-7]{24}$/);
    expect(ok.body.player).toMatchObject({ name: 'Zoe', seat: 0 });
    const dup = await new Client(srv.url).post('/players', { name: 'zoe', pin: '9999' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('NAME_TAKEN');
    // The cookie session works for /me.
    const me = await c.get('/me');
    expect(me.body).toMatchObject({ player: { name: 'Zoe' }, apiKey: ok.body.apiKey });
  });

  it('logs in by name + PIN, Bearer keys work, bad keys are KEY_INVALID', async () => {
    const c = new Client(srv.url);
    expect((await c.post('/login', { name: 'ZOE', pin: '0000' })).body.error.code).toBe('BAD_LOGIN');
    const r = await c.post('/login', { name: 'ZOE', pin: '1234' });
    expect(r.status).toBe(200);
    const k = new Client(srv.url);
    k.bearer = r.body.apiKey;
    expect((await k.get('/me')).body.player.name).toBe('Zoe');
    const bad = new Client(srv.url);
    bad.bearer = 'pc_aaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await bad.get('/units');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('KEY_INVALID');
    const anon = await new Client(srv.url).get('/units');
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('AUTH_REQUIRED');
    // Logout ends the cookie session.
    await c.post('/logout');
    expect((await c.get('/me')).status).toBe(401);
  });

  it('protects admin endpoints with the admin cookie', async () => {
    const c = new Client(srv.url);
    expect((await c.post('/admin/match', { rounds: 2 })).body.error.code).toBe('ADMIN_REQUIRED');
    expect((await c.post('/admin/login', { password: 'nope' })).status).toBe(401);
    const admin = await adminClient(srv.url);
    // Only one player so far.
    const r = await admin.post('/admin/match', { rounds: 2 });
    expect(r.body.error.code).toBe('NOT_ENOUGH_PLAYERS');
    const ov = await admin.get('/admin/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.players[0].units.length).toBeGreaterThanOrEqual(2);
  });

  it('every player has the four templates (soldier, tower, wall, factory)', async () => {
    const p = await newPlayer(srv.url, 'Max');
    const units = (await p.client.get('/units')).body as Array<{ unitId: string; isTemplate: boolean; cost: number; group: string }>;
    expect(units.map((u) => [u.unitId, u.isTemplate, u.cost, u.group])).toEqual([
      ['basic-soldier', true, 807, 'unit'],
      ['basic-tower', true, 1200, 'building'],
      ['basic-wall', true, 149, 'building'],
      // The test server's battles last 240 ticks, too short for a minion
      // (E = 0), so the factory costs only its body here ($2,194 at 7200 ticks).
      ['basic-factory', true, 247, 'building'],
    ]);
    // Templates can't be deleted (and DELETE is PLAN-only anyway).
    expect((await p.client.del('/units/basic-soldier')).body.error.code).toBe('PHASE_CLOSED');
  });

  it('rate-limits login attempts', async () => {
    const s2dir = tempDataDir();
    const s2 = await bootServer({ dataDir: s2dir, config: { rateLimits: { loginPerMinute: 2, validatePerSecond: 1, submitMinIntervalMs: 3000 } } });
    try {
      const c = new Client(s2.url);
      await c.post('/players', { name: 'Lim', pin: '1111' });
      expect((await c.post('/login', { name: 'Lim', pin: '0000' })).status).toBe(401);
      expect((await c.post('/login', { name: 'Lim', pin: '1111' })).status).toBe(200);
      const third = await c.post('/login', { name: 'Lim', pin: '1111' });
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
      expect(third.body.error.details.retryAfterMs).toBeGreaterThan(0);
      // validate: 1 per second.
      const v1 = await c.post('/units/validate', { source: fixture('good/big_tank.js') });
      expect(v1.status).toBe(200);
      const v2 = await c.post('/units/validate', { source: fixture('good/big_tank.js') });
      expect(v2.status).toBe(429);
    } finally {
      await s2.close();
      removeDir(s2dir);
    }
  }, T);
});

describe('phase gates', () => {
  let srv: RunningServer;
  let dir: string;
  let a: Awaited<ReturnType<typeof newPlayer>>;
  let b: Awaited<ReturnType<typeof newPlayer>>;
  let admin: Client;
  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    a = await newPlayer(srv.url, 'Ann');
    b = await newPlayer(srv.url, 'Ben');
    admin = await adminClient(srv.url);
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('LOBBY: validate works, submit/selection/placement/ready are closed', async () => {
    const v = await a.client.post('/units/validate', { source: namedUnit('Gate Tank') });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true, unit: { unitId: 'gate-tank', version: 1, cost: 1941 } });
    const bad = await a.client.post('/units/validate', { source: fixture('bad/stat_out_of_range.js') });
    expect(bad.status).toBe(422);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors[0]).toHaveProperty('fix');

    const s = await a.client.post('/units', { source: namedUnit('Gate Tank') });
    expect(s.status).toBe(409);
    expect(s.body.error).toMatchObject({ code: 'PHASE_CLOSED', details: { phase: 'LOBBY', opensIn: 'PLAN' } });
    expect((await a.client.put('/round/selection', { unitIds: ['basic-tower'] })).body.error.code).toBe('PHASE_CLOSED');
    expect((await a.client.put('/round/placement', { placements: [] })).body.error.code).toBe('PHASE_CLOSED');
    expect((await a.client.post('/round/ready', { ready: true })).body.error.code).toBe('PHASE_CLOSED');
    // Admin: submit on behalf is PLAN-only, validate on behalf works any time.
    const ob = await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Gate Tank') });
    expect(ob.body.error.code).toBe('PHASE_CLOSED');
    const dry = await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Gate Tank'), dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.ok).toBe(true);
  }, T);

  it('PLAN: submit, selection and retire are open; placement is closed', async () => {
    expect((await admin.post('/admin/match', { rounds: 1 })).body.phase).toBe('PLAN');
    const s = await a.client.post('/units', { source: namedUnit('Gate Tank') });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ ok: true, unitId: 'gate-tank', version: 1 });
    // Revision by name slug keeps the design; explicit unitId too (rename).
    const s2 = await a.client.post('/units', { source: namedUnit('Gate Tank II'), unitId: 'gate-tank' });
    expect(s2.body).toMatchObject({ unitId: 'gate-tank', version: 2 });
    const units = (await a.client.get('/units')).body as Array<{ unitId: string; name: string }>;
    expect(units.filter((u) => !u.unitId.startsWith('basic-'))).toEqual([expect.objectContaining({ unitId: 'gate-tank', name: 'Gate Tank II' })]);
    // Unknown and template unitIds.
    expect((await a.client.post('/units', { source: namedUnit('X'), unitId: 'nope' })).body.error.code).toBe('NOT_FOUND');
    expect((await a.client.post('/units', { source: namedUnit('X'), unitId: 'basic-soldier' })).body.error.code).toBe('TEMPLATE_PROTECTED');
    // Source round-trips.
    const src = await a.client.get('/units/gate-tank');
    expect(src.body.source).toContain('Gate Tank II');
    // Admin submit on behalf works in PLAN.
    const ob = await admin.post(`/admin/players/${b.id}/units`, { source: namedUnit('Helper Tank') });
    expect(ob.body).toMatchObject({ ok: true, unitId: 'helper-tank' });
    // Selection.
    // More ids than 4 unit + 4 building types can ever hold.
    expect(
      (await a.client.put('/round/selection', { unitIds: ['gate-tank', 'basic-soldier', 'basic-tower', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'] })).body.error.code,
    ).toBe('TOO_MANY_TYPES');
    expect((await a.client.put('/round/selection', { unitIds: ['nope'] })).body.error.code).toBe('NOT_FOUND');
    expect((await a.client.put('/round/selection', { unitIds: ['gate-tank', 'basic-soldier'] })).body.selection).toEqual([
      'gate-tank',
      'basic-soldier',
    ]);
    expect((await a.client.put('/round/placement', { placements: [] })).body.error).toMatchObject({
      code: 'PHASE_CLOSED',
      details: { phase: 'PLAN', opensIn: 'PLACEMENT' },
    });
    expect(typeof (await a.client.put('/round/placement', { placements: [] })).body.error.details.secondsLeft).toBe('number');
    // Retire: templates are protected.
    expect((await a.client.del('/units/basic-tower')).body.error.code).toBe('TEMPLATE_PROTECTED');
  }, T);

  it('PLACEMENT: placement rules, Ready, START needs everyone ready', async () => {
    expect((await admin.post('/admin/phase/next')).body.phase).toBe('PLACEMENT');
    expect((await a.client.post('/units', { source: namedUnit('Late') })).body.error.code).toBe('PHASE_CLOSED');
    expect((await a.client.put('/round/selection', { unitIds: [] })).body.error.code).toBe('PHASE_CLOSED');
    const st = (await a.client.get('/state')).body as GameStateDTO;
    expect(legacyCornerOf(st.me!.myZone!)).toMatch(/^(TL|BR)$/);
    expect(st.me?.selection).toEqual(['gate-tank', 'basic-soldier']);

    const put = (placements: unknown) => a.client.put('/round/placement', { placements });
    expect((await put([{ unitId: 'basic-tower', col: 0, row: 0 }])).body.error.code).toBe('NOT_SELECTED');
    expect((await put([{ unitId: 'gate-tank', col: 6, row: 0 }])).body.error.code).toBe('CELL_OUT_OF_ZONE');
    expect(
      (await put([
        { unitId: 'gate-tank', col: 0, row: 0 },
        { unitId: 'basic-soldier', col: 0, row: 0 },
      ])).body.error.code,
    ).toBe('CELL_TAKEN');
    const five = [0, 1, 2, 3, 4].map((i) => ({ unitId: 'gate-tank', col: i, row: 0 }));
    // Copy ramp: 3 × $1,941, then copy 4 +15% ($2,233) and copy 5 +30% ($2,524) = $10,580.
    expect((await put(five)).body.error).toMatchObject({ code: 'OVER_BUDGET', details: { spent: 10580 } });
    // 3 tanks + 5 soldiers would be $9,858 at the plain price, but soldier copies 4 and 5
    // cost $929 and $1,050: $10,223 is over the budget.
    const rampedOver = [
      ...[0, 1, 2].map((i) => ({ unitId: 'gate-tank', col: i, row: 0 })),
      ...[0, 1, 2, 3, 4].map((i) => ({ unitId: 'basic-soldier', col: i, row: 1 })),
    ];
    expect((await put(rampedOver)).body.error).toMatchObject({ code: 'OVER_BUDGET', details: { spent: 10223 } });
    const ok = await put([
      { unitId: 'gate-tank', col: 0, row: 0 },
      { unitId: 'basic-soldier', col: 1, row: 0 },
      { unitId: 'basic-soldier', col: 0, row: 1 },
    ]);
    expect(ok.body).toMatchObject({ spent: 3555, remaining: 6445 });
    expect((await a.client.post('/round/ready', { ready: true })).body).toEqual({ ready: true });
    const notReady = await admin.post('/admin/start', {});
    expect(notReady.body.error).toMatchObject({ code: 'NOT_ALL_READY', details: { notReady: ['Ben'] } });
    // Next from PLACEMENT behaves like START without force.
    expect((await admin.post('/admin/phase/next')).body.error.code).toBe('NOT_ALL_READY');
  }, T);
});

describe('a scripted 2-player, 2-round match', () => {
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

  it('plays LOBBY → PLAN → PLACEMENT → BATTLE → RESULTS ×2 → MATCH_RESULTS → LOBBY', async () => {
    const admin = await adminClient(srv.url);
    const a = await newPlayer(srv.url, 'Alice');
    const b = await newPlayer(srv.url, 'Bob');

    // Round 1 PLAN.
    let s = (await admin.post('/admin/match', { rounds: 2 })).body as GameStateDTO;
    expect(s).toMatchObject({ phase: 'PLAN', round: 1, rounds: 2 });
    expect(s.timer.secondsLeft).toBeGreaterThan(500);
    expect((await a.client.post('/units', { source: fixture('good/big_tank.js') })).body.unitId).toBe('big-tank');
    await a.client.put('/round/selection', { unitIds: ['big-tank'] });
    // Bob does nothing: his selection falls back to the templates.

    // PLACEMENT via the PLAN timer running out (set to 0 s).
    await admin.post('/admin/timer', { setSeconds: 0 });
    s = await waitForState(a.client, (x) => x.phase === 'PLACEMENT');
    const zoneA1 = legacyCornerOf(s.me!.myZone!);
    expect(zoneA1).toMatch(/^(TL|BR)$/);
    const sb = (await b.client.get('/state')).body as GameStateDTO;
    expect(sb.me!.selection).toEqual(['basic-soldier', 'basic-tower', 'basic-wall', 'basic-factory']);
    expect(legacyCornerOf(sb.me!.myZone!)).not.toBe(zoneA1);
    await a.client.put('/round/placement', {
      placements: [
        { unitId: 'big-tank', col: 0, row: 0 },
        { unitId: 'big-tank', col: 1, row: 0 },
      ],
    });
    await a.client.post('/round/ready', { ready: true });

    // Force start: Bob is auto-placed.
    s = (await admin.post('/admin/start', { force: true })).body as GameStateDTO;
    expect(s.phase).toBe('BATTLE');
    const bobPlacement = (await b.client.get('/state')).body.me.placement as unknown[];
    expect(bobPlacement.length).toBeGreaterThan(0);

    // The result is released when playback ends (fast-forwarded).
    s = await waitForState(a.client, (x) => x.phase === 'RESULTS');
    expect(s.lastBattle?.round).toBe(1);
    expect(s.lastBattle?.ranking).toHaveLength(2);
    const pts1 = s.scoreboard.reduce((sum, e) => sum + e.points, 0);
    expect(pts1).toBeGreaterThanOrEqual(1); // 2 players: 1st gets 1 place point
    // Round points = place + damage bonus + value bonus; the scoreboard adds them up.
    const r1 = s.lastBattle!.ranking;
    for (const r of r1) {
      expect(r.pointsGained).toBe(r.placePoints + r.damageBonus + r.valueBonus);
      // 2 players: place 1/0, bonus maxima 2 × 2/4 = 1 and round(1 × 2/4) = 1.
      expect(r.placePoints).toBe(r.place === 1 ? 1 : 0);
      expect(r.damageBonus).toBeGreaterThanOrEqual(0);
      expect(r.damageBonus).toBeLessThanOrEqual(1);
      expect(r.valueBonus).toBeLessThanOrEqual(1);
      const board = s.scoreboard.find((e) => e.playerId === r.playerId)!;
      expect(board).toMatchObject({ points: r.pointsGained, damage: r.damage });
      for (const b of r.badges) expect(board.badges[b]).toBe(1);
    }
    expect(r1.filter((r) => r.badges.includes('lastStanding')).every((r) => r.place === 1)).toBe(true);
    expect(s.scoreboard.map((e) => e.place)).toEqual(s.scoreboard[0]!.points === s.scoreboard[1]!.points && s.scoreboard[0]!.damage === s.scoreboard[1]!.damage ? [1, 1] : [1, 2]);
    const report = await a.client.get('/battles/1/report');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ round: 1 });
    const mine1 = r1.find((r) => r.playerId === a.id)!;
    expect(report.body.score).toMatchObject({
      place: mine1.place,
      placePoints: mine1.placePoints,
      damage: mine1.damage,
      damageBonus: mine1.damageBonus,
      valueDestroyed: mine1.valueDestroyed,
      valueBonus: mine1.valueBonus,
      total: mine1.pointsGained,
      badges: mine1.badges,
    });
    expect(report.body.damageDealt).toBe(mine1.damage);
    expect(report.body.valueDestroyed).toBe(mine1.valueDestroyed);
    expect((await a.client.get('/battles/latest/report')).body.round).toBe(1);
    const replay = await new Client(srv.url).get('/battles/1/replay');
    expect(replay.status).toBe(200);
    expect(replay.body.frames.length).toBeGreaterThan(10);
    expect(replay.body.reveal.players).toHaveLength(2);
    const units = (await a.client.get('/units')).body as Array<{ unitId: string; lastBattle?: { fielded: number } }>;
    expect(units.find((u) => u.unitId === 'big-tank')?.lastBattle?.fielded).toBe(2);

    // Round 2: zones rotate, selection carries over, "Copy last layout" exists.
    s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(s).toMatchObject({ phase: 'PLAN', round: 2 });
    s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(s.phase).toBe('PLACEMENT');
    const sa2 = (await a.client.get('/state')).body as GameStateDTO;
    expect(legacyCornerOf(sa2.me!.myZone!)).not.toBe(zoneA1);
    expect(sa2.me!.selection).toEqual(['big-tank']);
    expect(sa2.me!.hasLastLayout).toBe(true);
    await a.client.post('/round/ready', { ready: true });
    await b.client.post('/round/ready', { ready: true });
    s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(s.phase).toBe('BATTLE');
    // Alice was auto-placed from her last layout.
    expect(((await a.client.get('/state')).body as GameStateDTO).me!.placement).toHaveLength(2);
    // Skip ends the battle at the playback tick and releases at once.
    s = (await admin.post('/admin/phase/skip')).body as GameStateDTO;
    expect(s.phase).toBe('RESULTS');
    expect(s.lastBattle).toMatchObject({ round: 2, reason: 'skipped' });
    const pts2 = s.scoreboard.reduce((sum, e) => sum + e.points, 0);
    expect(pts2).toBeGreaterThan(pts1);
    // Skip scores from the metrics at the playback tick; totals keep adding up.
    for (const r of s.lastBattle!.ranking) {
      expect(r.pointsGained).toBe(r.placePoints + r.damageBonus + r.valueBonus);
      const before = r1.find((x) => x.playerId === r.playerId)!;
      expect(s.scoreboard.find((e) => e.playerId === r.playerId)).toMatchObject({
        points: before.pointsGained + r.pointsGained,
        damage: before.damage + r.damage,
      });
    }
    // Standings: points, then match damage.
    const [first, second] = s.scoreboard;
    expect(first!.points > second!.points || (first!.points === second!.points && first!.damage >= second!.damage)).toBe(true);

    s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(s.phase).toBe('MATCH_RESULTS');
    expect(s.lastBattle?.round).toBe(2);
    s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(s).toMatchObject({ phase: 'LOBBY', round: 0 });
    expect(s.scoreboard.every((e) => e.points === 0 && e.damage === 0 && e.place === 1)).toBe(true);
    expect(s.scoreboard.every((e) => Object.values(e.badges).every((n) => n === 0))).toBe(true);
    // Units survive a new match.
    expect(((await a.client.get('/units')).body as unknown[]).length).toBe(5);
  }, T);
});

describe('kick, PIN reset, config and restart recovery', () => {
  it('survives a restart mid-PLAN and resets a running battle to PLACEMENT', async () => {
    const dir = tempDataDir();
    let srv = await bootServer({ dataDir: dir, playbackRate: 0.01 });
    const admin = await adminClient(srv.url);
    const a = await newPlayer(srv.url, 'Ria');
    const b = await newPlayer(srv.url, 'Sam');
    await admin.post('/admin/match', { rounds: 3 });
    await a.client.post('/units', { source: namedUnit('Keeper') });
    await srv.close();

    srv = await bootServer({ dataDir: dir, port: 0, playbackRate: 0.01 });
    const ra = new Client(srv.url);
    ra.cookies = a.client.cookies; // the web session survives
    const st = (await ra.get('/state')).body as GameStateDTO;
    expect(st).toMatchObject({ phase: 'PLAN', round: 1 });
    expect(((await ra.get('/units')).body as Array<{ unitId: string }>).map((u) => u.unitId)).toContain('keeper');
    const src = await ra.get('/units/keeper');
    expect(src.body.source).toContain('Keeper');

    // Into a (very slow) battle, then restart: back to PLACEMENT.
    const admin2 = new Client(srv.url);
    admin2.cookies = admin.cookies;
    await admin2.post('/admin/phase/next');
    await admin2.post('/admin/start', { force: true });
    expect(((await ra.get('/state')).body as GameStateDTO).phase).toBe('BATTLE');
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    const rb = new Client(srv.url);
    rb.cookies = b.client.cookies;
    const st2 = (await rb.get('/state')).body as GameStateDTO;
    expect(st2.phase).toBe('PLACEMENT');
    expect(st2.me?.myZone).toBeTruthy();
    await srv.close();
    removeDir(dir);
  }, T);

  it('kicks (now, and after the battle), resets PINs and re-prices on config changes', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir, playbackRate: 0.05 });
    try {
      const admin = await adminClient(srv.url);
      const a = await newPlayer(srv.url, 'Kim');
      const b = await newPlayer(srv.url, 'Lou');
      const c = await newPlayer(srv.url, 'Mo');
      // Kick in LOBBY: immediate, key revoked, seat freed.
      expect((await admin.post(`/admin/players/${c.id}/kick`, {})).body).toEqual({ ok: true, effective: 'now' });
      expect((await c.client.get('/me')).status).toBe(401);
      const k = new Client(srv.url);
      k.bearer = c.apiKey;
      expect((await k.get('/me')).body.error.code).toBe('KEY_INVALID');
      const d = await newPlayer(srv.url, 'Mo'); // name reusable, seat reused
      expect(d.seat).toBe(c.seat);
      await admin.post(`/admin/players/${d.id}/kick`, { deleteData: true });

      // PIN reset: sessions die, the key keeps working.
      expect((await admin.post(`/admin/players/${b.id}/pin`, { pin: '7777' })).body).toEqual({ ok: true });
      expect((await b.client.get('/me')).status).toBe(401);
      const kb = new Client(srv.url);
      kb.bearer = b.apiKey;
      expect((await kb.get('/me')).status).toBe(200);
      expect((await new Client(srv.url).post('/login', { name: 'Lou', pin: '7777' })).status).toBe(200);

      // Config: a retune that breaks a template is refused; a cheaper base re-prices.
      const breaking = await admin.put('/admin/config', { stats: { bounds: { maxHealth: { min: 80, max: 1300 } } } });
      expect(breaking.body.error.code).toBe('TEMPLATE_WOULD_BREAK');
      const cheaper = await admin.put('/admin/config', { cost: { base: 0 } });
      expect(cheaper.status).toBe(200);
      expect(cheaper.body.repriced.length).toBeGreaterThan(0);
      const units = (await kb.get('/units')).body as Array<{ unitId: string; cost: number }>;
      expect(units.find((u) => u.unitId === 'basic-soldier')?.cost).toBe(749);
      await admin.put('/admin/config', { cost: { base: 50 } });
      // M8.8: element and effect knobs (the quick settings) retune live; the tips follow them.
      const fire = await admin.put('/admin/config', { cost: { element: { fire: 1.5 } }, elements: { ice: { slowPct: 50 } } });
      expect(fire.status).toBe(200);
      expect((await new Client(srv.url).get('/rules')).body.elements.ice).toContain('50% slower');
      expect((await new Client(srv.url).get('/contract')).body.notes.join('\n')).toContain('price x1.5 fire, x1.75 ice, x1.3 lightning');
      expect((await admin.put('/admin/config', { elements: { ice: { slowPct: 100 } } })).body.error.code).toBe('BAD_REQUEST');
      await admin.put('/admin/config', { cost: { element: { fire: 1.3 } }, elements: { ice: { slowPct: 35 } } });

      // Kick during BATTLE takes effect after the battle.
      await admin.post('/admin/match', { rounds: 1 });
      await admin.post('/admin/phase/next');
      await admin.post('/admin/start', { force: true });
      const kick = await admin.post(`/admin/players/${a.id}/kick`, {});
      expect(kick.body.effective).toBe('after-battle');
      expect((await a.client.get('/me')).status).toBe(200);
      const s = (await admin.post('/admin/phase/skip')).body as GameStateDTO;
      expect(s.phase).toBe('RESULTS');
      expect(s.lastBattle!.ranking.map((r) => r.playerId)).toEqual([b.id]);
      expect((await a.client.get('/me')).status).toBe(401);
      expect(s.players.map((p) => p.name)).toEqual(['Lou']);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('private pushes', () => {
  it('a player sees only their own data in `private`', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    try {
      const a = await newPlayer(srv.url, 'Pia');
      const st = (await a.client.get('/state')).body as GameStateDTO;
      expect(st.me).toMatchObject({ budget: 10000, submissionsOpen: false, active: true });
      const { WsRecorder } = await import('./helpers/server.js');
      const ws = await WsRecorder.open(srv.url, 'player', a.client.cookieHeader());
      const priv = (await ws.find((m) => m.type === 'private')) as { data: PrivateStateDTO };
      expect(priv.data.roster.map((u) => u.unitId)).toEqual(['basic-soldier', 'basic-tower', 'basic-wall', 'basic-factory']);
      ws.close();
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});
