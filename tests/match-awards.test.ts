// Match awards (plan §9 Match awards, §14): per-match stats accumulated per
// round (wins, damage, value, units, walls, minions, survivors, healing,
// combos, Armory borrows both ways, designs, standings places, the
// longest-range KO from the frames), the 15 awards with ties, skips, team
// mode, kicked players and the Comeback definition; then end to end: nothing
// before MATCH_RESULTS, `matchAwards` + `me.awards` at MATCH_RESULTS (no
// source), a restart keeps them and New match clears them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AWARD_IDS, awardStatText, type BattleRevealDTO, type FrameDTO, type GameStateDTO, type RankingEntryDTO, type ScoreboardEntryDTO, type StatsSnapshot } from '@pixel-clash/shared';
import {
  accumulateRound,
  computeAwards,
  emptyPlayerStats,
  longestKnockouts,
  type AwardCandidate,
  type MatchStats,
  type RoundStatsInput,
} from '../packages/server/src/services/awards.js';
import type { UnitReport } from '../packages/server/src/sim/types.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, adminClient, bootServer, fixture, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 60_000;

const stats = (type: StatsSnapshot['type'], name: string, extra: Partial<StatsSnapshot> = {}): StatsSnapshot =>
  ({ name, type, maxHealth: 100, damage: 10, range: 30, speed: 1, attackCooldown: 30, size: type === 'wall' ? 20 : 10, color: '#fff', shape: 'square', ...extra }) as StatsSnapshot;

const sprite = { w: 2, h: 2, palette: ['#000'], pixels: '0000' } as never;

function unitReport(r: Partial<UnitReport> & Pick<UnitReport, 'instanceId' | 'playerId' | 'unitId'>): UnitReport {
  return {
    unitName: r.unitId,
    cost: 100,
    survived: false,
    hp: 0,
    diedAtTick: null,
    damageDealt: 0,
    kills: 0,
    valueDestroyed: 0,
    strikes: 0,
    disabled: false,
    errors: [],
    ...r,
  } as UnitReport;
}

function rank(playerId: string, place: number, extra: Partial<RankingEntryDTO> = {}): RankingEntryDTO {
  return { playerId, place, placePoints: 0, damage: 0, damageBonus: 0, valueDestroyed: 0, valueBonus: 0, badges: [], pointsGained: 0, kills: 0, livingCost: 0, eliminatedAtTick: null, ...extra };
}

function board(rows: Array<[string, number, number]>): ScoreboardEntryDTO[] {
  return rows.map(([playerId, place, points]) => ({ playerId, name: playerId, seat: 0, points, damage: 0, place, badges: {} as never }));
}

const P = (id: string, seat: number, teamId?: number): AwardCandidate => ({ playerId: id, name: id.toUpperCase(), seat, ...(teamId !== undefined ? { teamId } : {}) });

/** A round with two players: A fields a soldier ×2 and a wall, B a factory and a borrowed copy of A's soldier. */
function sampleRound(): RoundStatsInput {
  const reveal: RoundStatsInput['reveal'] = {
    minions: { medic: { stats: stats('soldier', 'Medic', { size: 7 }) as never, value: 50 } },
    players: [
      {
        playerId: 'a',
        name: 'A',
        seat: 0,
        zone: null,
        units: [
          { unitId: 'zapper', name: 'Zapper', stats: stats('soldier', 'Zapper', { size: 10 }), cost: 100, sprite, spriteHidden: false },
          { unitId: 'rock', name: 'Rock', stats: stats('wall', 'Rock'), cost: 50, sprite: null, spriteHidden: false },
        ],
        instances: [
          { instanceId: '0-0-0', unitId: 'zapper', x: 100, y: 100 },
          { instanceId: '0-0-1', unitId: 'zapper', x: 140, y: 100 },
          { instanceId: '0-1-0', unitId: 'rock', x: 100, y: 140 },
        ],
      },
      {
        playerId: 'b',
        name: 'B',
        seat: 1,
        zone: null,
        units: [
          { unitId: 'plant', name: 'Plant', stats: stats('factory', 'Plant', { size: 18 }), cost: 300, sprite: null, spriteHidden: false },
          {
            unitId: 'armory:zap1',
            name: 'Zapper (A)',
            stats: stats('soldier', 'Zapper', { size: 10 }),
            cost: 100,
            sprite,
            spriteHidden: false,
            borrowedFrom: { armoryId: 'zap1', creatorId: 'a', creatorName: 'A' },
          },
        ],
        instances: [
          { instanceId: '1-0-0', unitId: 'plant', x: 600, y: 600 },
          { instanceId: '1-0-1', unitId: 'armory:zap1', x: 640, y: 600 },
        ],
      },
    ],
  };
  // Frame 1: A's zapper (100,100, r10) shoots B's borrowed zapper (400,100, r10) dead: gap 300 − 20 = 280.
  // Frame 2: B's medic minion (spawned at 300,300, r7) KOs A's second zapper at (320,300): gap 20 − 17 = 3.
  const frames: FrameDTO[] = [
    { t: 0, units: [['0-0-0', 100, 100, 100, 0], ['1-0-1', 400, 100, 100, 0], ['0-0-1', 140, 100, 100, 0]], projectiles: [], safeZoneRadius: 400, events: [] },
    {
      t: 2,
      units: [['0-0-0', 100, 100, 100, 0]],
      projectiles: [],
      safeZoneRadius: 400,
      events: [
        { type: 'hit', instanceId: '0-0-0', targetId: '1-0-1', damage: 60 },
        { type: 'hit', instanceId: '0-0-0', targetId: '1-0-1', damage: 40 },
        { type: 'hit', instanceId: '0-0-1', targetId: '1-0-1', damage: 0 },
        { type: 'death', instanceId: '1-0-1' },
        { type: 'spawn', instanceId: '1-0-0-m1', factoryId: '1-0-0', x: 300, y: 300, kind: 'medic' },
      ],
    },
    { t: 4, units: [['0-0-1', 320, 300, 100, 0], ['1-0-0-m1', 300, 300, 30, 0]], projectiles: [], safeZoneRadius: 400, events: [] },
    {
      t: 6,
      units: [],
      projectiles: [],
      safeZoneRadius: 400,
      events: [
        { type: 'hit', instanceId: '1-0-0-m1', targetId: '0-0-1', damage: 100 },
        { type: 'death', instanceId: '0-0-1' },
      ],
    },
  ];
  const units: UnitReport[] = [
    unitReport({ instanceId: '0-0-0', playerId: 'a', unitId: 'zapper', type: 'soldier', survived: true, damageDealt: 100, kills: 1, valueDestroyed: 100, combos: 2 }),
    unitReport({ instanceId: '0-0-1', playerId: 'a', unitId: 'zapper', type: 'soldier', survived: false }),
    unitReport({ instanceId: '0-1-0', playerId: 'a', unitId: 'rock', type: 'wall', survived: true }),
    unitReport({
      instanceId: '1-0-0',
      playerId: 'b',
      unitId: 'plant',
      type: 'factory',
      survived: true,
      factory: { bodyCost: 200, minionValue: 50, minionsLeft: 3, minionsMade: 4, minionsLost: 1 },
    }),
    unitReport({ instanceId: '1-0-0-m1', playerId: 'b', unitId: 'plant', type: 'minion', survived: true, damageDealt: 100, kills: 1, healing: 35 }),
    unitReport({ instanceId: '1-0-1', playerId: 'b', unitId: 'armory:zap1', type: 'soldier', survived: false }),
  ];
  return {
    round: 1,
    reveal,
    frames,
    units,
    ranking: [rank('a', 1, { damage: 100, valueDestroyed: 100, combos: 2 }), rank('b', 2, { damage: 100, valueDestroyed: 100, healing: 35 })],
    borrowed: [{ borrowerId: 'b', creatorId: 'a', sourceUnitId: 'zapper', name: 'Zapper', armoryUnitId: 'armory:zap1' }],
    ownDesigns: { a: ['zapper', 'rock'], b: ['plant'] },
  };
}

describe('match stats per round', () => {
  it('finds the longest-range KO edge to edge at the killing hit (and ignores 0-damage hits)', () => {
    const r = sampleRound();
    const kos = longestKnockouts(r.reveal, r.frames, r.units);
    expect(kos.get('a')).toEqual({ distance: 280, unitId: 'zapper' });
    // The medic minion's KO counts for B's factory design.
    expect(kos.get('b')?.unitId).toBe('plant');
    expect(kos.get('b')?.distance).toBeCloseTo(3, 5);
  });

  it('accumulates wins, units, walls, minions, survivors, borrows both ways, designs and places', () => {
    const s: MatchStats = {};
    const r = sampleRound();
    accumulateRound(s, r, board([['a', 1, 3], ['b', 2, 1]]));
    accumulateRound(s, { ...r, round: 2, ranking: [rank('a', 2, { damage: 50 }), rank('b', 1, { damage: 10 })] }, board([['b', 1, 4], ['a', 2, 3]]));
    const a = s.a!;
    const b = s.b!;
    expect(a).toMatchObject({ rounds: 2, wins: 1, damage: 150, unitsFielded: 4, wallsPlaced: 2, survivors: 2, combos: 2, borrowedByOthers: 2, borrowsMade: 0, places: [1, 2] });
    expect(a.designs).toEqual(['zapper', 'rock']);
    expect(a.units.zapper).toMatchObject({ fielded: 4, survived: 2, damage: 200, borrowedByOthers: 2, combos: 4 });
    expect(a.longestKo).toEqual({ distance: 280, unitId: 'zapper', round: 1 });
    expect(b).toMatchObject({ wins: 1, unitsFielded: 4, wallsPlaced: 0, minionsMade: 8, survivors: 2, healing: 35, borrowsMade: 2, borrowedByOthers: 0, places: [2, 1] });
    expect(b.designs).toEqual(['plant']);
    // Minions count for their factory's damage and healing, not as fielded copies.
    expect(b.units.plant).toMatchObject({ fielded: 2, damage: 200, healing: 70, minionsMade: 8 });
    expect(b.units['armory:zap1']).toMatchObject({ name: 'Zapper (A)', borrowedFrom: 'A', fielded: 2 });
  });

  it('never stores source (only the revealed name, stats and sprite)', () => {
    const s: MatchStats = {};
    accumulateRound(s, sampleRound(), board([['a', 1, 3], ['b', 2, 1]]));
    expect(JSON.stringify(s)).not.toMatch(/source|compiledJs|update\(/);
  });
});

describe('the 15 awards', () => {
  function full(): MatchStats {
    const s: MatchStats = {};
    accumulateRound(s, sampleRound(), board([['a', 1, 3], ['b', 2, 1]]));
    return s;
  }

  it('gives each award to the best player with the stat and the unit tied to it', () => {
    const awards = computeAwards({ stats: full(), standings: board([['a', 1, 3], ['b', 2, 1]]), candidates: [P('a', 0), P('b', 1)] });
    const by = Object.fromEntries(awards.map((x) => [x.id, x]));
    const win = (id: string) => by[id]?.winners.map((w) => w.playerId);
    expect(awards.map((x) => x.id)).toEqual(AWARD_IDS.filter((id) => by[id]));
    expect(by.champion).toMatchObject({ value: 3, text: '3 points', emoji: '🏆' });
    expect(win('champion')).toEqual(['a']);
    expect(win('mostWins')).toEqual(['a']);
    expect(win('masterBuilder')).toEqual(['a']);
    expect(by.masterBuilder!.winners[0]!.bestUnit?.unitId).toBe('rock');
    expect(win('factoryBoss')).toEqual(['b']);
    expect(by.factoryBoss!.winners[0]!.bestUnit?.unitId).toBe('plant');
    expect(win('bestMedic')).toEqual(['b']);
    expect(by.bestMedic!.text).toBe('35 HP healed');
    expect(win('comboMaster')).toEqual(['a']);
    expect(win('armoryStar')).toEqual(['a']);
    expect(by.armoryStar!.winners[0]!.bestUnit).toMatchObject({ unitId: 'zapper', name: 'Zapper', sprite });
    expect(win('teamPlayer')).toEqual(['b']);
    expect(by.teamPlayer!.winners[0]!.bestUnit).toMatchObject({ unitId: 'armory:zap1', borrowedFrom: 'A' });
    expect(win('inventor')).toEqual(['a']); // 2 designs vs 1
    expect(win('sharpshooter')).toEqual(['a']);
    expect(by.sharpshooter).toMatchObject({ value: 280, text: '280 px KO' });
    expect(by.sharpshooter!.winners[0]!.detail).toBe('in round 1');
    // Ties share: equal damage (100 each) and value destroyed.
    expect(win('biggestHitter')).toEqual(['a', 'b']);
    expect(win('giantSlayer')).toEqual(['a', 'b']);
    expect(win('biggestArmy')).toEqual(['a', 'b']);
    expect(win('survivor')).toEqual(['a', 'b']);
    // Nobody climbed: Comeback is skipped.
    expect(by.comeback).toBeUndefined();
  });

  it('skips awards nobody earned (value 0), also the Champion with 0 points', () => {
    const s: MatchStats = { a: emptyPlayerStats(), b: emptyPlayerStats() };
    expect(computeAwards({ stats: s, standings: board([['a', 1, 0], ['b', 1, 0]]), candidates: [P('a', 0), P('b', 1)] })).toEqual([]);
  });

  it('Comeback = worst place after any round minus the final place (ties share)', () => {
    const s: MatchStats = { a: emptyPlayerStats(), b: emptyPlayerStats(), c: emptyPlayerStats(), d: emptyPlayerStats() };
    s.a!.places = [4, 2, 1]; // climbed 3
    s.b!.places = [1, 3, 2]; // worst 3, final 2: climbed 1
    s.c!.places = [2, 4, 1]; // climbed 3 (worst came mid-match)
    s.d!.places = [3, 1, 4]; // never lower than now: 0
    const final = board([['a', 1, 9], ['c', 1, 9], ['b', 3, 5], ['d', 4, 2]]);
    const awards = computeAwards({ stats: s, standings: final, candidates: [P('a', 0), P('b', 1), P('c', 2), P('d', 3)] });
    const cb = awards.find((x) => x.id === 'comeback')!;
    expect(cb).toMatchObject({ value: 3, text: 'climbed 3 places' });
    expect(cb.winners.map((w) => [w.playerId, w.detail])).toEqual([
      ['a', '4th → 1st'],
      ['c', '4th → 1st'],
    ]);
    // Shared 1st = shared Champion.
    expect(awards.find((x) => x.id === 'champion')!.winners.map((w) => w.playerId)).toEqual(['a', 'c']);
  });

  it('leaves kicked players out (they are not candidates) and lets the next best win', () => {
    const s = full();
    const awards = computeAwards({ stats: s, standings: board([['b', 1, 1]]), candidates: [P('b', 1)] });
    expect(awards.every((x) => x.winners.every((w) => w.playerId === 'b'))).toBe(true);
    expect(awards.find((x) => x.id === 'masterBuilder')).toBeUndefined(); // only A placed walls
    expect(awards.find((x) => x.id === 'champion')!.winners[0]!.playerId).toBe('b');
  });

  it('carries the team in team mode and hides moderated sprites', () => {
    const awards = computeAwards({
      stats: full(),
      standings: board([['a', 1, 3], ['b', 2, 1]]),
      candidates: [P('a', 0, 1), P('b', 1, 2)],
      spriteHidden: (pid, uid) => pid === 'a' && uid === 'zapper',
    });
    const star = awards.find((x) => x.id === 'armoryStar')!.winners[0]!;
    expect(star.teamId).toBe(1);
    expect(star.bestUnit).toMatchObject({ unitId: 'zapper', sprite: null, spriteHidden: true });
  });

  it('words every stat', () => {
    expect(awardStatText('mostWins', 1)).toBe('1 round won');
    expect(awardStatText('biggestHitter', 12345)).toBe('12,345 damage');
    expect(awardStatText('giantSlayer', 4200)).toBe('$4,200 destroyed');
    expect(awardStatText('armoryStar', 2)).toBe('borrowed 2 times');
    for (const id of AWARD_IDS) expect(awardStatText(id, 2).length).toBeGreaterThan(3);
  });
});

describe('match awards end to end', () => {
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

  it('shows awards only at MATCH_RESULTS, keeps them over a restart and clears them on New match', async () => {
    const admin = await adminClient(srv.url);
    const a = await newPlayer(srv.url, 'Ava');
    const b = await newPlayer(srv.url, 'Ben');
    await admin.post('/admin/match', { rounds: 2 });
    await a.client.post('/units', { source: fixture('good/big_tank.js') });
    await a.client.put('/round/selection', { unitIds: ['big-tank'] });
    for (let round = 1; round <= 2; round++) {
      let s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
      expect(s.phase).toBe('PLACEMENT');
      await admin.post('/admin/start', { force: true });
      s = await waitForState(a.client, (x) => x.phase === 'RESULTS' && x.round === round);
      expect(s.matchAwards).toBeUndefined();
      expect(s.me?.awards).toBeUndefined();
      if (round === 1) {
        s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
        expect(s.matchAwards).toBeUndefined();
      }
    }
    const fin = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(fin.phase).toBe('MATCH_RESULTS');
    const awards = fin.matchAwards!;
    expect(awards.length).toBeGreaterThan(3);
    const champ = awards.find((x) => x.id === 'champion')!;
    expect(champ.winners.map((w) => w.playerId)).toEqual(fin.scoreboard.filter((e) => e.place === 1).map((e) => e.playerId));
    expect(awards.find((x) => x.id === 'biggestArmy')).toBeTruthy();
    expect(awards.every((x) => x.value > 0 && x.winners.length > 0)).toBe(true);
    // Ava fielded her Big Tank: her best unit is a revealed design with its stats, never source.
    const avaUnit = awards.flatMap((x) => x.winners).find((w) => w.playerId === a.id && w.bestUnit)?.bestUnit;
    if (avaUnit) expect(avaUnit.stats?.name).toBeTruthy();
    expect(JSON.stringify(awards)).not.toMatch(/"source"|compiledJs|module\.exports|update\s*\(/);
    // Each player's own block lists what they won; the screen view has the same awards.
    const sa = (await a.client.get('/state')).body as GameStateDTO;
    expect(sa.me!.awards).toEqual(awards.filter((x) => x.winners.some((w) => w.playerId === a.id)).map((x) => x.id));
    const screen = (await new Client(srv.url).get('/state')).body as GameStateDTO;
    expect(screen.matchAwards).toEqual(awards);
    expect(screen.me).toBeUndefined();

    // Restart: the stats and awards were persisted.
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    const again = (await new Client(srv.url).get('/state')).body as GameStateDTO;
    expect(again.phase).toBe('MATCH_RESULTS');
    expect(again.matchAwards).toEqual(awards);

    // New match → LOBBY: no awards, stats cleared.
    const admin2 = new Client(srv.url);
    admin2.cookies = admin.cookies;
    const lobby = (await admin2.post('/admin/phase/next')).body as GameStateDTO;
    expect(lobby.phase).toBe('LOBBY');
    expect(lobby.matchAwards).toBeUndefined();
    const b2 = new Client(srv.url);
    b2.cookies = b.client.cookies;
    expect(((await b2.get('/state')).body as GameStateDTO).me?.awards).toBeUndefined();
    srv.game.store.flush();
    expect(srv.game.store.match.stats).toEqual({});
    expect(srv.game.store.match.awards).toBeNull();
  }, T);
});
