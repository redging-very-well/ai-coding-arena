// Battle playback on the client: a buffer of FrameDTOs, interpolation between
// them, and the render clock (live: trails the newest frame by a small delay
// so there is always a next frame to interpolate towards; replay: free-running
// at 1x/2x). DOM-free.
//
// Walls (M8.5) are listed only in the first frame and in frames
// where their hp changed. The buffer is told their ids (`setSticky`, from the
// reveal) and carries each one forward into every frame it is pushed, until a
// `death` or `crumble` event removes it, so sampling, seeking and the death
// resync see walls like any other body.

import type { FrameDTO, FrameEvent, FrameFactory, FrameProjectile, FrameUnit } from '@pixel-clash/shared';

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
  /** Living factories (M8.5): progress, minions left, rally point, holding. */
  fac: FrameFactory[];
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** Sorted, de-duplicated frames with time lookup and interpolation. */
export class FrameBuffer {
  private frames: FrameDTO[] = [];
  /** Id lookups of the last "next" frame sampled: rendering samples it ~3 times per frame batch. */
  private nextOf: FrameDTO | null = null;
  private nextUnits = new Map<string, FrameDTO['units'][number]>();
  private nextProjectiles = new Map<number, FrameProjectile>();
  /** Ids carried forward when a frame doesn't list them (walls), with their state before the first frame. */
  private sticky = new Map<string, FrameUnit>();

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
    this.nextOf = null;
    this.sticky = new Map();
  }

  /**
   * The bodies that frames list only when they change (walls),
   * with their state at the start (reveal position, full hp). Call before
   * pushing the battle's frames (clear() forgets them).
   */
  setSticky(seed: Iterable<FrameUnit>): void {
    this.sticky = new Map([...seed].map((u) => [u[0], u]));
  }

  /** `f` with every sticky body it doesn't list carried over from `prev` (or the seed), unless it died in `f`. */
  private materialize(f: FrameDTO, prev: FrameDTO | undefined): FrameDTO {
    if (this.sticky.size === 0) return f;
    const listed = new Set<string>();
    for (const u of f.units) if (this.sticky.has(u[0])) listed.add(u[0]);
    for (const ev of f.events) {
      if (ev.type === 'death' && this.sticky.has(ev.instanceId)) listed.add(ev.instanceId);
      else if (ev.type === 'crumble') for (const id of ev.ids) if (this.sticky.has(id)) listed.add(id);
    }
    const carried: FrameUnit[] = [];
    if (prev) {
      for (const u of prev.units) if (this.sticky.has(u[0]) && !listed.has(u[0])) carried.push(u);
    } else if (f.t === 0) {
      for (const u of this.sticky.values()) if (!listed.has(u[0])) carried.push(u);
    }
    // A first frame after t=0 is a late joiner's catch-up frame: the server lists every
    // living wall in it, so a wall it leaves out has already fallen.
    return carried.length === 0 ? f : { ...f, units: [...f.units, ...carried] };
  }

  private indexNext(b: FrameDTO): void {
    if (this.nextOf === b) return;
    this.nextOf = b;
    this.nextUnits.clear();
    for (const u of b.units) this.nextUnits.set(u[0], u);
    this.nextProjectiles.clear();
    for (const p of b.projectiles) this.nextProjectiles.set(p.id, p);
  }

  /** Add frames (any order; a frame with a known `t` replaces the old one). */
  push(frames: readonly FrameDTO[]): void {
    for (const f of frames) {
      const last = this.frames[this.frames.length - 1];
      if (!last || f.t > last.t) {
        this.frames.push(this.materialize(f, last));
        continue;
      }
      const i = this.indexAt(f.t);
      if (i >= 0 && this.frames[i]!.t === f.t) this.frames[i] = this.materialize(f, this.frames[i - 1]);
      else this.frames.splice(i + 1, 0, this.materialize(f, this.frames[i]));
      this.nextOf = null;
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
        fac: a.fac ?? [],
      };
    }
    const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    this.indexNext(b);
    const next = this.nextUnits;
    const units = a.units.map(([id, x, y, hp, flags]): SampledUnit => {
      const n = next.get(id);
      if (!n) return { id, x, y, hp, flags };
      return { id, x: lerp(x, n[1], f), y: lerp(y, n[2], f), hp: lerp(hp, n[3], f), flags: n[4] };
    });
    const nextP = this.nextProjectiles;
    const projectiles = a.projectiles.map((p): SampledProjectile => {
      const n = nextP.get(p.id);
      return n ? { ...p, x: lerp(p.x, n.x, f), y: lerp(p.y, n.y, f) } : { ...p };
    });
    return { t, units, projectiles, safeZoneRadius: lerp(a.safeZoneRadius, b.safeZoneRadius, f), fac: a.fac ?? [] };
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
