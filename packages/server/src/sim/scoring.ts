// Round scoring (plan §9 Points, Damage metric, Value destroyed, Badges,
// Skip / kick, Match standings).
//
//   round points = place points + damage bonus + value bonus
//
//   * Place points: scoring.placePoints[place - 1] (default 3/2/1/0, the same
//     table for 2-4 players; tied players share the better place).
//   * Damage bonus: round-half-up(damageBonusMax × myDamage / topDamage).
//   * Value bonus: round-half-up(valueBonusMax × myValueDestroyed / topValueDestroyed).
//     A bonus is 0 when the top value is 0.
//   * Badges (titles, no points): Last Standing (1st place), Biggest Hitter
//     (most damage), Giant Slayer (most value destroyed), Iron Wall (most
//     living army value at the end). Ties share a badge; a badge needs a
//     value > 0.
//   * Only RANKED players are scored: players kicked during the battle are
//     not in the ranking, so they get no points or badges and do not set the
//     "top" values. Damage dealt TO them still counts for the others.
//
// Everything here is pure: the metrics come from the sim result (natural end)
// or from the recorded counters at the playback tick (Skip).

import type { BadgeId, GameConfig, PlayerMetricsDTO, RankingEntryDTO, RoundScoreDTO } from '@pixel-clash/shared';
import type { Placing } from './ranking.js';
import type { BattleResult } from './types.js';

export type ScoringConfig = GameConfig['scoring'];

/** One unit's contribution to its owner's metrics. */
export interface UnitMetricInput {
  playerId: string;
  cost: number;
  alive: boolean;
  damageDealt: number;
  kills: number;
  valueDestroyed: number;
}

/**
 * Per-player metrics from per-unit counters. `playerIds` fixes the output
 * order (and includes players without units). Damage is rounded to a whole
 * number here, so what the kids see is exactly what the bonus was computed on.
 */
export function sumMetrics(playerIds: readonly string[], units: Iterable<UnitMetricInput>): PlayerMetricsDTO[] {
  const by = new Map<string, PlayerMetricsDTO & { rawDamage: number }>(
    playerIds.map((playerId) => [playerId, { playerId, damage: 0, rawDamage: 0, valueDestroyed: 0, kills: 0, livingValue: 0 }]),
  );
  for (const u of units) {
    const m = by.get(u.playerId);
    if (!m) continue;
    m.rawDamage += u.damageDealt;
    m.kills += u.kills;
    m.valueDestroyed += u.valueDestroyed;
    if (u.alive) m.livingValue += u.cost;
  }
  return [...by.values()].map(({ rawDamage, ...m }) => ({ ...m, damage: Math.round(rawDamage) }));
}

/** Per-player metrics of a (possibly Skip-trimmed, see `resultAtTick`) result, in seat order. */
export function playerMetrics(result: Pick<BattleResult, 'players' | 'units'>): PlayerMetricsDTO[] {
  return sumMetrics(
    result.players.map((p) => p.playerId),
    result.units.map((u) => ({
      playerId: u.playerId,
      cost: u.cost,
      alive: u.survived,
      damageDealt: u.damageDealt,
      kills: u.kills,
      valueDestroyed: u.valueDestroyed,
    })),
  );
}

/**
 * round-half-up(max × mine / top), 0 when top ≤ 0. Computed as
 * floor((2·max·mine + top) / (2·top)) so exact halves never fall to float
 * error for whole-number inputs.
 */
export function proportionalBonus(max: number, mine: number, top: number): number {
  if (!(top > 0) || !(mine > 0) || !(max > 0)) return 0;
  return Math.floor((2 * max * mine + top) / (2 * top) + 1e-9);
}

/**
 * Score one round. `ranking` holds the ranked (not kicked) players with their
 * places; `metrics` may include more players (kicked ones are ignored).
 * Output follows the order of `ranking`.
 */
export function computeRoundScore(
  ranking: ReadonlyArray<Pick<Placing, 'playerId' | 'place'>>,
  metrics: readonly PlayerMetricsDTO[],
  config: ScoringConfig,
): RoundScoreDTO[] {
  const zero = (playerId: string): PlayerMetricsDTO => ({ playerId, damage: 0, valueDestroyed: 0, kills: 0, livingValue: 0 });
  const byId = new Map(metrics.map((m) => [m.playerId, m]));
  const rows = ranking.map((r) => ({ r, m: byId.get(r.playerId) ?? zero(r.playerId) }));
  const top = (pick: (m: PlayerMetricsDTO) => number) => Math.max(0, ...rows.map((x) => pick(x.m)));
  const topDamage = top((m) => m.damage);
  const topValue = top((m) => m.valueDestroyed);
  const topLiving = top((m) => m.livingValue);

  return rows.map(({ r, m }) => {
    const placePoints = config.placePoints[r.place - 1] ?? 0;
    const damageBonus = proportionalBonus(config.damageBonusMax, m.damage, topDamage);
    const valueBonus = proportionalBonus(config.valueBonusMax, m.valueDestroyed, topValue);
    const badges: BadgeId[] = [];
    if (r.place === 1) badges.push('lastStanding');
    if (topDamage > 0 && m.damage === topDamage) badges.push('biggestHitter');
    if (topValue > 0 && m.valueDestroyed === topValue) badges.push('giantSlayer');
    if (topLiving > 0 && m.livingValue === topLiving) badges.push('ironWall');
    return {
      playerId: r.playerId,
      place: r.place,
      placePoints,
      damage: m.damage,
      damageBonus,
      valueDestroyed: m.valueDestroyed,
      valueBonus,
      total: placePoints + damageBonus + valueBonus,
      badges,
    };
  });
}

/** The released ranking: places joined with the round score and metrics. */
export function scoreRanking(
  placings: readonly Placing[],
  metrics: readonly PlayerMetricsDTO[],
  config: ScoringConfig,
): RankingEntryDTO[] {
  const scores = computeRoundScore(placings, metrics, config);
  const byId = new Map(metrics.map((m) => [m.playerId, m]));
  return placings.map((p, i) => {
    const { total, ...s } = scores[i]!;
    return {
      ...s,
      pointsGained: total,
      kills: byId.get(p.playerId)?.kills ?? 0,
      livingCost: p.livingCost,
      eliminatedAtTick: p.eliminatedAtTick,
    };
  });
}

/** A ranking entry's round score (for reports). */
export function roundScoreOf(entry: RankingEntryDTO): RoundScoreDTO {
  return {
    playerId: entry.playerId,
    place: entry.place,
    placePoints: entry.placePoints,
    damage: entry.damage,
    damageBonus: entry.damageBonus,
    valueDestroyed: entry.valueDestroyed,
    valueBonus: entry.valueBonus,
    total: entry.pointsGained,
    badges: [...entry.badges],
    ...(entry.inventorUsedBy !== undefined ? { inventorUsedBy: entry.inventorUsedBy } : {}),
  };
}

// ---------------------------------------------------------------------------
// Match standings
// ---------------------------------------------------------------------------

export interface MatchTotals {
  playerId: string;
  seat: number;
  points: number;
  damage: number;
}

/**
 * Match standings (§9): total points, then total match damage, then a shared
 * place. Sorted best first (seat orders equal rows); returns the 1-based place.
 */
export function matchStandings<T extends MatchTotals>(rows: readonly T[]): Array<T & { place: number }> {
  const cmp = (a: MatchTotals, b: MatchTotals) => b.points - a.points || b.damage - a.damage;
  const sorted = [...rows].sort((a, b) => cmp(a, b) || a.seat - b.seat);
  let place = 0;
  return sorted.map((r, i) => {
    if (i === 0 || cmp(sorted[i - 1]!, r) !== 0) place = i + 1;
    return { ...r, place };
  });
}
