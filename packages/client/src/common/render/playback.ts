// Battle playback on the client: a buffer of FrameDTOs, interpolation between
// them, and the render clock (live: trails the newest frame by a small delay
// so there is always a next frame to interpolate towards; replay: free-running
// at 1x/2x). DOM-free.

import type { FrameDTO, FrameEvent, FrameProjectile } from '@pixel-clash/shared';

/** Sim ticks per second of battle (config timers.ticksPerSecond). */
export const TICKS_PER_SECOND = 60;
/** Live mode trails the newest frame by this many ticks (×speed) ≈ 100 ms. */
export const LIVE_DELAY_TICKS = 6;
/** Further than this from the target and the clock jumps instead of easing. */
export const LIVE_SNAP_TICKS = 90;

export interface SampledUnit {
  id: string;
  x: number;
  y: number;
  hp: number;
  /** Flags describing the motion towards the next frame (else the current one). */
  flags: number;
}

export type SampledProjectile = FrameProjectile;

export interface FrameSample {
  t: number;
  units: SampledUnit[];
  projectiles: SampledProjectile[];
  safeZoneRadius: number;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** Sorted, de-duplicated frames with time lookup and interpolation. */
export class FrameBuffer {
  private frames: FrameDTO[] = [];

  get length(): number {
    return this.frames.length;
  }
  get firstT(): number {
    return this.frames[0]?.t ?? 0;
  }
  get latestT(): number {
    return this.frames[this.frames.length - 1]?.t ?? 0;
  }
  get all(): readonly FrameDTO[] {
    return this.frames;
  }

  clear(): void {
    this.frames = [];
  }

  /** Add frames (any order; a frame with a known `t` replaces the old one). */
  push(frames: readonly FrameDTO[]): void {
    for (const f of frames) {
      const last = this.frames[this.frames.length - 1];
      if (!last || f.t > last.t) {
        this.frames.push(f);
        continue;
      }
      const i = this.indexAt(f.t);
      if (i >= 0 && this.frames[i]!.t === f.t) this.frames[i] = f;
      else this.frames.splice(i + 1, 0, f);
    }
  }

  /** Drop frames older than `t` (keeps the one at or before `t`). */
  trimBefore(t: number): void {
    const i = this.indexAt(t);
    if (i > 0) this.frames.splice(0, i);
  }

  /** Index of the last frame with frame.t ≤ t, or -1. */
  indexAt(t: number): number {
    let lo = 0;
    let hi = this.frames.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid]!.t <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /**
   * The interpolated state at (fractional) tick `t`. Units present in both
   * neighbouring frames are lerped; a unit missing from the next frame (it
   * died) stays at its last position. Projectiles are matched by id.
   */
  sample(t: number): FrameSample | null {
    if (this.frames.length === 0) return null;
    const i = Math.max(0, this.indexAt(t));
    const a = this.frames[i]!;
    const b = this.frames[i + 1];
    if (!b || t <= a.t) {
      return {
        t: Math.max(t, a.t),
        units: a.units.map(([id, x, y, hp, flags]) => ({ id, x, y, hp, flags })),
        projectiles: a.projectiles.map((p) => ({ ...p })),
        safeZoneRadius: a.safeZoneRadius,
      };
    }
    const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    const next = new Map(b.units.map((u) => [u[0], u]));
    const units = a.units.map(([id, x, y, hp, flags]): SampledUnit => {
      const n = next.get(id);
      if (!n) return { id, x, y, hp, flags };
      return { id, x: lerp(x, n[1], f), y: lerp(y, n[2], f), hp: lerp(hp, n[3], f), flags: n[4] };
    });
    const nextP = new Map(b.projectiles.map((p) => [p.id, p]));
    const projectiles = a.projectiles.map((p): SampledProjectile => {
      const n = nextP.get(p.id);
      return n ? { ...p, x: lerp(p.x, n.x, f), y: lerp(p.y, n.y, f) } : { ...p };
    });
    return { t, units, projectiles, safeZoneRadius: lerp(a.safeZoneRadius, b.safeZoneRadius, f) };
  }

  /** Events of the frames with fromT < frame.t ≤ toT, in order (with their frame time). */
  eventsBetween(fromT: number, toT: number): Array<{ t: number; event: FrameEvent }> {
    const out: Array<{ t: number; event: FrameEvent }> = [];
    if (toT <= fromT) return out;
    for (let i = Math.max(0, this.indexAt(fromT)); i < this.frames.length; i++) {
      const fr = this.frames[i]!;
      if (fr.t <= fromT) continue;
      if (fr.t > toT) break;
      for (const event of fr.events) out.push({ t: fr.t, event });
    }
    return out;
  }
}

export type ClockMode = 'live' | 'replay';

/** The render clock in (fractional) sim ticks. */
export class PlaybackClock {
  tick = 0;
  speed: 1 | 2 = 1;
  paused = false;
  mode: ClockMode = 'live';

  /** Replay: jump to a tick. */
  seek(t: number): void {
    this.tick = Math.max(0, t);
  }

  /**
   * Advance by `dtMs` of wall time. Live mode eases towards
   * `latestT − LIVE_DELAY_TICKS·speed` (and snaps when far off); replay mode
   * runs freely. The clock never passes `endT` (the newest/final frame).
   */
  advance(dtMs: number, firstT: number, endT: number): number {
    const dt = Math.max(0, Math.min(dtMs, 250)); // a background tab must not jump ahead
    if (!this.paused) this.tick += (dt * TICKS_PER_SECOND * this.speed) / 1000;
    if (this.mode === 'live') {
      const target = Math.max(firstT, endT - LIVE_DELAY_TICKS * this.speed);
      const err = target - this.tick;
      if (Math.abs(err) > LIVE_SNAP_TICKS) this.tick = target;
      else if (!this.paused) this.tick += err * Math.min(1, dt / 400);
    }
    this.tick = Math.min(endT, Math.max(firstT, this.tick));
    return this.tick;
  }
}
