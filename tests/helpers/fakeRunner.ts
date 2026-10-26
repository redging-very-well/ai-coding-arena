// A plain-JS stand-in for the sandbox runners (tests only).
//
// It implements the Runner interface from packages/server/src/sandbox/runner.ts
// without any isolate: each design is a "brain" factory, one brain object is
// constructed per spawned instance (so `this` state persists like in player
// code), and update() is called with fresh deep copies of the inputs, with
// the unit itself removed from `allies`, exactly like the real harness.
// A `hook` can replace a whole tick's result to simulate timeouts, crashes,
// slow ticks or forged output.

import {
  DEFAULT_CONFIG,
  computeCost,
  type GameConfig,
  type OtherView,
  type SelfView,
  type StatsSnapshot,
  type UnitStats,
  type WorldView,
} from '@pixel-clash/shared';
import type {
  PlayerRunner,
  RunnerFactory,
  RunnerPlayer,
  RunnerUnitDesign,
  SpawnResult,
  TickInput,
  TickResult,
  UnitOutput,
} from '../../packages/server/src/sandbox/runner.js';
import type { BattlePlayerSetup, BattleUnitDesign } from '../../packages/server/src/sim/engine.js';
import type { PlacementDTO, ZoneRef } from '@pixel-clash/shared';

export interface Brain {
  update(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView): unknown;
}
export type BrainFactory = () => Brain;

/** Optional per-tick override: return a TickResult to use instead of running the brains. */
export type TickHook = (input: TickInput, runner: FakePlayerRunner) => TickResult | undefined;

export class FakePlayerRunner implements PlayerRunner {
  readonly loadErrors = new Map<string, { message: string; line?: number }>();
  private readonly instances = new Map<string, Brain>();
  private _disposed = false;
  /** Every TickInput this runner received (handy for assertions). */
  readonly inputs: TickInput[] = [];
  recordInputs = false;

  constructor(
    readonly player: RunnerPlayer,
    private readonly brains: Readonly<Record<string, BrainFactory>>,
    private readonly hook?: TickHook,
  ) {}

  get disposed(): boolean {
    return this._disposed;
  }

  async spawn(instanceId: string, unitId: string): Promise<SpawnResult> {
    const make = this.brains[unitId];
    if (!make) return { ok: false, error: { message: `unknown unit ${unitId}` } };
    try {
      this.instances.set(instanceId, make());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  }

  async tick(input: TickInput): Promise<TickResult> {
    if (this._disposed) return { status: 'crashed', outputs: [], elapsedMs: 0, slow: false, forged: 0, detail: 'disposed' };
    if (this.recordInputs) this.inputs.push(structuredClone(input));
    const hooked = this.hook?.(input, this);
    if (hooked) {
      if (hooked.status === 'crashed') this.dispose();
      return hooked;
    }
    const outputs: UnitOutput[] = [];
    for (const self of input.selves) {
      const brain = this.instances.get(self.id);
      if (!brain) continue;
      try {
        const action = brain.update(
          structuredClone(self),
          structuredClone(input.enemies),
          structuredClone(input.allies.filter((a) => a.id !== self.id)),
          structuredClone(input.world),
        );
        // JSON round-trip, like the real boundary (functions/Promises vanish).
        outputs.push({ instanceId: self.id, action: action === undefined ? undefined : JSON.parse(JSON.stringify(action)) });
      } catch (err) {
        outputs.push({ instanceId: self.id, error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }
    return { status: 'ok', outputs, elapsedMs: 0, slow: false, forged: 0 };
  }

  dispose(): void {
    this._disposed = true;
  }
}

export class FakeRunnerFactory implements RunnerFactory {
  readonly mode = 'inproc-unsafe' as const;
  constructor(
    private readonly brains: Readonly<Record<string, BrainFactory>>,
    private readonly hook?: TickHook,
  ) {}
  async create(player: RunnerPlayer, _units: readonly RunnerUnitDesign[]): Promise<PlayerRunner> {
    return new FakePlayerRunner(player, this.brains, this.hook);
  }
}

// ---------------------------------------------------------------------------
// Brains (template-like logic, mirroring packages/starter-kit/units/*.js)
// ---------------------------------------------------------------------------

const gap = (a: { x: number; y: number; radius: number }, b: { x: number; y: number; radius: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;

/** basic_soldier.js: chase the nearest enemy, attack when in range and ready. */
export const soldierBrain: BrainFactory = () => ({
  update(self, enemies, _allies, world) {
    if (enemies.length === 0) return { action: 'move', destination: world.center };
    let target = enemies[0]!;
    let best = Infinity;
    for (const e of enemies) {
      const g = gap(self, e);
      if (g < best) {
        best = g;
        target = e;
      }
    }
    if (best <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: target.id } : { action: 'idle' };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  },
});

/** basic_tower.js: shoot the nearest enemy in range. */
export const towerBrain: BrainFactory = () => ({
  update(self, enemies) {
    if (self.cooldownRemaining > 0) return { action: 'idle' };
    let target: OtherView | null = null;
    let best = Infinity;
    for (const e of enemies) {
      const g = gap(self, e);
      if (g <= self.range && g < best) {
        best = g;
        target = e;
      }
    }
    return target ? { action: 'attack', targetId: target.id } : { action: 'idle' };
  },
});

export const idleBrain: BrainFactory = () => ({ update: () => ({ action: 'idle' }) });

/** A brain from a plain function (no per-instance state needed). */
export const scripted =
  (fn: Brain['update']): BrainFactory =>
  () => ({ update: fn });

// ---------------------------------------------------------------------------
// Stats and battle-setup helpers
// ---------------------------------------------------------------------------

/**
 * Test stats at the M8.8 ×5 scale: the Basic Soldier (600 HP, 50 damage), a
 * tower with the old 180 range (750 HP, 75 damage: today's Basic Tower ×5,
 * so the M8.7 geometry of these tests holds), the Basic Wall (2000 HP) and
 * the Basic Factory (225 HP: 1500 before the brittle factories, same price). The sim is scale-invariant (sudden death is a
 * percentage), so the battles play exactly like their ×1 originals.
 */
export function stats(over: Partial<Omit<StatsSnapshot, 'type'>> & Pick<UnitStats, 'type'>): StatsSnapshot {
  if (over.type === 'wall' || over.type === 'factory') {
    // Buildings: no attack, no move, fixed size.
    const b: StatsSnapshot =
      over.type === 'wall'
        ? { name: 'Basic Wall', type: 'wall', maxHealth: 2000, damage: 0, range: 0, speed: 0, attackCooldown: 0, color: '#8A8F98', size: 20, shape: 'square' }
        : { name: 'Basic Factory', type: 'factory', maxHealth: 225, damage: 0, range: 0, speed: 0, attackCooldown: 0, productionInterval: 900, color: '#C0A060', size: 18, shape: 'square' };
    return Object.freeze({ ...b, ...over, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: b.size }) as StatsSnapshot;
  }
  const base: StatsSnapshot =
    over.type === 'tower'
      ? { name: 'Basic Tower', type: 'tower', maxHealth: 750, damage: 75, range: 180, speed: 0, attackCooldown: 45, color: '#FF9933', size: 14, shape: 'square' }
      : { name: 'Basic Soldier', type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, color: '#3399FF', size: 10, shape: 'circle' };
  return Object.freeze({ ...base, ...over }) as StatsSnapshot;
}

export const SOLDIER = stats({ type: 'soldier' });
export const TOWER = stats({ type: 'tower' });

export function design(unitId: string, s: StatsSnapshot, cost?: number, config: GameConfig = DEFAULT_CONFIG): BattleUnitDesign {
  return { unitId, stats: s, cost: cost ?? computeCost(s, config.cost).cost };
}

export interface FakePlayerSpec {
  playerId: string;
  seat: number;
  /** A Corner of the 800 Corners map, or a zone of any map. */
  zone: ZoneRef;
  /** Team mode: give it to every player or to none. */
  teamId?: number;
  units: BattleUnitDesign[];
  placements: PlacementDTO[];
  brains: Record<string, BrainFactory>;
  hook?: TickHook;
}

/** Build engine player setups with a FakePlayerRunner each (seed = battleSeed + seat). */
export function fakePlayers(specs: FakePlayerSpec[], battleSeed = 1): { setups: BattlePlayerSetup[]; runners: Map<string, FakePlayerRunner> } {
  const runners = new Map<string, FakePlayerRunner>();
  const setups = specs.map((s) => {
    const runner = new FakePlayerRunner({ playerId: s.playerId, seat: s.seat, seed: battleSeed + s.seat }, s.brains, s.hook);
    runners.set(s.playerId, runner);
    return { playerId: s.playerId, seat: s.seat, zone: s.zone, ...(s.teamId !== undefined ? { teamId: s.teamId } : {}), units: s.units, placements: s.placements, runner };
  });
  return { setups, runners };
}
