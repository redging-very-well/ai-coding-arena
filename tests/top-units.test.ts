// Top damage units of a round and past battles
// (/battles/:round/results): the pure aggregation (per design per
// player, ties, borrowed names, 0 damage, kicked, teams) and, end to end,
// release gating, Skip metrics, the report / MCP copy, persistence across a
// restart and New match clearing old rounds.

import { afterEach, describe, expect, it } from 'vitest';
import type { BattleRevealDTO, GameStateDTO, UnitBattleSummaryDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { topUnits } from '../packages/server/src/sim/topUnits.js';
import { Client, adminClient, bootServer, fixture, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 90_000;
// Long enough for the armies to meet (damage), still fast at the test playback rate.
const CFG = { timers: { battleTicks: 2400 }, suddenDeath: { startTick: 1200, endTick: 2400 } };

const stats = { type: 'soldier', maxHealth: 100, damage: 10, range: 40, speed: 1, attackCooldown: 60, size: 10, color: '#ff0000', shape: 'circle' } as never;
const unit = (unitId: string, name: string, extra: object = {}) => ({ unitId, name, stats, cost: 100, sprite: null, spriteHidden: false, ...extra });
const sum = (damageDealt: number, o: Partial<UnitBattleSummaryDTO> = {}): UnitBattleSummaryDTO => ({
  round: 1,
  survived: 0,
  fielded: 2,
  damageDealt,
  kills: 0,
  valueDestroyed: 0,
  strikes: 0,
  disabled: 0,
  ...o,
});
const reveal = (players: Array<{ id: string; name: string; seat: number; teamId?: number; units: ReturnType<typeof unit>[] }>): Pick<BattleRevealDTO, 'players'> => ({
  players: players.map((p) => ({ playerId: p.id, name: p.name, seat: p.seat, zone: null, units: p.units, instances: [], ...(p.teamId !== undefined ? { teamId: p.teamId } : {}) })),
});

describe('topUnits (pure)', () => {
  it('ranks unit types per player by summed damage, names the player, drops 0 damage', () => {
    const r = reveal([
      { id: 'a', name: 'Ann', seat: 0, units: [unit('tank', 'Tank'), unit('tower', 'Tower')] },
      { id: 'b', name: 'Ben', seat: 1, units: [unit('tank', 'Tank'), unit('ninja', 'Ninja')] },
    ]);
    const out = topUnits({
      reveal: r,
      summaries: { a: { tank: sum(120.4, { kills: 2, fielded: 3 }), tower: sum(0) }, b: { tank: sum(80), ninja: sum(300.6, { kills: 4 }) } },
      shown: 3,
    });
    expect(out.map((t) => [t.rank, t.displayName, t.playerName, t.seat, t.damage])).toEqual([
      [1, 'Ninja', 'Ben', 1, 301],
      [2, 'Tank', 'Ann', 0, 120],
      [3, 'Tank', 'Ben', 1, 80],
    ]);
    expect(out[1]).toMatchObject({ playerId: 'a', copies: 3, kills: 2, unitId: 'tank' });
    expect(out.find((t) => t.unitId === 'tower')).toBeUndefined(); // 0 damage
  });

  it('M8.8: entries carry the healing their type did (ranked by damage still; healing never counts as damage)', () => {
    const r = reveal([{ id: 'a', name: 'Ann', seat: 0, units: [unit('cleric', 'Cleric'), unit('medic', 'Medic')] }]);
    const out = topUnits({ reveal: r, summaries: { a: { cleric: sum(90, { healing: 240.6 }), medic: sum(0, { healing: 900 }) } }, shown: 3 });
    expect(out.map((t) => [t.displayName, t.damage, t.healing])).toEqual([['Cleric', 90, 241]]);
  });

  it('shares places on equal damage and shows every tie within the places', () => {
    const r = reveal([
      { id: 'a', name: 'Ann', seat: 0, units: [unit('x', 'X'), unit('y', 'Y')] },
      { id: 'b', name: 'Ben', seat: 1, units: [unit('z', 'Z'), unit('w', 'W')] },
    ]);
    const out = topUnits({ reveal: r, summaries: { a: { x: sum(50), y: sum(50) }, b: { z: sum(50), w: sum(10) } }, shown: 2 });
    expect(out.map((t) => t.rank)).toEqual([1, 1, 1]);
    const one = topUnits({ reveal: r, summaries: { a: { x: sum(60), y: sum(50) }, b: { z: sum(50), w: sum(10) } }, shown: 2 });
    expect(one.map((t) => [t.rank, t.displayName])).toEqual([
      [1, 'X'],
      [2, 'Y'],
      [2, 'Z'],
    ]);
  });

  it('keeps borrowed names, team ids, hidden sprites and marks kicked players', () => {
    const r = reveal([
      { id: 'a', name: 'Ann', seat: 0, teamId: 1, units: [unit('armory:7', 'Ogre (Ninja Sam)', { borrowedFrom: { armoryId: '7', creatorId: 's', creatorName: 'Ninja Sam' }, spriteHidden: true, sprite: { w: 1 } })] },
    ]);
    const [t] = topUnits({ reveal: r, summaries: { a: { 'armory:7': sum(42) } }, kicked: new Set(['a']), shown: 3 });
    expect(t).toMatchObject({ displayName: 'Ogre (Ninja Sam)', borrowedFrom: 'Ninja Sam', teamId: 1, left: true, spriteHidden: true, sprite: null });
  });
});

describe('top units and past battles (server)', () => {
  let srv: RunningServer | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await srv?.close();
    if (dir) removeDir(dir);
    srv = undefined;
    dir = undefined;
  });

  async function playRound(admin: Client, a: Awaited<ReturnType<typeof newPlayer>>, skip: boolean) {
    await admin.post('/admin/phase/next'); // → PLACEMENT
    await a.client.put('/round/placement', { placements: [0, 1, 2].map((col) => ({ unitId: 'big-tank', col, row: 0 })) });
    const s = (await admin.post('/admin/start', { force: true })).body as GameStateDTO;
    expect(s.phase).toBe('BATTLE');
    expect(s.lastBattle).toBeUndefined();
    // Not released while it plays.
    expect((await new Client(srv!.url).get(`/battles/${s.round}/results`)).body.error.code).toBe('PHASE_CLOSED');
    if (skip) {
      await waitForState(admin, (x) => x.phase !== 'BATTLE' || (x.battle?.tick ?? 0) > 450);
      const skipped = (await admin.post('/admin/phase/skip')).body as GameStateDTO;
      expect(skipped.lastBattle?.reason).toBe('skipped');
      return skipped;
    }
    return waitForState(admin, (x) => x.phase === 'RESULTS');
  }

  it('releases top units with the result, in the report and MCP-ready, and keeps every round of the match', async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir, config: CFG, playbackRate: 4 });
    const admin = await adminClient(srv.url);
    const a = await newPlayer(srv.url, 'Ann');
    const b = await newPlayer(srv.url, 'Ben');
    await admin.post('/admin/match', { rounds: 3 });
    await a.client.post('/units', { source: fixture('good/big_tank.js') });
    await a.client.put('/round/selection', { unitIds: ['big-tank'] });

    let s = await playRound(admin, a, true);
    expect(s.phase).toBe('RESULTS');
    const top = s.lastBattle!.topUnits!;
    expect(top.length).toBeGreaterThan(0);
    for (const t of top) {
      expect(t.damage).toBeGreaterThan(0);
      expect(['Ann', 'Ben']).toContain(t.playerName);
      expect(t).not.toHaveProperty('source');
    }
    // Skip: the top units use the same (playback-tick) counters as the ranking.
    const annTank = top.find((t) => t.playerId === a.id && t.unitId === 'big-tank');
    const annRank = s.lastBattle!.ranking.find((r) => r.playerId === a.id)!;
    if (annTank) expect(annTank.damage).toBe(Math.round(annRank.damage));
    expect(top.map((t) => t.damage)).toEqual([...top.map((t) => t.damage)].sort((x, y) => y - x));

    // The report carries them; the results endpoint is public after release.
    const rep = (await a.client.get('/battles/1/report')).body;
    expect(rep.topUnits).toEqual(top);
    const pub = await new Client(srv.url).get('/battles/1/results');
    expect(pub.status).toBe(200);
    expect(pub.body.topUnits).toEqual(top);
    expect(pub.body.ranking).toHaveLength(2);
    expect((await new Client(srv.url).get('/battles/2/results')).status).toBe(404);
    // Other players' reports are never reachable: the report is always the caller's own.
    expect((await b.client.get('/battles/1/report')).body.damageDealt).toBe(s.lastBattle!.ranking.find((r) => r.playerId === b.id)!.damage);

    // Round 2 (natural end): round 1 stays readable, in PLAN too.
    await admin.post('/admin/phase/next'); // → PLAN round 2
    s = await playRound(admin, a, false);
    expect(s.round).toBe(2);
    await admin.post('/admin/phase/next'); // → PLAN round 3
    expect((await a.client.get('/battles/1/results')).body.round).toBe(1);
    expect((await a.client.get('/battles/1/replay')).body.frames.length).toBeGreaterThan(0);
    expect((await a.client.get('/battles/2/replay')).body.round).toBe(2);

    // Restart: still there.
    await srv.close();
    srv = await bootServer({ dataDir: dir, config: CFG, playbackRate: 4 });
    const fresh = new Client(srv.url);
    expect((await fresh.get('/battles/1/results')).body.topUnits).toEqual(top);
    expect((await fresh.get('/battles/2/replay')).status).toBe(200);

    // New match: old rounds are gone (including the replay files' rounds).
    const admin2 = await adminClient(srv.url);
    await admin2.post('/admin/match/new');
    expect((await fresh.get('/battles/1/results')).status).toBe(404);
    expect((await fresh.get('/battles/1/replay')).status).toBe(404);
  }, T);
});
