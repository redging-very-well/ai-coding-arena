// Round scoring (points, badges, Skip / kick, match standings, team
// scoring), hand-computed. The sim-side metrics (effective damage, kill
// credit, sudden death, Skip) and team battles are tested in sim.test.ts.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  emptyTeams,
  parseConfig,
  placePointsFor,
  placePointsTable,
  safeParseConfig,
  scaledBonusMax,
  type PlayerMetricsDTO,
} from '@pixel-clash/shared';
import {
  computeRoundScore,
  matchStandings,
  proportionalBonus,
  scoreRanking,
  teamRoundRanking,
  teamTable,
} from '../packages/server/src/sim/scoring.js';
import { rankSides, rankStandings } from '../packages/server/src/sim/ranking.js';

const S = DEFAULT_CONFIG.scoring; // at 4 players: damage 0-2, value 0-1 (scaled × P/4)

const m = (playerId: string, damage: number, valueDestroyed = 0, livingValue = 0, kills = 0): PlayerMetricsDTO => ({
  playerId,
  damage,
  valueDestroyed,
  livingValue,
  kills,
});
const pl = (playerId: string, place: number) => ({ playerId, place });

/** [playerId, placePoints, damageBonus, valueBonus, total] */
const pts = (rows: ReturnType<typeof computeRoundScore>) => rows.map((r) => [r.playerId, r.placePoints, r.damageBonus, r.valueBonus, r.total]);
const badges = (rows: ReturnType<typeof computeRoundScore>) => Object.fromEntries(rows.map((r) => [r.playerId, r.badges]));

describe('config', () => {
  it('defaults: damage bonus up to 2 and value bonus up to 1 at 4 players; no place-points table; 8 players', () => {
    expect(DEFAULT_CONFIG.scoring).toEqual({ damageBonusMax: 2, valueBonusMax: 1, topUnitsShown: 3 });
    expect('points' in DEFAULT_CONFIG).toBe(false);
    expect(DEFAULT_CONFIG.match).toEqual({ maxPlayers: 8 });
    expect(safeParseConfig({ match: { maxPlayers: 9 } }).success).toBe(false);
    expect(safeParseConfig({ match: { maxPlayers: 1 } }).success).toBe(false);
  });

  it('drops the old fixed place-points table (`points`, `scoring.placePoints`): place points are a formula now', () => {
    expect(parseConfig({ points: [5, 3, 1, 0] }).scoring).toEqual({ damageBonusMax: 2, valueBonusMax: 1, topUnitsShown: 3 });
    expect(parseConfig({ points: [5, 3, 1, 0], scoring: { placePoints: [4, 2, 1, 0], damageBonusMax: 3 } }).scoring).toEqual({ damageBonusMax: 3, valueBonusMax: 1, topUnitsShown: 3 });
    expect(safeParseConfig({ points: [1, 2] }).success).toBe(true);
    expect(safeParseConfig({ scoring: { damageBonusMax: -1 } }).success).toBe(false);
  });
});

describe('place points and bonus maxima scale with the player count', () => {
  it('free-for-all: 1st gets P − 1 down to 0 for last', () => {
    expect(placePointsTable(2)).toEqual([1, 0]);
    expect(placePointsTable(3)).toEqual([2, 1, 0]);
    expect(placePointsTable(4)).toEqual([3, 2, 1, 0]); // = the old fixed table
    expect(placePointsTable(8)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    for (let p = 2; p <= 8; p++) for (let k = 1; k <= p; k++) expect(placePointsFor(k, p)).toBe(p - k);
  });

  it('team mode: round((P − 1)(T − k)/(T − 1)), half up', () => {
    expect(placePointsTable(4, 2)).toEqual([3, 0]); // 2v2
    expect(placePointsTable(6, 2)).toEqual([5, 0]); // 3v3
    expect(placePointsTable(6, 3)).toEqual([5, 3, 0]); // 2v2v2: 2.5 rounds up
    expect(placePointsTable(8, 2)).toEqual([7, 0]); // 4v4
    expect(placePointsTable(8, 4)).toEqual([7, 5, 2, 0]); // 2v2v2v2: 4.67, 2.33
  });

  it('one player or one side scores no place points', () => {
    expect(placePointsFor(1, 1)).toBe(0);
    expect(placePointsFor(1, 4, 1)).toBe(0);
  });

  it('bonus maxima are × P/4: 2p 1 + 0.5, 4p 2 + 1, 8p 4 + 2', () => {
    expect([2, 3, 4, 8].map((p) => [scaledBonusMax(S.damageBonusMax, p), scaledBonusMax(S.valueBonusMax, p)])).toEqual([
      [1, 0.5],
      [1.5, 0.75],
      [2, 1],
      [4, 2],
    ]);
    // The top earner gets round(Dmax) + round(Vmax): 2p 1 + 1, 4p 2 + 1, 8p 4 + 2.
    expect([2, 4, 8].map((p) => proportionalBonus(scaledBonusMax(2, p), 50, 50) + proportionalBonus(scaledBonusMax(1, p), 50, 50))).toEqual([2, 3, 6]);
  });
});

describe('proportionalBonus: round-half-up(max × mine / top)', () => {
  it('rounds halves up and is 0 when the top is 0', () => {
    expect(proportionalBonus(2, 100, 400)).toBe(1); // 0.5 → 1
    expect(proportionalBonus(2, 99, 400)).toBe(0); // 0.495 → 0
    expect(proportionalBonus(2, 300, 400)).toBe(2); // 1.5 → 2
    expect(proportionalBonus(2, 299, 400)).toBe(1); // 1.495 → 1
    expect(proportionalBonus(1, 200, 400)).toBe(1); // 0.5 → 1
    expect(proportionalBonus(1, 199, 400)).toBe(0);
    expect(proportionalBonus(2, 400, 400)).toBe(2);
    expect(proportionalBonus(2, 0, 0)).toBe(0);
    expect(proportionalBonus(2, 0, 400)).toBe(0);
    expect(proportionalBonus(0, 400, 400)).toBe(0);
  });
});

describe('computeRoundScore (hand-computed)', () => {
  it('2 players: the winner does everything', () => {
    // A: 1st, 412 dmg, $300 destroyed, $200 alive. B: 2nd, 206 dmg.
    const s = computeRoundScore([pl('a', 1), pl('b', 2)], [m('a', 412, 300, 200), m('b', 206)], S);
    // 2 players: place 1/0, Dmax 1, Vmax 0.5.
    // A: 1 + 1 + round(0.5) 1 = 3. B: 0 + round(1 × 206/412 = 0.5) 1 + 0 = 1.
    expect(pts(s)).toEqual([
      ['a', 1, 1, 1, 3],
      ['b', 0, 1, 0, 1],
    ]);
    expect(s[0]).toMatchObject({ place: 1, damage: 412, valueDestroyed: 300 });
    expect(badges(s)).toEqual({ a: ['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall'], b: [] });
  });

  it('3 players: an aggressive 2nd outscores the surviving 1st', () => {
    // 1st survived ($150 left) but hit little; 2nd and 3rd fought hard and died.
    const s = computeRoundScore(
      [pl('turtle', 1), pl('brawler', 2), pl('sniper', 3)],
      [m('turtle', 100, 0, 150), m('brawler', 300, 200), m('sniper', 250, 100)],
      S,
    );
    // 3 players: place 2/1/0, Dmax 1.5, Vmax 0.75.
    // turtle:  2 + round(1.5×100/300 = 0.5) 1 + 0                           = 3
    // brawler: 1 + round(1.5) 2               + round(0.75) 1               = 4
    // sniper:  0 + round(1.5×250/300 = 1.25) 1 + round(0.75×100/200 = 0.375) 0 = 1
    expect(pts(s)).toEqual([
      ['turtle', 2, 1, 0, 3],
      ['brawler', 1, 2, 1, 4],
      ['sniper', 0, 1, 0, 1],
    ]);
    expect(badges(s)).toEqual({ turtle: ['lastStanding', 'ironWall'], brawler: ['biggestHitter', 'giantSlayer'], sniper: [] });
  });

  it('4 players with a shared 1st place, tied tops and rounding half-up', () => {
    const s = computeRoundScore(
      [pl('a', 1), pl('b', 1), pl('c', 3), pl('d', 4)],
      [m('a', 400, 104, 200), m('b', 400, 0, 200), m('c', 100, 52), m('d', 99, 51)],
      S,
    );
    // a: 3 + 2 + 1                                  = 6
    // b: 3 + 2 + 0                                  = 5
    // c: 1 + round(2×100/400 = 0.5) 1 + round(52/104 = 0.5) 1   = 3
    // d: 0 + round(2×99/400 = 0.495) 0 + round(51/104 = 0.49) 0 = 0
    expect(pts(s)).toEqual([
      ['a', 3, 2, 1, 6],
      ['b', 3, 2, 0, 5],
      ['c', 1, 1, 1, 3],
      ['d', 0, 0, 0, 0],
    ]);
    // Ties share a badge: both 1st places, both top hitters, both Iron Walls.
    expect(badges(s)).toEqual({
      a: ['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall'],
      b: ['lastStanding', 'biggestHitter', 'ironWall'],
      c: [],
      d: [],
    });
  });

  it('a zero top gives no bonus and no badge (a badge needs a value > 0)', () => {
    // Everybody was wiped by sudden death on the same tick: nobody hit, nobody survived.
    const s = computeRoundScore([pl('a', 1), pl('b', 1)], [m('a', 0), m('b', 0)], S);
    expect(pts(s)).toEqual([
      ['a', 1, 0, 0, 1],
      ['b', 1, 0, 0, 1],
    ]);
    expect(badges(s)).toEqual({ a: ['lastStanding'], b: ['lastStanding'] });
    // Missing metrics count as zero.
    expect(pts(computeRoundScore([pl('a', 1), pl('b', 2)], [], S))).toEqual([
      ['a', 1, 0, 0, 1],
      ['b', 0, 0, 0, 0],
    ]);
  });

  it('a kicked player gets nothing and does not set the top; damage dealt TO them still counts', () => {
    // 'k' was kicked during the battle: not in the ranking. 'a' did 300 damage,
    // all of it to k's units; k did 1000 damage.
    const s = computeRoundScore([pl('a', 1), pl('b', 2)], [m('a', 300, 200, 100), m('b', 150), m('k', 1000, 500, 900)], S);
    expect(s.map((r) => r.playerId)).toEqual(['a', 'b']);
    // Tops are a's: 300 damage, $200, $100 alive. P = 2 ranked players (k doesn't count).
    expect(pts(s)).toEqual([
      ['a', 1, 1, 1, 3],
      ['b', 0, 1, 0, 1],
    ]);
    expect(badges(s).a).toEqual(['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall']);
  });

  it('uses the configured maxima (scaled × P/4)', () => {
    const cfg = parseConfig({ scoring: { damageBonusMax: 4, valueBonusMax: 0 } }).scoring;
    const s = computeRoundScore([pl('a', 1), pl('b', 2)], [m('a', 100, 50), m('b', 300, 100)], cfg);
    // 2 players: Dmax = 4 × 2/4 = 2. a: 1 + round(2×100/300 = 0.67) 1 + 0 = 2; b: 0 + 2 + 0 = 2.
    expect(pts(s)).toEqual([
      ['a', 1, 1, 0, 2],
      ['b', 0, 2, 0, 2],
    ]);
  });

  it('8 players: place 7..0 and bonuses up to 4 + 2', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const s = computeRoundScore(
      ids.map((id, i) => pl(id, i + 1)),
      ids.map((id, i) => m(id, 800 - i * 100, i === 7 ? 400 : 0)),
      S,
    );
    // h: last (0) + round(4 × 100/800 = 0.5) 1 + round(2) 2 = 3; a: 7 + 4 + 0 = 11.
    expect(pts(s)[0]).toEqual(['a', 7, 4, 0, 11]);
    expect(pts(s)[7]).toEqual(['h', 0, 1, 2, 3]);
    expect(s.map((r) => r.placePoints)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('scoreRanking merges places, scores and metrics into the released ranking', () => {
    const placings = rankStandings(
      [
        { playerId: 'a', seat: 0, livingCost: 0, eliminatedAtTick: 900 },
        { playerId: 'b', seat: 1, livingCost: 208, eliminatedAtTick: null },
        { playerId: 'k', seat: 2, livingCost: 500, eliminatedAtTick: null },
      ],
      new Set(['k']),
    );
    const ranking = scoreRanking(placings, [m('a', 330, 104, 0, 1), m('b', 220, 312, 208, 3), m('k', 0)], S);
    // 2 ranked players: place 1/0, Dmax 1, Vmax 0.5.
    expect(ranking).toEqual([
      {
        playerId: 'b',
        place: 1,
        placePoints: 1,
        damage: 220,
        damageBonus: 1, // 1 × 220/330 = 0.67
        valueDestroyed: 312,
        valueBonus: 1, // round(0.5)
        badges: ['lastStanding', 'giantSlayer', 'ironWall'],
        pointsGained: 3,
        kills: 3,
        livingCost: 208,
        eliminatedAtTick: null,
      },
      {
        playerId: 'a',
        place: 2,
        placePoints: 0,
        damage: 330,
        damageBonus: 1,
        valueDestroyed: 104,
        valueBonus: 0, // 0.5 × 104/312 = 0.17
        badges: ['biggestHitter'],
        pointsGained: 1,
        kills: 1,
        livingCost: 0,
        eliminatedAtTick: 900,
      },
    ]);
  });
});

describe('match standings', () => {
  const row = (playerId: string, seat: number, points: number, damage: number) => ({ playerId, seat, points, damage });

  it('total points, then total match damage, then a shared place', () => {
    const st = matchStandings([row('a', 0, 9, 500), row('b', 1, 12, 100), row('c', 2, 9, 800), row('d', 3, 9, 500)]);
    expect(st.map((s) => [s.playerId, s.place])).toEqual([
      ['b', 1],
      ['c', 2],
      ['a', 3],
      ['d', 3],
    ]);
  });

  it('2 players with equal points and damage share 1st', () => {
    expect(matchStandings([row('b', 1, 6, 200), row('a', 0, 6, 200)]).map((s) => [s.playerId, s.place])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });
});

describe('team scoring', () => {
  const st = (playerId: string, seat: number, teamId: number, livingCost: number, eliminatedAtTick: number | null) => ({
    playerId,
    seat,
    teamId,
    livingCost,
    eliminatedAtTick,
  });

  it('every member gets the team place points; bonuses stay individual (4p 2v2 → 3 / 0)', () => {
    // Team 0 (a, d) survives with a's units; team 1 (b, c) is wiped out.
    const placings = rankStandings([st('a', 0, 0, 200, null), st('b', 1, 1, 0, 900), st('c', 2, 1, 0, 800), st('d', 3, 0, 0, 500)]);
    expect(placings.map((p) => [p.playerId, p.teamId, p.place])).toEqual([
      ['a', 0, 1],
      ['d', 0, 1],
      ['b', 1, 2],
      ['c', 1, 2],
    ]);
    const ranking = scoreRanking(placings, [m('a', 100, 0, 200), m('b', 400, 300), m('c', 0), m('d', 200, 150)], S);
    // P = 4: Dmax 2, Vmax 1. d's units died but d still gets the team's 3 and Last Standing.
    expect(ranking.map((r) => [r.playerId, r.teamId, r.placePoints, r.damageBonus, r.valueBonus, r.pointsGained])).toEqual([
      ['a', 0, 3, 1, 0, 4],
      ['d', 0, 3, 1, 1, 5],
      ['b', 1, 0, 2, 1, 3],
      ['c', 1, 0, 0, 0, 0],
    ]);
    expect(Object.fromEntries(ranking.map((r) => [r.playerId, r.badges]))).toEqual({
      a: ['lastStanding', 'ironWall'],
      d: ['lastStanding'],
      b: ['biggestHitter', 'giantSlayer'],
      c: [],
    });
    expect(teamRoundRanking(ranking)).toEqual([
      { teamId: 0, place: 1, placePoints: 3, livingCost: 200, eliminatedAtTick: null, members: ['a', 'd'] },
      { teamId: 1, place: 2, placePoints: 0, livingCost: 0, eliminatedAtTick: 900, members: ['b', 'c'] },
    ]);
  });

  it('6p 2v2v2: places 5 / 3 / 0; timeout ranks teams by team living cost', () => {
    const placings = rankStandings([
      st('a', 0, 0, 100, null), st('b', 1, 0, 100, null), // team 0: 200
      st('c', 2, 1, 250, null), st('d', 3, 1, 0, 3000), // team 1: 250
      st('e', 4, 2, 0, 2000), st('f', 5, 2, 0, 4000), // team 2: wiped at 4000
    ]);
    const ranking = scoreRanking(placings, [], S);
    expect(ranking.map((r) => [r.playerId, r.place, r.placePoints])).toEqual([
      ['c', 1, 5], ['d', 1, 5],
      ['a', 2, 3], ['b', 2, 3],
      ['e', 3, 0], ['f', 3, 0],
    ]);
    expect(rankSides([
      st('a', 0, 0, 100, null), st('b', 1, 0, 100, null),
      st('c', 2, 1, 250, null), st('d', 3, 1, 0, 3000),
      st('e', 4, 2, 0, 2000), st('f', 5, 2, 0, 4000),
    ]).map((s) => [s.teamId, s.place, s.livingCost, s.eliminatedAtTick])).toEqual([
      [1, 1, 250, null],
      [0, 2, 200, null],
      [2, 3, 0, 4000],
    ]);
  });

  it('tied teams share the better place; a kicked member is left out and an all-kicked team removed', () => {
    const standings = [
      st('a', 0, 0, 100, null), st('b', 1, 0, 50, null), // team 0: 150 (+ b kicked → 100)
      st('c', 2, 1, 100, null), st('d', 3, 1, 0, 100), // team 1: 100
      st('e', 4, 2, 999, null), st('f', 5, 2, 0, 50), // team 2: all kicked
    ];
    const kicked = new Set(['b', 'e', 'f']);
    const placings = rankStandings(standings, kicked);
    expect(placings.map((p) => [p.playerId, p.place])).toEqual([
      ['a', 1],
      ['c', 1],
      ['d', 1],
    ]);
    // P = 3 ranked players, T = 2 sides: both share 1st → 2 each.
    expect(scoreRanking(placings, [], S).map((r) => r.placePoints)).toEqual([2, 2, 2]);
  });

  it('team table: average of member totals (one decimal), then team place points, then a shared place', () => {
    const [t0, t1, t2] = emptyTeams(3).map((t, i) => ({ ...t, members: [`p${i}a`, `p${i}b`] }));
    const table = teamTable([
      { team: t0!, memberPoints: [7, 8], placePoints: 8 }, // 7.5
      { team: t1!, memberPoints: [9], placePoints: 5 }, // short-handed: 9
      { team: t2!, memberPoints: [7, 8], placePoints: 10 }, // 7.5, more place points
    ]);
    expect(table.map((r) => [r.teamId, r.points, r.placePoints, r.place])).toEqual([
      [1, 9, 5, 1],
      [2, 7.5, 10, 2],
      [0, 7.5, 8, 3],
    ]);
    expect(table[0]).toMatchObject({ name: 'Team 2', color: '#3CD6FF', pattern: 'dashed', members: ['p1a', 'p1b'] });
    expect(teamTable([{ team: t0!, memberPoints: [1, 2, 2], placePoints: 0 }, { team: t1!, memberPoints: [2, 1, 2], placePoints: 0 }]).map((r) => [r.points, r.place])).toEqual([
      [1.7, 1],
      [1.7, 1],
    ]);
  });

  it('team table: a team whose members were all kicked is left out (no row, no place)', () => {
    const [t0, t1, t2] = emptyTeams(3).map((t, i) => ({ ...t, members: [`p${i}a`, `p${i}b`] }));
    const table = teamTable([
      { team: t0!, memberPoints: [3, 5], placePoints: 4 },
      { team: { ...t1!, members: [] }, memberPoints: [], placePoints: 6 },
      { team: t2!, memberPoints: [1, 1], placePoints: 2 },
    ]);
    expect(table.map((r) => [r.teamId, r.place])).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });
});
