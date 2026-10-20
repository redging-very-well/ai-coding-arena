// Ranking and ties (plan §9 Ranking/Ties, §4 Kick). Points are computed from
// the places by sim/scoring.ts.
//
//   * Players kicked during this battle are removed first; the others are
//     ranked among themselves.
//   * Survivors rank above the eliminated, by the total FULL cost of their
//     living units (higher is better).
//   * Eliminated players rank by elimination tick (later is better).
//   * Equal living cost / the same elimination tick share a place; the next
//     place is skipped ("1, 1, 3"). Tied players get the place points of the
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
}

/** A ranked player (kicked players are never ranked). */
export interface Placing {
  playerId: string;
  /** 1-based; ties share a place and the next place is skipped. */
  place: number;
  livingCost: number;
  eliminatedAtTick: number | null;
}

/** Compare for "better first". Returns 0 for a tie. */
function compareStandings(a: Standing, b: Standing): number {
  const aAlive = a.eliminatedAtTick === null;
  const bAlive = b.eliminatedAtTick === null;
  if (aAlive !== bAlive) return aAlive ? -1 : 1;
  if (aAlive) return b.livingCost - a.livingCost;
  return b.eliminatedAtTick! - a.eliminatedAtTick!;
}

/**
 * Rank standings. `excluded` (kicked player ids) are left out entirely.
 * Output is sorted by place, then seat.
 */
export function rankStandings(standings: readonly Standing[], excluded: ReadonlySet<string> = new Set()): Placing[] {
  const sorted = standings
    .filter((s) => !excluded.has(s.playerId))
    .slice()
    .sort((a, b) => compareStandings(a, b) || a.seat - b.seat || compareIds(a.playerId, b.playerId));

  const out: Placing[] = [];
  let place = 0;
  sorted.forEach((s, i) => {
    // Competition ranking: a tie keeps the previous place, otherwise place = position.
    if (i === 0 || compareStandings(sorted[i - 1]!, s) !== 0) place = i + 1;
    out.push({
      playerId: s.playerId,
      place,
      livingCost: s.livingCost,
      eliminatedAtTick: s.eliminatedAtTick,
    });
  });
  return out;
}

/** Ranking from a finished (or stopped) sim result. */
export function rankResult(result: Pick<BattleResult, 'players'>, excluded: ReadonlySet<string> = new Set()): Placing[] {
  return rankStandings(
    result.players.map((p) => ({
      playerId: p.playerId,
      seat: p.seat,
      livingCost: p.livingCost,
      eliminatedAtTick: p.eliminatedAtTick,
    })),
    excluded,
  );
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
      return { playerId: p.playerId, seat: p.seat, livingCost: cost ?? 0, eliminatedAtTick };
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
