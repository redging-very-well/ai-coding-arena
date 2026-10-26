// Battle effects for the projector: muzzle flashes, hit
// sparks, death pops (pixel particles), floating damage numbers, screen shake
// on big hits and the idle bob. Everything lives in fixed-size pools that are
// reused, so a 96-unit battle allocates nothing per frame. The timing math is
// DOM-free (tests import it); `FxLayer.draw` only needs a 2D context.

/** A hit bigger than this share of the target's max HP shakes the screen. */
export const BIG_HIT_FRACTION = 0.2;

export function isBigHit(damage: number, maxHealth: number): boolean {
  return maxHealth > 0 && damage > BIG_HIT_FRACTION * maxHealth;
}

/** Shake amplitude (CSS px) for a hit of `fraction` of the target's max HP: 0 below the big-hit line, up to 10 px. */
export function shakeStrength(fraction: number): number {
  if (!(fraction > BIG_HIT_FRACTION)) return 0;
  return Math.min(10, 3 + 14 * (fraction - BIG_HIT_FRACTION));
}

export const SHAKE_MS = 320;

/**
 * Screen shake: kicks add up (capped) and decay over SHAKE_MS. The offset is a
 * deterministic function of time, so tests can check it.
 */
export class ScreenShake {
  private amp = 0;
  private at = Number.NEGATIVE_INFINITY;

  kick(strength: number, now: number): void {
    if (strength <= 0) return;
    const left = this.amplitude(now);
    this.amp = Math.min(14, left + strength);
    this.at = now;
  }

  /** Current amplitude (linear decay to 0 over SHAKE_MS). */
  amplitude(now: number): number {
    const t = (now - this.at) / SHAKE_MS;
    if (t >= 1 || t < 0) return 0;
    return this.amp * (1 - t);
  }

  /** Offset to translate the scene by (whole pixels). */
  offset(now: number): { x: number; y: number } {
    const a = this.amplitude(now);
    if (a === 0) return { x: 0, y: 0 };
    return { x: Math.round(Math.sin(now * 0.09) * a), y: Math.round(Math.cos(now * 0.113) * a * 0.6) };
  }

  reset(): void {
    this.amp = 0;
    this.at = Number.NEGATIVE_INFINITY;
  }
}

/** Idle bob (CSS px, upward) for a standing unit: a slow 1-2 px float, desynced by `phase` ms. */
export function bobOffset(now: number, phase: number, height: number): number {
  const amp = Math.max(1, Math.min(3, height * 0.05));
  return (Math.sin(((now + phase) / 900) * Math.PI * 2) + 1) * 0.5 * amp;
}

/** Muzzle flash length. */
export const FLASH_MS = 90;
/** Floating damage numbers rise for this long. */
export const DAMAGE_NUMBER_MS = 750;

/** Muzzle flash alpha after `elapsed` ms (1 → 0), or 0 when over. */
export function flashAlpha(elapsed: number, duration = FLASH_MS): number {
  if (elapsed < 0 || elapsed >= duration) return 0;
  return 1 - elapsed / duration;
}

/** Rise (px) and alpha of a floating damage number `elapsed` ms after the hit. */
export function damageNumberPose(elapsed: number): { rise: number; alpha: number } | null {
  if (elapsed < 0 || elapsed >= DAMAGE_NUMBER_MS) return null;
  const t = elapsed / DAMAGE_NUMBER_MS;
  return { rise: 28 * (1 - (1 - t) ** 2), alpha: t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4 };
}

/** Particles in a death pop: more for bigger units, fewer with reduced motion. */
export function deathBurstCount(size: number, reducedMotion: boolean): number {
  const n = Math.round(8 + size * 0.8);
  return reducedMotion ? Math.min(6, n) : Math.min(24, n);
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

export interface Particle {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Ms left / total. */
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
}

export interface Flash {
  alive: boolean;
  x: number;
  y: number;
  at: number;
  size: number;
  color: string;
}

export interface DamageNumber {
  alive: boolean;
  x: number;
  y: number;
  at: number;
  text: string;
  big: boolean;
  /** Fill colour of a label ("+1" in the seat colour); null = the damage-number colours. */
  color: string | null;
  /** M8.8: drawn smaller (burn ticks, splash and zap hits). */
  small: boolean;
}

/**
 * A fixed-capacity pool: `take()` returns a dead slot, or recycles the oldest
 * one when full (so the cap holds no matter how busy the battle gets).
 */
export class Pool<T extends { alive: boolean }> {
  readonly items: T[];
  private next = 0;

  constructor(
    readonly capacity: number,
    make: () => T,
  ) {
    this.items = Array.from({ length: capacity }, make);
  }

  take(): T {
    for (let i = 0; i < this.capacity; i++) {
      const j = (this.next + i) % this.capacity;
      const it = this.items[j]!;
      if (!it.alive) {
        this.next = (j + 1) % this.capacity;
        it.alive = true;
        return it;
      }
    }
    // Full: recycle round-robin (the oldest-ish slot).
    const it = this.items[this.next]!;
    this.next = (this.next + 1) % this.capacity;
    it.alive = true;
    return it;
  }

  get aliveCount(): number {
    let n = 0;
    for (const it of this.items) if (it.alive) n++;
    return n;
  }

  clear(): void {
    for (const it of this.items) it.alive = false;
  }
}

export const MAX_PARTICLES = 360;
export const MAX_FLASHES = 64;
export const MAX_DAMAGE_NUMBERS = 40;
/** M8.8: flame, frost and sparkle particles have their own pool, so a burning army can't steal death pops. */
export const MAX_STATUS_PARTICLES = 120;

/** Cheap deterministic-enough random for effects (no allocation). */
function rand(): number {
  return Math.random();
}

/** The bits of CanvasRenderingContext2D the effects use (keeps this file DOM-type free for tests). */
export interface FxCanvas {
  globalAlpha: number;
  fillStyle: unknown;
  strokeStyle: unknown;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
}

export interface FxOptions {
  reducedMotion?: boolean;
}

/** All projector effects. Positions are canvas CSS px (computed when spawned). */
export class FxLayer {
  readonly particles = new Pool<Particle>(MAX_PARTICLES, () => ({
    alive: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 1,
    size: 2,
    color: '#fff',
    gravity: 0,
  }));
  readonly flashes = new Pool<Flash>(MAX_FLASHES, () => ({ alive: false, x: 0, y: 0, at: 0, size: 4, color: '#fff' }));
  readonly numbers = new Pool<DamageNumber>(MAX_DAMAGE_NUMBERS, () => ({ alive: false, x: 0, y: 0, at: 0, text: '', big: false, color: null, small: false }));
  /** M8.8 status particles: rising flames, heal sparkles, cleanse smoke, shatter shards. */
  readonly status = new Pool<Particle>(MAX_STATUS_PARTICLES, () => ({
    alive: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife: 1,
    size: 2,
    color: '#fff',
    gravity: 0,
  }));
  readonly shake = new ScreenShake();

  constructor(public options: FxOptions = {}) {}

  get reducedMotion(): boolean {
    return !!this.options.reducedMotion;
  }

  clear(): void {
    this.particles.clear();
    this.flashes.clear();
    this.numbers.clear();
    this.status.clear();
    this.shake.reset();
  }

  muzzle(x: number, y: number, size: number, color: string, now: number): void {
    const f = this.flashes.take();
    f.x = x;
    f.y = y;
    f.at = now;
    f.size = size;
    f.color = color;
  }

  /** A few sparks where a hit lands. */
  sparks(x: number, y: number, scale: number, color: string): void {
    const n = this.reducedMotion ? 1 : 3;
    for (let i = 0; i < n; i++) this.spawn(x, y, (rand() - 0.5) * 120 * scale, (-rand() * 90 - 20) * scale, 220, Math.max(1, Math.round(scale * 1.5)), color, 300 * scale);
  }

  /** A pixel pop: the unit bursts into its colours. */
  deathPop(x: number, y: number, unitSize: number, scale: number, colors: readonly string[]): void {
    const n = deathBurstCount(unitSize, this.reducedMotion);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.4;
      const sp = (60 + rand() * 110) * scale;
      const color = colors[i % colors.length] ?? '#fff';
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp * 0.6 - 60 * scale, 420 + rand() * 280, Math.max(2, Math.round(scale * (1.5 + rand() * 1.5))), color, 380 * scale);
    }
  }

  /**
   * A floating "-N". M8.8: `color` (an element's colour; null = the warm
   * default) and `small` (burn ticks, splash and zap hits).
   */
  damageNumber(x: number, y: number, damage: number, big: boolean, now: number, color: string | null = null, small = false): void {
    const d = this.numbers.take();
    d.x = x;
    d.y = y;
    d.at = now;
    // A minus sign and a warm colour keep it apart from the white seat-number badges.
    d.text = `-${Math.max(1, Math.round(damage)).toLocaleString('en-US')}`;
    d.big = big;
    d.color = color;
    d.small = small;
  }

  /** A rising label in a colour (a factory's "+1" when it makes a minion). */
  label(x: number, y: number, text: string, color: string, now: number): void {
    const d = this.numbers.take();
    d.x = x;
    d.y = y;
    d.at = now;
    d.text = text;
    d.big = false;
    d.color = color;
    d.small = false;
  }

  // M8.8 status particles (their own pool) ------------------------------------

  /** One or two flames rising off a burning body (none with reduced motion: the flame icon stays). */
  flame(x: number, y: number, width: number, scale: number): void {
    if (this.reducedMotion) return;
    const n = rand() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const color = rand() < 0.35 ? '#FFE14A' : rand() < 0.5 ? '#FF5A1F' : '#FF8A2A';
      this.spawnStatus(x + (rand() - 0.5) * width * 0.7, y - rand() * width * 0.3, (rand() - 0.5) * 14 * scale, (-30 - rand() * 30) * scale, 360 + rand() * 200, Math.max(2, Math.round(scale * (1.6 + rand()))), color, -20 * scale);
    }
  }

  /** A frost glint drifting off a frozen body. */
  frost(x: number, y: number, width: number, scale: number): void {
    if (this.reducedMotion) return;
    this.spawnStatus(x + (rand() - 0.5) * width * 0.8, y - rand() * width * 0.5, (rand() - 0.5) * 8 * scale, 12 * scale, 420, Math.max(1, Math.round(scale * 1.4)), rand() < 0.5 ? '#FFFFFF' : '#9BEBFF', 0);
  }

  /** Green sparkles rising round a healed body. */
  sparkles(x: number, y: number, width: number, scale: number): void {
    const n = this.reducedMotion ? 2 : 6;
    for (let i = 0; i < n; i++) {
      this.spawnStatus(x + (rand() - 0.5) * width, y - rand() * width * 0.6, (rand() - 0.5) * 16 * scale, (-40 - rand() * 30) * scale, 520 + rand() * 200, Math.max(2, Math.round(scale * 1.6)), i % 3 === 0 ? '#FFFFFF' : '#5CF08A', -10 * scale);
    }
  }

  /** A grey smoke puff (a cleanse put the fire out / thawed the ice). */
  smoke(x: number, y: number, width: number, scale: number): void {
    const n = this.reducedMotion ? 3 : 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.spawnStatus(x + Math.cos(a) * width * 0.25, y, Math.cos(a) * 24 * scale, (-20 - rand() * 20) * scale, 520 + rand() * 200, Math.max(2, Math.round(scale * 2.5)), i % 2 ? '#D8DCE4' : '#9AA0AA', -15 * scale);
    }
  }

  /** Eight ice shards flying off a shattered body. */
  shards(x: number, y: number, scale: number): void {
    const n = this.reducedMotion ? 4 : 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.3;
      const sp = (90 + rand() * 70) * scale;
      this.spawnStatus(x, y, Math.cos(a) * sp, Math.sin(a) * sp * 0.6 - 50 * scale, 420 + rand() * 160, Math.max(2, Math.round(scale * (2 + rand()))), i % 2 ? '#FFFFFF' : '#7FE3FF', 380 * scale);
    }
  }

  private spawnStatus(x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, gravity: number): void {
    const p = this.status.take();
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = life;
    p.maxLife = life;
    p.size = size;
    p.color = color;
    p.gravity = gravity;
  }

  /** A small "pop" puff (a minion appears): a ring of light particles. */
  puff(x: number, y: number, scale: number, colors: readonly string[]): void {
    const n = this.reducedMotion ? 4 : 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const sp = (40 + rand() * 40) * scale;
      const color = colors[i % colors.length] ?? '#fff';
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp * 0.5 - 20 * scale, 260 + rand() * 120, Math.max(1, Math.round(scale * 1.5)), color, 60 * scale);
    }
  }

  /** A minion crumbles with its destroyed factory: a few falling bits and a puff of dust (cheap: 6 particles, 3 reduced). */
  crumblePop(x: number, y: number, scale: number, colors: readonly string[]): void {
    const n = this.reducedMotion ? 3 : 6;
    for (let i = 0; i < n; i++) {
      const color = i % 3 === 2 ? '#B8B2A6' : (colors[i % colors.length] ?? '#888');
      this.spawn(x + (rand() - 0.5) * 8 * scale, y, (rand() - 0.5) * 50 * scale, -(20 + rand() * 40) * scale, 380 + rand() * 200, Math.max(1, Math.round(scale * 2)), color, 360 * scale);
    }
  }

  /** A wall crumbles: stone chunks falling off and a dust cloud. */
  crumble(x: number, y: number, width: number, scale: number, colors: readonly string[]): void {
    const chunks = this.reducedMotion ? 6 : 18;
    for (let i = 0; i < chunks; i++) {
      const color = colors[i % colors.length] ?? '#888';
      const ox = (rand() - 0.5) * width;
      const oy = -rand() * width * 0.6;
      this.spawn(x + ox, y + oy, (rand() - 0.5) * 70 * scale, -rand() * 60 * scale, 500 + rand() * 300, Math.max(2, Math.round(scale * (2 + rand() * 2))), color, 520 * scale);
    }
    const dust = this.reducedMotion ? 3 : 10;
    for (let i = 0; i < dust; i++) {
      const a = (i / dust) * Math.PI * 2;
      this.spawn(x + Math.cos(a) * width * 0.3, y, Math.cos(a) * 50 * scale, Math.sin(a) * 18 * scale - 10 * scale, 600 + rand() * 300, Math.max(2, Math.round(scale * 3)), '#B8B2A6', -10 * scale);
    }
  }

  /** A tiny dust puff at the feet of a unit pushing on a wall. */
  dust(x: number, y: number, scale: number): void {
    if (this.reducedMotion) return;
    this.spawn(x + (rand() - 0.5) * 6 * scale, y, (rand() - 0.5) * 30 * scale, -15 * scale - rand() * 15 * scale, 280, Math.max(1, Math.round(scale * 1.5)), '#A89F90', 0);
  }

  bigHit(fraction: number, now: number): void {
    if (this.reducedMotion) return;
    this.shake.kick(shakeStrength(fraction), now);
  }

  private spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, color: string, gravity: number): void {
    const p = this.particles.take();
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = life;
    p.maxLife = life;
    p.size = size;
    p.color = color;
    p.gravity = gravity;
  }

  /** Advance particles by `dtMs` (clamped so a background tab doesn't fling them away). */
  update(dtMs: number, now: number): void {
    const dt = Math.max(0, Math.min(dtMs, 50)) / 1000;
    stepParticles(this.particles.items, dt);
    stepParticles(this.status.items, dt);
    for (const f of this.flashes.items) if (f.alive && now - f.at >= FLASH_MS) f.alive = false;
    for (const d of this.numbers.items) if (d.alive && now - d.at >= DAMAGE_NUMBER_MS) d.alive = false;
  }

  /** Scene offset for this frame (0 with reduced motion). */
  offset(now: number): { x: number; y: number } {
    return this.reducedMotion ? { x: 0, y: 0 } : this.shake.offset(now);
  }

  /** Draw flashes, particles and damage numbers on top of the scene. */
  draw(ctx: FxCanvas, now: number, fontPx: number): void {
    for (const f of this.flashes.items) {
      if (!f.alive) continue;
      const a = flashAlpha(now - f.at);
      if (a <= 0) continue;
      const s = Math.max(2, Math.round(f.size * (0.6 + 0.4 * a)));
      ctx.globalAlpha = a;
      ctx.fillStyle = f.color;
      ctx.fillRect(Math.round(f.x - s), Math.round(f.y - s / 2), s * 2, s);
      ctx.fillRect(Math.round(f.x - s / 2), Math.round(f.y - s), s, s * 2);
      ctx.fillStyle = '#FFFFFF';
      const c = Math.max(1, Math.round(s / 2));
      ctx.fillRect(Math.round(f.x - c / 2), Math.round(f.y - c / 2), c, c);
    }
    drawParticles(ctx, this.particles.items);
    drawParticles(ctx, this.status.items);
    ctx.globalAlpha = 1;
    let fontSet = '';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, fontPx / 4);
    ctx.strokeStyle = '#05040A';
    for (const d of this.numbers.items) {
      if (!d.alive) continue;
      const pose = damageNumberPose(now - d.at);
      if (!pose) continue;
      const size = Math.round(d.big ? fontPx * BIG_NUMBER_SCALE : d.small ? fontPx * 0.8 : fontPx);
      const font = `${size}px "Press Start 2P", ui-monospace, monospace`;
      if (font !== fontSet) {
        ctx.font = font;
        fontSet = font;
      }
      ctx.globalAlpha = pose.alpha;
      const y = Math.round(d.y - pose.rise);
      ctx.strokeText(d.text, Math.round(d.x), y);
      ctx.fillStyle = d.color ?? (d.big ? '#FFD447' : '#FF8A7A');
      ctx.fillText(d.text, Math.round(d.x), y);
    }
    ctx.globalAlpha = 1;
  }
}

/** Big damage numbers are drawn this much bigger (M8.8: 1.5×, was 1.4×). */
export const BIG_NUMBER_SCALE = 1.5;

function drawParticles(ctx: FxCanvas, items: readonly Particle[]): void {
  for (const p of items) {
    if (!p.alive) continue;
    ctx.globalAlpha = Math.min(1, (p.life / p.maxLife) * 1.6);
    ctx.fillStyle = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
  }
}

/** Move live particles by `dt` seconds; retire the finished ones. */
function stepParticles(items: Particle[], dt: number): void {
  for (const p of items) {
    if (!p.alive) continue;
    p.life -= dt * 1000;
    if (p.life <= 0) {
      p.alive = false;
      continue;
    }
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}
