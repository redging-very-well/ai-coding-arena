// Frame recording (plan §9 Frames).
//
// A frame is taken every `frameEveryTicks` (2) completed ticks, plus the spawn
// frame at t=0 and always the final frame. Format:
//   { t, units: [[instanceId, x, y, hp, flags]], projectiles, safeZoneRadius, events }
// `events` holds everything that happened since the previous frame (spawn,
// fire, hit, death, disable). Coordinates and hp are rounded to 2 decimals to
// keep the stream small; the sim itself keeps full precision.
//
// M8.5 (§9.3 Frames): walls are listed only in the first frame and in frames
// where their (rounded) hp changed, `fac` lists the living factories, and the
// flags gain BLOCKED (a wall turned the move) and PRODUCED (a factory made a
// minion).
//
// M8.6 (§9.3): `fac` entries gain stored, burst and the order code, and
// their (x, y) is the order's focus (`focusOf`; default the rally point).
//
// M8.8 (§9.4 Frames): the flags gain BURNING, FROZEN, HASTED, MIGHTY and
// SHIELDED (the body's state at the frame), and the events gain hit kinds
// and elements, arc, splash, shatter, heal and cleanse (sim/effects.ts,
// sim/support.ts). A battle without elements or support records exactly the
// M8.7 frames.

import { FRAME_FLAGS, MINION_ORDERS, type FrameDTO, type FrameEvent, type FrameFactory, type FrameUnit, type Point } from '@pixel-clash/shared';
import type { Projectile, SimUnit } from './types.js';

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function unitFlags(u: SimUnit): number {
  let flags = 0;
  if (u.firedSinceFrame) flags |= FRAME_FLAGS.ATTACKING;
  if (u.movedSinceFrame) flags |= FRAME_FLAGS.MOVING;
  if (u.facingLeft) flags |= FRAME_FLAGS.FACING_LEFT;
  if (u.disabled) flags |= FRAME_FLAGS.DISABLED;
  if (u.outsideSafeZone) flags |= FRAME_FLAGS.OUTSIDE_SAFE_ZONE;
  if (u.blockedSinceFrame) flags |= FRAME_FLAGS.BLOCKED;
  if (u.factory?.spawnedSinceFrame) flags |= FRAME_FLAGS.PRODUCED;
  if ((u.burns?.length ?? 0) > 0) flags |= FRAME_FLAGS.BURNING;
  if ((u.frozen ?? 0) > 0) flags |= FRAME_FLAGS.FROZEN;
  const a = u.aura;
  if (a) {
    if (a.haste > 0) flags |= FRAME_FLAGS.HASTED;
    if (a.might > 0) flags |= FRAME_FLAGS.MIGHTY;
    if (a.shield > 0) flags |= FRAME_FLAGS.SHIELDED;
  }
  return flags;
}

/** Buffers events between frames and builds FrameDTOs. */
export class FrameRecorder {
  readonly frames: FrameDTO[] = [];
  private pending: FrameEvent[] = [];

  event(e: FrameEvent): void {
    this.pending.push(e);
  }

  /**
   * Snapshot the living units (instanceId order) and projectiles at time `t`.
   * Resets each unit's `firedSinceFrame` and `movedSinceFrame` flags.
   */
  record(
    t: number,
    livingUnits: readonly SimUnit[],
    projectiles: readonly Projectile[],
    safeZoneRadius: number,
    focusOf: (factory: SimUnit) => Point = (u) => u.factory!.rally,
  ): FrameDTO {
    const first = this.frames.length === 0;
    const units: FrameUnit[] = [];
    let fac: FrameFactory[] | undefined;
    for (const u of livingUnits) {
      const hp = round2(u.hp);
      if (u.type === 'wall') {
        if (!first && u.frameHp === hp) continue;
        u.frameHp = hp;
      }
      units.push([u.id, round2(u.x), round2(u.y), hp, unitFlags(u)]);
      const f = u.factory;
      if (f) {
        const progress = f.minionsLeft > 0 ? Math.floor((f.timer * 100) / f.productionInterval) : 100;
        const focus = focusOf(u);
        (fac ??= []).push([
          u.id,
          progress,
          f.minionsLeft,
          round2(focus.x),
          round2(focus.y),
          f.holding ? 1 : 0,
          f.canMake,
          f.stored,
          f.burst,
          Math.max(0, MINION_ORDERS.indexOf(f.order)),
        ]);
      }
    }
    for (const u of livingUnits) {
      u.firedSinceFrame = false;
      u.movedSinceFrame = false;
      u.blockedSinceFrame = false;
      if (u.factory) u.factory.spawnedSinceFrame = false;
    }
    const frame: FrameDTO = {
      t,
      units,
      projectiles: projectiles.map((p) => ({ id: p.id, x: round2(p.x), y: round2(p.y), targetId: p.targetId })),
      safeZoneRadius: round2(safeZoneRadius),
      events: this.pending,
    };
    if (fac) frame.fac = fac;
    this.pending = [];
    this.frames.push(frame);
    return frame;
  }
}

/**
 * The latest recorded frame at or before time `t` (frames are sorted by t).
 * Used by playback and by Skip, which ranks at the current playback tick.
 */
export function frameAt(frames: readonly FrameDTO[], t: number): FrameDTO | undefined {
  let lo = 0;
  let hi = frames.length - 1;
  let found: FrameDTO | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = frames[mid]!;
    if (f.t <= t) {
      found = f;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The frame at or before `t` for a late joiner (§9.3 Frames): frames list a
 * wall only when its hp changes, so a lone mid-battle frame would leave out
 * the walls that haven't been hit lately. This copy of it also lists every
 * body still alive at `t` that it doesn't (their last listed row), so the
 * catch-up frame holds every living wall and the client can trust it alone.
 */
export function catchUpFrame(frames: readonly FrameDTO[], t: number): FrameDTO | undefined {
  const at = frameAt(frames, t);
  if (!at || at === frames[0]) return at;
  const last = new Map<string, FrameUnit>();
  for (const f of frames) {
    if (f.t > at.t) break;
    for (const u of f.units) last.set(u[0], u);
    for (const e of f.events) {
      if (e.type === 'death') last.delete(e.instanceId);
      else if (e.type === 'crumble') for (const id of e.ids) last.delete(id);
    }
  }
  for (const u of at.units) last.delete(u[0]);
  if (last.size === 0) return at;
  return { ...at, units: [...at.units, ...[...last.values()].map((u): FrameUnit => [u[0], u[1], u[2], u[3], 0])] };
}
