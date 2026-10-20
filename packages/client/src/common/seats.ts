// Seat colours (plan §12): a colourblind-safe 4-colour set used ONLY for
// outlines, ground rings and zone tints (never for a unit's own body colour).
//
// The hues are from the Okabe-Ito palette, which stays distinguishable under
// protanopia, deuteranopia and tritanopia, and each seat also has a name and a
// symbol so colour is never the only cue. DOM-free (imported by tests).

export interface SeatStyle {
  seat: number;
  /** Kid-facing name ("Blue team"). */
  name: string;
  /** Extra non-colour cue for tiles, legends and the scoreboard. */
  symbol: string;
  /** Main colour: outlines, rings, text accents. */
  color: string;
  /** Lighter variant for highlights on the dark background. */
  light: string;
  /** Darker variant for shadows and pressed states. */
  dark: string;
}

export const SEATS: readonly SeatStyle[] = [
  { seat: 0, name: 'Blue', symbol: '●', color: '#56B4E9', light: '#A6DAF5', dark: '#1F6E99' },
  { seat: 1, name: 'Orange', symbol: '▲', color: '#E69F00', light: '#FFCF66', dark: '#8A5F00' },
  { seat: 2, name: 'Green', symbol: '■', color: '#009E73', light: '#5FD6B2', dark: '#005C43' },
  { seat: 3, name: 'Pink', symbol: '◆', color: '#CC79A7', light: '#EDB6D5', dark: '#7D3D61' },
];

/** Neutral colour for "no seat" (spectators, unknown instances). */
export const NEUTRAL_SEAT: SeatStyle = {
  seat: -1,
  name: 'Grey',
  symbol: '○',
  color: '#9AA0AA',
  light: '#D0D4DA',
  dark: '#555A63',
};

/** Style of a seat (0-3); anything else gets the neutral style. */
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
