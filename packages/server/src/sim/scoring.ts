// Round scoring (plan §9 Points, Damage metric, Value destroyed, Badges,
// Skip / kick, Match standings; §9.2 Team scoring).
//
//   round points = place points + damage bonus + value bonus
//
//   * Place points (P = ranked players, T = ranked sides, T = P free-for-all):
//     a player whose side is in place k gets round((P − 1)(T − k)/(T − 1)).
//     Free-for-all that is P − k (4p 3/2/1/0, 2p 1/0, 8p 7..0). In team mode
//     every member gets the team's place points. Tied sides share the better
//     place.
//   * Damage bonus: round-half-up(Dmax × myDamage / topDamage), Dmax =
//     damageBonusMax × P/4. Value bonus likewise with valueBonusMax × P/4.
//     Bonuses are always individual; a bonus is 0 when the top value is 0 or
//     P = 1.
//   * Badges (titles, no points): Last Standing (1st place; team mode: every
//     member of the 1st-place team), Biggest Hitter (most damage), Giant
//     Slayer (most value destroyed), Iron Wall (most living army value at the
//     end). Ties share a badge; a badge needs a value > 0.
//   * Only RANKED players are scored: players kicked during the battle are
//     not in the ranking, so they get no points or badges and do not set the
//     "top" values. Damage dealt TO them still counts for the others.
//
// Everything here is pure: the metrics come from the sim result (natural end)
// or from the recorded counters at the playback tick (Skip).

import {
  placePointsFor,
  scaledBonusMax,
  type BadgeId,
  type GameConfig,
  type PlayerMetricsDTO,
  type RankingEntryDTO,
  type RoundScoreDTO,
  type TeamDTO,
  type TeamRoundRankDTO,
  type TeamTableRowDTO,
} from '@pixel-clash/shared';
import type { Placing } from './ranking.js';
import type { BattleResult } from './types.js';

export type ScoringConfig = GameConfig['scoring'];

/** One unit's contribution to its owner's metrics. */
export interface UnitMetricInput {
  playerId: string;
  /** Its living value while alive (§9.3; the unit cost for soldiers and towers). */
  cost: number;
  alive: boolean;
  damageDealt: number;
  kills: number;
  valueDestroyed: number;
}

/**
 * Per-player metrics from per-unit counters. `playerIds` fixes the output
 * order (and includes players without units). Damage is rounded to a whole
 * number here, so what the players see is exactly what the bonus was computed on.
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
      // Living value (§9.3: walls $0, factories body + unbuilt minions); older reports: the cost.
      cost: u.livingValue ?? u.cost,
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

/** Number of sides among ranked players: distinct teams, plus every player without a team. */
export function sideCount(ranking: ReadonlyArray<Pick<Placing, 'playerId' | 'teamId'>>): number {
  return new Set(ranking.map((r) => (r.teamId !== undefined ? `t:${r.teamId}` : `p:${r.playerId}`))).size;
}

/**
 * Score one round. `ranking` holds the ranked (not kicked) players with their
 * side's place (and `teamId` in team mode); `metrics` may include more
 * players (kicked ones are ignored). Output follows the order of `ranking`.
 */
export function computeRoundScore(
  ranking: ReadonlyArray<Pick<Placing, 'playerId' | 'place' | 'teamId'>>,
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
  const players = ranking.length;
  const sides = sideCount(ranking);
  // Bonus maxima scale × P/4; nothing to beat with one player.
  const damageMax = players > 1 ? scaledBonusMax(config.damageBonusMax, players) : 0;
  const valueMax = players > 1 ? scaledBonusMax(config.valueBonusMax, players) : 0;

  return rows.map(({ r, m }) => {
    const placePoints = placePointsFor(r.place, players, sides);
    const damageBonus = proportionalBonus(damageMax, m.damage, topDamage);
    const valueBonus = proportionalBonus(valueMax, m.valueDestroyed, topValue);
    const badges: BadgeId[] = [];
    if (r.place === 1) badges.push('lastStanding');
    if (topDamage > 0 && m.damage === topDamage) badges.push('biggestHitter');
    if (topValue > 0 && m.valueDestroyed === topValue) badges.push('giantSlayer');
    if (topLiving > 0 && m.livingValue === topLiving) badges.push('ironWall');
    return {
      playerId: r.playerId,
      ...(r.teamId !== undefined ? { teamId: r.teamId } : {}),
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
    ...(entry.teamId !== undefined ? { teamId: entry.teamId } : {}),
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

// ---------------------------------------------------------------------------
// Teams (§9.2 Team scoring)
// ---------------------------------------------------------------------------

/**
 * The round's team ranking from a released (team mode) ranking: one row per
 * team with its place, the place points every member got, the team living
 * cost and when its last unit died. Entries without a teamId are ignored.
 * Sorted by place, then teamId.
 */
export function teamRoundRanking(ranking: readonly RankingEntryDTO[]): TeamRoundRankDTO[] {
  const by = new Map<number, TeamRoundRankDTO>();
  for (const r of ranking) {
    if (r.teamId === undefined) continue;
    const t = by.get(r.teamId);
    if (!t) {
      by.set(r.teamId, {
        teamId: r.teamId,
        place: r.place,
        placePoints: r.placePoints,
        livingCost: r.livingCost,
        eliminatedAtTick: r.eliminatedAtTick,
        members: [r.playerId],
      });
      continue;
    }
    t.livingCost += r.livingCost;
    t.members.push(r.playerId);
    if (t.eliminatedAtTick !== null) t.eliminatedAtTick = r.eliminatedAtTick === null ? null : Math.max(t.eliminatedAtTick, r.eliminatedAtTick);
  }
  return [...by.values()].sort((a, b) => a.place - b.place || a.teamId - b.teamId);
}

/** One team's match totals for the team table. */
export interface TeamTotalsInput {
  team: TeamDTO;
  /** The team's current (not kicked) members' match totals. */
  memberPoints: readonly number[];
  /** Sum of the team's place points over the match (counted once per round). */
  placePoints: number;
}

/**
 * Team table (§9.2): team points = the average of the current members' match
 * totals (one decimal), tie-break the sum of the team's place points, then a
 * shared place. Sorted best first (teamId orders equal rows). A team with no
 * current members (all kicked) is left out: it gets no row and no place.
 */
export function teamTable(rows: readonly TeamTotalsInput[]): TeamTableRowDTO[] {
  const scored = rows.filter((r) => r.memberPoints.length > 0).map(({ team, memberPoints, placePoints }) => ({
    teamId: team.teamId,
    name: team.name,
    color: team.color,
    pattern: team.pattern,
    members: [...team.members],
    points: Math.round((memberPoints.reduce((a, b) => a + b, 0) / memberPoints.length) * 10) / 10,
    placePoints,
  }));
  const cmp = (a: { points: number; placePoints: number }, b: { points: number; placePoints: number }) =>
    b.points - a.points || b.placePoints - a.placePoints;
  scored.sort((a, b) => cmp(a, b) || a.teamId - b.teamId);
  let place = 0;
  return scored.map((r, i) => {
    if (i === 0 || cmp(scored[i - 1]!, r) !== 0) place = i + 1;
    return { ...r, place };
  });
}
