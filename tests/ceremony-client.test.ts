// The /screen awards ceremony, DOM-free: the step
// timeline and its length, the pausable clock with skip and replay, the
// facilitator-only keys, which sound each step starts with (and that a
// pause or re-render doesn't replay it), the synthesized drumroll / sting /
// tune recipes and their rate limits, and the final board's award icons.

import { describe, expect, it } from 'vitest';
import { AWARDS, AWARD_IDS, awardStatText, type MatchAwardDTO } from '@pixel-clash/shared';
import {
  CEREMONY_MS,
  CeremonyClock,
  awardsByPlayer,
  ceremonyCues,
  ceremonyKey,
  ceremonyLength,
  ceremonySteps,
  podiumRiseMs,
  stepSounds,
} from '../packages/client/src/screen/ceremony.js';
import { DRUMROLL_SEC, SFX, SFX_MIN_GAP_MS, SfxLimiter, drumrollSteps, sfxDuration } from '../packages/client/src/common/sfx.js';

function award(id: (typeof AWARD_IDS)[number], winners: string[], value = 3): MatchAwardDTO {
  const a = AWARDS[id];
  return {
    id,
    emoji: a.emoji,
    title: a.title,
    rule: a.rule,
    value,
    text: awardStatText(id, value),
    winners: winners.map((w, i) => ({ playerId: w, name: w, seat: i, bestUnit: null })),
  };
}

const ALL = AWARD_IDS.map((id) => award(id, ['p1']));

describe('ceremony timeline', () => {
  it('runs intro → one step per award → podium → board, ~90-120 s for all 15 awards', () => {
    const steps = ceremonySteps(ALL);
    expect(steps.map((s) => s.kind)).toEqual(['intro', ...ALL.map(() => 'award'), 'podium', 'board']);
    const total = ceremonyLength(steps);
    expect(total).toBeGreaterThanOrEqual(90_000);
    expect(total).toBeLessThanOrEqual(120_000);
    expect(steps.at(-1)!.ms).toBe(Number.POSITIVE_INFINITY);
    const third = steps[3]!;
    expect(third.kind === 'award' && [third.index, third.count, third.award.id]).toEqual([2, 15, ALL[2]!.id]);
  });

  it('is quicker with reduced motion and goes straight to the podium without awards', () => {
    expect(ceremonyLength(ceremonySteps(ALL, { reducedMotion: true }))).toBeLessThan(ceremonyLength(ceremonySteps(ALL)));
    expect(ceremonySteps([]).map((s) => s.kind)).toEqual(['podium', 'board']);
    expect(ceremonySteps(undefined).map((s) => s.kind)).toEqual(['podium', 'board']);
  });

  it('a clock walks the steps, skips ahead, pauses, resumes and replays', () => {
    const steps = ceremonySteps(ALL.slice(0, 2));
    const c = new CeremonyClock(steps, 1000);
    expect(c.at(1000)).toMatchObject({ index: 0, elapsed: 0, paused: false });
    expect(c.at(1000 + CEREMONY_MS.intro + 10)).toMatchObject({ index: 1, elapsed: 10 });
    // → / Enter: the start of the next step.
    c.next(1000 + CEREMONY_MS.intro + 500);
    expect(c.at(1000 + CEREMONY_MS.intro + 500)).toMatchObject({ index: 2, elapsed: 0 });
    // Space: frozen while paused, then on from the same spot.
    c.togglePause(20_000);
    expect(c.at(60_000)).toEqual(c.at(20_000));
    expect(c.at(60_000).paused).toBe(true);
    const before = c.at(20_000);
    c.togglePause(60_000);
    expect(c.at(60_100)).toMatchObject({ index: before.index, elapsed: before.elapsed + 100, paused: false });
    // Skip while paused stays paused.
    c.togglePause(61_000);
    c.next(61_000);
    expect(c.at(70_000)).toMatchObject({ index: before.index + 1, elapsed: 0, paused: true });
    c.togglePause(70_000);
    // The board is the end: skipping there does nothing, time passes on it.
    for (let i = 0; i < 10; i++) c.next(80_000);
    expect(c.at(500_000).step.kind).toBe('board');
    // R: from the top, running.
    c.replay(600_000);
    expect(c.at(600_000)).toMatchObject({ index: 0, elapsed: 0, paused: false });
  });

  it('keeps its place when new steps arrive (setSteps)', () => {
    const c = new CeremonyClock(ceremonySteps(ALL.slice(0, 1)), 0);
    c.setSteps(ceremonySteps(ALL.slice(0, 3)));
    expect(c.at(CEREMONY_MS.intro + CEREMONY_MS.award + 5)).toMatchObject({ index: 2, elapsed: 5 });
  });
});

describe('facilitator keys', () => {
  it('maps → / Enter, Space and R only for an admin session', () => {
    expect(ceremonyKey('ArrowRight', true)).toBe('next');
    expect(ceremonyKey('Enter', true)).toBe('next');
    expect(ceremonyKey(' ', true)).toBe('pause');
    expect(ceremonyKey('r', true)).toBe('replay');
    expect(ceremonyKey('R', true)).toBe('replay');
    expect(ceremonyKey('x', true)).toBeNull();
    for (const k of ['ArrowRight', 'Enter', ' ', 'r']) expect(ceremonyKey(k, false)).toBeNull();
  });
});

describe('ceremony sounds', () => {
  it('drumroll for the intro, a sting per award (the bigger tune for the Champion), the tune for the podium', () => {
    const steps = ceremonySteps([award('masterBuilder', ['a']), award('champion', ['a'])]);
    expect(steps.map(stepSounds)).toEqual([['drumroll'], ['sting'], ['fanfare'], ['fanfare'], []]);
  });

  it('plays only when a new step starts (not on pause or re-render); a replay plays the drumroll again', () => {
    const steps = ceremonySteps(ALL.slice(0, 2));
    expect(ceremonyCues(null, 0, steps)).toEqual(['drumroll']);
    expect(ceremonyCues(0, 0, steps)).toEqual([]);
    expect(ceremonyCues(0, 1, steps)).toEqual(['sting']);
    // A skip from award 1 straight to the podium plays the podium's tune.
    expect(ceremonyCues(1, 3, steps)).toEqual(['fanfare']);
    expect(ceremonyCues(3, 4, steps)).toEqual([]);
    // Replay: the view resets its last cue to null.
    expect(ceremonyCues(null, 0, steps)).toEqual(['drumroll']);
  });

  it('the drumroll is a speeding-up crescendo of snare strokes ending in a cymbal crash', () => {
    const steps = drumrollSteps();
    const strokes = steps.filter((s) => s.kind === 'noise' && s.filter === 'bandpass' && s.at < DRUMROLL_SEC);
    expect(strokes.length).toBeGreaterThan(40);
    for (let i = 1; i < strokes.length; i++) {
      expect(strokes[i]!.gain).toBeGreaterThanOrEqual(strokes[i - 1]!.gain);
      if (i > 1) expect(strokes[i]!.at - strokes[i - 1]!.at).toBeLessThanOrEqual(strokes[i - 1]!.at - strokes[i - 2]!.at + 1e-9);
    }
    const cymbal = steps.find((s) => s.kind === 'noise' && s.filter === 'highpass');
    expect(cymbal).toMatchObject({ at: DRUMROLL_SEC });
    expect(cymbal!.dur).toBeGreaterThan(1);
    // The drumroll (and its crash) fit in the intro step; the sting fits an award step; the tune the podium.
    expect(sfxDuration('drumroll') * 1000).toBeLessThan(CEREMONY_MS.intro + 200);
    expect(sfxDuration('sting') * 1000).toBeLessThan(CEREMONY_MS.reduced.award);
    expect(sfxDuration('fanfare')).toBeGreaterThan(2);
    expect(sfxDuration('fanfare') * 1000).toBeLessThan(CEREMONY_MS.reduced.podium);
  });

  it('synthesizes everything (tones and noise only) and never stacks the same ceremony sound', () => {
    for (const name of ['drumroll', 'sting', 'fanfare'] as const) {
      expect(SFX[name].length).toBeGreaterThan(3);
      for (const s of SFX[name]) {
        expect(['tone', 'noise']).toContain(s.kind);
        expect(s.gain).toBeGreaterThan(0);
        expect(s.gain).toBeLessThanOrEqual(0.45);
      }
      expect(SFX_MIN_GAP_MS[name]).toBeGreaterThan(0);
    }
    const lim = new SfxLimiter();
    expect(lim.allow('drumroll', 0)).toBe(true);
    expect(lim.allow('drumroll', 100)).toBe(false); // a double mount
    expect(lim.allow('sting', 100)).toBe(true);
    expect(lim.allow('sting', 200)).toBe(false);
    expect(lim.allow('sting', 100 + CEREMONY_MS.reduced.award)).toBe(true);
  });
});

describe('podium and final board', () => {
  it('lists every player\'s award icons in ceremony order, ties for everyone', () => {
    const map = awardsByPlayer([award('masterBuilder', ['a']), award('biggestHitter', ['a', 'b']), award('champion', ['b'])]);
    expect(map.get('a')!.map((x) => x.emoji)).toEqual(['🧱', '💥']);
    expect(map.get('b')!.map((x) => x.id)).toEqual(['biggestHitter', 'champion']);
    expect(map.get('c')).toBeUndefined();
    expect(awardsByPlayer(undefined).size).toBe(0);
  });

  it('raises 3rd, then 2nd, then 1st (all at once with reduced motion)', () => {
    expect(podiumRiseMs(3)).toBeLessThan(podiumRiseMs(2));
    expect(podiumRiseMs(2)).toBeLessThan(podiumRiseMs(1));
    expect(podiumRiseMs(1)).toBeLessThan(CEREMONY_MS.podium - 3000);
    expect([1, 2, 3].map((p) => podiumRiseMs(p, true))).toEqual([0, 0, 0]);
  });
});
