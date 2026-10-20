// Round scoring (plan §9 Points, Badges, Skip / kick, Match standings),
// hand-computed. The sim-side metrics (effective damage, kill credit, sudden
// death, Skip) are tested in sim.test.ts.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, safeParseConfig, type PlayerMetricsDTO } from '@pixel-clash/shared';
import { computeRoundScore, matchStandings, proportionalBonus, scoreRanking } from '../packages/server/src/sim/scoring.js';
import { rankStandings } from '../packages/server/src/sim/ranking.js';

const S = DEFAULT_CONFIG.scoring; // 3/2/1/0, damage 0-2, value 0-1

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
  it('defaults: place points 3/2/1/0, damage bonus up to 2, value bonus up to 1', () => {
    expect(DEFAULT_CONFIG.scoring).toEqual({ placePoints: [3, 2, 1, 0], damageBonusMax: 2, valueBonusMax: 1 });
    expect('points' in DEFAULT_CONFIG).toBe(false);
  });

  it('migrates the old top-level `points` key to scoring.placePoints', () => {
    expect(parseConfig({ points: [5, 3, 1, 0] }).scoring).toEqual({ placePoints: [5, 3, 1, 0], damageBonusMax: 2, valueBonusMax: 1 });
    // An explicit scoring.placePoints wins over a legacy `points`.
    expect(parseConfig({ points: [5, 3, 1, 0], scoring: { placePoints: [4, 2, 1, 0] } }).scoring.placePoints).toEqual([4, 2, 1, 0]);
    expect(safeParseConfig({ points: [1, 2] }).success).toBe(false); // still validated (min 4 places)
    expect(safeParseConfig({ scoring: { damageBonusMax: -1 } }).success).toBe(false);
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
    // A: 3 + 2 + 1 = 6. B: 2 + round(2 × 206/412 = 1.0) = 1 + 0 = 3.
    expect(pts(s)).toEqual([
      ['a', 3, 2, 1, 6],
      ['b', 2, 1, 0, 3],
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
    // turtle:  3 + round(2×100/300 = 0.67) 1 + 0                    = 4
    // brawler: 2 + 2                     + 1                         = 5
    // sniper:  1 + round(2×250/300 = 1.67) 2 + round(100/200 = 0.5) 1 = 4
    expect(pts(s)).toEqual([
      ['turtle', 3, 1, 0, 4],
      ['brawler', 2, 2, 1, 5],
      ['sniper', 1, 2, 1, 4],
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
      ['a', 3, 0, 0, 3],
      ['b', 3, 0, 0, 3],
    ]);
    expect(badges(s)).toEqual({ a: ['lastStanding'], b: ['lastStanding'] });
    // Missing metrics count as zero.
    expect(pts(computeRoundScore([pl('a', 1), pl('b', 2)], [], S))).toEqual([
      ['a', 3, 0, 0, 3],
      ['b', 2, 0, 0, 2],
    ]);
  });

  it('a kicked player gets nothing and does not set the top; damage dealt TO them still counts', () => {
    // 'k' was kicked during the battle: not in the ranking. 'a' did 300 damage,
    // all of it to k's units; k did 1000 damage.
    const s = computeRoundScore([pl('a', 1), pl('b', 2)], [m('a', 300, 200, 100), m('b', 150), m('k', 1000, 500, 900)], S);
    expect(s.map((r) => r.playerId)).toEqual(['a', 'b']);
    // Tops are a's: 300 damage, $200, $100 alive.
    expect(pts(s)).toEqual([
      ['a', 3, 2, 1, 6],
      ['b', 2, 1, 0, 3],
    ]);
    expect(badges(s).a).toEqual(['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall']);
  });

  it('uses the configured maxima and place table', () => {
    const cfg = parseConfig({ scoring: { placePoints: [10, 5, 0, 0], damageBonusMax: 4, valueBonusMax: 0 } }).scoring;
    const s = computeRoundScore([pl('a', 1), pl('b', 2)], [m('a', 100, 50), m('b', 300, 100)], cfg);
    // a: 10 + round(4×100/300 = 1.33) 1 + 0 = 11; b: 5 + 4 + 0 = 9.
    expect(pts(s)).toEqual([
      ['a', 10, 1, 0, 11],
      ['b', 5, 4, 0, 9],
    ]);
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
    expect(ranking).toEqual([
      {
        playerId: 'b',
        place: 1,
        placePoints: 3,
        damage: 220,
        damageBonus: 1, // 2 × 220/330 = 1.33
        valueDestroyed: 312,
        valueBonus: 1,
        badges: ['lastStanding', 'giantSlayer', 'ironWall'],
        pointsGained: 5,
        kills: 3,
        livingCost: 208,
        eliminatedAtTick: null,
      },
      {
        playerId: 'a',
        place: 2,
        placePoints: 2,
        damage: 330,
        damageBonus: 2,
        valueDestroyed: 104,
        valueBonus: 0, // 104/312 = 0.33
        badges: ['biggestHitter'],
        pointsGained: 4,
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
