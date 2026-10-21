// Seat colours (plan §12): an 8-colour set based on Okabe-Ito, adjusted for
// the dark floor, used ONLY for outlines, zone tints and accents (never for a
// unit's own body colour).
//
// Eight colours can't all be told apart under every colour-vision type, so
// every unit, zone and player tile ALSO shows the seat-number badge (1-8,
// `symbol`), and teams add a ring pattern (teamLook). DOM-free (imported by
// tests).

import { TEAM_STYLES, type TeamPattern } from '@pixel-clash/shared';

export interface SeatStyle {
  seat: number;
  /** Player-facing colour name ("Sky"). */
  name: string;
  /** The seat-number badge ("1"-"8"): the non-colour cue on tiles, zones and HP bars. */
  symbol: string;
  /** Main colour: outlines, rings, text accents. */
  color: string;
  /** Lighter variant for highlights on the dark background. */
  light: string;
  /** Darker variant for shadows and pressed states. */
  dark: string;
  /** Text colour on a `color` background (the badge digit). */
  ink: string;
}

/** Seats 0-7 = badges 1-8 (§12): orange, sky, green, yellow, blue, vermillion, pink, white. */
export const SEATS: readonly SeatStyle[] = [
  { seat: 0, name: 'Orange', symbol: '1', color: '#E69F00', light: '#FFCF66', dark: '#8A5F00', ink: '#0D0F1A' },
  { seat: 1, name: 'Sky', symbol: '2', color: '#56B4E9', light: '#A6DAF5', dark: '#1F6E99', ink: '#0D0F1A' },
  { seat: 2, name: 'Green', symbol: '3', color: '#009E73', light: '#5FD6B2', dark: '#005C43', ink: '#0D0F1A' },
  { seat: 3, name: 'Yellow', symbol: '4', color: '#F0E442', light: '#FAF3A0', dark: '#8C8420', ink: '#0D0F1A' },
  { seat: 4, name: 'Blue', symbol: '5', color: '#4B8DFF', light: '#A3C4FF', dark: '#1F4FA8', ink: '#0D0F1A' },
  { seat: 5, name: 'Vermillion', symbol: '6', color: '#D55E00', light: '#FF9F5A', dark: '#7F3800', ink: '#0D0F1A' },
  { seat: 6, name: 'Pink', symbol: '7', color: '#CC79A7', light: '#EDB6D5', dark: '#7D3D61', ink: '#0D0F1A' },
  { seat: 7, name: 'White', symbol: '8', color: '#EEEEEE', light: '#FFFFFF', dark: '#8A8A8A', ink: '#0D0F1A' },
];

/** Neutral colour for "no seat" (spectators, unknown instances). */
export const NEUTRAL_SEAT: SeatStyle = {
  seat: -1,
  name: 'Grey',
  symbol: '?',
  color: '#9AA0AA',
  light: '#D0D4DA',
  dark: '#555A63',
  ink: '#0D0F1A',
};

/** Style of a seat (0-7); anything else gets the neutral style. */
export function seatStyle(seat: number | null | undefined): SeatStyle {
  return (seat !== null && seat !== undefined && SEATS[seat]) || NEUTRAL_SEAT;
}

export function seatColor(seat: number | null | undefined): string {
  return seatStyle(seat).color;
}

/** The seat of an instance id `${seat}-${row}-${col}`, or -1. */
export function seatOfInstance(instanceId: string): number {
  const n = Number.parseInt(instanceId, 10);
  return Number.isInteger(n) && n >= 0 && n < SEATS.length ? n : -1;
}

export type Rgb = [number, number, number];

/** "#RRGGBB" → [r,g,b]; invalid input gives mid grey. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [136, 136, 136];
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Linear mix of two colours: t=0 → a, t=1 → b. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** `rgba(...)` string for canvas fills. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Colour distance (tests: the seat colours stay distinguishable)
// ---------------------------------------------------------------------------

/** sRGB → CIE L*a*b* (D65). */
export function rgbToLab([r, g, b]: Rgb): [number, number, number] {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 ΔE between two "#RRGGBB" colours (≈ 2.3 is a just-noticeable difference). */
export function deltaE(a: string, b: string): number {
  const p = rgbToLab(hexToRgb(a));
  const q = rgbToLab(hexToRgb(b));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// ---------------------------------------------------------------------------
// Team looks (§9.2): ground-ring colour + pattern
// ---------------------------------------------------------------------------

export interface TeamLook {
  teamId: number;
  name: string;
  color: string;
  pattern: TeamPattern;
}

/** The look of team 0-3 (gold solid, cyan dashed, magenta double, lime dotted), or null. */
export function teamLook(teamId: number | null | undefined): TeamLook | null {
  if (teamId === null || teamId === undefined) return null;
  const s = TEAM_STYLES[teamId];
  return s ? { teamId, name: s.name, color: s.color, pattern: s.pattern } : null;
}

/** A pattern as a canvas line dash (in multiples of the line width). Double is drawn as two rings. */
export function patternDash(pattern: TeamPattern, lineWidth: number): number[] {
  switch (pattern) {
    case 'dashed':
      return [lineWidth * 3, lineWidth * 2];
    case 'dotted':
      return [lineWidth * 0.01, lineWidth * 2];
    default:
      return [];
  }
}
