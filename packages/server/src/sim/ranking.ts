// Ranking and ties (plan §9 Ranking/Ties, §9.2, §4 Kick). Points are computed
// from the places by sim/scoring.ts.
//
// SIDES are ranked: free-for-all every player is a side; in team mode (the
// standings carry a `teamId`) a side is a team, and every member gets the
// team's place.
//
//   * Players kicked during this battle are removed first; the others are
//     ranked among themselves. A kicked member's units don't count towards
//     the team, and a team whose members were all kicked is removed.
//   * Survivors rank above the eliminated, by the total FULL cost of their
//     living units (team: the sum over its members = team living cost;
//     higher is better).
//   * Eliminated sides rank by elimination tick (later is better; a team is
//     eliminated when its last member's last unit died).
//   * Equal living cost / the same elimination tick share a place; the next
//     place is skipped ("1, 1, 3"). Tied sides get the place points of the
//     better place (scoring.ts).

import type { FrameDTO } from '@pixel-clash/shared';
import { frameAt } from './frames.js';
import { compareIds, type BattleResult } from './types.js';

export interface Standing {
  playerId: string;
  /** Used only to order equal places deterministically in the output. */
  seat: number;
  livingCost: number;
  /** null = still has living units. */
  eliminatedAtTick: number | null;
  /** Team mode: the player's team. Absent = the player is a side of their own. */
  teamId?: number;
}

/** A ranked player (kicked players are never ranked). */
export interface Placing {
  playerId: string;
  /** 1-based place of the player's SIDE; ties share a place and the next place is skipped. */
  place: number;
  /** The player's own living cost (the side's is in `SidePlacing`). */
  livingCost: number;
  eliminatedAtTick: number | null;
  /** Team mode: the player's team. */
  teamId?: number;
}

/** A ranked side (a free-for-all player or a team). */
export interface SidePlacing {
  /** Team mode: the team; absent for a free-for-all player. */
  teamId?: number;
  /** Ranked members in seat order. */
  playerIds: string[];
  place: number;
  livingCost: number;
  eliminatedAtTick: number | null;
}

type Comparable = Pick<Standing, 'livingCost' | 'eliminatedAtTick'>;

/** Compare for "better first". Returns 0 for a tie. */
function compareStandings(a: Comparable, b: Comparable): number {
  const aAlive = a.eliminatedAtTick === null;
  const bAlive = b.eliminatedAtTick === null;
  if (aAlive !== bAlive) return aAlive ? -1 : 1;
  if (aAlive) return b.livingCost - a.livingCost;
  return b.eliminatedAtTick! - a.eliminatedAtTick!;
}

interface Side {
  teamId?: number;
  members: Standing[];
  /** Lowest member seat: orders equal places deterministically. */
  seat: number;
  livingCost: number;
  eliminatedAtTick: number | null;
}

/** Group the (non-kicked) standings into sides and rank them. Sorted by place, then seat. */
function rankSidesInternal(standings: readonly Standing[], excluded: ReadonlySet<string>): Array<Side & { place: number }> {
  const groups = new Map<string, Standing[]>();
  for (const s of standings) {
    if (excluded.has(s.playerId)) continue;
    const key = s.teamId !== undefined ? `t:${s.teamId}` : `p:${s.playerId}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const sides: Side[] = [...groups.values()].map((members) => {
    members.sort((a, b) => a.seat - b.seat || compareIds(a.playerId, b.playerId));
    const alive = members.some((m) => m.eliminatedAtTick === null);
    const side: Side = {
      members,
      seat: members[0]!.seat,
      livingCost: members.reduce((sum, m) => sum + m.livingCost, 0),
      // A side is eliminated when its last member's last unit died.
      eliminatedAtTick: alive ? null : Math.max(...members.map((m) => m.eliminatedAtTick!)),
    };
    if (members[0]!.teamId !== undefined) side.teamId = members[0]!.teamId;
    return side;
  });
  sides.sort((a, b) => compareStandings(a, b) || a.seat - b.seat);

  let place = 0;
  return sides.map((s, i) => {
    // Competition ranking: a tie keeps the previous place, otherwise place = position.
    if (i === 0 || compareStandings(sides[i - 1]!, s) !== 0) place = i + 1;
    return { ...s, place };
  });
}

/**
 * Rank standings by side. `excluded` (kicked player ids) are left out
 * entirely. Every player gets their side's place. Output is sorted by place,
 * then seat.
 */
export function rankStandings(standings: readonly Standing[], excluded: ReadonlySet<string> = new Set()): Placing[] {
  const out: Placing[] = [];
  for (const side of rankSidesInternal(standings, excluded)) {
    for (const s of side.members) {
      const p: Placing = { playerId: s.playerId, place: side.place, livingCost: s.livingCost, eliminatedAtTick: s.eliminatedAtTick };
      if (s.teamId !== undefined) p.teamId = s.teamId;
      out.push(p);
    }
  }
  return out.sort((a, b) => a.place - b.place || seatOf(standings, a.playerId) - seatOf(standings, b.playerId));
}

/** The ranked sides themselves (team table, §9.2). Sorted by place, then seat. */
export function rankSides(standings: readonly Standing[], excluded: ReadonlySet<string> = new Set()): SidePlacing[] {
  return rankSidesInternal(standings, excluded).map((s) => {
    const out: SidePlacing = { playerIds: s.members.map((m) => m.playerId), place: s.place, livingCost: s.livingCost, eliminatedAtTick: s.eliminatedAtTick };
    if (s.teamId !== undefined) out.teamId = s.teamId;
    return out;
  });
}

function seatOf(standings: readonly Standing[], playerId: string): number {
  return standings.find((s) => s.playerId === playerId)?.seat ?? 0;
}

/** Standings from player outcomes (team mode when they carry a teamId). */
function standingOf(p: { playerId: string; seat: number; teamId?: number }, livingCost: number, eliminatedAtTick: number | null): Standing {
  const s: Standing = { playerId: p.playerId, seat: p.seat, livingCost, eliminatedAtTick };
  if (p.teamId !== undefined) s.teamId = p.teamId;
  return s;
}

/** Ranking from a finished (or stopped) sim result. */
export function rankResult(result: Pick<BattleResult, 'players'>, excluded: ReadonlySet<string> = new Set()): Placing[] {
  return rankStandings(standingsOf(result), excluded);
}

/** Per-player standings of a finished (or stopped) sim result. */
export function standingsOf(result: Pick<BattleResult, 'players'>): Standing[] {
  return result.players.map((p) => standingOf(p, p.livingCost, p.eliminatedAtTick));
}

/**
 * Rank from a recorded frame, as a timeout (§9 Skip): players with units in
 * the frame are survivors ranked by the full cost of those units; the others
 * keep their elimination tick (which is ≤ frame.t by construction).
 */
export function rankFromFrame(
  frame: FrameDTO,
  result: Pick<BattleResult, 'players' | 'units'>,
  excluded: ReadonlySet<string> = new Set(),
): Placing[] {
  const unitInfo = new Map(result.units.map((u) => [u.instanceId, u]));
  const living = new Map<string, number>();
  for (const [instanceId] of frame.units) {
    const u = unitInfo.get(instanceId);
    if (!u) continue;
    living.set(u.playerId, (living.get(u.playerId) ?? 0) + u.cost);
  }
  return rankStandings(
    result.players.map((p) => {
      const cost = living.get(p.playerId);
      const alive = cost !== undefined;
      let eliminatedAtTick: number | null = null;
      if (!alive) {
        eliminatedAtTick =
          p.eliminatedAtTick !== null && p.eliminatedAtTick <= frame.t ? p.eliminatedAtTick : frame.t;
      }
      return standingOf(p, cost ?? 0, eliminatedAtTick);
    }),
    excluded,
  );
}

/**
 * Skip helper: rank at the playback tick using the latest frame at or before
 * it. Falls back to the first frame if `tick` precedes every frame.
 */
export function rankAtPlaybackTick(
  frames: readonly FrameDTO[],
  tick: number,
  result: Pick<BattleResult, 'players' | 'units'>,
  excluded: ReadonlySet<string> = new Set(),
): Placing[] {
  const frame = frameAt(frames, tick) ?? frames[0];
  if (!frame) throw new Error('rankAtPlaybackTick: no frames recorded');
  return rankFromFrame(frame, result, excluded);
}
