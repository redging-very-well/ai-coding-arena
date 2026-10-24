// "Show enemy names to units" (plan §9.1a, §5) in the sim and the sandbox:
//   * off (the default): views are exactly as before (no ownerName, teamName
//     or world.players keys) and the frames are identical;
//   * on: every body carries its player's name (minions: the factory's
//     player), team mode adds teamName, world.players lists the players;
//   * names cross the real sandbox boundary, and a unit that targets a named
//     player works;
//   * a borrowed Armory part sees the same id swap in world.players as in
//     ownerId, with the names untouched.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mapFor, parseConfig, type GameConfig, type OtherView, type PlacementDTO, type StatsSnapshot } from '@pixel-clash/shared';
import { createInprocRunnerFactory } from '../packages/server/src/sandbox/inprocRunner.js';
import { runnerLimitsFromConfig, type PlayerRunner, type RunnerFactory, type TickInput, type TickResult } from '../packages/server/src/sandbox/runner.js';
import { encodeTickInput } from '../packages/server/src/sandbox/session.js';
import { createSplitRunner } from '../packages/server/src/sandbox/splitRunner.js';
import { BattleEngine, runBattle, type BattlePlayerSetup } from '../packages/server/src/sim/engine.js';
import { normalizeSource } from '../packages/server/src/validator/normalize.js';
import { transpile } from '../packages/server/src/validator/transpile.js';
import { design, fakePlayers, idleBrain, scripted, soldierBrain, stats, towerBrain, type FakePlayerSpec } from './helpers/fakeRunner.js';

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

function cfg(battleTicks = 600): GameConfig {
  return parseConfig({ timers: { battleTicks }, suddenDeath: { startTick: 100_000, endTick: 100_001 } });
}

const NAMES: Record<string, string> = { a: 'Ninja Sam', b: 'Bob', c: 'Carol', d: 'Dee' };
const named = (setups: BattlePlayerSetup[], teamNames?: Record<number, string>): BattlePlayerSetup[] =>
  setups.map((s) => ({ ...s, name: NAMES[s.playerId]!, ...(teamNames && s.teamId !== undefined ? { teamName: teamNames[s.teamId]! } : {}) }));

const NAME_KEYS = ['ownerName', 'teamName'];
const hasNameKeys = (o: OtherView) => NAME_KEYS.some((k) => k in o);

const TOWER = stats({ type: 'tower', name: 'Post', maxHealth: 2500, damage: 5 });

function duel(brains: FakePlayerSpec['brains'] = { t: idleBrain }): FakePlayerSpec[] {
  return [
    { playerId: 'a', seat: 0, zone: 'TL', units: [design('t', TOWER)], placements: [at(0, 0, 't'), at(1, 0, 't')], brains },
    { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains },
  ];
}

describe('views with "Show enemy names to units" off (default)', () => {
  it('bodies and world carry no name fields, omitted or explicitly false', async () => {
    for (const revealNames of [undefined, false]) {
      const { setups, runners } = fakePlayers(duel());
      runners.get('a')!.recordInputs = true;
      await runBattle({ players: named(setups), config: cfg(2), seed: 1, ...(revealNames === undefined ? {} : { revealNames }) });
      const input = runners.get('a')!.inputs[0]!;
      expect(input.enemies.length).toBe(1);
      expect(input.allies.length).toBe(2);
      expect([...input.enemies, ...input.allies].some(hasNameKeys)).toBe(false);
      expect('players' in input.world).toBe(false);
      // The wire format has no trace of them either.
      expect(encodeTickInput(input)).not.toMatch(/ownerName|teamName|players|Ninja Sam|Bob/);
    }
  });

  it('frames are identical with the setting off, on (names unread) and omitted', async () => {
    const army = (): FakePlayerSpec[] => [
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', stats({ type: 'soldier' })), design('t', TOWER)], placements: [at(0, 0, 's'), at(1, 0, 's'), at(2, 2, 't')], brains: { s: soldierBrain, t: towerBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', stats({ type: 'soldier' }))], placements: [at(0, 0, 's'), at(0, 1, 's'), at(1, 1, 's')], brains: { s: soldierBrain } },
    ];
    const run = async (revealNames?: boolean) => {
      const { setups } = fakePlayers(army(), 3);
      const r = await runBattle({ players: named(setups), config: cfg(900), seed: 7, ...(revealNames === undefined ? {} : { revealNames }) });
      return JSON.stringify({ frames: r.frames, ranking: r.ranking, units: r.units });
    };
    const base = await run();
    expect(await run(false)).toBe(base);
    expect(await run(true)).toBe(base);
    expect(await run(true)).toBe(base);
  });
});

describe('views with "Show enemy names to units" on', () => {
  it('free-for-all: ownerName on every body, no teamName, world.players with seats as teamIds', async () => {
    const { setups, runners } = fakePlayers(duel());
    runners.get('a')!.recordInputs = true;
    await runBattle({ players: named(setups), config: cfg(2), seed: 1, revealNames: true });
    const input = runners.get('a')!.inputs[0]!;
    expect(input.enemies.map((o) => [o.ownerId, o.ownerName])).toEqual([['b', 'Bob']]);
    expect(input.allies.map((o) => [o.ownerId, o.ownerName])).toEqual([
      ['a', 'Ninja Sam'],
      ['a', 'Ninja Sam'],
    ]);
    expect([...input.enemies, ...input.allies].some((o) => 'teamName' in o)).toBe(false);
    expect(input.world.players).toEqual([
      { id: 'a', name: 'Ninja Sam', teamId: 0 },
      { id: 'b', name: 'Bob', teamId: 1 },
    ]);
    // SelfView is unchanged.
    expect(input.selves.some((s) => 'ownerName' in s)).toBe(false);
  });

  it('a player without a name shows its id', async () => {
    const { setups, runners } = fakePlayers(duel());
    runners.get('b')!.recordInputs = true;
    await runBattle({ players: setups, config: cfg(2), seed: 1, revealNames: true });
    const input = runners.get('b')!.inputs[0]!;
    expect(input.enemies.every((o) => o.ownerName === 'a')).toBe(true);
    expect(input.world.players!.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it("team mode: teamName on every body and in world.players", async () => {
    const corners = mapFor('corners', 4);
    const t = design('t', TOWER);
    const specs: FakePlayerSpec[] = [
      { playerId: 'a', seat: 0, teamId: 0, zone: corners.zones[0]!, units: [t], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      { playerId: 'b', seat: 1, teamId: 1, zone: corners.zones[2]!, units: [t], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      { playerId: 'c', seat: 2, teamId: 1, zone: corners.zones[3]!, units: [t], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      { playerId: 'd', seat: 3, teamId: 0, zone: corners.zones[1]!, units: [t], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
    ];
    const { setups, runners } = fakePlayers(specs);
    runners.get('a')!.recordInputs = true;
    await runBattle({ players: named(setups, { 0: 'Team 1', 1: 'Team 2' }), map: corners, config: cfg(2), seed: 1, revealNames: true });
    const input = runners.get('a')!.inputs[0]!;
    expect(input.enemies.map((o) => [o.ownerName, o.teamId, o.teamName])).toEqual([
      ['Bob', 1, 'Team 2'],
      ['Carol', 1, 'Team 2'],
    ]);
    expect(input.allies.map((o) => [o.ownerName, o.teamName])).toEqual([
      ['Ninja Sam', 'Team 1'],
      ['Dee', 'Team 1'],
    ]);
    expect(input.world.players).toEqual([
      { id: 'a', name: 'Ninja Sam', teamId: 0, teamName: 'Team 1' },
      { id: 'b', name: 'Bob', teamId: 1, teamName: 'Team 2' },
      { id: 'c', name: 'Carol', teamId: 1, teamName: 'Team 2' },
      { id: 'd', name: 'Dee', teamId: 0, teamName: 'Team 1' },
    ]);
  });

  it("a minion carries its factory's player", async () => {
    const factory = stats({ type: 'factory', productionInterval: 300 });
    const hold = scripted((_s, _e, _a, world) => ({ action: 'rally', destination: world.myCorner }));
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', factory)], placements: [at(2, 2, 'f')], brains: { f: hold } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
    ]);
    runners.get('b')!.recordInputs = true;
    runners.get('a')!.recordInputs = true;
    await runBattle({ players: named(setups), config: cfg(400), seed: 1, revealNames: true });
    const late = runners.get('b')!.inputs.at(-1)!;
    const minions = late.enemies.filter((o) => o.type === 'minion');
    expect(minions.length).toBeGreaterThan(0);
    for (const m of minions) expect([m.ownerId, m.ownerName]).toEqual(['a', 'Ninja Sam']);
    const own = runners.get('a')!.inputs.at(-1)!.allies.filter((o) => o.type === 'minion');
    expect(own.length).toBeGreaterThan(0);
    for (const m of own) expect(m.ownerName).toBe('Ninja Sam');
  });

  it('world.players is one array per battle and its JSON lands in every world', async () => {
    const { setups } = fakePlayers(duel());
    const engine = new BattleEngine({ players: named(setups), config: cfg(3), seed: 1, revealNames: true });
    const seen: Array<TickInput['world']> = [];
    for (const s of setups) {
      const inner = s.runner;
      const tick = inner.tick.bind(inner);
      inner.tick = (input: TickInput) => {
        seen.push(input.world);
        return tick(input);
      };
    }
    await engine.run();
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen.map((w) => w.players)).size).toBe(1);
    const encoded = JSON.parse(encodeTickInput({ nowMs: 0, selves: [], enemies: [], allies: [], world: seen[0]! })) as { worldJson: string };
    expect(JSON.parse(encoded.worldJson)).toEqual(seen[0]);
  });
});

// ---------------------------------------------------------------------------
// Real sandbox: names cross the isolate boundary and code can use them.
// ---------------------------------------------------------------------------

async function compile(source: string): Promise<string> {
  const n = normalizeSource(source, 20480);
  if (!n.ok) throw new Error(n.error.message);
  const t = await transpile(n.source);
  if (!t.ok) throw new Error(t.error.message);
  return t.compiledJs;
}

const HUNTER = `
export default class Unit {
  constructor() {
    this.name = 'Hunter';
    this.type = 'soldier';
    this.maxHealth = 600;
    this.damage = 50;
    this.range = 40;
    this.speed = 5;
    this.attackCooldown = 10;
    this.color = '#FF0000';
  }
  update(self, enemies, allies, world) {
    const carol = (world.players || []).find((p) => p.name === 'Carol');
    const target = carol && enemies.find((e) => e.ownerName === 'Carol' && e.ownerId === carol.id);
    if (!target) return { action: 'idle' };
    const gap = Math.hypot(target.x - self.x, target.y - self.y) - self.radius - target.radius;
    if (gap <= self.range) return { action: 'attack', targetId: target.id };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  }
}
`;

const SITTER = `
export default class Unit {
  constructor() {
    this.name = 'Sitter';
    this.type = 'tower';
    this.maxHealth = 2500;
    this.damage = 5;
    this.range = 20;
    this.attackCooldown = 60;
    this.color = '#00FF00';
  }
  update() { return { action: 'idle' }; }
}
`;

describe('a unit that targets a named player (real sandbox)', () => {
  const hunter = stats({ type: 'soldier', name: 'Hunter', maxHealth: 600, damage: 50, range: 40, speed: 5, attackCooldown: 10 });
  const sitter = stats({ type: 'tower', name: 'Sitter', maxHealth: 2500, damage: 5, range: 20, attackCooldown: 60 });

  async function battle(revealNames: boolean) {
    const factory: RunnerFactory = createInprocRunnerFactory({ unsafe: true });
    const limits = runnerLimitsFromConfig(DEFAULT_CONFIG.sandbox);
    const players = [
      { playerId: 'p_hunt', seat: 0, zone: 'TL' as const, name: 'Ninja Sam', units: [design('hunter', hunter)], source: HUNTER, unitId: 'hunter' },
      { playerId: 'p_bob', seat: 1, zone: 'TR' as const, name: 'Bob', units: [design('sitter', sitter)], source: SITTER, unitId: 'sitter' },
      { playerId: 'p_carol', seat: 2, zone: 'BR' as const, name: 'Carol', units: [design('sitter', sitter)], source: SITTER, unitId: 'sitter' },
    ];
    const setups: BattlePlayerSetup[] = [];
    for (const p of players) {
      const runner = await factory.create({ playerId: p.playerId, seat: p.seat, seed: 10 + p.seat }, [{ unitId: p.unitId, compiledJs: await compile(p.source), stats: p.units[0]!.stats as StatsSnapshot }], limits);
      setups.push({ playerId: p.playerId, seat: p.seat, zone: p.zone, name: p.name, units: p.units, placements: [at(0, 0, p.unitId)], runner });
    }
    return runBattle({ players: setups, config: cfg(900), seed: 3, revealNames, yieldEveryTicks: 0 });
  }

  it('on: the hunter finds Carol by name and hits only her units', async () => {
    const r = await battle(true);
    const hpOf = (playerId: string) => r.units.find((u) => u.playerId === playerId)!.hp;
    expect(r.units.find((u) => u.playerId === 'p_hunt')!.damageDealt).toBeGreaterThan(0);
    expect(hpOf('p_carol')).toBeLessThan(2500);
    expect(hpOf('p_bob')).toBe(2500);
    expect(r.units.every((u) => u.errors.length === 0)).toBe(true);
  }, 60_000);

  it('off: the same code sees no names and never attacks', async () => {
    const r = await battle(false);
    expect(r.units.find((u) => u.playerId === 'p_hunt')!.damageDealt).toBe(0);
    expect(r.units.every((u) => u.errors.length === 0)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Borrowed Armory parts (sandbox/splitRunner.ts)
// ---------------------------------------------------------------------------

describe('a borrowed Armory part sees world.players with the same id swap as ownerId', () => {
  it('ids swap, names stay with their bodies', async () => {
    const seen = new Map<string, TickInput>();
    const factory: RunnerFactory = {
      mode: 'inproc-unsafe',
      async create(_player, units): Promise<PlayerRunner> {
        const key = units.map((u) => u.unitId).join(',');
        return {
          loadErrors: new Map(),
          disposed: false,
          spawn: async () => ({ ok: true }),
          tick: async (input: TickInput): Promise<TickResult> => {
            seen.set(key, input);
            return { status: 'ok', outputs: [], elapsedMs: 0, slow: false, forged: 0 };
          },
          dispose: () => {},
        } as unknown as PlayerRunner;
      },
    };
    const limits = runnerLimitsFromConfig(DEFAULT_CONFIG.sandbox);
    const runner = await createSplitRunner(
      factory,
      { playerId: 'bob', seat: 1, seed: 1 },
      [
        { unitId: 'own', compiledJs: '', stats: TOWER },
        { unitId: 'armory:ar_1', compiledJs: '', stats: TOWER, borrowed: { sourceUnitId: 'ogre', creatorId: 'sam' } },
      ],
      limits,
    );
    await runner.spawn('1-0-0', 'own');
    await runner.spawn('1-1-0', 'armory:ar_1');
    const body = (id: string, ownerId: string, ownerName: string) => ({ id, ownerId, ownerName }) as unknown as OtherView;
    const input = {
      tick: 0,
      nowMs: 0,
      selves: [
        { id: '1-0-0', unitId: 'own', ownerId: 'bob' },
        { id: '1-1-0', unitId: 'armory:ar_1', ownerId: 'bob' },
      ],
      enemies: [body('0-0-0', 'sam', 'Ninja Sam')],
      allies: [body('1-0-0', 'bob', 'Bob'), body('1-1-0', 'bob', 'Bob')],
      world: {
        players: [
          { id: 'sam', name: 'Ninja Sam', teamId: 0 },
          { id: 'bob', name: 'Bob', teamId: 1 },
        ],
      },
    } as unknown as TickInput;
    await runner.tick(input);
    const own = seen.get('own')!;
    expect(own.world.players).toEqual(input.world.players);
    const part = seen.get('ogre')!;
    expect(part.selves.map((s) => [s.unitId, s.ownerId])).toEqual([['ogre', 'sam']]);
    expect(part.enemies.map((o) => [o.ownerId, o.ownerName])).toEqual([['bob', 'Ninja Sam']]);
    expect(part.allies.map((o) => [o.ownerId, o.ownerName])).toEqual([
      ['sam', 'Bob'],
      ['sam', 'Bob'],
    ]);
    // The same mapping: each id still names the bodies that carry it.
    expect(part.world.players).toEqual([
      { id: 'bob', name: 'Ninja Sam', teamId: 0 },
      { id: 'sam', name: 'Bob', teamId: 1 },
    ]);
    runner.dispose();
  });
});
