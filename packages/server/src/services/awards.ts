// Match awards: per-match stats accumulated round by
// round (stored in the match state, so they survive a restart; New match and
// a wipe clear them) and the 15 awards computed from them when the match
// reaches MATCH_RESULTS. Everything here is pure (no Game): battle.ts builds
// the round input at release, match.ts accumulates it and computes the awards.
//
// What a round adds (fielded = placed copies; minions are never "fielded"):
//   wins            the player's ranking place was 1 (team mode: the team's)
//   damage, value   the ranking's effective damage / value destroyed (the
//                   numbers the standings use)
//   healing, combos the ranking's (M8.8)
//   unitsFielded    placed copies that are not walls; wallsPlaced the walls
//   survivors       placed non-wall copies alive at the end (Skip: the shown frame)
//   minionsMade     every minion their factories made
//   borrowsMade     borrowed Armory types they fielded; borrowedByOthers on
//                   the creator: one per other player fielding one of their
//                   designs that round
//   designs         their own (non-template) designs fielded, distinct
//   places          their match standings place after the round
//   longestKo       the longest edge-to-edge gap between the killer and the
//                   victim at the killing hit (from the recorded frames)

import {
  AWARDS,
  AWARD_IDS,
  awardStatText,
  sizeOf,
  type AwardId,
  type AwardUnitDTO,
  type AwardWinnerDTO,
  type BattleRevealDTO,
  type FrameDTO,
  type MatchAwardDTO,
  type RankingEntryDTO,
  type ScoreboardEntryDTO,
  type SpriteSpec,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import type { UnitReport } from '../sim/types.js';

/** One design a player fielded this match (own or borrowed), summed over rounds. */
export interface UnitMatchStats {
  /** The name it fought under (the latest). */
  name: string;
  stats: StatsSnapshot;
  sprite: SpriteSpec | null;
  spriteHidden: boolean;
  /** A borrowed Armory unit: the creator's name. */
  borrowedFrom?: string;
  /** Placed copies over the match (minions not counted). */
  fielded: number;
  survived: number;
  damage: number;
  kills: number;
  valueDestroyed: number;
  healing: number;
  combos: number;
  minionsMade: number;
  /** The creator's design: how often other players fielded it from the Armory. */
  borrowedByOthers: number;
}

export interface PlayerMatchStats {
  /** Rounds fought. */
  rounds: number;
  wins: number;
  damage: number;
  valueDestroyed: number;
  unitsFielded: number;
  wallsPlaced: number;
  minionsMade: number;
  survivors: number;
  healing: number;
  combos: number;
  borrowedByOthers: number;
  borrowsMade: number;
  /** Own non-template designs fielded (distinct unitIds). */
  designs: string[];
  /** Match standings place after each released round they were on the scoreboard for. */
  places: number[];
  longestKo: { distance: number; unitId: string; round: number } | null;
  /** unitId → the design's match totals (borrowed ones under their Armory unitId). */
  units: Record<string, UnitMatchStats>;
}

/** playerId → stats (`MatchState.stats`). */
export type MatchStats = Record<string, PlayerMatchStats>;

export function emptyPlayerStats(): PlayerMatchStats {
  return {
    rounds: 0,
    wins: 0,
    damage: 0,
    valueDestroyed: 0,
    unitsFielded: 0,
    wallsPlaced: 0,
    minionsMade: 0,
    survivors: 0,
    healing: 0,
    combos: 0,
    borrowedByOthers: 0,
    borrowsMade: 0,
    designs: [],
    places: [],
    longestKo: null,
    units: {},
  };
}

function emptyUnit(meta: Pick<UnitMatchStats, 'name' | 'stats' | 'sprite' | 'spriteHidden' | 'borrowedFrom'>): UnitMatchStats {
  return {
    name: meta.name,
    stats: meta.stats,
    sprite: meta.sprite,
    spriteHidden: meta.spriteHidden,
    ...(meta.borrowedFrom !== undefined ? { borrowedFrom: meta.borrowedFrom } : {}),
    fielded: 0,
    survived: 0,
    damage: 0,
    kills: 0,
    valueDestroyed: 0,
    healing: 0,
    combos: 0,
    minionsMade: 0,
    borrowedByOthers: 0,
  };
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

/** A borrowed Armory type fielded in the round. */
export interface RoundBorrow {
  borrowerId: string;
  creatorId: string;
  /** The creator's own unitId of the design. */
  sourceUnitId: string;
  /** The raw unit name (without "(Creator)"). */
  name: string;
  /** The borrower's unitId for it (`armory:…`), to find its revealed stats/sprite. */
  armoryUnitId: string;
}

export interface RoundStatsInput {
  round: number;
  reveal: Pick<BattleRevealDTO, 'players' | 'minion' | 'minions'>;
  /** Recorded frames up to the released tick. */
  frames: readonly FrameDTO[];
  /** Per-instance reports at the released tick. */
  units: readonly UnitReport[];
  /** The released ranking (kicked players are not in it). */
  ranking: readonly RankingEntryDTO[];
  borrowed: readonly RoundBorrow[];
  /** playerId → own non-template designs fielded this round. */
  ownDesigns: Readonly<Record<string, readonly string[]>>;
}

/** The longest knockout per player in one battle: playerId → distance and the killer's design. */
export function longestKnockouts(
  reveal: RoundStatsInput['reveal'],
  frames: readonly FrameDTO[],
  units: readonly UnitReport[],
): Map<string, { distance: number; unitId: string }> {
  const owner = new Map(units.map((u) => [u.instanceId, u]));
  const radius = new Map<string, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const p of reveal.players) {
    const stats = new Map(p.units.map((u) => [u.unitId, u.stats]));
    for (const i of p.instances) {
      const s = stats.get(i.unitId);
      radius.set(i.instanceId, s ? sizeOf(s) : 10);
      pos.set(i.instanceId, { x: i.x, y: i.y });
    }
  }
  const minionSize = (kind: string | undefined): number =>
    (kind ? reveal.minions?.[kind as keyof NonNullable<typeof reveal.minions>]?.stats.size : undefined) ?? reveal.minion?.stats.size ?? 6;
  const best = new Map<string, { distance: number; unitId: string }>();
  for (const f of frames) {
    // The last damaging hit on each body in this frame: the one that finished it off.
    const lastHit = new Map<string, { attackerId: string; gap: number | null }>();
    for (const ev of f.events) {
      if (ev.type === 'spawn') {
        if (ev.factoryId) radius.set(ev.instanceId, minionSize(ev.kind));
        if (ev.x !== undefined && ev.y !== undefined) pos.set(ev.instanceId, { x: ev.x, y: ev.y });
      } else if (ev.type === 'hit' && ev.damage > 0) {
        const a = pos.get(ev.instanceId);
        const t = pos.get(ev.targetId);
        const gap = a && t ? Math.hypot(t.x - a.x, t.y - a.y) - (radius.get(ev.instanceId) ?? 0) - (radius.get(ev.targetId) ?? 0) : null;
        lastHit.set(ev.targetId, { attackerId: ev.instanceId, gap });
      } else if (ev.type === 'death') {
        const h = lastHit.get(ev.instanceId);
        const killer = h ? owner.get(h.attackerId) : undefined;
        const victim = owner.get(ev.instanceId);
        if (!h || h.gap === null || !killer || !victim || killer.playerId === victim.playerId) continue;
        const distance = Math.max(0, h.gap);
        const prev = best.get(killer.playerId);
        if (!prev || distance > prev.distance) best.set(killer.playerId, { distance, unitId: killer.unitId });
      }
    }
    for (const [id, x, y] of f.units) pos.set(id, { x, y });
  }
  return best;
}

/**
 * Add one released round to the match stats. `standings` is the match
 * scoreboard right after the round (its places feed Comeback).
 */
export function accumulateRound(stats: MatchStats, input: RoundStatsInput, standings: readonly ScoreboardEntryDTO[]): void {
  const of = (id: string) => (stats[id] ??= emptyPlayerStats());
  const ranking = new Map(input.ranking.map((r) => [r.playerId, r]));
  for (const p of input.reveal.players) {
    const ps = of(p.playerId);
    ps.rounds += 1;
    for (const u of p.units) {
      const meta = {
        name: u.name,
        stats: u.stats,
        sprite: u.spriteHidden ? null : u.sprite,
        spriteHidden: u.spriteHidden,
        ...(u.borrowedFrom ? { borrowedFrom: u.borrowedFrom.creatorName } : {}),
      };
      const entry = (ps.units[u.unitId] ??= emptyUnit(meta));
      Object.assign(entry, meta);
    }
    const r = ranking.get(p.playerId);
    if (r) {
      if (r.place === 1) ps.wins += 1;
      ps.damage += r.damage;
      ps.valueDestroyed += r.valueDestroyed;
      ps.healing += r.healing ?? 0;
      ps.combos += r.combos ?? 0;
    }
    for (const id of input.ownDesigns[p.playerId] ?? []) if (!ps.designs.includes(id)) ps.designs.push(id);
  }
  for (const u of input.units) {
    const ps = stats[u.playerId];
    const entry = ps?.units[u.unitId];
    if (!ps || !entry) continue;
    entry.damage += u.damageDealt;
    entry.kills += u.kills;
    entry.valueDestroyed += u.valueDestroyed;
    entry.healing += u.healing ?? 0;
    entry.combos += u.combos ?? 0;
    if (u.type === 'minion') continue;
    entry.fielded += 1;
    if (u.factory) {
      entry.minionsMade += u.factory.minionsMade;
      ps.minionsMade += u.factory.minionsMade;
    }
    if (u.type === 'wall') {
      ps.wallsPlaced += 1;
      continue;
    }
    ps.unitsFielded += 1;
    if (u.survived) {
      ps.survivors += 1;
      entry.survived += 1;
    }
  }
  for (const b of input.borrowed) {
    if (b.borrowerId === b.creatorId) continue;
    of(b.borrowerId).borrowsMade += 1;
    const creator = of(b.creatorId);
    creator.borrowedByOthers += 1;
    let entry = creator.units[b.sourceUnitId];
    if (!entry) {
      // The creator fielded it in an earlier round (that's how it got into the Armory); keep the revealed look.
      const seen = stats[b.borrowerId]?.units[b.armoryUnitId];
      if (!seen) continue;
      entry = creator.units[b.sourceUnitId] = emptyUnit({ name: b.name, stats: seen.stats, sprite: seen.sprite, spriteHidden: seen.spriteHidden });
    }
    entry.borrowedByOthers += 1;
  }
  for (const s of standings) of(s.playerId).places.push(s.place);
  for (const [playerId, ko] of longestKnockouts(input.reveal, input.frames, input.units)) {
    const ps = of(playerId);
    if (!ps.longestKo || ko.distance > ps.longestKo.distance) ps.longestKo = { ...ko, round: input.round };
  }
}

// ---------------------------------------------------------------------------
// The awards
// ---------------------------------------------------------------------------

/** A player who can win awards (kicked players are left out by the caller). */
export interface AwardCandidate {
  playerId: string;
  name: string;
  seat: number;
  teamId?: number;
}

export interface ComputeAwardsInput {
  stats: MatchStats;
  /** The final match standings (MATCH_RESULTS). */
  standings: readonly ScoreboardEntryDTO[];
  candidates: readonly AwardCandidate[];
  /** The facilitator hid this design's sprite (moderation, checked now). */
  spriteHidden?: (playerId: string, unitId: string) => boolean;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

type UnitKey = (u: UnitMatchStats, unitId: string) => number;

/** The design with the highest key (> 0), ties by damage, copies, then name. */
function topUnit(ps: PlayerMatchStats, key: UnitKey, filter: (u: UnitMatchStats, unitId: string) => boolean = () => true): string | undefined {
  let bestId: string | undefined;
  let best: UnitMatchStats | undefined;
  for (const [id, u] of Object.entries(ps.units)) {
    if (!filter(u, id) || key(u, id) <= 0) continue;
    if (
      !best ||
      key(u, id) > key(best, bestId!) ||
      (key(u, id) === key(best, bestId!) && (u.damage > best.damage || (u.damage === best.damage && (u.fielded > best.fielded || (u.fielded === best.fielded && u.name < best.name)))))
    ) {
      best = u;
      bestId = id;
    }
  }
  return bestId;
}

const byDamage: UnitKey = (u) => u.damage;
const notWall = (u: UnitMatchStats) => u.stats.type !== 'wall';

/** The unit tied to an award (falls back to the most damaging, then the most placed). */
function bestUnitId(id: AwardId, ps: PlayerMatchStats): string | undefined {
  let pick: string | undefined;
  switch (id) {
    case 'giantSlayer':
      pick = topUnit(ps, (u) => u.valueDestroyed);
      break;
    case 'biggestArmy':
      pick = topUnit(ps, (u) => u.fielded, notWall);
      break;
    case 'armoryStar':
      pick = topUnit(ps, (u) => u.borrowedByOthers);
      break;
    case 'bestMedic':
      pick = topUnit(ps, (u) => u.healing);
      break;
    case 'comboMaster':
      pick = topUnit(ps, (u) => u.combos);
      break;
    case 'masterBuilder':
      pick = topUnit(ps, (u) => u.fielded, (u) => u.stats.type === 'wall');
      break;
    case 'factoryBoss':
      pick = topUnit(ps, (u) => u.minionsMade);
      break;
    case 'survivor':
      pick = topUnit(ps, (u) => u.survived, notWall);
      break;
    case 'inventor':
      pick = topUnit(ps, byDamage, (_u, uid) => ps.designs.includes(uid)) ?? topUnit(ps, (u) => u.fielded, (_u, uid) => ps.designs.includes(uid));
      break;
    case 'sharpshooter':
      pick = ps.longestKo && ps.units[ps.longestKo.unitId] ? ps.longestKo.unitId : undefined;
      break;
    case 'teamPlayer':
      pick = topUnit(ps, (u) => u.fielded, (u) => u.borrowedFrom !== undefined);
      break;
    default:
      break;
  }
  return pick ?? topUnit(ps, byDamage) ?? topUnit(ps, (u) => u.fielded, notWall) ?? topUnit(ps, (u) => u.fielded);
}

/**
 * The match awards in ceremony order (AWARD_IDS). For each award the
 * candidates with the highest value win it together; an award whose best
 * value is 0 is left out. Champion = 1st in the final standings (shared
 * place = shared award), value = their points.
 *
 * Comeback: for each player, worst = the lowest (largest-number) standings
 * place they had after any released round, final = their place in the final
 * standings; climb = worst − final (0 when they were never lower). The
 * biggest climb wins.
 */
export function computeAwards(input: ComputeAwardsInput): MatchAwardDTO[] {
  const { stats, standings, candidates } = input;
  const place = new Map(standings.map((s) => [s.playerId, s]));
  const value = (id: AwardId, c: AwardCandidate): number => {
    const ps = stats[c.playerId];
    const sb = place.get(c.playerId);
    switch (id) {
      case 'champion':
        return sb && sb.place === 1 ? sb.points : 0;
      case 'comeback': {
        if (!ps || !sb || ps.places.length === 0) return 0;
        return Math.max(0, Math.max(...ps.places) - sb.place);
      }
      default:
        break;
    }
    if (!ps) return 0;
    switch (id) {
      case 'mostWins':
        return ps.wins;
      case 'biggestHitter':
        return Math.round(ps.damage);
      case 'giantSlayer':
        return Math.round(ps.valueDestroyed);
      case 'biggestArmy':
        return ps.unitsFielded;
      case 'armoryStar':
        return ps.borrowedByOthers;
      case 'bestMedic':
        return Math.round(ps.healing);
      case 'comboMaster':
        return ps.combos;
      case 'masterBuilder':
        return ps.wallsPlaced;
      case 'factoryBoss':
        return ps.minionsMade;
      case 'survivor':
        return ps.survivors;
      case 'inventor':
        return ps.designs.length;
      case 'sharpshooter':
        return ps.longestKo ? Math.round(ps.longestKo.distance) : 0;
      case 'teamPlayer':
        return ps.borrowsMade;
      default:
        return 0;
    }
  };
  const awards: MatchAwardDTO[] = [];
  for (const id of AWARD_IDS) {
    const scored = candidates.map((c) => ({ c, v: value(id, c) }));
    const top = Math.max(0, ...scored.map((s) => s.v));
    if (top <= 0) continue;
    const winners = scored
      .filter((s) => s.v === top)
      .sort((a, b) => a.c.seat - b.c.seat)
      .map(({ c }) => winnerDTO(id, c, stats[c.playerId], place.get(c.playerId), input.spriteHidden));
    const info = AWARDS[id];
    awards.push({ id, emoji: info.emoji, title: info.title, rule: info.rule, value: top, text: awardStatText(id, top), winners });
  }
  return awards;
}

function winnerDTO(
  id: AwardId,
  c: AwardCandidate,
  ps: PlayerMatchStats | undefined,
  sb: ScoreboardEntryDTO | undefined,
  hidden: ComputeAwardsInput['spriteHidden'],
): AwardWinnerDTO {
  const w: AwardWinnerDTO = { playerId: c.playerId, name: c.name, seat: c.seat, bestUnit: null };
  if (c.teamId !== undefined) w.teamId = c.teamId;
  if (!ps) return w;
  const unitId = bestUnitId(id, ps);
  const u = unitId ? ps.units[unitId] : undefined;
  if (unitId && u) {
    const isHidden = u.spriteHidden || (hidden?.(c.playerId, unitId) ?? false);
    const unit: AwardUnitDTO = { unitId, name: u.name, stats: u.stats, sprite: isHidden ? null : u.sprite, spriteHidden: isHidden };
    if (u.borrowedFrom !== undefined) unit.borrowedFrom = u.borrowedFrom;
    w.bestUnit = unit;
  }
  if (id === 'comeback' && sb && ps.places.length > 0) w.detail = `${ordinal(Math.max(...ps.places))} → ${ordinal(sb.place)}`;
  if (id === 'sharpshooter' && ps.longestKo) w.detail = `in round ${ps.longestKo.round}`;
  return w;
}
