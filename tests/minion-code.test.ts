// Player-written minion code (plan §5.3 "4. Minion code: updateMinion()",
// 2026-10-26): a factory's optional updateMinion(self, enemies, allies, world)
// decides for each of its minions on the field, inside the player's ONE
// sandbox call per tick. Returning nothing (or null), throwing, or a
// timed-out tick falls back to the built-in minion logic.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, type FrameDTO, type GameConfig, type PlacementDTO } from '@pixel-clash/shared';
import { createInprocRunnerFactory } from '../packages/server/src/sandbox/inprocRunner.js';
import type { PlayerRunner, RunnerFactory, RunnerUnitDesign, TickInput, TickResult } from '../packages/server/src/sandbox/runner.js';
import { BattleEngine, createBattleRunners, designFor, type BattleResult, type BattleUnitDesign } from '../packages/server/src/sim/engine.js';
import { validateDetailed } from '../packages/server/src/validator/validate.js';

const kit = (f: string) => readFileSync(new URL(`../packages/starter-kit/units/${f}`, import.meta.url), 'utf8');
const SOLDIER = kit('basic_soldier.js');
const TOWER = kit('basic_tower.js');
const FACTORY = kit('basic_factory.js');

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

/** A factory with these extra constructor lines and class body (no updateMinion unless the body has one). */
export function factorySource(name: string, ctorExtra: string, body: string): string {
  return `
export default class F {
  constructor() {
    this.name = '${name}';
    this.type = 'factory';
    this.maxHealth = 360;
    this.productionInterval = 300;
    this.color = '#C0A060';
    ${ctorExtra}
  }
  update(self, enemies, allies, world) {
    return { action: 'rally', destination: world.center };
  }
  ${body}
}`;
}

interface Built {
  battle: BattleUnitDesign;
  runner: RunnerUnitDesign;
}

async function build(source: string, unitId: string, config: GameConfig, dryRun = true): Promise<Built> {
  const d = await validateDetailed(source, { unitId, dryRun }, config);
  if (!d.result.ok) throw new Error(`validation failed: ${JSON.stringify(d.result.errors)}`);
  return { battle: designFor(unitId, d.result.unit.stats, config), runner: { unitId, compiledJs: d.compiledJs!, stats: d.result.unit.stats } };
}

interface Side {
  units: Built[];
  placements: PlacementDTO[];
}

const NO_DIE: GameConfig = deepMerge(DEFAULT_CONFIG, { factory: { dieAtSuddenDeath: false } });
const cfg = (ticks: number, patch: object = {}): GameConfig => deepMerge(NO_DIE, { ...patch, timers: { battleTicks: ticks } });

/** Play a 2-player battle with real (node:vm) sandboxes. `wrap` can wrap each player's runner. */
async function play(
  sides: [Side, Side],
  config: GameConfig,
  seed = 7,
  wrap: (r: PlayerRunner, seat: number) => PlayerRunner = (r) => r,
  factory: RunnerFactory = createInprocRunnerFactory({ unsafe: true }),
): Promise<{ engine: BattleEngine; result: BattleResult; frames: FrameDTO[] }> {
  const players = sides.map((s, seat) => ({ playerId: `p${seat}`, seat, units: s.units.map((u) => u.runner) }));
  const runners = await createBattleRunners(factory, players, config, seed);
  const engine = new BattleEngine({
    players: sides.map((s, seat) => ({
      playerId: `p${seat}`,
      seat,
      zone: seat === 0 ? ('TL' as const) : ('BR' as const),
      units: s.units.map((u) => u.battle),
      placements: s.placements,
      runner: wrap(runners.get(`p${seat}`)!, seat),
    })),
    config,
    seed,
    yieldEveryTicks: 0,
  });
  const result = await engine.run();
  return { engine, result, frames: engine.frames };
}

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('backward compatibility: factories without updateMinion() play exactly as before', () => {
  it('a battle of the starter units and kind factories replays bit for bit (golden hash from before the change)', async () => {
    // A generous tick budget only so a loaded test host never times a tick out (no tick timed out when the hash was recorded).
    const config = cfg(2400, { sandbox: { battle: { hardTimeoutMs: 250, softTimeoutMs: 200 } } });
    const archers = factorySource('Archer Works', "this.produces = 'archer'; this.burst = 2;", '');
    const medics = factorySource('Medic Works', "this.produces = 'medic';", '');
    const brutes = factorySource('Brute Works', "this.produces = 'brute'; this.minionElement = 'fire';", '');
    const a: Side = {
      units: [await build(SOLDIER, 's', config), await build(FACTORY, 'f', config), await build(archers, 'g', config), await build(medics, 'h', config)],
      placements: [at(0, 0, 's'), at(1, 1, 's'), at(2, 2, 'f'), at(3, 3, 'g'), at(4, 4, 'h')],
    };
    const b: Side = {
      units: [await build(SOLDIER, 's', config), await build(TOWER, 't', config), await build(brutes, 'f', config)],
      placements: [at(0, 0, 's'), at(1, 1, 't'), at(2, 2, 'f'), at(3, 3, 'f')],
    };
    const { result, frames } = await play([a, b], config);
    expect(result.units.filter((u) => u.type === 'minion').length).toBeGreaterThan(5);
    expect({ frames: hashOf(frames), units: hashOf(result.units), ranking: hashOf(result.ranking) }).toEqual(GOLDEN);
  }, 60_000);
});

/** Recorded on the code before updateMinion() existed (commit dcacdca). */
const GOLDEN = { frames: '27e0256623f05617', units: 'c20e3979e8e06534', ranking: 'ed8e972aa9825013' };

// ---------------------------------------------------------------------------
// The battle behaviour
// ---------------------------------------------------------------------------

import { SessionPlayerRunner, parseTickOutput, type SandboxSession, type SessionOpener } from '../packages/server/src/sandbox/session.js';
import { vmSessionOpener } from '../packages/server/src/sandbox/inprocRunner.js';
import { createIvmRunnerFactory } from '../packages/server/src/sandbox/ivmRunner.js';

/** A far enemy tower that never dies (so battles run their full length). */
const FAR_TOWER = `
export default class T {
  constructor() { this.name = 'Far Tower'; this.type = 'tower'; this.maxHealth = 4000; this.damage = 1; this.range = 20; this.speed = 0; this.attackCooldown = 600; this.color = '#888888'; }
  update() { return { action: 'idle' }; }
}`;

// A generous tick budget, so a loaded test host never times a tick out (a
// timed-out tick would switch the minions to the built-in logic for it).
const NO_SD = { suddenDeath: { damagePctPerSecond: 0 }, sandbox: { battle: { hardTimeoutMs: 250, softTimeoutMs: 200 } } };

/** One factory (unitId f) for player 0 against a far tower; `factory` is its source. */
async function duel(
  factory: string,
  ticks = 1500,
  extra: object = {},
  opts: { seed?: number; wrap?: (r: PlayerRunner, seat: number) => PlayerRunner; runners?: RunnerFactory; unchecked?: boolean } = {},
) {
  const config = cfg(ticks, { ...NO_SD, ...extra });
  // unchecked: skip the dry run (code the validator would refuse, to test the battle rules).
  const a: Side = { units: [await build(factory, 'f', config, !opts.unchecked)], placements: [at(2, 2, 'f')] };
  const b: Side = { units: [await build(FAR_TOWER, 't', config)], placements: [at(5, 5, 't')] };
  return play([a, b], config, opts.seed ?? 7, opts.wrap, opts.runners);
}

/** Records the TickInputs and TickResults of player 0. */
function recorder() {
  const inputs: TickInput[] = [];
  const results: TickResult[] = [];
  const wrap = (r: PlayerRunner, seat: number): PlayerRunner =>
    seat !== 0
      ? r
      : {
          get player() { return r.player; },
          get loadErrors() { return r.loadErrors; },
          get disposed() { return r.disposed; },
          spawn: (i, u) => r.spawn(i, u),
          tick: async (input) => {
            inputs.push(input);
            const res = await r.tick(input);
            results.push(res);
            return res;
          },
          dispose: () => r.dispose(),
        };
  return { inputs, results, wrap };
}

const minionFrames = (frames: FrameDTO[]) => frames.map((f) => f.units.filter((u) => u[0].includes('-m')));

describe('updateMinion(): what it sees and what it does', () => {
  it('runs once per minion per tick with self = the minion and self.minion facts; its moves are applied', async () => {
    const corner = factorySource('Corner Works', '', `
      updateMinion(self, enemies, allies, world) {
        this.calls = (this.calls || 0) + 1;
        return { action: 'move', destination: { x: 20, y: world.height - 20 } };
      }`);
    const rec = recorder();
    const { frames, result } = await duel(corner, 2400, {}, { wrap: rec.wrap });
    // Every input with minions lists exactly the factory's living minions.
    const withMinions = rec.inputs.filter((i) => i.minions && i.minions.length > 0);
    expect(withMinions.length).toBeGreaterThan(0);
    const v = withMinions[0]!.minions![0]!;
    expect(v).toMatchObject({ type: 'minion', name: 'Grunt', unitId: 'f', factory: null, minion: { kind: 'grunt', factoryId: '0-2-2', order: 'attack', orderTargetId: null } });
    expect(v.minion!.builtIn).toMatchObject({ action: 'move' });
    expect(v.id).toBe('0-2-2-m1');
    // One result per listed minion.
    for (const [k, input] of rec.inputs.entries()) {
      const ids = (input.minions ?? []).map((m) => m.id);
      expect((rec.results[k]!.minions ?? []).map((m) => m.instanceId)).toEqual(ids);
    }
    // The minions walked to the bottom-left corner instead of the built-in rally point (the centre).
    const last = minionFrames(frames).at(-1)!;
    expect(last.length).toBeGreaterThan(0);
    for (const u of last) {
      expect(u[1]).toBeLessThan(120);
      expect(u[2]).toBeGreaterThan(680);
    }
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.errors).toEqual([]);
  }, 60_000);

  it('returning nothing, null or self.minion.builtIn plays exactly like no updateMinion()', async () => {
    const base = await duel(factorySource('Works', '', ''), 1500);
    for (const body of [
      'updateMinion() { return undefined; }',
      'updateMinion() { return null; }',
      'updateMinion(self) { return self.minion.builtIn; }',
    ]) {
      const r = await duel(factorySource('Works', '', body), 1500);
      expect(r.frames, body).toEqual(base.frames);
    }
  }, 60_000);

  it('a factory action (rally, command, release, hold) from updateMinion() is an idle', async () => {
    const idle = await duel(factorySource('Works', '', `updateMinion() { return { action: 'idle' }; }`), 1200);
    const moved = await duel(factorySource('Works', '', ''), 1200);
    expect(idle.frames).not.toEqual(moved.frames);
    for (const act of ["{ action: 'rally', destination: world.center }", "{ action: 'command', order: 'defend' }", "{ action: 'release' }", "{ action: 'hold' }"]) {
      const r = await duel(factorySource('Works', '', `updateMinion(self, enemies, allies, world) { return ${act}; }`), 1200, {}, { unchecked: true });
      expect(r.frames, act).toEqual(idle.frames);
    }
  }, 60_000);

  it('a medic minion heals from updateMinion() (and only when it says so)', async () => {
    const config = cfg(1500, NO_SD);
    // A soldier walks up to a fire tower and gets burnt; the medics follow it.
    const walker = `
export default class S {
  constructor() { this.name = 'Walker'; this.type = 'soldier'; this.maxHealth = 3000; this.damage = 1; this.range = 20; this.speed = 1.5; this.attackCooldown = 600; this.color = '#3399FF'; }
  update(self, enemies) {
    const t = enemies.find((e) => e.type === 'tower');
    if (!t || Math.hypot(t.x - self.x, t.y - self.y) < 200) return { action: 'idle' };
    return { action: 'move', destination: { x: t.x, y: t.y } };
  }
}`;
    const fireTower = `
export default class T {
  constructor() { this.name = 'Burner'; this.type = 'tower'; this.maxHealth = 800; this.damage = 40; this.range = 250; this.speed = 0; this.attackCooldown = 60; this.element = 'fire'; this.color = '#FF3300'; }
  update(self, enemies) {
    const s = enemies.find((e) => e.type === 'soldier' && Math.hypot(e.x - self.x, e.y - self.y) - self.radius - e.radius <= self.range);
    return s && self.cooldownRemaining === 0 ? { action: 'attack', targetId: s.id } : { action: 'idle' };
  }
}`;
    const medics = (heal: boolean) =>
      factorySource('Medic Works', "this.produces = 'medic';", `
      updateMinion(self, enemies, allies, world) {
        const a = allies.find((x) => x.type === 'soldier');
        if (!a) return { action: 'idle' };
        const gap = Math.hypot(a.x - self.x, a.y - self.y) - self.radius - a.radius;
        if (${heal} && gap <= self.support.range && self.cooldownRemaining === 0 && (a.hp < a.maxHp || a.status.burning > 0)) return { action: 'heal', targetId: a.id };
        return gap > 10 ? { action: 'move', destination: { x: a.x, y: a.y } } : { action: 'idle' };
      }`);
    const healed = async (heal: boolean) => {
      const a: Side = { units: [await build(medics(heal), 'f', config), await build(walker, 's', config)], placements: [at(2, 2, 'f'), at(5, 5, 's')] };
      const b: Side = { units: [await build(fireTower, 't', config)], placements: [at(5, 5, 't')] };
      const { result } = await play([a, b], config);
      expect(result.units.find((u) => u.instanceId === '0-2-2')!.errors).toEqual([]);
      return result.units.filter((u) => u.type === 'minion' && u.playerId === 'p0').reduce((n, u) => n + (u.healing ?? 0), 0);
    };
    expect(await healed(true)).toBeGreaterThan(0);
    expect(await healed(false)).toBe(0);
  }, 60_000);
});

describe('updateMinion(): a borrowed Armory factory', () => {
  it('runs in its own sandbox part and still steers its minions', async () => {
    const corner = factorySource('Corner Works', '', `updateMinion(self, enemies, allies, world) { return { action: 'move', destination: { x: 20, y: world.height - 20 } }; }`);
    const config = cfg(2400, NO_SD);
    const f = await build(corner, 'armory:ar_1', config);
    const borrowed: Built = { battle: f.battle, runner: { ...f.runner, unitId: 'armory:ar_1', borrowed: { sourceUnitId: 'corner', creatorId: 'p1' } } };
    const a: Side = { units: [await build(FAR_TOWER, 't', config), borrowed], placements: [at(0, 0, 't'), at(2, 2, 'armory:ar_1')] };
    const b: Side = { units: [await build(FAR_TOWER, 't', config)], placements: [at(5, 5, 't')] };
    const rec = recorder();
    const { frames } = await play([a, b], config, 7, rec.wrap);
    expect(rec.inputs.some((i) => i.minions?.[0]?.unitId === 'armory:ar_1')).toBe(true);
    const last = minionFrames(frames).at(-1)!;
    expect(last.length).toBeGreaterThan(0);
    for (const u of last) expect(u[1]).toBeLessThan(120);
  }, 60_000);
});

describe('updateMinion(): fallback rules', () => {
  it('a throw: that minion uses the built-in logic this tick; 30 error ticks switch the minion code off, the factory keeps working', async () => {
    const thrower = factorySource('Oops Works', '', `updateMinion(self) { throw new Error('boom ' + self.minion.kind); }`);
    const base = await duel(factorySource('Oops Works', '', ''), 1500);
    const rec = recorder();
    const r = await duel(thrower, 1500, {}, { wrap: rec.wrap, unchecked: true });
    // Built-in every tick: the same battle as without the method.
    expect(r.frames).toEqual(base.frames);
    const fac = r.result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(fac.disabled).toBe(false);
    expect(fac.errors[0]).toMatchObject({ tick: 300, message: 'updateMinion() threw for 0-2-2-m1: Error: boom grunt' });
    expect(fac.errors[0]!.line).toBeGreaterThan(0);
    // One strike per tick: ticks 300-329 have errors, then the code is off (no more minion views).
    expect(fac.errors.at(-1)!.message).toMatch(/updateMinion\(\) got confused too many times/);
    expect(fac.errors.at(-1)!.tick).toBe(329);
    expect(rec.inputs.filter((i) => i.minions).length).toBe(30);
    // The factory still built its minions.
    expect(fac.factory!.minionsMade).toBeGreaterThan(1);
  }, 60_000);

  it('an endless loop: the first timeout idles one tick, the second switches the minion code off (not the factory or the player)', async () => {
    const looper = factorySource('Loop Works', '', `updateMinion(self, enemies, allies, world) { if (world.tick >= 400) { while (true) {} } }`);
    const rec = recorder();
    const r = await duel(looper, 900, {}, { wrap: rec.wrap, unchecked: true });
    const fac = r.result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(fac.disabled).toBe(false);
    expect(r.result.players.find((p) => p.playerId === 'p0')!.disabled).toBe(false);
    expect(fac.errors.map((e) => [e.tick, e.message.replace(/ \(.*\)/, '')])).toEqual([
      [400, "Loop Works's updateMinion() took too long once: it was stopped and all units idled this tick."],
      [401, "Loop Works's updateMinion() took too long again, so its minions use their built-in logic for the rest of the battle"],
    ]);
    expect(rec.results.filter((x) => x.status === 'timeout')).toHaveLength(2);
    expect(rec.inputs.slice(-1)[0]!.minions).toBeUndefined();
    // The factory kept giving orders and building after that.
    expect(fac.factory!.minionsMade).toBe(2);
  }, 60_000);

  it('a destroyed factory: its minions go back to the built-in logic', async () => {
    // The factory's own update() never runs again once it is gone, so no minion views either.
    const corner = factorySource('Corner Works', '', `updateMinion(self, enemies, allies, world) { return { action: 'move', destination: { x: 20, y: 20 } }; }`);
    const config = cfg(1200, NO_SD);
    const rec = recorder();
    // A tower keeps player 0's sandbox ticking after the factory is gone.
    const a: Side = { units: [await build(corner, 'f', config), await build(FAR_TOWER, 't', config)], placements: [at(2, 2, 'f'), at(0, 0, 't')] };
    const b: Side = { units: [await build(FAR_TOWER, 't', config)], placements: [at(5, 5, 't')] };
    // The host option 'Factories die at sudden death' destroys it at tick 700.
    const cfg2 = deepMerge(config, { factory: { dieAtSuddenDeath: true }, suddenDeath: { startTick: 700 } });
    const { result } = await play([a, b], cfg2, 7, rec.wrap);
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.diedAtTick).toBe(701); // completed ticks: it falls in tick 700
    expect(result.units.some((u) => u.type === 'minion' && u.diedAtTick === null)).toBe(true);
    const after = rec.inputs.filter((i) => i.tick > 700);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((i) => !i.minions)).toBe(true);
    const before = rec.inputs.filter((i) => i.tick > 300 && i.tick < 700);
    expect(before.every((i) => (i.minions?.length ?? 0) > 0)).toBe(true);
  }, 60_000);
});

describe('updateMinion(): one sandbox call per player per tick', () => {
  it('a player with 2 minion-code factories and 8 minions still makes exactly one tick call per tick', async () => {
    let tickCalls = 0;
    const counting: SessionOpener = async (opts) => {
      const s = await vmSessionOpener(opts);
      const wrapped: SandboxSession = {
        get disposed() { return s.disposed; },
        load: (...a) => s.load(...a),
        call: (fn, args, t, o) => {
          if (fn === 'tick') tickCalls++;
          return s.call(fn, args, t, o);
        },
        dispose: () => s.dispose(),
      };
      return wrapped;
    };
    const runners: RunnerFactory = {
      mode: 'inproc-unsafe',
      create: (player, units, limits) => SessionPlayerRunner.create(counting, player, units, limits),
    };
    const factory = factorySource('Busy Works', '', `
      updateMinion(self, enemies, allies, world) {
        let best = null, d = Infinity;
        for (const e of enemies) { const g = Math.hypot(e.x - self.x, e.y - self.y); if (g < d) { d = g; best = e; } }
        return best ? { action: 'move', destination: { x: best.x, y: best.y } } : undefined;
      }`);
    const config = cfg(1500, NO_SD);
    const a: Side = { units: [await build(factory, 'f', config)], placements: [at(2, 2, 'f'), at(3, 3, 'f')] };
    const b: Side = { units: [await build(FAR_TOWER, 't', config)], placements: [at(5, 5, 't')] };
    const rec = recorder();
    const r = await play([a, b], config, 7, rec.wrap, runners);
    expect(Math.max(...rec.inputs.map((i) => i.minions?.length ?? 0))).toBe(8);
    // Two players, one call each per tick (both act every tick).
    expect(tickCalls).toBe(2 * r.result.endTick);
  }, 60_000);
});

describe('updateMinion(): determinism', () => {
  it('the same seed replays the same battle (Math.random in updateMinion is the seeded one)', async () => {
    const wobbly = factorySource('Wobbly Works', "this.produces = 'runner';", `
      updateMinion(self, enemies, allies, world) {
        if (Math.random() < 0.5) return undefined;
        return { action: 'move', destination: { x: Math.random() * world.width, y: Math.random() * world.height } };
      }`);
    const x = await duel(wobbly, 1500, {}, { seed: 11 });
    const y = await duel(wobbly, 1500, {}, { seed: 11 });
    const z = await duel(wobbly, 1500, {}, { seed: 12 });
    expect(y.frames).toEqual(x.frames);
    expect(z.frames).not.toEqual(x.frames);
  }, 60_000);

  it('isolated-vm and node:vm play the same battle', async () => {
    const hunter = factorySource('Hunt Works', "this.produces = 'archer'; this.burst = 2;", `
      updateMinion(self, enemies, allies, world) {
        for (const e of enemies) {
          if (Math.hypot(e.x - self.x, e.y - self.y) - self.radius - e.radius <= self.range && self.cooldownRemaining === 0) return { action: 'attack', targetId: e.id };
        }
        return { action: 'move', destination: { x: world.width - 40, y: world.height - 40 } };
      }`);
    const vm = await duel(hunter, 1500);
    const ivm = await duel(hunter, 1500, {}, { runners: createIvmRunnerFactory() });
    expect(ivm.frames).toEqual(vm.frames);
  }, 120_000);
});

describe('parseTickOutput: minion entries are checked like unit entries', () => {
  it('drops entries for minions of another factory, unknown minions and duplicates (forged)', () => {
    const minions = [
      { id: '0-1-1-m1', minion: { factoryId: '0-1-1' } },
      { id: '0-2-2-m1', minion: { factoryId: '0-2-2' } },
    ] as never[];
    const raw = JSON.stringify([
      {
        instanceId: '0-1-1',
        action: { action: 'idle' },
        ms: 0,
        mms: 1,
        minions: [
          { instanceId: '0-1-1-m1', action: { action: 'idle' } },
          { instanceId: '0-1-1-m1', action: { action: 'idle' } },
          { instanceId: '0-2-2-m1', action: { action: 'idle' } },
          { instanceId: '9-9-9-m1', action: { action: 'idle' } },
          { instanceId: '0-1-1-m1x', error: { message: 'x' } },
        ],
      },
    ]);
    const p = parseTickOutput(raw, [{ id: '0-1-1' }], minions);
    expect(p.minions).toEqual([{ instanceId: '0-1-1-m1', factoryId: '0-1-1', action: { action: 'idle' } }]);
    expect(p.forged).toBe(4);
    expect(p.outputs[0]).toMatchObject({ instanceId: '0-1-1', mms: 1 });
  });
});

// ---------------------------------------------------------------------------
// Validation (§7 dry run)
// ---------------------------------------------------------------------------

describe('validation: updateMinion() is dry-run like update()', () => {
  const check = async (source: string) => (await validateDetailed(source, {}, DEFAULT_CONFIG)).result;

  it('a good updateMinion() passes with no new warnings; the starter factory validates exactly as before', async () => {
    const good = await check(factorySource('Good Works', "this.produces = 'archer';", `
      updateMinion(self, enemies, allies, world) {
        if (self.type !== 'minion' || self.factory !== null || self.minion.kind !== 'archer') throw new Error('wrong self');
        if (!allies.some((a) => a.id === self.minion.factoryId)) throw new Error('no factory in allies');
        if (allies.some((a) => a.id === self.id)) throw new Error('self in allies');
        const e = enemies.find((x) => x.type !== 'wall' && Math.hypot(x.x - self.x, x.y - self.y) - self.radius - x.radius <= self.range);
        if (e && self.cooldownRemaining === 0) return { action: 'attack', targetId: e.id };
        return self.minion.builtIn;
      }`));
    expect(good.ok, JSON.stringify(good)).toBe(true);
    expect(good.warnings.map((w) => w.code)).not.toContain('W_ACTION_NOT_FOR_TYPE');
    const kitFactory = await check(FACTORY);
    expect(kitFactory.ok).toBe(true);
  }, 30_000);

  it('a throw is UPDATE_THREW on field updateMinion, with its line', async () => {
    const r = await check(factorySource('Oops Works', '', `
      updateMinion(self, enemies) {
        return { action: 'attack', targetId: enemies[0].id };
      }`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ code: 'UPDATE_THREW', field: 'updateMinion', line: 15 });
    expect(r.errors[0]!.message).toMatch(/updateMinion\(\) threw an error on line 15 for a practice minion \(no enemies\)/);
  }, 30_000);

  it('a bad return value is BAD_ACTION; a Promise too; undefined and null are fine', async () => {
    const bad = await check(factorySource('Bad Works', '', `updateMinion() { return { action: 'walk' }; }`));
    expect(!bad.ok && bad.errors[0]).toMatchObject({ code: 'BAD_ACTION', field: 'updateMinion' });
    const promise = await check(factorySource('Async Works', '', `async updateMinion() { return { action: 'idle' }; }`));
    expect(!promise.ok && promise.errors[0]).toMatchObject({ code: 'BAD_ACTION', field: 'updateMinion', value: 'Promise' });
    for (const ret of ['undefined', 'null']) {
      const r = await check(factorySource('Quiet Works', '', `updateMinion() { return ${ret}; }`));
      expect(r.ok, ret).toBe(true);
    }
  }, 30_000);

  it('an endless loop is UPDATE_TIMEOUT on field updateMinion', async () => {
    const r = await check(factorySource('Loop Works', '', `updateMinion() { while (true) {} }`));
    expect(!r.ok && r.errors[0]).toMatchObject({ code: 'UPDATE_TIMEOUT', field: 'updateMinion' });
  }, 30_000);

  it('a factory action from updateMinion() warns W_ACTION_NOT_FOR_TYPE; updateMinion() on a soldier warns W_MINION_IGNORED', async () => {
    const r = await check(factorySource('Order Works', '', `updateMinion() { return { action: 'command', order: 'defend' }; }`));
    expect(r.ok).toBe(true);
    expect(r.warnings.find((w) => w.code === 'W_ACTION_NOT_FOR_TYPE')).toMatchObject({ field: 'updateMinion', value: 'command' });
    const soldier = SOLDIER.replace(/\n {2}sprite\(\) \{/, "\n  updateMinion() { return { action: 'idle' }; }\n  sprite() {");
    expect(soldier).toContain('updateMinion');
    const s = await check(soldier);
    expect(s.ok).toBe(true);
    expect(s.warnings.map((w) => w.code)).toContain('W_MINION_IGNORED');
  }, 30_000);
});
