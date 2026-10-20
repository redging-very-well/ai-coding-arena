// Frame recording (plan §9 Frames).
//
// A frame is taken every `frameEveryTicks` (2) completed ticks, plus the spawn
// frame at t=0 and always the final frame. Format:
//   { t, units: [[instanceId, x, y, hp, flags]], projectiles, safeZoneRadius, events }
// `events` holds everything that happened since the previous frame (spawn,
// fire, hit, death, disable). Coordinates and hp are rounded to 2 decimals to
// keep the stream small; the sim itself keeps full precision.

import { FRAME_FLAGS, type FrameDTO, type FrameEvent, type FrameUnit } from '@pixel-clash/shared';
import type { Projectile, SimUnit } from './types.js';

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function unitFlags(u: SimUnit): number {
  let flags = 0;
  if (u.firedSinceFrame) flags |= FRAME_FLAGS.ATTACKING;
  if (u.movedSinceFrame) flags |= FRAME_FLAGS.MOVING;
  if (u.facingLeft) flags |= FRAME_FLAGS.FACING_LEFT;
  if (u.disabled) flags |= FRAME_FLAGS.DISABLED;
  if (u.outsideSafeZone) flags |= FRAME_FLAGS.OUTSIDE_SAFE_ZONE;
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
  record(t: number, livingUnits: readonly SimUnit[], projectiles: readonly Projectile[], safeZoneRadius: number): FrameDTO {
    const units: FrameUnit[] = livingUnits.map((u) => [u.id, round2(u.x), round2(u.y), round2(u.hp), unitFlags(u)]);
    for (const u of livingUnits) {
      u.firedSinceFrame = false;
      u.movedSinceFrame = false;
    }
    const frame: FrameDTO = {
      t,
      units,
      projectiles: projectiles.map((p) => ({ id: p.id, x: round2(p.x), y: round2(p.y), targetId: p.targetId })),
      safeZoneRadius: round2(safeZoneRadius),
      events: this.pending,
    };
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
