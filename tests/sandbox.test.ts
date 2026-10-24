// §14 sandbox.test.ts (core set, M1): the isolated-vm runner (isolates in
// child processes), the hardened harness, timeouts with culprit attribution,
// slow strikes, memory limits, strikes -> disable, and output forgery.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  type OtherView,
  type SelfView,
  type StatsSnapshot,
  type WorldView,
} from '@pixel-clash/shared';
import { ChildIvmSession, createIvmRunnerFactory } from '../packages/server/src/sandbox/ivmRunner.js';
import { createInprocRunnerFactory } from '../packages/server/src/sandbox/inprocRunner.js';
import {
  isUnitError,
  runnerLimitsFromConfig,
  type PlayerRunner,
  type RunnerFactory,
  type RunnerLimits,
  type RunnerUnitDesign,
  type TickInput,
  type TickResult,
  type UnitActionOutput,
} from '../packages/server/src/sandbox/runner.js';
import {
  SessionPlayerRunner,
  parseTickOutput,
  type CallOutcome,
  type SandboxSession,
} from '../packages/server/src/sandbox/session.js';
import { StrikeTracker, napMessage, timedOutOnceMessage } from '../packages/server/src/sandbox/strikes.js';
import { normalizeSource } from '../packages/server/src/validator/normalize.js';
import { transpile } from '../packages/server/src/validator/transpile.js';

const FIX = new URL('./fixtures/units/', import.meta.url);
const TEMPLATE_SOLDIER = new URL('../packages/starter-kit/units/basic_soldier.js', import.meta.url);

const LIMITS: RunnerLimits = runnerLimitsFromConfig(DEFAULT_CONFIG.sandbox);
const STRIKE_LIMITS = DEFAULT_CONFIG.sandbox.battle;
const ivm = createIvmRunnerFactory();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function compile(source: string): Promise<string> {
  const n = normalizeSource(source, 20480);
  if (!n.ok) throw new Error(n.error.message);
  const t = await transpile(n.source);
  if (!t.ok) throw new Error(t.error.message);
  return t.compiledJs;
}

async function design(unitId: string, path: string | URL): Promise<RunnerUnitDesign> {
  const src = readFileSync(typeof path === 'string' ? new URL(path, FIX) : path, 'utf8');
  return { unitId, compiledJs: await compile(src), stats: {} as StatsSnapshot };
}

async function inlineDesign(unitId: string, source: string): Promise<RunnerUnitDesign> {
  return { unitId, compiledJs: await compile(source), stats: {} as StatsSnapshot };
}

const open: PlayerRunner[] = [];
async function create(
  units: RunnerUnitDesign[],
  opts: { seat?: number; seed?: number; limits?: Partial<RunnerLimits>; factory?: RunnerFactory } = {},
): Promise<PlayerRunner> {
  const seat = opts.seat ?? 0;
  const r = await (opts.factory ?? ivm).create(
    { playerId: `p${seat}`, seat, seed: opts.seed ?? 1000 + seat },
    units,
    { ...LIMITS, ...opts.limits },
  );
  open.push(r);
  return r;
}
afterEach(() => {
  for (const r of open.splice(0)) r.dispose();
});

function selfView(id: string, unitId: string, x = 100, y = 100): SelfView {
  return {
    id, unitId, ownerId: 'p0', teamId: 0, type: 'soldier', name: unitId, x, y, radius: 10, hp: 120, maxHp: 120,
    damage: 10, range: 40, speed: 1.5, attackCooldown: 60, cooldownRemaining: 0, blockedBy: null, blockedTicks: 0, pathing: 'direct', factory: null,
    element: 'normal', splashRadius: 0, support: null, status: NO_STATUS,
  };
}
function otherView(id: string, ownerId: string, x: number, y: number): OtherView {
  return {
    id, ownerId, teamId: ownerId === 'p0' ? 0 : 1, type: 'soldier', name: 'x', x, y, radius: 10, hp: 120, maxHp: 120, range: 40,
    element: 'normal', splashRadius: 0, support: null, status: NO_STATUS,
  };
}
const NO_STATUS = { burning: 0, burnLeft: 0, frozen: 0, haste: 0, might: 0, shield: 0, healRoom: 0 };
const WORLD: WorldView = {
  width: 800, height: 800, tick: 0, ticksLeft: 5400, mapStyle: 'corners', myCorner: { x: 120, y: 120 },
  center: { x: 400, y: 400 }, safeZone: { x: 400, y: 400, radius: 570 },
};

function input(tick: number, selves: SelfView[], enemies: OtherView[] = []): TickInput {
  const allies = selves.map((s) => otherView(s.id, s.ownerId, s.x, s.y));
  return { tick, nowMs: (tick * 1000) / 60, selves, enemies, allies, world: { ...WORLD, tick, ticksLeft: 5400 - tick } };
}

const actions = (r: TickResult) =>
  Object.fromEntries(r.outputs.filter((o) => !isUnitError(o)).map((o) => [o.instanceId, (o as UnitActionOutput).action]));

/** Run ticks the way the sim will: disabled instances are left out of `selves`. */
async function battle(runner: PlayerRunner, tracker: StrikeTracker, selves: SelfView[], ticks: number, enemies: OtherView[] = []) {
  const results: TickResult[] = [];
  for (let t = 0; t < ticks && !tracker.playerDisabled; t++) {
    const r = await runner.tick(input(t, tracker.active(selves), enemies));
    tracker.record(t, r);
    results.push(r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ivm runner: basics', () => {
  it('runs the template: chases, then attacks; outputs sorted and per instance', async () => {
    const r = await create([await design('basic-soldier', TEMPLATE_SOLDIER)]);
    expect(r.loadErrors.size).toBe(0);
    expect(await r.spawn('0-0-1', 'basic-soldier')).toEqual({ ok: true });
    expect(await r.spawn('0-0-0', 'basic-soldier')).toEqual({ ok: true });
    const far = otherView('1-0-0', 'p1', 300, 100);
    const near = otherView('1-0-1', 'p1', 140, 100); // gap 20 <= 40
    const res = await r.tick(input(0, [selfView('0-0-0', 'basic-soldier'), selfView('0-0-1', 'basic-soldier', 100, 300)], [far, near]));
    expect(res.status).toBe('ok');
    expect(res.forged).toBe(0);
    expect(res.outputs.map((o) => o.instanceId)).toEqual(['0-0-0', '0-0-1']);
    expect(actions(res)).toEqual({
      '0-0-0': { action: 'attack', targetId: '1-0-1' },
      '0-0-1': { action: 'move', destination: { x: 140, y: 100 } },
    });
  });

  it('Date.now is sim time, Math.random is seeded; isolates are independent per player', async () => {
    const spy = await design('spy', 'malicious/shared_globals.js');
    const a = await create([spy], { seat: 0, seed: 7 });
    const b = await create([spy], { seat: 1, seed: 8 });
    const c = await create([spy], { seat: 2, seed: 7 });
    for (const [r, id] of [[a, '0-0-0'], [b, '1-0-0'], [c, '2-0-0']] as const) await r.spawn(id, 'spy');
    const ra = actions(await a.tick(input(30, [selfView('0-0-0', 'spy')])))['0-0-0'] as Record<string, unknown>;
    const rb = actions(await b.tick(input(30, [selfView('1-0-0', 'spy')])))['1-0-0'] as Record<string, unknown>;
    const rc = actions(await c.tick(input(30, [selfView('2-0-0', 'spy')])))['2-0-0'] as Record<string, unknown>;
    expect(ra.seen).toEqual(['0-0-0']); // no state leaks between players
    expect(rb.seen).toEqual(['1-0-0']);
    expect(ra.now).toBe(500);
    expect(ra.date).toBe(500);
    expect(ra.random).toBe(rc.random); // same seed, same sequence
    expect(ra.random).not.toBe(rb.random);
  });

  it('spawn failures carry the message and original line; load errors are reported', async () => {
    const r = await create([
      await design('clumsy', 'bad/constructor_threw.js'),
      await design('loader', 'bad/eval_threw.js'),
    ]);
    expect(r.loadErrors.get('loader')?.line).toBe(2);
    const s = await r.spawn('0-0-0', 'clumsy');
    expect(s).toMatchObject({ ok: false, error: { line: 5 } });
    expect(await r.spawn('0-0-1', 'loader')).toMatchObject({ ok: false });
    expect(await r.spawn('0-0-2', 'nope')).toMatchObject({ ok: false });
  });

  it('this.damage = 9999 in update changes nothing: the runner never reads stats back', async () => {
    const r = await create([
      await inlineDesign(
        'cheat',
        `export default class C { constructor() { this.damage = 10; }
          update(self) { const seen = self.damage; this.damage = 9999; self.damage = 9999; return { action: 'idle', seen }; } }`,
      ),
    ]);
    await r.spawn('0-0-0', 'cheat');
    for (let t = 0; t < 3; t++) {
      const res = await r.tick(input(t, [selfView('0-0-0', 'cheat')]));
      expect(res.outputs).toEqual([{ instanceId: '0-0-0', action: { action: 'idle', seen: 10 }, ms: expect.any(Number) }]);
    }
  });
});

describe('ivm runner: deadlines and culprits', () => {
  it('the hard timeout kills a while(true) within the deadline + 10 ms and names the culprit', async () => {
    const r = await create([await design('looper', 'malicious/loop_update.js')]);
    await r.spawn('0-0-0', 'looper');
    const res = await r.tick(input(0, [selfView('0-0-0', 'looper')]));
    expect(res.status).toBe('timeout');
    expect(res.outputs).toEqual([]);
    expect(res.culprit).toBe('0-0-0');
    expect(res.elapsedMs).toBeLessThan(LIMITS.hardTimeoutMs + 10);
    expect(r.disposed).toBe(false);
  });

  it("a while(true) in one unit's update disables ONLY that unit; the others keep acting", async () => {
    const r = await create([
      await design('basic-soldier', TEMPLATE_SOLDIER),
      await design('looper', 'malicious/loop_update.js'),
    ]);
    const selves = [selfView('0-0-0', 'basic-soldier'), selfView('0-0-1', 'basic-soldier'), selfView('0-1-0', 'looper')];
    for (const s of selves) expect(await r.spawn(s.id, s.unitId)).toEqual({ ok: true });
    const tracker = new StrikeTracker(STRIKE_LIMITS, (id) => (id === '0-1-0' ? 'Looper' : 'Soldier'));
    const results = await battle(r, tracker, selves, 10, [otherView('1-0-0', 'p1', 400, 400)]);

    // First timeout is forgiven (could be a GC stall); the second, on the very
    // next tick, disables the genuine infinite loop.
    expect(results.slice(0, 2).map((x) => [x.status, x.culprit])).toEqual([['timeout', '0-1-0'], ['timeout', '0-1-0']]);
    expect(tracker.events[1]).toMatchObject({ kind: 'unit-error', tick: 0, instanceId: '0-1-0', message: timedOutOnceMessage('Looper'), strikes: 1 });
    expect(tracker.isDisabled('0-1-0')).toBe(true);
    expect(tracker.isDisabled('0-0-0')).toBe(false);
    expect(tracker.playerDisabled).toBe(false);
    for (const res of results.slice(2)) {
      expect(res.status).toBe('ok');
      expect(Object.keys(actions(res))).toEqual(['0-0-0', '0-0-1']);
    }
    expect(tracker.events.filter((e) => e.kind === 'unit-disabled')).toEqual([
      expect.objectContaining({ tick: 1, instanceId: '0-1-0', reason: 'timeout' }),
    ]);
  });

  it('a ~15 ms-per-tick unit is disabled within a few seconds; the rest of the army is unaffected', async () => {
    const r = await create([await design('basic-soldier', TEMPLATE_SOLDIER), await design('slow', 'malicious/slow_update.js')]);
    const selves = [selfView('0-0-0', 'basic-soldier'), selfView('0-0-1', 'slow')];
    for (const s of selves) await r.spawn(s.id, s.unitId);
    const tracker = new StrikeTracker(STRIKE_LIMITS);
    const results = await battle(r, tracker, selves, 180);
    const disabledAt = tracker.events.find((e) => e.kind === 'unit-disabled' && e.instanceId === '0-0-1')?.tick;
    expect(disabledAt).toBeDefined();
    expect(disabledAt!).toBeLessThan(180);
    expect(tracker.isDisabled('0-0-0')).toBe(false);
    expect(tracker.playerDisabled).toBe(false);
    expect(actions(results.at(-1)!)).toHaveProperty('0-0-0');
  });

  it('slow strikes (over the soft limit) disable the slowest unit first', async () => {
    const heavy = await inlineDesign(
      'heavy',
      `export default class H { update() { let s = 0; for (let i = 0; i < 4e6; i++) s += i % 3; return { action: 'idle', s }; } }`,
    );
    const r = await create([await design('basic-soldier', TEMPLATE_SOLDIER), heavy], {
      limits: { softTimeoutMs: 1, hardTimeoutMs: 200, disposeGraceMs: 200 },
    });
    const selves = [selfView('0-0-0', 'basic-soldier'), selfView('0-0-1', 'heavy')];
    for (const s of selves) await r.spawn(s.id, s.unitId);
    const tracker = new StrikeTracker({ ...STRIKE_LIMITS, slowStrikeLimit: 10 });
    const results = await battle(r, tracker, selves, 60);
    expect(results.filter((x) => x.slow).length).toBeGreaterThanOrEqual(10);
    expect(tracker.events.find((e) => e.kind === 'unit-disabled')).toMatchObject({ instanceId: '0-0-1', reason: 'slow' });
    expect(tracker.isDisabled('0-0-0')).toBe(false);
  });

  it('2 copies of a looping design both nap; a soldier keeps acting and the player is not disabled', async () => {
    // A generous culprit probe: a busy test machine must not hide the culprit.
    const r = await create([await design('basic-soldier', TEMPLATE_SOLDIER), await design('looper', 'malicious/loop_update.js')], {
      limits: { culpritProbeTimeoutMs: 100, disposeGraceMs: 500 },
    });
    const selves = [selfView('0-0-0', 'looper'), selfView('0-0-1', 'looper'), selfView('0-0-2', 'basic-soldier')];
    for (const s of selves) expect(await r.spawn(s.id, s.unitId)).toEqual({ ok: true });
    const tracker = new StrikeTracker(STRIKE_LIMITS);
    const results = await battle(r, tracker, selves, 8);
    // A, A (naps), B, B (naps): a culprit's own timeouts don't count toward the player limits.
    // (Filtered: a busy test machine may add stray stalls, and a looper's own
    // timeout can be classed as a forgiven host stall, which earns no strike, so
    // that unit then needs one more counted timeout to nap. Only counted ones
    // must follow the A, A, B, B pattern.)
    const counted = results.filter((x) => (x.culprit === '0-0-0' || x.culprit === '0-0-1') && !x.hostStall);
    expect(counted.map((x) => [x.status, x.culprit])).toEqual([
      ['timeout', '0-0-0'],
      ['timeout', '0-0-0'],
      ['timeout', '0-0-1'],
      ['timeout', '0-0-1'],
    ]);
    expect(tracker.isDisabled('0-0-0')).toBe(true);
    expect(tracker.isDisabled('0-0-1')).toBe(true);
    expect(tracker.playerDisabled).toBe(false);
    expect(tracker.isDisabled('0-0-2')).toBe(false);
    expect(results.at(-1)!.status).toBe('ok');
    expect(Object.keys(actions(results.at(-1)!))).toEqual(['0-0-2']);
  });

  it('an infinite microtask chain is stopped (timeout or crash) and leads to a disable', async () => {
    const r = await create([await design('micro', 'malicious/microtask_loop.js')]);
    await r.spawn('0-0-0', 'micro');
    const tracker = new StrikeTracker(STRIKE_LIMITS);
    const results = await battle(r, tracker, [selfView('0-0-0', 'micro')], 10);
    expect(['timeout', 'crashed']).toContain(results[0]?.status);
    expect(tracker.playerDisabled || tracker.isDisabled('0-0-0')).toBe(true);
  });
});

describe('ivm runner: memory and crashes', () => {
  it.each(['malicious/array_bomb.js', 'malicious/growing_map.js'])(
    'memory exhaustion in update (%s) disposes the sandbox and disables the player',
    async (file) => {
      // A long hard timeout, so the allocation loop hits the memory limit first.
      const r = await create([await design('hog', file), await design('basic-soldier', TEMPLATE_SOLDIER)], {
        limits: { hardTimeoutMs: 5000 },
      });
      await r.spawn('0-0-0', 'hog');
      await r.spawn('0-0-1', 'basic-soldier');
      const tracker = new StrikeTracker(STRIKE_LIMITS);
      const res = await r.tick(input(0, [selfView('0-0-0', 'hog'), selfView('0-0-1', 'basic-soldier')]));
      tracker.record(0, res);
      expect(res.status).toBe('crashed');
      expect(r.disposed).toBe(true);
      expect(tracker.playerDisabled).toBe(true);
      expect((await r.tick(input(1, [selfView('0-0-1', 'basic-soldier')]))).status).toBe('crashed');
      // The host is healthy: a new sandbox works.
      const fresh = await create([await design('basic-soldier', TEMPLATE_SOLDIER)]);
      await fresh.spawn('0-0-0', 'basic-soldier');
      expect((await fresh.tick(input(0, [selfView('0-0-0', 'basic-soldier')]))).status).toBe('ok');
    },
  );

  it('a 500 MB array at load time crashes only that sandbox', async () => {
    const r = await create([await design('hoarder', 'malicious/huge_array.js'), await design('basic-soldier', TEMPLATE_SOLDIER)]);
    expect(r.loadErrors.get('hoarder')?.message).toMatch(/crashed|memory|too long/);
    expect(r.disposed).toBe(true);
    expect((await r.spawn('0-0-0', 'basic-soldier')).ok).toBe(false);
  });

  it('dispose is idempotent and later ticks report crashed', async () => {
    const r = await create([await design('basic-soldier', TEMPLATE_SOLDIER)]);
    r.dispose();
    r.dispose();
    expect(r.disposed).toBe(true);
    expect((await r.tick(input(0, []))).status).toBe('crashed');
  });
});

describe('host hiccups are not the player\'s fault', () => {
  // Regression: the child's tick deadline (hard 12 + grace 10 = 22 ms) used to
  // be a bare wall-clock timer. When the sandbox process was not scheduled for
  // more than ~22 ms mid-tick (a busy laptop, VM preemption), the expired timer
  // ran before the finished call was polled, killed a healthy isolate and
  // reported 'crashed', which disables the player's whole army.
  it('pausing the sandbox process for ~80 ms during a short (~3 ms) tick never crashes it', async () => {
    const light = await inlineDesign(
      'light',
      `export default class L { update() { let s = 0; for (let i = 0; i < 4e6; i++) s += i % 3; return { action: 'idle', s }; } }`,
    );
    for (const pauseAfterMs of [0, 0, 0, 1, 1, 1, 2, 2]) {
      let child: ChildIvmSession | undefined;
      const runner = await SessionPlayerRunner.create(
        async (o) => (child = await ChildIvmSession.open(o)),
        { playerId: 'p0', seat: 0, seed: 1 },
        [light],
        LIMITS, // the real defaults: hard 12 ms, grace 10 ms
      );
      open.push(runner);
      expect(await runner.spawn('0-0-0', 'light')).toEqual({ ok: true });
      const pid = child!.pid!;
      // Warm up, so the paused tick is a normal one.
      expect((await runner.tick(input(0, [selfView('0-0-0', 'light')]))).status).toBe('ok');

      const ticking = runner.tick(input(1, [selfView('0-0-0', 'light')]));
      await new Promise((r) => setTimeout(r, pauseAfterMs));
      process.kill(pid, 'SIGSTOP');
      await new Promise((r) => setTimeout(r, 80));
      process.kill(pid, 'SIGCONT');
      const res = await ticking;
      // 'timeout' is the forgiven-once hard timeout (isolated-vm's own timer
      // saw the pause); a 'crashed' would disable the whole player.
      expect(['ok', 'timeout'], `pause after ${pauseAfterMs} ms: ${res.detail ?? ''}`).toContain(res.status);
      // The whole process was stopped, so a timeout is recognised as the host's fault.
      if (res.status === 'timeout') expect(res.hostStall, `pause after ${pauseAfterMs} ms`).toBe(true);
      expect(runner.disposed).toBe(false);
      // The isolate is still alive and answering.
      expect(['ok', 'timeout']).toContain((await runner.tick(input(2, [selfView('0-0-0', 'light')]))).status);
      expect(runner.disposed).toBe(false);
      runner.dispose();
    }
  });

  it('a slow host alone gives no slow strike: the units\' own (in-isolate) time must be slow too', async () => {
    const reply = (ms: number) => JSON.stringify([{ instanceId: '0-0-0', action: { action: 'idle' }, ms }]);
    let unitMs = 0;
    const fake: SandboxSession = {
      disposed: false,
      load: async (): Promise<CallOutcome> => ({ kind: 'ok', value: '{"ok":true}', elapsedMs: 0 }),
      // The wall time around the call is always way over the 6 ms soft limit.
      call: async (fn): Promise<CallOutcome> => ({ kind: 'ok', value: fn === 'tick' ? reply(unitMs) : '{"ok":true}', elapsedMs: 40 }),
      dispose: () => {},
    };
    const runner = await SessionPlayerRunner.create(async () => fake, { playerId: 'p0', seat: 0, seed: 1 }, [await inlineDesign('x', `export default class X { update() { return { action: 'idle' }; } }`)], LIMITS);
    unitMs = 0;
    expect((await runner.tick(input(0, [selfView('0-0-0', 'x')]))).slow).toBe(false);
    unitMs = LIMITS.softTimeoutMs + 3;
    expect(await runner.tick(input(1, [selfView('0-0-0', 'x')]))).toMatchObject({ status: 'ok', slow: true, slowestInstanceId: '0-0-0' });
  });

  it('a genuinely stuck isolate (microtask loop) is still killed quickly with an honest message', async () => {
    const r = await create([await design('micro', 'malicious/microtask_loop.js')]);
    await r.spawn('0-0-0', 'micro');
    const t0 = performance.now();
    const res = await r.tick(input(0, [selfView('0-0-0', 'micro')]));
    expect(['timeout', 'crashed']).toContain(res.status);
    expect(performance.now() - t0).toBeLessThan(2000);
    if (res.status === 'crashed') expect(res.detail ?? '').not.toMatch(/probably using too much memory/);
  });
});

describe('strikes', () => {
  it('a unit that throws every tick is disabled at 30 strikes with the friendly message', async () => {
    const r = await create([await design('grumpy', 'malicious/throws_always.js'), await design('basic-soldier', TEMPLATE_SOLDIER)]);
    const selves = [selfView('0-0-0', 'grumpy'), selfView('0-0-1', 'basic-soldier')];
    for (const s of selves) await r.spawn(s.id, s.unitId);
    const tracker = new StrikeTracker(STRIKE_LIMITS, (id) => (id === '0-0-0' ? 'Grumpy' : 'Soldier'));
    const results = await battle(r, tracker, selves, 40);
    const first = results[0]!.outputs.find((o) => o.instanceId === '0-0-0');
    expect(first && isUnitError(first) ? first.error : undefined).toEqual({ message: 'Error: nope', line: 17 });
    const disabled = tracker.events.find((e) => e.kind === 'unit-disabled');
    expect(disabled).toMatchObject({ tick: 29, instanceId: '0-0-0', reason: 'errors', message: napMessage('Grumpy') });
    expect(napMessage('Zappy')).toBe('Zappy got confused too many times and is taking a nap 💤');
    expect(tracker.strikesOf('0-0-0')).toBe(30);
    expect(tracker.isDisabled('0-0-1')).toBe(false);
    expect(Object.keys(actions(results.at(-1)!))).toEqual(['0-0-1']);
  });

  it('crash, forged output and bad output are recorded', () => {
    const t = new StrikeTracker(STRIKE_LIMITS);
    const base = { outputs: [], elapsedMs: 1, slow: false, forged: 0 };
    t.record(0, { ...base, status: 'ok', forged: 2 });
    t.record(1, { ...base, status: 'bad-output', detail: 'x' });
    expect(t.playerStrikes).toBe(2);
    expect(t.playerDisabled).toBe(false);
    t.record(2, { ...base, status: 'crashed', detail: 'ran out of memory' });
    expect(t.playerDisabled).toBe(true);
    expect(t.active([{ id: 'a' }])).toEqual([]);
  });

  it("a unit's first hard timeout only idles the tick; its second disables it", () => {
    const t = new StrikeTracker(STRIKE_LIMITS, (id) => (id === '0-0-0' ? 'Zappy' : 'Soldier'));
    const ok: TickResult = { status: 'ok', outputs: [], elapsedMs: 1, slow: false, forged: 0 };
    const stall = (culprit: string): TickResult => ({ status: 'timeout', outputs: [], elapsedMs: 26, slow: false, forged: 0, culprit });
    expect(t.record(0, stall('0-0-0'))).toEqual([
      { kind: 'timeout', tick: 0, elapsedMs: 26, culprit: '0-0-0' },
      { kind: 'unit-error', tick: 0, instanceId: '0-0-0', message: 'Zappy took too long once', strikes: 1 },
    ]);
    expect(timedOutOnceMessage('Zappy')).toBe('Zappy took too long once');
    expect(t.isDisabled('0-0-0')).toBe(false);
    expect(t.strikesOf('0-0-0')).toBe(1);
    // A different unit's single stall is forgiven too.
    t.record(1, ok);
    t.record(2, stall('0-0-1'));
    expect(t.isDisabled('0-0-1')).toBe(false);
    // Much later, Zappy times out again: now it naps.
    for (let i = 3; i < 50; i++) t.record(i, ok);
    const second = t.record(50, stall('0-0-0'));
    expect(second.find((e) => e.kind === 'unit-disabled')).toMatchObject({ instanceId: '0-0-0', reason: 'timeout' });
    expect(t.isDisabled('0-0-0')).toBe(true);
    expect(t.isDisabled('0-0-1')).toBe(false);
    expect(t.playerDisabled).toBe(false);
  });

  it('a host-stall timeout is reported but gives no strike and counts toward no limit', () => {
    const t = new StrikeTracker(STRIKE_LIMITS, () => 'Zappy');
    const hostStall: TickResult = { status: 'timeout', outputs: [], elapsedMs: 40, slow: false, forged: 0, culprit: 'a', hostStall: true };
    expect(t.record(0, hostStall)).toEqual([{ kind: 'timeout', tick: 0, elapsedMs: 40, hostStall: true }]);
    for (let i = 1; i < 10; i++) t.record(i, hostStall);
    expect(t.strikesOf('a')).toBe(0);
    expect(t.isDisabled('a')).toBe(false);
    expect(t.playerDisabled).toBe(false);
  });

  it('timeoutsToDisable is configurable (1 = the old disable-on-first rule)', () => {
    const t = new StrikeTracker({ ...STRIKE_LIMITS, timeoutsToDisable: 1 }, () => 'Zappy');
    const events = t.record(0, { status: 'timeout', outputs: [], elapsedMs: 13, slow: false, forged: 0, culprit: 'a' });
    expect(t.isDisabled('a')).toBe(true);
    // Its first timeout: no "again".
    expect(events.find((e) => e.kind === 'unit-error')).toMatchObject({ message: 'Zappy took too long' });
  });

  it("timeouts blamed on a fresh culprit don't count toward the player limits; ones that continue after it naps do", () => {
    const t = new StrikeTracker(STRIKE_LIMITS);
    const stall = (culprit?: string): TickResult => ({ status: 'timeout', outputs: [], elapsedMs: 13, slow: false, forged: 0, ...(culprit ? { culprit } : {}) });
    for (const id of ['a', 'a', 'b', 'b', 'c', 'c']) t.record(0, stall(id));
    expect(['a', 'b', 'c'].every((id) => t.isDisabled(id))).toBe(true);
    expect(t.playerDisabled).toBe(false);
    // The culprit is already napping (or none can be named): these count.
    t.record(1, stall('a'));
    t.record(2, stall());
    expect(t.playerDisabled).toBe(false);
    t.record(3, stall());
    expect(t.playerDisabled).toBe(true);
  });

  it('5 timeouts in total disable the player even when not in a row', () => {
    const t = new StrikeTracker(STRIKE_LIMITS);
    const ok: TickResult = { status: 'ok', outputs: [], elapsedMs: 1, slow: false, forged: 0 };
    const to: TickResult = { status: 'timeout', outputs: [], elapsedMs: 13, slow: false, forged: 0 };
    for (let i = 0; i < 4; i++) {
      t.record(i * 2, to);
      t.record(i * 2 + 1, ok);
    }
    expect(t.playerDisabled).toBe(false);
    t.record(9, to);
    expect(t.playerDisabled).toBe(true);
  });
});

describe('hardening', () => {
  it('reassigning __tick, patching JSON/Map/Reflect and prototypes changes nothing', async () => {
    const r = await create([await design('hijacker', 'malicious/tick_hijack.js')]);
    expect(r.loadErrors.size).toBe(0);
    const selves = [selfView('0-0-0', 'hijacker'), selfView('0-0-1', 'hijacker')];
    for (const s of selves) expect(await r.spawn(s.id, 'hijacker')).toEqual({ ok: true });
    const enemy = otherView('1-0-0', 'p1', 500, 500);
    for (let t = 0; t < 3; t++) {
      const res = await r.tick(input(t, selves, [enemy]));
      expect(res.status).toBe('ok');
      expect(res.forged).toBe(0);
      expect(actions(res)).toEqual({
        '0-0-0': { action: 'attack', targetId: '1-0-0', me: '0-0-0' },
        '0-0-1': { action: 'attack', targetId: '1-0-0', me: '0-0-1' },
      });
    }
  });

  it('host-side parsing drops forged, enemy, unknown and duplicate entries', () => {
    const selves = [{ id: '0-0-0' }, { id: '0-0-1' }];
    const raw = JSON.stringify([
      { instanceId: '0-0-1', action: { action: 'idle' }, ms: 1 },
      { instanceId: '1-0-0', action: { action: 'attack', targetId: '0-0-0' } }, // enemy id
      { instanceId: '0-0-1', action: { action: 'move' } }, // duplicate
      { instanceId: '9-9-9' }, // unknown
      'garbage',
      null,
      { instanceId: '0-0-0', error: { message: 'boom', stack: 'at x (unit-0.js:3:1)' }, ms: -1 },
    ]);
    const p = parseTickOutput(raw, selves);
    expect(p.ok).toBe(true);
    expect(p.forged).toBe(5);
    expect(p.outputs).toEqual([
      { instanceId: '0-0-0', error: { message: 'boom' } },
      { instanceId: '0-0-1', action: { action: 'idle' }, ms: 1 },
    ]);
    expect(parseTickOutput('not json', selves)).toMatchObject({ ok: false, outputs: [] });
    expect(parseTickOutput('{"instanceId":"0-0-0"}', selves)).toMatchObject({ ok: false, outputs: [] });
  });

  it('a returned Promise and a getter-laden action are handled (idle / unit error)', async () => {
    const r = await create([await design('promiser', 'malicious/returns_promise.js'), await design('tricky', 'malicious/getter_action.js')]);
    await r.spawn('0-0-0', 'promiser');
    await r.spawn('0-0-1', 'tricky');
    const res = await r.tick(input(0, [selfView('0-0-0', 'promiser'), selfView('0-0-1', 'tricky')]));
    expect(res.status).toBe('ok');
    expect(actions(res)['0-0-0']).toEqual({ action: 'idle' });
    const tricky = res.outputs.find((o) => o.instanceId === '0-0-1');
    expect(tricky && isUnitError(tricky) ? tricky.error.message : '').toMatch(/gotcha/);
  });
});

describe('inproc-unsafe runner (node:vm, tests/dev only)', () => {
  it('refuses without the explicit unsafe flag', () => {
    expect(() => createInprocRunnerFactory({ unsafe: false })).toThrow(/not a security boundary/);
    expect(() => createInprocRunnerFactory({} as { unsafe: boolean })).toThrow();
  });

  it('runs the same harness: actions, timeout culprit, errors with lines', async () => {
    const factory = createInprocRunnerFactory({ unsafe: true });
    expect(factory.mode).toBe('inproc-unsafe');
    const r = await create(
      [await design('basic-soldier', TEMPLATE_SOLDIER), await design('looper', 'malicious/loop_update.js'), await design('grumpy', 'malicious/throws_always.js')],
      // node:vm runs inside this (shared, parallel) test worker, so give normal
      // ticks headroom: only the genuine infinite loop should time out.
      { factory, limits: { hardTimeoutMs: 100 } },
    );
    await r.spawn('0-0-0', 'basic-soldier');
    await r.spawn('0-0-1', 'looper');
    await r.spawn('0-0-2', 'grumpy');
    const t0 = await r.tick(input(0, [selfView('0-0-0', 'basic-soldier'), selfView('0-0-1', 'looper')]));
    expect(t0).toMatchObject({ status: 'timeout', culprit: '0-0-1' });
    const t1 = await r.tick(input(1, [selfView('0-0-0', 'basic-soldier'), selfView('0-0-2', 'grumpy')]));
    expect(t1.status).toBe('ok');
    expect(actions(t1)['0-0-0']).toEqual({ action: 'move', destination: { x: 400, y: 400 } });
    const err = t1.outputs.find((o) => o.instanceId === '0-0-2');
    expect(err && isUnitError(err) ? err.error : undefined).toEqual({ message: 'Error: nope', line: 17 });
  });
});

describe('review regressions (hardening)', () => {
  it.each([
    ['malicious/wasm_memory.js', /WebAssembly is not defined/],
    ['malicious/resizable_buffer.js', /resiz/i],
    ['malicious/growable_sab.js', /SharedArrayBuffer is not defined/],
  ])('memory outside the isolate limit (%s) fails at load time', async (file, re) => {
    const r = await create([await design('hog', file), await design('basic-soldier', TEMPLATE_SOLDIER)]);
    expect(r.loadErrors.get('hog')?.message).toMatch(re);
    expect(r.disposed).toBe(false);
    expect(await r.spawn('0-0-0', 'basic-soldier')).toEqual({ ok: true });
  });

  it('WebAssembly, SharedArrayBuffer and Atomics are gone; ArrayBuffer ignores maxByteLength', async () => {
    const r = await create([
      await inlineDesign(
        'probe',
        `export default class P { update() {
          const b = new ArrayBuffer(8, { maxByteLength: 1 << 30 });
          let viaCtor;
          try { viaCtor = new Uint8Array(4).buffer.constructor(8, { maxByteLength: 64 }); } catch (e) { viaCtor = e.name; }
          const viaNew = new (new Uint8Array(4).buffer.constructor)(8, { maxByteLength: 64 });
          return { action: 'idle', wasm: typeof WebAssembly, sab: typeof SharedArrayBuffer, atomics: typeof Atomics,
            resizable: b.resizable, viaCtor, viaNewResizable: viaNew.resizable, isView: ArrayBuffer.isView(new Uint8Array(1)),
            instance: b instanceof ArrayBuffer };
        } }`,
      ),
    ]);
    await r.spawn('0-0-0', 'probe');
    const res = await r.tick(input(0, [selfView('0-0-0', 'probe')]));
    expect(actions(res)['0-0-0']).toEqual({
      action: 'idle', wasm: 'undefined', sab: 'undefined', atomics: 'undefined',
      resizable: false, viaCtor: 'TypeError', viaNewResizable: false, isView: true, instance: true,
    });
  });

  it('a 200 MB ArrayBuffer is still refused by the memory limit', async () => {
    const r = await create([
      await inlineDesign('big', `export default class B { update() { try { const b = new ArrayBuffer(200 * 1024 * 1024); return { action: 'idle', got: b.byteLength }; } catch (e) { return { action: 'idle', got: e.name }; } } }`),
    ], { limits: { hardTimeoutMs: 2000 } });
    await r.spawn('0-0-0', 'big');
    const res = await r.tick(input(0, [selfView('0-0-0', 'big')]));
    if (res.status === 'ok') expect(actions(res)['0-0-0']).toEqual({ action: 'idle', got: 'RangeError' });
    else expect(res.status).toBe('crashed');
  });

  it('a thrown 12 MB message (via Object.prototype.toJSON) stays a short unit error', async () => {
    const r = await create([await design('bomb', 'malicious/tojson_bomb.js')]);
    await r.spawn('0-0-0', 'bomb');
    const res = await r.tick(input(0, [selfView('0-0-0', 'bomb')], [otherView('1-0-0', 'p1', 300, 300)]));
    expect(res.status).toBe('ok');
    const out = res.outputs[0]!;
    expect(isUnitError(out) && out.error.message).toMatch(/^Error: AAAA/);
    expect(JSON.stringify(res).length).toBeLessThan(2000);
  });

  it('an endless toJSON runs inside the unit: the timeout names the culprit', async () => {
    const r = await create([
      await inlineDesign('loopy', `Object.prototype.toJSON = function () { while (true) {} };\nexport default class L { update() { return { action: 'idle' }; } }`),
    ]);
    await r.spawn('0-0-0', 'loopy');
    const res = await r.tick(input(0, [selfView('0-0-0', 'loopy')], [otherView('1-0-0', 'p1', 300, 300)]));
    expect(res).toMatchObject({ status: 'timeout', culprit: '0-0-0' });
  });

  it('player code cannot reach the harness API: no design swap, no re-entrant tick', async () => {
    const r = await create([
      await inlineDesign('a', `export default class A { update() { return { action: 'idle', who: 'a' }; } }`),
      await design('b', 'malicious/design_swap.js'),
    ]);
    expect([...r.loadErrors]).toEqual([]);
    await r.spawn('0-0-0', 'a');
    await r.spawn('0-0-1', 'b');
    const res = await r.tick(input(0, [selfView('0-0-0', 'a'), selfView('0-0-1', 'b')]));
    expect(actions(res)).toEqual({
      '0-0-0': { action: 'idle', who: 'a' },
      '0-0-1': { action: 'idle', who: 'b', seen: [], swap: 'TypeError', reentry: 'TypeError', me: '0-0-1' },
    });
  });

  it.each([
    ['then', `update() { Promise.resolve().then(() => { while (true) {} }); return { action: 'idle' }; }`],
    ['await', `async update() { await null; while (true) {} }`],
  ])('a microtask loop (%s) after the tick loop is blamed on the unit that queued it', async (_kind, body) => {
    const r = await create([
      await design('basic-soldier', TEMPLATE_SOLDIER),
      await inlineDesign('late', `export default class L { ${body} }`),
    ]);
    await r.spawn('0-0-0', 'basic-soldier');
    await r.spawn('0-0-1', 'late');
    const tracker = new StrikeTracker(STRIKE_LIMITS);
    const selves = [selfView('0-0-0', 'basic-soldier'), selfView('0-0-1', 'late')];
    const results = await battle(r, tracker, selves, 5, [otherView('1-0-0', 'p1', 400, 400)]);
    expect(results[0]).toMatchObject({ status: 'timeout', culprit: '0-0-1' });
    expect(tracker.isDisabled('0-0-1')).toBe(true);
    expect(tracker.isDisabled('0-0-0')).toBe(false);
    expect(tracker.playerDisabled).toBe(false);
    expect(results.at(-1)!.status).toBe('ok');
  });

  it('Intl.DateTimeFormat without a date formats the sim time, not the wall clock', async () => {
    const r = await create([
      await inlineDesign(
        'clock',
        `export default class C { update() {
          const f = new Intl.DateTimeFormat('en', { timeStyle: 'medium', timeZone: 'UTC' });
          const parts = f.formatToParts().map((p) => p.value).join('').split(String.fromCharCode(0x202f)).join(' ');
          return { action: 'idle', t: f.format().split(String.fromCharCode(0x202f)).join(' '), parts, same: f.format() === f.format(new Date()) };
        } }`,
      ),
    ]);
    await r.spawn('0-0-0', 'clock');
    const res = await r.tick(input(30, [selfView('0-0-0', 'clock')])); // nowMs 500
    expect(actions(res)['0-0-0']).toEqual({ action: 'idle', t: '12:00:00 AM', parts: '12:00:00 AM', same: true });
  });

  it("a busy server event loop doesn't kill an innocent player's sandbox", async () => {
    const r = await create([await design('basic-soldier', TEMPLATE_SOLDIER)]);
    await r.spawn('0-0-0', 'basic-soldier');
    const pending = r.tick(input(0, [selfView('0-0-0', 'basic-soldier')]));
    const until = performance.now() + 40; // longer than hard timeout + grace (22 ms)
    while (performance.now() < until) {
      /* the host is busy (GC, a big JSON.stringify…) */
    }
    const res = await pending;
    expect(res.status).toBe('ok');
    expect(r.disposed).toBe(false);
  });

  it('the node:vm runner also hides the harness API', async () => {
    const r = await create(
      [
        await inlineDesign('a', `export default class A { update() { return { action: 'idle', who: 'a' }; } }`),
        await design('b', 'malicious/design_swap.js'),
      ],
      { factory: createInprocRunnerFactory({ unsafe: true }) },
    );
    await r.spawn('0-0-0', 'a');
    await r.spawn('0-0-1', 'b');
    const res = await r.tick(input(0, [selfView('0-0-0', 'a'), selfView('0-0-1', 'b')]));
    expect(actions(res)['0-0-0']).toEqual({ action: 'idle', who: 'a' });
    expect(actions(res)['0-0-1']).toMatchObject({ seen: [], swap: 'TypeError', reentry: 'TypeError' });
  });
});
