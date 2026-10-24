// M8.8 element, splash and support effects for the iso arena (plan §12.2,
// elements spec §9): the projector-readable layer on top of fx.ts.
//
//   * Status from frame flags (BURNING, FROZEN, HASTED, MIGHTY, SHIELDED) and
//     the sprite tint of a frozen or burning body (`tintSpec`: a palette mix,
//     baked once per design like the seat outline).
//   * Animation tempo: a frozen body animates at 65% speed (`animTempo`).
//   * Pooled one-shot effects (`EffectLayer`): jagged lightning arcs, splash
//     rings, heal / cleanse beams and "SHATTER!" / "OVERLOAD!" pop text. Every
//     pool has a fixed capacity and recycles its oldest slot, so a busy
//     8-player battle allocates nothing per frame and never grows.
//   * Aura ground rings (`drawAuraRing`) and the small status icons over a
//     body (`drawStatusIcons`): shapes, never colour only (snowflake, flame,
//     chevrons, sword, hexagon).
//   * The first-battle legend (`LegendTracker`): the first time an element or
//     an aura shows up, a 3 s corner box says what it does.
//
// Reduced motion: no flicker, jitter, pulsing or growth: arcs keep one fixed
// shape, rings appear at their full size and fade, pop text doesn't bounce.
// DOM-free: drawing takes the small `EffectCanvas` interface (tests fake it).

import { FRAME_FLAGS, type AuraKind, type Element, type HitKind, type SpriteSpec, type SupportKind } from '@pixel-clash/shared';
import { Pool } from './fx.js';
import { hexToRgb, mixRgb, rgbToHex } from '../seats.js';

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Element colours (projectiles, damage numbers, splash rings, chips). Normal is a light grey. */
export const ELEMENT_COLOR: Readonly<Record<Element, string>> = {
  normal: '#C9CED6',
  fire: '#FF8A2A',
  ice: '#7FE3FF',
  lightning: '#FFE14A',
};

/** Aura ring and icon colours (spec §9: haste green, might red, shield blue). */
export const AURA_COLOR: Readonly<Record<AuraKind, string>> = {
  haste: '#4ADE80',
  might: '#FF5A5A',
  shield: '#5AA8FF',
};

export const HEAL_COLOR = '#5CF08A';
export const CLEANSE_COLOR = '#FFFFFF';
/** The white frost outline of a frozen body. */
export const FROST_OUTLINE = '#E8FBFF';
/** The orange outline a burning body flickers to. */
export const BURN_OUTLINE = '#FF8A2A';

/** One icon per element and support kind (unit cards, chips, the legend). */
export const ELEMENT_ICON: Readonly<Record<Element, string>> = { normal: '•', fire: '🔥', ice: '❄️', lightning: '⚡' };
export const SUPPORT_ICON: Readonly<Record<SupportKind, string>> = { heal: '💚', haste: '💨', might: '💪', shield: '🛡️' };

/**
 * Damage-number colour: plain hits keep the warm M8 colour (apart from the
 * white seat badges), element hits their element's colour, burn ticks orange.
 */
export function damageColor(kind: HitKind | undefined, element: Element | undefined, big: boolean): string {
  if (kind === 'burn') return ELEMENT_COLOR.fire;
  if (kind === 'shatter') return ELEMENT_COLOR.ice;
  if (element && element !== 'normal') return ELEMENT_COLOR[element];
  return big ? '#FFD447' : '#FF8A7A';
}

/** Damage numbers of 100 or more are drawn 1.5× bigger (spec §9). */
export const BIG_NUMBER_DAMAGE = 100;

// ---------------------------------------------------------------------------
// Status from frame flags
// ---------------------------------------------------------------------------

export interface FlagStatus {
  burning: boolean;
  frozen: boolean;
  hasted: boolean;
  mighty: boolean;
  shielded: boolean;
}

export const STATUS_FLAGS = FRAME_FLAGS.BURNING | FRAME_FLAGS.FROZEN | FRAME_FLAGS.HASTED | FRAME_FLAGS.MIGHTY | FRAME_FLAGS.SHIELDED;

export function statusOf(flags: number): FlagStatus {
  return {
    burning: (flags & FRAME_FLAGS.BURNING) !== 0,
    frozen: (flags & FRAME_FLAGS.FROZEN) !== 0,
    hasted: (flags & FRAME_FLAGS.HASTED) !== 0,
    mighty: (flags & FRAME_FLAGS.MIGHTY) !== 0,
    shielded: (flags & FRAME_FLAGS.SHIELDED) !== 0,
  };
}

/** How many status icons a body shows (snowflake, flame, then the three buffs). */
export function statusIconCount(flags: number): number {
  let n = 0;
  for (const f of [FRAME_FLAGS.FROZEN, FRAME_FLAGS.BURNING, FRAME_FLAGS.HASTED, FRAME_FLAGS.MIGHTY, FRAME_FLAGS.SHIELDED]) if (flags & f) n++;
  return n;
}

/** Frozen bodies move, reload and animate 35% slower (spec §3.3); a hasted one animates a little faster. */
export const FROZEN_TEMPO = 0.65;
export const HASTED_TEMPO = 1.25;

/** The sprite animation rate for a body's flags (1 = normal). */
export function animTempo(flags: number): number {
  let t = 1;
  if (flags & FRAME_FLAGS.FROZEN) t *= FROZEN_TEMPO;
  if (flags & FRAME_FLAGS.HASTED) t *= HASTED_TEMPO;
  return t;
}

/** Which tinted bake a body uses: frozen wins over burning (the flames still show). */
export type BodyTint = 'none' | 'ice' | 'fire';

export function tintOf(flags: number): BodyTint {
  if (flags & FRAME_FLAGS.FROZEN) return 'ice';
  if (flags & FRAME_FLAGS.BURNING) return 'fire';
  return 'none';
}

/** Mix of every palette colour toward the tint (ice: a strong cyan frost; fire: a light orange glow). */
export const TINT_MIX: Readonly<Record<Exclude<BodyTint, 'none'>, { color: string; amount: number }>> = {
  ice: { color: '#9BEBFF', amount: 0.55 },
  fire: { color: '#FF8A2A', amount: 0.3 },
};

/** A copy of `spec` with every palette colour mixed toward the tint colour (same frames). */
export function tintSpec(spec: SpriteSpec, tint: Exclude<BodyTint, 'none'>): SpriteSpec {
  const { color, amount } = TINT_MIX[tint];
  const to = hexToRgb(color);
  const palette: Record<string, string> = {};
  for (const [k, hex] of Object.entries(spec.palette)) palette[k] = rgbToHex(mixRgb(hexToRgb(hex), to, amount));
  return { ...spec, palette };
}

/** Outline of a tinted bake: frost white when frozen, orange when burning (it flickers with the seat colour). */
export function tintOutline(tint: BodyTint, seatColor: string): string {
  return tint === 'ice' ? FROST_OUTLINE : tint === 'fire' ? BURN_OUTLINE : seatColor;
}

/** A burning body's outline flickers between orange and its seat colour (steady orange with reduced motion). */
export function burnFlickerOn(now: number, phase: number, reducedMotion: boolean): boolean {
  if (reducedMotion) return true;
  return Math.floor((now + phase) / 110) % 3 !== 2;
}

// ---------------------------------------------------------------------------
// Timing (DOM-free, tested)
// ---------------------------------------------------------------------------

/** A lightning arc is drawn this long (spec: 150 ms; a little longer so it reads on a projector). */
export const ARC_MS = 180;
/** A splash ring grows to its radius over this long, then fades. */
export const SPLASH_MS = 250;
export const SPLASH_FADE_MS = 150;
/** Heal and cleanse beams. */
export const BEAM_MS = 320;
/** "SHATTER!" / "OVERLOAD!" pop text. */
export const POP_MS = 500;
/** The corner legend stays this long after the newest thing it explains. */
export const LEGEND_MS = 3000;

/** Splash ring at `elapsed` ms: radius share (0-1) and alpha, or null when over. */
export function splashRingPose(elapsed: number, reducedMotion = false): { grow: number; alpha: number } | null {
  if (elapsed < 0 || elapsed >= SPLASH_MS + SPLASH_FADE_MS) return null;
  if (reducedMotion) return { grow: 1, alpha: Math.max(0, 1 - elapsed / (SPLASH_MS + SPLASH_FADE_MS)) * 0.9 };
  const t = Math.min(1, elapsed / SPLASH_MS);
  const grow = 1 - (1 - t) ** 3;
  const alpha = elapsed < SPLASH_MS ? 0.95 : 0.95 * (1 - (elapsed - SPLASH_MS) / SPLASH_FADE_MS);
  return { grow, alpha };
}

/** Arc alpha at `elapsed` ms (full, then a quick fade), or 0 when over. */
export function arcAlpha(elapsed: number): number {
  if (elapsed < 0 || elapsed >= ARC_MS) return 0;
  const t = elapsed / ARC_MS;
  return t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
}

/** Beam alpha at `elapsed` ms, or 0 when over. */
export function beamAlpha(elapsed: number): number {
  if (elapsed < 0 || elapsed >= BEAM_MS) return 0;
  return 1 - (elapsed / BEAM_MS) ** 2;
}

/** Pop-text scale and alpha at `elapsed` ms (a bounce in, a fade out), or null when over. */
export function popPose(elapsed: number, reducedMotion = false): { scale: number; alpha: number; rise: number } | null {
  if (elapsed < 0 || elapsed >= POP_MS) return null;
  const t = elapsed / POP_MS;
  const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
  if (reducedMotion) return { scale: 1, alpha, rise: 0 };
  const scale = t < 0.2 ? 0.6 + (t / 0.2) * 0.65 : t < 0.35 ? 1.25 - ((t - 0.2) / 0.15) * 0.25 : 1;
  return { scale, alpha, rise: 14 * t };
}

/** Slow aura-ring pulse (alpha multiplier 0.75-1; steady with reduced motion). */
export function auraPulse(now: number, phase: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  return 0.875 + 0.125 * Math.sin(((now + phase) / 1600) * Math.PI * 2);
}

/** Small deterministic hash → [0, 1) (arc jitter: same seed, same bolt). */
export function hash01(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Points of one jagged bolt segment. */
export const BOLT_STEPS = 6;

/**
 * A jagged polyline from (x0, y0) to (x1, y1) written into `out` as x, y pairs
 * (BOLT_STEPS + 1 points; the ends are exact). The kinks sit perpendicular to
 * the line, at most `amp` px, and depend only on `seed`.
 */
export function boltPath(x0: number, y0: number, x1: number, y1: number, seed: number, amp: number, out: Float32Array | number[]): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const a = Math.min(amp, len * 0.18);
  for (let i = 0; i <= BOLT_STEPS; i++) {
    const t = i / BOLT_STEPS;
    const off = i === 0 || i === BOLT_STEPS ? 0 : (hash01(seed * 31 + i) * 2 - 1) * a;
    out[i * 2] = x0 + dx * t + nx * off;
    out[i * 2 + 1] = y0 + dy * t + ny * off;
  }
  return BOLT_STEPS + 1;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export type LegendKey = 'fire' | 'ice' | 'lightning' | 'shatter' | 'splash' | 'heal' | 'haste' | 'might' | 'shield';

export const LEGEND_TEXT: Readonly<Record<LegendKey, string>> = {
  fire: 'fire burns',
  ice: 'ice slows',
  lightning: 'lightning zaps',
  shatter: 'ice then fire = SHATTER',
  splash: 'splash hits everyone near',
  heal: 'medics heal (fire stops them)',
  haste: 'green ring = faster',
  might: 'red ring = stronger',
  shield: 'blue ring = tougher',
};

export const LEGEND_COLOR: Readonly<Record<LegendKey, string>> = {
  fire: ELEMENT_COLOR.fire,
  ice: ELEMENT_COLOR.ice,
  lightning: ELEMENT_COLOR.lightning,
  shatter: ELEMENT_COLOR.ice,
  splash: ELEMENT_COLOR.normal,
  heal: HEAL_COLOR,
  haste: AURA_COLOR.haste,
  might: AURA_COLOR.might,
  shield: AURA_COLOR.shield,
};

/**
 * The first-battle legend (spec §9): each key is explained once per match
 * (the renderer's lifetime, or until `reset`). `note` returns true when the
 * key is new; `lines(now)` is what to show (in the order they appeared),
 * all of them until LEGEND_MS after the newest one.
 */
export class LegendTracker {
  private readonly seen = new Set<LegendKey>();
  private shown: LegendKey[] = [];
  private lastAt = Number.NEGATIVE_INFINITY;

  note(key: LegendKey, now: number): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (now - this.lastAt >= LEGEND_MS) this.shown = [];
    this.shown.push(key);
    this.lastAt = now;
    return true;
  }

  lines(now: number): readonly LegendKey[] {
    if (now - this.lastAt >= LEGEND_MS || now < this.lastAt) return [];
    return this.shown;
  }

  /** Alpha of the legend box (fades in the last 400 ms). */
  alpha(now: number): number {
    const left = LEGEND_MS - (now - this.lastAt);
    if (left <= 0) return 0;
    return Math.min(1, left / 400);
  }

  has(key: LegendKey): boolean {
    return this.seen.has(key);
  }

  reset(): void {
    this.seen.clear();
    this.shown = [];
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Drawing interface
// ---------------------------------------------------------------------------

/** The bits of CanvasRenderingContext2D the effects use (DOM-free for tests). */
export interface EffectCanvas {
  globalAlpha: number;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
}

// ---------------------------------------------------------------------------
// Pooled one-shot effects
// ---------------------------------------------------------------------------

/** Up to 3 points: the struck target, then each zapped body in hop order. */
export interface Arc {
  alive: boolean;
  at: number;
  /** x, y pairs (screen px). */
  pts: Float32Array;
  n: number;
  /** Overload (2+ hops): a thicker bolt. */
  thick: boolean;
  seed: number;
}

export interface Ring {
  alive: boolean;
  at: number;
  x: number;
  y: number;
  rx: number;
  ry: number;
  color: string;
}

export interface Beam {
  alive: boolean;
  at: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
}

export interface Pop {
  alive: boolean;
  at: number;
  x: number;
  y: number;
  text: string;
  color: string;
}

export const MAX_ARCS = 24;
export const MAX_RINGS = 24;
export const MAX_BEAMS = 24;
export const MAX_POPS = 6;
/** Most points of one arc (target + 2 hops). */
export const ARC_POINTS = 3;

const FONT = '"Press Start 2P", ui-monospace, monospace';

export class EffectLayer {
  readonly arcs = new Pool<Arc>(MAX_ARCS, () => ({ alive: false, at: 0, pts: new Float32Array(ARC_POINTS * 2), n: 0, thick: false, seed: 0 }));
  readonly rings = new Pool<Ring>(MAX_RINGS, () => ({ alive: false, at: 0, x: 0, y: 0, rx: 0, ry: 0, color: '#fff' }));
  readonly beams = new Pool<Beam>(MAX_BEAMS, () => ({ alive: false, at: 0, x0: 0, y0: 0, x1: 0, y1: 0, color: '#fff' }));
  readonly pops = new Pool<Pop>(MAX_POPS, () => ({ alive: false, at: 0, x: 0, y: 0, text: '', color: '#fff' }));
  readonly legend = new LegendTracker();
  private seed = 1;
  /** Scratch for one bolt segment (no allocation per frame). */
  private readonly bolt = new Float32Array((BOLT_STEPS + 1) * 2);

  constructor(public reducedMotion = false) {}

  clear(): void {
    this.arcs.clear();
    this.rings.clear();
    this.beams.clear();
    this.pops.clear();
  }

  /** A lightning arc through `points` (x, y pairs; 2-3 points). */
  arc(points: readonly number[], now: number): void {
    const n = Math.min(ARC_POINTS, Math.floor(points.length / 2));
    if (n < 2) return;
    const a = this.arcs.take();
    a.at = now;
    a.n = n;
    for (let i = 0; i < n * 2; i++) a.pts[i] = points[i]!;
    a.thick = n > 2;
    a.seed = this.seed++;
  }

  /** A splash ring (screen centre and radii at the full splash radius). */
  ring(x: number, y: number, rx: number, ry: number, color: string, now: number): void {
    const r = this.rings.take();
    r.at = now;
    r.x = x;
    r.y = y;
    r.rx = rx;
    r.ry = ry;
    r.color = color;
  }

  beam(x0: number, y0: number, x1: number, y1: number, color: string, now: number): void {
    const b = this.beams.take();
    b.at = now;
    b.x0 = x0;
    b.y0 = y0;
    b.x1 = x1;
    b.y1 = y1;
    b.color = color;
  }

  pop(x: number, y: number, text: string, color: string, now: number): void {
    const p = this.pops.take();
    p.at = now;
    p.x = x;
    p.y = y;
    p.text = text;
    p.color = color;
  }

  /** Retire finished effects. */
  update(now: number): void {
    for (const a of this.arcs.items) if (a.alive && now - a.at >= ARC_MS) a.alive = false;
    for (const r of this.rings.items) if (r.alive && now - r.at >= SPLASH_MS + SPLASH_FADE_MS) r.alive = false;
    for (const b of this.beams.items) if (b.alive && now - b.at >= BEAM_MS) b.alive = false;
    for (const p of this.pops.items) if (p.alive && now - p.at >= POP_MS) p.alive = false;
  }

  /** Splash rings: drawn on the ground, under the bodies. */
  drawGround(ctx: EffectCanvas, now: number, zoom: number): void {
    for (const r of this.rings.items) {
      if (!r.alive) continue;
      const pose = splashRingPose(now - r.at, this.reducedMotion);
      if (!pose) continue;
      const rx = Math.max(2, r.rx * pose.grow);
      const ry = Math.max(1, r.ry * pose.grow);
      ctx.globalAlpha = pose.alpha * 0.25;
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = pose.alpha;
      ctx.lineWidth = Math.max(2, 2.5 * zoom);
      ctx.strokeStyle = '#05040A';
      ctx.stroke();
      ctx.lineWidth = Math.max(1.5, 1.6 * zoom);
      ctx.strokeStyle = r.color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Arcs, beams and pop text: drawn over everything. */
  drawOver(ctx: EffectCanvas, now: number, zoom: number): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of this.beams.items) {
      if (!b.alive) continue;
      const a = beamAlpha(now - b.at);
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(b.x0, b.y0);
      ctx.lineTo(b.x1, b.y1);
      ctx.lineWidth = Math.max(4, 4 * zoom);
      ctx.strokeStyle = '#05040A';
      ctx.stroke();
      ctx.lineWidth = Math.max(2, 2.4 * zoom);
      ctx.strokeStyle = b.color;
      ctx.stroke();
      ctx.lineWidth = Math.max(1, 0.8 * zoom);
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }
    const amp = Math.max(4, 7 * zoom);
    for (const arc of this.arcs.items) {
      if (!arc.alive) continue;
      const a = arcAlpha(now - arc.at);
      if (a <= 0) continue;
      // The bolt re-kinks every 45 ms (a flicker); one fixed shape with reduced motion.
      const seed = this.reducedMotion ? arc.seed * 977 : arc.seed * 977 + Math.floor((now - arc.at) / 45);
      ctx.globalAlpha = a;
      for (const [color, width] of [
        ['#05040A', (arc.thick ? 6 : 4) * zoom + 2],
        [ELEMENT_COLOR.lightning, (arc.thick ? 4 : 2.5) * zoom],
        ['#FFFFFF', (arc.thick ? 1.6 : 1) * zoom],
      ] as const) {
        ctx.beginPath();
        for (let s = 0; s + 1 < arc.n; s++) {
          const n = boltPath(arc.pts[s * 2]!, arc.pts[s * 2 + 1]!, arc.pts[s * 2 + 2]!, arc.pts[s * 2 + 3]!, seed + s * 13, amp, this.bolt);
          for (let i = 0; i < n; i++) {
            if (i === 0) ctx.moveTo(this.bolt[0]!, this.bolt[1]!);
            else ctx.lineTo(this.bolt[i * 2]!, this.bolt[i * 2 + 1]!);
          }
        }
        ctx.lineWidth = Math.max(1, width);
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    const fontPx = Math.max(12, Math.round(10 * zoom));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.pops.items) {
      if (!p.alive) continue;
      const pose = popPose(now - p.at, this.reducedMotion);
      if (!pose) continue;
      ctx.font = `${Math.round(fontPx * 1.5 * pose.scale)}px ${FONT}`;
      ctx.globalAlpha = pose.alpha;
      ctx.lineWidth = Math.max(3, fontPx / 3);
      ctx.strokeStyle = '#05040A';
      const y = Math.round(p.y - pose.rise * zoom);
      ctx.strokeText(p.text, Math.round(p.x), y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, Math.round(p.x), y);
    }
    ctx.globalAlpha = 1;
  }

  /** The legend box in the bottom-left corner (nothing when no lines are due). */
  drawLegend(ctx: EffectCanvas, now: number, height: number, zoom: number): void {
    const lines = this.legend.lines(now);
    if (lines.length === 0) return;
    const fontPx = Math.max(11, Math.round(8 * Math.min(1.6, zoom)));
    const lh = Math.round(fontPx * 1.9);
    const pad = Math.round(fontPx * 0.8);
    const w = Math.round(fontPx * 26);
    const h = lines.length * lh + pad * 2;
    const x = 12;
    const y = Math.round(height - h - 12);
    ctx.globalAlpha = 0.88 * this.legend.alpha(now);
    ctx.fillStyle = '#05040A';
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = this.legend.alpha(now);
    ctx.font = `${fontPx}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((key, i) => {
      const cy = y + pad + i * lh + lh / 2;
      const sw = Math.round(fontPx * 0.9);
      ctx.fillStyle = LEGEND_COLOR[key];
      ctx.fillRect(x + pad, Math.round(cy - sw / 2), sw, sw);
      ctx.fillStyle = '#F5F3FF';
      ctx.fillText(LEGEND_TEXT[key], x + pad + sw + Math.round(fontPx * 0.7), cy + 1);
    });
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Aura rings and status icons
// ---------------------------------------------------------------------------

/** Pre-built fill/stroke strings per aura (no per-frame string building). */
const AURA_FILL: Readonly<Record<AuraKind, string>> = {
  haste: 'rgba(74,222,128,0.10)',
  might: 'rgba(255,90,90,0.10)',
  shield: 'rgba(90,168,255,0.10)',
};

/** Marks round an aura ring (they turn slowly; still with reduced motion). */
export const AURA_MARKS = 6;

/**
 * A support unit's aura on the ground (spec §9): a translucent ring at its
 * reach (body radius + supportRange, as an iso ellipse), pulsing slowly, with
 * the kind's marks on it: haste chevrons, might arrows, shield hexagons.
 */
export function drawAuraRing(ctx: EffectCanvas, kind: AuraKind, x: number, y: number, rx: number, ry: number, zoom: number, now: number, phase: number, reducedMotion: boolean): void {
  const pulse = auraPulse(now, phase, reducedMotion);
  const color = AURA_COLOR[kind];
  ctx.globalAlpha = pulse;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = AURA_FILL[kind];
  ctx.fill();
  ctx.globalAlpha = 0.55 * pulse;
  ctx.lineWidth = Math.max(1.5, 1.4 * zoom);
  ctx.setLineDash(kind === 'shield' ? [] : [Math.max(4, 6 * zoom), Math.max(3, 4 * zoom)]);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);
  const turn = reducedMotion ? 0 : ((now + phase) / 9000) * Math.PI * 2;
  const s = Math.max(3, 3 * zoom);
  ctx.globalAlpha = 0.8 * pulse;
  ctx.lineWidth = Math.max(1.5, 1.2 * zoom);
  for (let i = 0; i < AURA_MARKS; i++) {
    const a = turn + (i / AURA_MARKS) * Math.PI * 2;
    drawAuraMark(ctx, kind, x + Math.cos(a) * rx, y + Math.sin(a) * ry, s);
  }
  ctx.globalAlpha = 1;
}

/** One aura mark centred on (x, y), `s` px across-ish. */
export function drawAuraMark(ctx: EffectCanvas, kind: AuraKind, x: number, y: number, s: number): void {
  ctx.beginPath();
  if (kind === 'haste') {
    // ">>" chevrons.
    for (const dx of [-s * 0.6, s * 0.3]) {
      ctx.moveTo(x + dx - s * 0.4, y - s * 0.6);
      ctx.lineTo(x + dx + s * 0.3, y);
      ctx.lineTo(x + dx - s * 0.4, y + s * 0.6);
    }
    ctx.strokeStyle = AURA_COLOR.haste;
    ctx.stroke();
    return;
  }
  if (kind === 'might') {
    // An up arrow.
    ctx.moveTo(x, y - s * 0.8);
    ctx.lineTo(x + s * 0.7, y);
    ctx.lineTo(x + s * 0.25, y);
    ctx.lineTo(x + s * 0.25, y + s * 0.8);
    ctx.lineTo(x - s * 0.25, y + s * 0.8);
    ctx.lineTo(x - s * 0.25, y);
    ctx.lineTo(x - s * 0.7, y);
    ctx.closePath();
    ctx.fillStyle = AURA_COLOR.might;
    ctx.fill();
    return;
  }
  // A hexagon.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = x + Math.cos(a) * s * 0.75;
    const py = y + Math.sin(a) * s * 0.75;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.strokeStyle = AURA_COLOR.shield;
  ctx.stroke();
}

/** A six-armed snowflake. */
export function drawSnowflake(ctx: EffectCanvas, x: number, y: number, s: number): void {
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    ctx.moveTo(x - Math.cos(a) * s, y - Math.sin(a) * s);
    ctx.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
  }
  ctx.lineWidth = Math.max(3, s * 0.55);
  ctx.strokeStyle = '#05040A';
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, s * 0.3);
  ctx.strokeStyle = ELEMENT_COLOR.ice;
  ctx.stroke();
}

/** A flame drop. */
export function drawFlame(ctx: EffectCanvas, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.7, y + s * 0.1);
  ctx.lineTo(x + s * 0.45, y + s * 0.75);
  ctx.lineTo(x - s * 0.45, y + s * 0.75);
  ctx.lineTo(x - s * 0.7, y + s * 0.1);
  ctx.closePath();
  ctx.lineWidth = Math.max(1, s * 0.25);
  ctx.strokeStyle = '#05040A';
  ctx.stroke();
  ctx.fillStyle = ELEMENT_COLOR.fire;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.2);
  ctx.lineTo(x + s * 0.3, y + s * 0.45);
  ctx.lineTo(x - s * 0.3, y + s * 0.45);
  ctx.closePath();
  ctx.fillStyle = '#FFE14A';
  ctx.fill();
}

/** A lightning bolt glyph (element pip of a lightning unit). */
export function drawBoltGlyph(ctx: EffectCanvas, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x + s * 0.2, y - s);
  ctx.lineTo(x - s * 0.55, y + s * 0.1);
  ctx.lineTo(x - s * 0.05, y + s * 0.1);
  ctx.lineTo(x - s * 0.25, y + s);
  ctx.lineTo(x + s * 0.55, y - s * 0.15);
  ctx.lineTo(x + s * 0.05, y - s * 0.15);
  ctx.closePath();
  ctx.lineWidth = Math.max(1, s * 0.25);
  ctx.strokeStyle = '#05040A';
  ctx.stroke();
  ctx.fillStyle = ELEMENT_COLOR.lightning;
  ctx.fill();
}

/** An ice diamond glyph (element pip of an ice unit). */
export function drawIceGlyph(ctx: EffectCanvas, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s * 0.65, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s * 0.65, y);
  ctx.closePath();
  ctx.lineWidth = Math.max(1, s * 0.25);
  ctx.strokeStyle = '#05040A';
  ctx.stroke();
  ctx.fillStyle = ELEMENT_COLOR.ice;
  ctx.fill();
}

/**
 * The element pip at the right end of a unit's HP bar (nothing for normal):
 * the glyph on a dark square chip like the seat badge, so a fire unit's pip
 * doesn't read as the floating "burning" flame.
 */
export function drawElementPip(ctx: EffectCanvas, element: Element, x: number, y: number, s: number): void {
  if (element === 'normal') return;
  ctx.fillStyle = '#05040A';
  ctx.fillRect(Math.round(x - s * 1.15), Math.round(y - s * 1.15), Math.round(s * 2.3), Math.round(s * 2.3));
  ctx.fillStyle = '#2A2440';
  ctx.fillRect(Math.round(x - s), Math.round(y - s), Math.round(s * 2), Math.round(s * 2));
  s *= 0.8;
  if (element === 'fire') drawFlame(ctx, x, y, s);
  else if (element === 'ice') drawIceGlyph(ctx, x, y, s);
  else if (element === 'lightning') drawBoltGlyph(ctx, x, y, s);
}

/**
 * The status icons over a body, in a row centred on `cx` with their bottom at
 * `y`: snowflake (frozen), flame (burning), then haste / might / shield marks
 * on a dark chip. Returns the y above the row (unchanged when none).
 */
export function drawStatusIcons(ctx: EffectCanvas, flags: number, cx: number, y: number, zoom: number): number {
  const n = statusIconCount(flags);
  if (n === 0) return y;
  const s = Math.max(4, 3.6 * zoom);
  const step = s * 2.4;
  const cy = y - s * 1.1;
  let x = cx - ((n - 1) * step) / 2;
  const chip = (kind: AuraKind) => {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#05040A';
    ctx.fillRect(Math.round(x - s * 1.05), Math.round(cy - s * 1.05), Math.round(s * 2.1), Math.round(s * 2.1));
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(1.5, s * 0.35);
    drawAuraMark(ctx, kind, x, cy, s * 1.1);
  };
  if (flags & FRAME_FLAGS.FROZEN) {
    drawSnowflake(ctx, x, cy, s);
    x += step;
  }
  if (flags & FRAME_FLAGS.BURNING) {
    drawFlame(ctx, x, cy, s);
    x += step;
  }
  if (flags & FRAME_FLAGS.HASTED) {
    chip('haste');
    x += step;
  }
  if (flags & FRAME_FLAGS.MIGHTY) {
    chip('might');
    x += step;
  }
  if (flags & FRAME_FLAGS.SHIELDED) chip('shield');
  return cy - s * 1.3;
}
