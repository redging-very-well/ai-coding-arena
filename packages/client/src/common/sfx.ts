// Sound design for the synthesized effects (plan §12.4): the recipes (as data,
// played by audio.ts with WebAudio oscillators and noise; no asset files) and
// the DOM-free decisions about WHEN to play them: countdown beeps, shot pitch
// by unit type and range, rate limiting so 96 units don't make a wall of
// noise, and the remembered mute flag. Tests import this file directly.

import type { UnitType } from '@pixel-clash/shared';

export type SfxName =
  | 'place'
  | 'remove'
  | 'ready'
  | 'allReady'
  | 'beep'
  | 'beepFinal'
  | 'clash'
  | 'shoot'
  | 'swing'
  | 'hit'
  | 'bigHit'
  | 'death'
  | 'siren'
  | 'victory'
  | 'badge'
  /** M8.5 (§12.5): a hit on a wall (stone tick), a wall crumbling (low thud), a factory making a minion (pop). */
  | 'wallHit'
  | 'crumble'
  | 'spawn'
  /** M8.6 (§12.5): 2+ stored minions leave a factory together (a rising whoosh). */
  | 'release'
  /** M8.8: a lightning zap (crackle), a SHATTER (glass) and a heal (soft chime). */
  | 'zap'
  | 'shatter'
  | 'heal'
  /** The awards ceremony (§12.4): a snare roll crescendo ending in a cymbal, a per-award sting and the victory tune. */
  | 'drumroll'
  | 'sting'
  | 'fanfare';

/** Oscillator wave shapes (the WebAudio OscillatorType values we use). */
export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

/** One oscillator note: frequency sweep `from` → `to` (Hz) with a quick attack and an exponential fade. */
export interface ToneStep {
  kind: 'tone';
  wave: Wave;
  from: number;
  to?: number;
  /** Seconds after the sound starts. */
  at: number;
  dur: number;
  gain: number;
}

/** A burst of filtered white noise (hits, explosions, swings). */
export interface NoiseStep {
  kind: 'noise';
  filter: 'lowpass' | 'bandpass' | 'highpass';
  freq: number;
  at: number;
  dur: number;
  gain: number;
}

export type SfxStep = ToneStep | NoiseStep;

/** Shot recipes are pitched at play time; `from`/`to` of tones are multiplied by `pitch / 440`. */
export const PITCHED: ReadonlySet<SfxName> = new Set(['shoot']);

const note = (wave: Wave, from: number, at: number, dur: number, gain: number, to?: number): ToneStep =>
  to === undefined ? { kind: 'tone', wave, from, at, dur, gain } : { kind: 'tone', wave, from, to, at, dur, gain };
const noise = (filter: NoiseStep['filter'], freq: number, at: number, dur: number, gain: number): NoiseStep => ({ kind: 'noise', filter, freq, at, dur, gain });

// C major arpeggio notes (Hz).
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

// ---------------------------------------------------------------------------
// Awards ceremony (§12.4): drumroll, sting and victory tune
// ---------------------------------------------------------------------------

export const DRUMROLL_SEC = 3.2;

/**
 * A snare roll: strokes of band-passed noise that speed up (90 → 38 ms apart)
 * and get louder, a low tom rumble under it, then a cymbal crash (long
 * high-passed noise) and a kick at DRUMROLL_SEC.
 */
export function drumrollSteps(seconds = DRUMROLL_SEC): SfxStep[] {
  const out: SfxStep[] = [];
  let t = 0;
  while (t < seconds) {
    const k = t / seconds;
    out.push(noise('bandpass', 1700 + 900 * k, t, 0.05, 0.05 + 0.2 * k * k));
    t += 0.09 - 0.052 * k;
  }
  out.push(note('sine', 70, 0, seconds, 0.08, 95));
  out.push(noise('highpass', 5200, seconds, 1.6, 0.34));
  out.push(noise('bandpass', 3000, seconds, 0.5, 0.18));
  out.push(note('sine', 140, seconds, 0.35, 0.4, 45));
  return out;
}

// G major-ish brass notes for the sting and tune (Hz).
const G4 = 392;
const A4 = 440;
const B4 = 493.88;
const D5 = 587.33;
const F3 = 174.61;

/** A short fanfare per award: a quick pickup into a bright held chord. */
const STING: readonly SfxStep[] = [
  note('square', G4, 0, 0.09, 0.1),
  note('square', G4, 0.1, 0.09, 0.1),
  note('square', C5, 0.2, 0.55, 0.13),
  note('triangle', E5, 0.2, 0.55, 0.12),
  note('triangle', G5, 0.2, 0.6, 0.1),
  note('sine', C6, 0.32, 0.45, 0.06, 1567.98),
  noise('highpass', 6000, 0.2, 0.35, 0.05),
];

/** The victory tune (~2.8 s): "ta-ta-ta TAA, ta-ta TAAA" with a bass line and a cymbal on the last chord. */
function tuneSteps(): SfxStep[] {
  const melody: Array<[number, number, number]> = [
    [G4, 0, 0.14],
    [G4, 0.16, 0.14],
    [G4, 0.32, 0.14],
    [C5, 0.48, 0.5],
    [A4, 1.0, 0.14],
    [B4, 1.16, 0.14],
    [D5, 1.32, 0.14],
    [C5, 1.5, 0.14],
    [E5, 1.66, 0.14],
    [G5, 1.84, 0.9],
  ];
  const out: SfxStep[] = melody.map(([f, at, dur]) => note('square', f, at, dur, 0.12));
  // Harmony and bass.
  out.push(note('triangle', E5, 0.48, 0.5, 0.08), note('triangle', C5 / 2, 0.48, 0.5, 0.16));
  out.push(note('triangle', F3, 1.0, 0.45, 0.12), note('triangle', G4 / 2, 1.32, 0.3, 0.14));
  out.push(note('triangle', C6, 1.84, 0.9, 0.08), note('triangle', E5, 1.84, 0.9, 0.08), note('triangle', C5 / 2, 1.84, 0.95, 0.18));
  out.push(noise('highpass', 5200, 1.84, 1.0, 0.16));
  return out;
}
export const SFX: Readonly<Record<SfxName, readonly SfxStep[]>> = {
  place: [note('square', 660, 0, 0.06, 0.16, 990)],
  remove: [note('square', 520, 0, 0.07, 0.14, 300)],
  ready: [note('triangle', C5, 0, 0.12, 0.22), note('triangle', E5, 0.08, 0.12, 0.22), note('triangle', G5, 0.16, 0.22, 0.22)],
  // Everyone is ready: a soft, rising chord (quieter and longer than 'ready').
  allReady: [
    note('sine', C5, 0, 0.5, 0.12),
    note('sine', E5, 0.1, 0.5, 0.12),
    note('sine', G5, 0.2, 0.55, 0.12),
    note('triangle', C6, 0.32, 0.6, 0.1),
  ],
  beep: [note('square', 880, 0, 0.09, 0.16)],
  beepFinal: [note('square', 1320, 0, 0.38, 0.18)],
  clash: [noise('lowpass', 1400, 0, 0.45, 0.4), note('sawtooth', 220, 0, 0.5, 0.22, 55), note('square', C6, 0, 0.2, 0.1, G5)],
  shoot: [note('square', 440, 0, 0.055, 0.05, 260)],
  swing: [noise('bandpass', 900, 0, 0.06, 0.08)],
  hit: [noise('bandpass', 1800, 0, 0.05, 0.1)],
  bigHit: [noise('lowpass', 700, 0, 0.2, 0.3), note('sine', 130, 0, 0.22, 0.3, 40)],
  death: [note('square', 420, 0, 0.26, 0.12, 70), noise('lowpass', 1200, 0.02, 0.18, 0.14)],
  siren: [
    note('sawtooth', 600, 0, 0.22, 0.12, 900),
    note('sawtooth', 900, 0.22, 0.22, 0.12, 600),
    note('sawtooth', 600, 0.44, 0.22, 0.12, 900),
    note('sawtooth', 900, 0.66, 0.3, 0.12, 600),
  ],
  victory: [
    note('square', C5, 0, 0.12, 0.14),
    note('square', E5, 0.12, 0.12, 0.14),
    note('square', G5, 0.24, 0.12, 0.14),
    note('square', C6, 0.36, 0.5, 0.16),
    note('triangle', C5 / 2, 0.36, 0.5, 0.18),
  ],
  badge: [note('sine', 990, 0, 0.1, 0.16, 1980), note('sine', 1480, 0.07, 0.12, 0.1)],
  wallHit: [noise('highpass', 2600, 0, 0.035, 0.09), note('square', 1900, 0, 0.03, 0.04, 1500)],
  crumble: [noise('lowpass', 400, 0, 0.35, 0.3), note('sine', 90, 0, 0.3, 0.26, 40)],
  spawn: [note('sine', 600, 0, 0.07, 0.14, 1200)],
  release: [noise('bandpass', 900, 0, 0.18, 0.12), note('triangle', 300, 0, 0.2, 0.14, 900), note('sine', 900, 0.12, 0.1, 0.1, 1400)],
  zap: [noise('highpass', 3200, 0, 0.09, 0.12), note('sawtooth', 1600, 0, 0.08, 0.05, 700)],
  shatter: [noise('highpass', 4200, 0, 0.18, 0.16), note('triangle', 2400, 0, 0.12, 0.1, 3400), note('triangle', 1800, 0.06, 0.1, 0.08, 2600)],
  heal: [note('sine', 880, 0, 0.12, 0.08, 1320)],
  drumroll: drumrollSteps(),
  sting: STING,
  fanfare: tuneSteps(),
};

/** Length of a recipe in seconds (its last step's end). */
export function sfxDuration(name: SfxName): number {
  return Math.max(0, ...SFX[name].map((s) => s.at + s.dur));
}

// ---------------------------------------------------------------------------
// Shot pitch: towers sound heavier, long range sounds brighter
// ---------------------------------------------------------------------------

export const RANGE_MIN = 20;
export const RANGE_MAX = 300;
const TYPE_BASE_HZ: Record<UnitType, number> = { soldier: 330, tower: 196, wall: 110, factory: 262 };

/** The shoot pitch (Hz) of a unit: its type's base, up to 1.5 octaves higher at max range. */
export function shotPitch(stats: { type: UnitType; range: number }): number {
  const base = TYPE_BASE_HZ[stats.type] ?? TYPE_BASE_HZ.soldier;
  const t = Math.max(0, Math.min(1, (stats.range - RANGE_MIN) / (RANGE_MAX - RANGE_MIN)));
  return Math.round(base * 2 ** (1.5 * t));
}

// ---------------------------------------------------------------------------
// Countdown beeps: the last 5 seconds of a timer
// ---------------------------------------------------------------------------

export const COUNTDOWN_BEEP_SECONDS = 5;

export type CountdownCue = { sfx: 'beep'; second: number } | { sfx: 'beepFinal'; second: 0 };

/**
 * The beep for a timer that went from `prev` to `now` seconds left: a short
 * beep as the shown second (rounded up) becomes 5, 4, 3, 2, 1, and a long one
 * as it reaches 0. Nothing when it didn't cross a second, went up (timer
 * +1 min), jumped by more than 2 s (a reload or a "set") or is above the window.
 */
export function countdownCue(prev: number | null, now: number | null, window = COUNTDOWN_BEEP_SECONDS): CountdownCue | null {
  if (prev === null || now === null) return null;
  if (now >= prev || prev - now > 2) return null;
  const shownPrev = Math.ceil(prev);
  const shown = Math.ceil(now);
  if (shown === shownPrev || shown > window) return null;
  return shown <= 0 ? { sfx: 'beepFinal', second: 0 } : { sfx: 'beep', second: shown };
}

/** The "3-2-1 CLASH!" overlay step's sound. */
export function revealCue(step: string | null): SfxName | null {
  if (step === null) return null;
  return step === 'CLASH!' ? 'clash' : 'beep';
}

// ---------------------------------------------------------------------------
// Rate limiting: a battle of 96 units fires many shots per frame
// ---------------------------------------------------------------------------

/** Minimum ms between two plays of the same sound (anything not listed: no limit). */
export const SFX_MIN_GAP_MS: Partial<Record<SfxName, number>> = {
  shoot: 45,
  swing: 60,
  hit: 40,
  bigHit: 120,
  death: 70,
  badge: 90,
  wallHit: 50,
  crumble: 90,
  spawn: 60,
  release: 150,
  place: 30,
  zap: 70,
  shatter: 120,
  heal: 90,
  // Ceremony: never two on top of each other (a re-render or a double mount).
  drumroll: 2500,
  sting: 400,
  fanfare: 1500,
};

/** Sounds allowed per name within one second (crowd control). */
export const SFX_PER_SECOND: Partial<Record<SfxName, number>> = {
  shoot: 14,
  swing: 10,
  hit: 14,
  bigHit: 6,
  death: 10,
  wallHit: 10,
  crumble: 6,
  spawn: 8,
  zap: 8,
  shatter: 4,
  heal: 6,
};

/** Decides whether a sound may play now (min gap + per-second budget per name). DOM-free. */
export class SfxLimiter {
  private readonly last = new Map<SfxName, number>();
  private readonly recent = new Map<SfxName, number[]>();

  allow(name: SfxName, now: number): boolean {
    const gap = SFX_MIN_GAP_MS[name] ?? 0;
    const prev = this.last.get(name);
    if (prev !== undefined && now - prev < gap) return false;
    const budget = SFX_PER_SECOND[name];
    if (budget !== undefined) {
      let list = this.recent.get(name);
      if (!list) this.recent.set(name, (list = []));
      while (list.length > 0 && now - list[0]! >= 1000) list.shift();
      if (list.length >= budget) return false;
      list.push(now);
    }
    this.last.set(name, now);
    return true;
  }

  reset(): void {
    this.last.clear();
    this.recent.clear();
  }
}

// ---------------------------------------------------------------------------
// Remembered mute flag (localStorage may be missing or throw)
// ---------------------------------------------------------------------------

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null where it is blocked (private mode, sandboxed frame). */
export function browserStorage(): KeyValueStore | null {
  try {
    return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadMuted(store: KeyValueStore | null, key: string, fallback: boolean): boolean {
  try {
    const v = store?.getItem(key);
    return v === '1' ? true : v === '0' ? false : fallback;
  } catch {
    return fallback;
  }
}

export function saveMuted(store: KeyValueStore | null, key: string, muted: boolean): void {
  try {
    store?.setItem(key, muted ? '1' : '0');
  } catch {
    // Storage full or blocked: the toggle still works for this page.
  }
}

export const MUTE_KEY_SCREEN = 'pixel-clash:screen-muted';
export const MUTE_KEY_PLAY = 'pixel-clash:play-muted';
