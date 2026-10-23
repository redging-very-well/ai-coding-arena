// M7 polish (plan §12.2, §12.4): the DOM-free parts of sound (recipes,
// countdown beeps, shot pitch, rate limiting, remembered mute), battle effects
// (shake, flashes, damage numbers, pooled particles), animation timing, the
// replay controller, and the /admin → /screen remote (POST /admin/screen).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScreenCommand, type PlayerStatusDTO, type ReplayDTO } from '@pixel-clash/shared';
import {
  COUNTDOWN_BEEP_SECONDS,
  SFX,
  SFX_MIN_GAP_MS,
  SFX_PER_SECOND,
  SfxLimiter,
  countdownCue,
  loadMuted,
  revealCue,
  saveMuted,
  sfxDuration,
  shotPitch,
  type KeyValueStore,
  type SfxName,
} from '../packages/client/src/common/sfx.js';
import {
  BIG_HIT_FRACTION,
  DAMAGE_NUMBER_MS,
  FLASH_MS,
  FxLayer,
  MAX_DAMAGE_NUMBERS,
  MAX_PARTICLES,
  Pool,
  SHAKE_MS,
  ScreenShake,
  bobOffset,
  damageNumberPose,
  deathBurstCount,
  flashAlpha,
  isBigHit,
  shakeStrength,
} from '../packages/client/src/common/render/fx.js';
import { SoundEngine } from '../packages/client/src/common/audio.js';
import { DROP_MS, DROP_STAGGER_MS, dropLift, dropProgress } from '../packages/client/src/common/render/arena.js';
import { FrameBuffer } from '../packages/client/src/common/render/playback.js';
import { REVEAL_STEPS, badgePopDelayMs, badgePopSchedule, countUpStartMs, newlyDone, resultsBadgePops } from '../packages/client/src/screen/model.js';
import { ReplayController, replayProgress, tickAtFraction, type ReplayTarget, type ReplayView } from '../packages/client/src/screen/replay.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, WsRecorder, adminClient, bootServer, removeDir, tempDataDir } from './helpers/server.js';

// ---------------------------------------------------------------------------
// Sound decisions
// ---------------------------------------------------------------------------

describe('sound recipes (§12.4)', () => {
  it('has every effect, each a short, quiet, well-formed recipe', () => {
    const names: SfxName[] = ['place', 'remove', 'ready', 'allReady', 'beep', 'beepFinal', 'clash', 'shoot', 'swing', 'hit', 'bigHit', 'death', 'siren', 'victory', 'badge'];
    for (const n of names) {
      const steps = SFX[n];
      expect(steps.length, n).toBeGreaterThan(0);
      for (const s of steps) {
        expect(s.dur, n).toBeGreaterThan(0);
        expect(s.at, n).toBeGreaterThanOrEqual(0);
        expect(s.gain, n).toBeGreaterThan(0);
        expect(s.gain, n).toBeLessThanOrEqual(0.5);
        if (s.kind === 'tone') expect(s.from, n).toBeGreaterThan(20);
      }
      expect(sfxDuration(n), n).toBeLessThan(1.5);
    }
    // Battle sounds stay very short: dozens play per second.
    for (const n of ['shoot', 'swing', 'hit'] as const) expect(sfxDuration(n)).toBeLessThanOrEqual(0.1);
  });
});

describe('shot pitch by unit type and range', () => {
  it('towers sound lower than soldiers at the same range', () => {
    expect(shotPitch({ type: 'tower', range: 120 })).toBeLessThan(shotPitch({ type: 'soldier', range: 120 }));
  });
  it('rises with range, 1.5 octaves over the whole range, clamped outside it', () => {
    const lo = shotPitch({ type: 'soldier', range: 20 });
    const hi = shotPitch({ type: 'soldier', range: 300 });
    expect(lo).toBe(330);
    expect(hi / lo).toBeCloseTo(2 ** 1.5, 1);
    expect(shotPitch({ type: 'soldier', range: 150 })).toBeGreaterThan(lo);
    expect(shotPitch({ type: 'soldier', range: 5 })).toBe(lo);
    expect(shotPitch({ type: 'soldier', range: 9999 })).toBe(hi);
  });
});

describe('countdown beeps: the last 5 seconds', () => {
  it('beeps once per second from 5 down to 1, then a long beep at 0', () => {
    const cues: string[] = [];
    let prev: number | null = null;
    for (let t = 8; t >= -0.05; t -= 0.1) {
      const now = Math.max(0, Math.round(t * 100) / 100);
      const c = countdownCue(prev, now);
      if (c) cues.push(c.sfx === 'beep' ? String(c.second) : 'final');
      prev = now;
    }
    expect(cues).toEqual(['5', '4', '3', '2', '1', 'final']);
    expect(COUNTDOWN_BEEP_SECONDS).toBe(5);
  });
  it('works with 1 Hz updates (/play gets state once a second)', () => {
    const seq = [7, 6, 5, 4, 3, 2, 1, 0];
    const cues = seq.slice(1).map((s, i) => countdownCue(seq[i]!, s));
    expect(cues.map((c) => (c ? (c.sfx === 'beep' ? c.second : 'final') : null))).toEqual([null, 5, 4, 3, 2, 1, 'final']);
  });
  it('stays quiet without a previous reading, when the timer goes up, jumps, or is above the window', () => {
    expect(countdownCue(null, 4.5)).toBeNull();
    expect(countdownCue(4.2, null)).toBeNull();
    expect(countdownCue(3.9, 63.9)).toBeNull(); // +1 min
    expect(countdownCue(30, 4.9)).toBeNull(); // "set" or a reload
    expect(countdownCue(6.4, 6.1)).toBeNull(); // no second crossed
    expect(countdownCue(6.05, 5.95)).toBeNull(); // shows 6 → 6
    expect(countdownCue(4.0, 4.0)).toBeNull(); // paused
  });
  it('maps the reveal steps to beeps and the CLASH! hit', () => {
    expect(REVEAL_STEPS.map(revealCue)).toEqual(['beep', 'beep', 'beep', 'clash']);
    expect(revealCue(null)).toBeNull();
  });
});

describe('sound rate limiter (96 units)', () => {
  it('enforces the minimum gap per sound', () => {
    const l = new SfxLimiter();
    const gap = SFX_MIN_GAP_MS.shoot!;
    expect(l.allow('shoot', 0)).toBe(true);
    expect(l.allow('shoot', gap - 1)).toBe(false);
    expect(l.allow('hit', 1)).toBe(true); // other names are independent
    expect(l.allow('shoot', gap)).toBe(true);
  });
  it('caps a storm of shots to the per-second budget', () => {
    const l = new SfxLimiter();
    let played = 0;
    // 96 units each firing every ~0.5 s: ~190 shots in one second, 1 ms apart-ish.
    for (let i = 0; i < 190; i++) if (l.allow('shoot', i * 5)) played++;
    expect(played).toBeLessThanOrEqual(SFX_PER_SECOND.shoot!);
    expect(played).toBeGreaterThan(5);
  });
  it('never limits UI sounds without a rule', () => {
    const l = new SfxLimiter();
    for (let i = 0; i < 5; i++) expect(l.allow('victory', 0)).toBe(true);
  });
});

describe('remembered mute flag', () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  it('round-trips and falls back to the page default', () => {
    const s = memory();
    expect(loadMuted(s, 'k', true)).toBe(true); // /play: muted by default
    expect(loadMuted(s, 'k', false)).toBe(false); // /screen: sound on by default
    saveMuted(s, 'k', false);
    expect(loadMuted(s, 'k', true)).toBe(false);
    saveMuted(s, 'k', true);
    expect(loadMuted(s, 'k', false)).toBe(true);
  });
  it('survives storage that is missing or throws', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadMuted(broken, 'k', true)).toBe(true);
    expect(() => saveMuted(broken, 'k', false)).not.toThrow();
    expect(loadMuted(null, 'k', false)).toBe(false);
    expect(() => saveMuted(null, 'k', true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Effects and animation timing
// ---------------------------------------------------------------------------

describe('audio unlock', () => {
  it('resumes on the next gesture after the browser suspends the context', () => {
    class FakeCtx {
      state = 'suspended';
      onstatechange: (() => void) | null = null;
      destination = {};
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
      resume() {
        this.state = 'running';
        this.onstatechange?.();
        return Promise.resolve();
      }
    }
    const listeners = new Map<string, Set<() => void>>();
    const win = {
      AudioContext: FakeCtx,
      addEventListener(t: string, f: () => void) {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(f);
      },
      removeEventListener(t: string, f: () => void) {
        listeners.get(t)?.delete(f);
      },
    };
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const prev = g.window;
    g.window = win;
    try {
      const eng = new SoundEngine('test-unlock', false);
      const off = eng.installUnlock(win as unknown as Window);
      const tap = () => listeners.get('pointerdown')!.forEach((f) => f());
      tap();
      expect(eng.state).toBe('running');
      const ctx = (eng as unknown as { ctx: FakeCtx }).ctx;
      ctx.state = 'suspended';
      ctx.onstatechange?.();
      expect(eng.state).toBe('locked');
      tap();
      expect(eng.state).toBe('running');
      off();
      expect(listeners.get('pointerdown')!.size).toBe(0);
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
});

describe('battle effects (§12.2)', () => {
  it('a big hit is more than 20% of max HP, and only big hits shake', () => {
    expect(BIG_HIT_FRACTION).toBe(0.2);
    expect(isBigHit(20, 100)).toBe(false);
    expect(isBigHit(20.5, 100)).toBe(true);
    expect(isBigHit(5, 0)).toBe(false);
    expect(shakeStrength(0.2)).toBe(0);
    expect(shakeStrength(0.25)).toBeGreaterThan(0);
    expect(shakeStrength(5)).toBe(10);
    expect(shakeStrength(Number.NaN)).toBe(0);
  });

  it('screen shake decays to nothing after SHAKE_MS and stacks with a cap', () => {
    const s = new ScreenShake();
    expect(s.offset(0)).toEqual({ x: 0, y: 0 });
    s.kick(8, 1000);
    expect(s.amplitude(1000)).toBe(8);
    expect(s.amplitude(1000 + SHAKE_MS / 2)).toBeCloseTo(4);
    expect(s.amplitude(1000 + SHAKE_MS)).toBe(0);
    expect(s.offset(1000 + SHAKE_MS + 1)).toEqual({ x: 0, y: 0 });
    for (let i = 0; i < 10; i++) s.kick(8, 2000);
    expect(s.amplitude(2000)).toBeLessThanOrEqual(14);
    const o = s.offset(2003);
    expect(Math.abs(o.x)).toBeLessThanOrEqual(14);
    expect(Number.isInteger(o.x) && Number.isInteger(o.y)).toBe(true);
  });

  it('muzzle flashes and damage numbers fade on time', () => {
    expect(flashAlpha(0)).toBe(1);
    expect(flashAlpha(FLASH_MS / 2)).toBeCloseTo(0.5);
    expect(flashAlpha(FLASH_MS)).toBe(0);
    expect(flashAlpha(-1)).toBe(0);
    const start = damageNumberPose(0)!;
    const mid = damageNumberPose(DAMAGE_NUMBER_MS / 2)!;
    expect(start.rise).toBe(0);
    expect(mid.rise).toBeGreaterThan(start.rise);
    expect(mid.alpha).toBe(1);
    expect(damageNumberPose(DAMAGE_NUMBER_MS * 0.9)!.alpha).toBeLessThan(1);
    expect(damageNumberPose(DAMAGE_NUMBER_MS)).toBeNull();
  });

  it('the idle bob stays within 1-3 px and differs between copies', () => {
    for (let t = 0; t < 2000; t += 37) {
      const b = bobOffset(t, 0, 40);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(2);
    }
    expect(Math.max(...Array.from({ length: 100 }, (_, i) => bobOffset(i * 10, 0, 200)))).toBeLessThanOrEqual(3);
    expect(bobOffset(100, 0, 40)).not.toBeCloseTo(bobOffset(100, 450, 40));
  });

  it('death pops scale with size and shrink with reduced motion', () => {
    expect(deathBurstCount(20, false)).toBeGreaterThan(deathBurstCount(6, false));
    expect(deathBurstCount(20, false)).toBeLessThanOrEqual(24);
    expect(deathBurstCount(20, true)).toBeLessThanOrEqual(6);
  });

  it('pools never grow: a full pool recycles slots', () => {
    let made = 0;
    const pool = new Pool(4, () => {
      made++;
      return { alive: false, n: 0 };
    });
    const first = pool.take();
    for (let i = 0; i < 10; i++) pool.take().n = i;
    expect(made).toBe(4);
    expect(pool.items).toHaveLength(4);
    expect(pool.aliveCount).toBe(4);
    expect(pool.items).toContain(first);
    pool.clear();
    expect(pool.aliveCount).toBe(0);
  });

  it('caps particles and damage numbers in a 96-unit brawl and expires them', () => {
    const fx = new FxLayer();
    const before = fx.particles.items.slice();
    for (let i = 0; i < 96; i++) {
      fx.deathPop(i, i, 20, 1, ['#fff', '#f00']);
      fx.sparks(i, i, 1, '#fff');
      fx.damageNumber(i, i, 12, i % 3 === 0, 0);
      fx.muzzle(i, i, 3, '#ff0', 0);
    }
    expect(fx.particles.aliveCount).toBe(MAX_PARTICLES);
    expect(fx.numbers.aliveCount).toBe(MAX_DAMAGE_NUMBERS);
    // The very same objects are reused.
    expect(fx.particles.items).toHaveLength(MAX_PARTICLES);
    expect(fx.particles.items.every((p, i) => p === before[i])).toBe(true);
    for (let t = 16; t <= 1500; t += 16) fx.update(16, t);
    expect(fx.particles.aliveCount).toBe(0);
    expect(fx.numbers.aliveCount).toBe(0);
    expect(fx.flashes.aliveCount).toBe(0);
  });

  it('reduced motion: no shake', () => {
    const fx = new FxLayer({ reducedMotion: true });
    fx.bigHit(0.9, 100);
    expect(fx.offset(110)).toEqual({ x: 0, y: 0 });
    const moving = new FxLayer();
    moving.bigHit(0.9, 100);
    expect(moving.shake.amplitude(110)).toBeGreaterThan(0);
  });

  it('the drop-in staggers units and lands them at progress 1', () => {
    expect(dropProgress(0, 0)).toBe(0);
    expect(dropProgress(DROP_MS, 0)).toBe(1);
    expect(dropProgress(0, 3)).toBeLessThan(0); // not visible yet
    expect(dropProgress(3 * DROP_STAGGER_MS, 3)).toBe(0);
    expect(dropLift(0)).toBe(260);
    expect(dropLift(0.5)).toBeCloseTo(65);
    expect(dropLift(1)).toBe(0);
    expect(dropLift(2)).toBe(0);
  });
});

describe('results animation timing', () => {
  it('counts each row up in turn, and pops badges after their row', () => {
    expect(countUpStartMs(1) - countUpStartMs(0)).toBe(250);
    expect(badgePopDelayMs(0, 0)).toBeGreaterThan(countUpStartMs(0) + 1200 - 1);
    expect(badgePopDelayMs(0, 1) - badgePopDelayMs(0, 0)).toBe(300);
    expect(badgePopDelayMs(1, 0) - badgePopDelayMs(0, 0)).toBe(250);
  });
  it('schedules one badge pop sound per badge, in time order', () => {
    const schedule = badgePopSchedule([{ badges: ['a', 'b', 'c'] }, { badges: [] }, { badges: ['d'] }]);
    expect(schedule).toEqual([1600, 1900, 2100, 2200]);
    expect(badgePopSchedule([])).toEqual([]);
  });
  it('pops badges all at once for the team tables and reduced motion', () => {
    const rows = [{ badges: ['a', 'b'] }, { badges: ['c'] }];
    expect(resultsBadgePops(rows, { teamMode: false, reducedMotion: false })).toEqual(badgePopSchedule(rows));
    expect(resultsBadgePops(rows, { teamMode: true, reducedMotion: false })).toEqual([0]);
    expect(resultsBadgePops(rows, { teamMode: false, reducedMotion: true })).toEqual([0]);
    expect(resultsBadgePops([{ badges: [] }], { teamMode: true, reducedMotion: false })).toEqual([]);
  });
  it('detects players who just got ready or ticked a box (chime / blip)', () => {
    const p = (id: string, o: Partial<PlayerStatusDTO>): PlayerStatusDTO =>
      ({ id, name: id, seat: 0, connected: true, active: true, submitted: false, selected: false, ready: false, points: 0, ...o }) as PlayerStatusDTO;
    const before = [p('a', {}), p('b', { selected: true })];
    expect(newlyDone(null, before, 'PLACEMENT')).toEqual({ ready: 0, ticks: 0 });
    expect(newlyDone(before, [p('a', { ready: true }), p('b', { selected: true, ready: true })], 'PLACEMENT')).toEqual({ ready: 2, ticks: 0 });
    expect(newlyDone(before, [p('a', { submitted: true, selected: true }), p('b', { selected: true }), p('c', { submitted: true })], 'PLAN')).toEqual({
      ready: 0,
      ticks: 2,
    });
    expect(newlyDone(before, [p('a', { ready: true })], 'BATTLE')).toEqual({ ready: 0, ticks: 0 });
  });
});

// ---------------------------------------------------------------------------
// Replay controller
// ---------------------------------------------------------------------------

function fakeReplay(round: number, endTick = 600): ReplayDTO {
  return { round, reveal: { round } as ReplayDTO['reveal'], frames: [], end: { round, endTick } as ReplayDTO['end'] };
}

/** An arena stand-in whose clock the test moves by hand. */
class FakeArena implements ReplayTarget {
  tick = 0;
  endTick = 0;
  startTick = 0;
  speed: 1 | 2 = 1;
  paused = false;
  loads: number[] = [];
  loadReplay(r: ReplayDTO): void {
    this.loads.push(r.round);
    this.endTick = r.end.endTick;
    this.tick = 0;
    this.paused = false;
  }
  setPlayback(p: { speed?: 1 | 2; paused?: boolean }): void {
    if (p.speed) this.speed = p.speed;
    if (p.paused !== undefined) this.paused = p.paused;
  }
  seek(t: number): void {
    this.tick = Math.min(this.endTick, Math.max(this.startTick, t));
  }
  run(ticks: number): void {
    if (!this.paused) this.tick = Math.min(this.endTick, this.tick + ticks * this.speed);
  }
}

function setup(fetchImpl?: (round: number) => Promise<ReplayDTO>) {
  const arena = new FakeArena();
  const views: Array<ReplayView | null> = [];
  const errors: unknown[] = [];
  const loaded: number[] = [];
  const ctl = new ReplayController({
    target: arena,
    fetch: fetchImpl ?? (async (r) => fakeReplay(r)),
    onChange: (v) => views.push(v),
    onLoaded: (r) => loaded.push(r.round),
    onError: (e) => errors.push(e),
  });
  return { arena, views, errors, loaded, ctl };
}

describe('replay controller', () => {
  it('maps ticks to progress and back', () => {
    expect(replayProgress(300, 0, 600)).toBe(0.5);
    expect(replayProgress(-5, 0, 600)).toBe(0);
    expect(replayProgress(900, 0, 600)).toBe(1);
    expect(replayProgress(10, 0, 0)).toBe(0);
    expect(tickAtFraction(0.25, 100, 500)).toBe(200);
    expect(tickAtFraction(2, 100, 500)).toBe(500);
    expect(tickAtFraction(-1, 100, 500)).toBe(100);
  });

  it('loads, plays at 1x/2x, reports progress and stops at the end', async () => {
    const { arena, views, loaded, ctl } = setup();
    const p = ctl.play(2);
    expect(ctl.view).toMatchObject({ round: 2, loading: true });
    expect(ctl.progress()).toBe(0);
    await p;
    expect(loaded).toEqual([2]);
    expect(ctl.view).toEqual({ round: 2, speed: 1, paused: false, loading: false, playing: true });
    arena.run(150);
    expect(ctl.progress()).toBeCloseTo(0.25);
    ctl.setSpeed(2);
    expect(arena.speed).toBe(2);
    expect(ctl.view?.speed).toBe(2);
    arena.run(150);
    expect(ctl.progress()).toBeCloseTo(0.75);
    ctl.sync();
    expect(ctl.view?.playing).toBe(true);
    arena.run(1000);
    ctl.sync();
    expect(ctl.view).toMatchObject({ playing: false, paused: true });
    expect(arena.paused).toBe(true);
    expect(views.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps a speed chosen before any replay loaded', async () => {
    const { arena, ctl } = setup();
    ctl.setSpeed(2);
    await ctl.play(1);
    expect(arena.speed).toBe(2);
    expect(ctl.view?.speed).toBe(2);
    ctl.clear();
    await ctl.play(1);
    expect(ctl.view?.speed).toBe(2);
  });

  it('pause toggles; at the end it restarts from the beginning', async () => {
    const { arena, ctl } = setup();
    await ctl.play(1);
    arena.run(100);
    ctl.togglePause();
    expect(arena.paused).toBe(true);
    expect(ctl.view?.paused).toBe(true);
    arena.run(100);
    expect(arena.tick).toBe(100);
    ctl.togglePause();
    expect(arena.paused).toBe(false);
    arena.run(10_000);
    ctl.sync();
    ctl.togglePause(); // ended: start over
    await Promise.resolve();
    await Promise.resolve();
    expect(arena.loads).toEqual([1, 1]);
    expect(arena.tick).toBe(0);
  });

  it('finish() stops a running replay on its last frame, and drops one still loading', async () => {
    const { arena, ctl } = setup();
    await ctl.play(1);
    arena.run(100);
    ctl.finish();
    expect(arena.tick).toBe(600);
    expect(arena.paused).toBe(true);
    expect(ctl.view).toMatchObject({ playing: false, paused: true });
    ctl.finish(); // nothing running: no-op
    expect(ctl.view).toMatchObject({ playing: false, paused: true });
    let release!: (r: ReplayDTO) => void;
    const slow = setup(() => new Promise<ReplayDTO>((r) => (release = r)));
    const p = slow.ctl.play(3);
    slow.ctl.finish();
    expect(slow.ctl.view).toBeNull();
    release(fakeReplay(3));
    await p;
    expect(slow.arena.loads).toEqual([]);
    expect(slow.ctl.view).toBeNull();
  });

  it('keeps the chosen speed for the next replay', async () => {
    const { arena, ctl } = setup();
    await ctl.play(1);
    ctl.setSpeed(2);
    await ctl.play(1);
    expect(ctl.view?.speed).toBe(2);
    expect(arena.speed).toBe(2);
  });

  it('scrubs: seeking jumps the arena, seeking to the end finishes, seeking back plays again', async () => {
    const { arena, ctl } = setup();
    await ctl.play(3);
    ctl.seekFraction(0.5);
    expect(arena.tick).toBe(300);
    ctl.seekFraction(1);
    expect(ctl.view).toMatchObject({ playing: false, paused: true });
    ctl.seekFraction(0.1);
    expect(arena.tick).toBe(60);
    expect(ctl.view?.playing).toBe(true);
  });

  it('atEnd shows the final frame paused (a reload during RESULTS)', async () => {
    const { arena, ctl } = setup();
    await ctl.load(4, { atEnd: true });
    expect(arena.tick).toBe(600);
    expect(arena.paused).toBe(true);
    expect(ctl.view).toMatchObject({ playing: false, paused: true, loading: false });
    expect(ctl.progress()).toBe(1);
  });

  it('a slow fetch never overwrites a newer load or a clear', async () => {
    let release: (r: ReplayDTO) => void = () => undefined;
    const slow = new Promise<ReplayDTO>((r) => (release = r));
    const { arena, ctl } = setup((round) => (round === 1 ? slow : Promise.resolve(fakeReplay(round, 300))));
    const first = ctl.play(1);
    await ctl.play(2);
    release(fakeReplay(1));
    await first;
    expect(arena.loads).toEqual([2]);
    expect(ctl.view?.round).toBe(2);
    ctl.clear();
    expect(ctl.view).toBeNull();
  });

  it('a failed fetch clears the view and reports (quietly for atEnd)', async () => {
    const { errors, ctl } = setup(() => Promise.reject(new Error('404')));
    await ctl.play(1);
    expect(ctl.view).toBeNull();
    expect(errors).toHaveLength(1);
    await ctl.load(1, { atEnd: true });
    expect(errors).toHaveLength(1);
  });

  it('does nothing without a round or while loading', async () => {
    const { arena, ctl } = setup();
    await ctl.play(undefined);
    expect(ctl.view).toBeNull();
    const p = ctl.play(1);
    ctl.togglePause();
    ctl.seekFraction(0.5);
    await p;
    expect(arena.paused).toBe(false);
    expect(arena.tick).toBe(0);
  });
});

describe('frame buffer sampling (perf: reused lookups)', () => {
  it('interpolates the same with the cached next-frame index, also after a frame is replaced', () => {
    const b = new FrameBuffer();
    const frame = (t: number, x: number) => ({ t, units: [['u1', x, 0, 10, 0]], projectiles: [], events: [], safeZoneRadius: 500 }) as never;
    b.push([frame(0, 0), frame(10, 100)]);
    expect(b.sample(5)!.units[0]!.x).toBe(50);
    expect(b.sample(7.5)!.units[0]!.x).toBe(75);
    b.push([frame(10, 200)]); // same t: replaces the frame
    expect(b.sample(5)!.units[0]!.x).toBe(100);
    b.clear();
    b.push([frame(0, 0), frame(10, 40)]);
    expect(b.sample(5)!.units[0]!.x).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// /admin → /screen remote
// ---------------------------------------------------------------------------

describe('screen commands', () => {
  it('parses only known commands', () => {
    expect(parseScreenCommand({ action: 'poster' })).toEqual({ action: 'poster' });
    expect(parseScreenCommand({ action: 'poster', show: false })).toEqual({ action: 'poster', show: false });
    expect(parseScreenCommand({ action: 'poster', show: 'yes' })).toBeNull();
    expect(parseScreenCommand({ action: 'replay' })).toEqual({ action: 'replay' });
    expect(parseScreenCommand({ action: 'replay', speed: 2 })).toEqual({ action: 'replay', speed: 2 });
    expect(parseScreenCommand({ action: 'replay', speed: 3 })).toBeNull();
    expect(parseScreenCommand({ action: 'replaySpeed', speed: 1 })).toEqual({ action: 'replaySpeed', speed: 1 });
    expect(parseScreenCommand({ action: 'replaySpeed' })).toBeNull();
    expect(parseScreenCommand({ action: 'replayPause', extra: 1 })).toEqual({ action: 'replayPause' });
    expect(parseScreenCommand({ action: 'wipe' })).toBeNull();
    expect(parseScreenCommand(null)).toBeNull();
    expect(parseScreenCommand('poster')).toBeNull();
  });
});

describe('POST /api/admin/screen', () => {
  let srv: RunningServer;
  let dir: string;
  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
  }, 60_000);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('needs the admin login', async () => {
    const r = await new Client(srv.url).post('/admin/screen', { action: 'poster' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ADMIN_REQUIRED');
  });

  it('sends the poster command to screen sockets only', async () => {
    const admin = await adminClient(srv.url);
    const screen = await WsRecorder.open(srv.url, 'screen');
    const adminWs = await WsRecorder.open(srv.url, 'admin', admin.cookieHeader());
    try {
      const got = screen.next((m) => m.type === 'screen');
      const r = await admin.post('/admin/screen', { action: 'poster', show: true });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, screens: 1 });
      expect(await got).toEqual({ type: 'screen', command: { action: 'poster', show: true } });
      expect(adminWs.messages.some((m) => m.type === 'screen')).toBe(false);
    } finally {
      screen.close();
      adminWs.close();
    }
  });

  it('refuses unknown commands and a replay outside RESULTS', async () => {
    const admin = await adminClient(srv.url);
    const bad = await admin.post('/admin/screen', { action: 'explode' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    const early = await admin.post('/admin/screen', { action: 'replay' });
    expect(early.body.error.code).toBe('PHASE_CLOSED');
  });
});
