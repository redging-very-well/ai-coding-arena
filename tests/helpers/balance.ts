// Balance harness (plan §14 balance.test.ts, §6 "no single archetype
// dominates", §9 sudden death). Headless battles between $5,000 archetype
// armies with simple "chase nearest" bots, on real §9.2 maps.
//
// The runner here is a lean stand-in for the sandbox (no isolates, no deep
// copies: the brains never mutate their inputs), so a full 5400-tick battle
// takes tens of milliseconds and the test can afford a round robin over
// several maps, zone pairs and seeds (M8.8: `playPairs` shares the pairs out
// over worker processes). `npx tsx --conditions=source
// scripts/balance-matrix.ts` prints the same matrix for docs/balance.md.
//
// M8.5: the brains follow the wall-aware templates (skip walls as targets,
// smash an enemy wall after 120 ticks blocked; factories rally on the
// nearest enemy that isn't a wall), and BUILDING_ARCHETYPES add walls and
// factories. Walls run no code (the engine never asks the runner for them);
// minions run the engine's built-in AI.
//
// M8.6: KIND_ARCHETYPES field the minion kinds (archers, runners, brutes) and
// the squad orders and bursts (§5.3); their factories use the order brain
// named by `factoryBrain` (the CLAUDE.md examples: guard a tower, swarm the
// weakest enemy, swarm the nearest enemy wall, defend).
//
// M8.8 (elements, splash, support, ×5 economy; plan §14 "M8.8 balance"):
// every archetype is refit to the M8.8 prices on the DEFAULT config ($5,000
// budget, $2,500 cap): the M8.7 armies at ×5 with copies dropped until they
// fit, the specialist archetypes of §6 (Huge Tanks, Glass Cannons, Max
// Snipers, the HP-padded scout swarm) and the element and support armies of
// §6 "M8.8 example armies". The brains follow the CLAUDE.md templates: medics
// cleanse first, then heal the lowest hp fraction in reach; aura units follow
// the nearest fighting ally; fire prefers frozen targets; splash picks the
// enemy with the most other enemies round it.

import { availableParallelism } from 'node:os';
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  deepMerge,
  computeCost,
  copiesCost,
  pricingOf,
  mapFor,
  zoneCentredOnLine,
  GRID_SIZE,
  type Cell,
  type Element,
  type Facing,
  type FrameDTO,
  type GameConfig,
  type MapLayout,
  type MapStyle,
  type MapZone,
  type MinionKind,
  type PlacementDTO,
  type StatsSnapshot,
  type SupportView,
  type UnitStats,
} from '@pixel-clash/shared';
import type { PlayerRunner, RunnerPlayer, SpawnResult, TickInput, TickResult, UnitOutput } from '../../packages/server/src/sandbox/runner.js';
import { runBattle, type BattlePlayerSetup, type BattleResult, type BattleUnitDesign } from '../../packages/server/src/sim/engine.js';
import { frontCells } from '../../packages/server/src/sim/autoPlace.js';
import { mulberry32 } from '../../packages/server/src/sim/prng.js';


import { BattleCache, cacheEnabled, configKey, engineHash, sha } from './balanceCache.js';
import { BalancePool } from './balancePool.js';
import { sandboxRunner, type BalanceRunnerKind } from './brainUnits.js';
import { actFor, type BrainOptions, type FactoryBrain, type Rng, type SoldierBrain } from './brains.js';

export type { FactoryBrain, SoldierBrain } from './brains.js';
export type { BalanceRunnerKind } from './brainUnits.js';

/**
 * The lean in-process runner of the balance tooling: a sandbox stand-in that
 * runs the brains (helpers/brains.ts) as plain functions, with no isolate, no
 * IPC and no deep copies (the brains never mutate their inputs). Every
 * instance runs the brain for its type; the PRNG is seeded per player (§8),
 * the same mulberry32 sequence as the sandbox's Math.random. Trusted bot code
 * only. tests/balance-parity.test.ts checks it gives the same battles,
 * bit for bit, as the real isolated-vm runner on the same brains.
 */
export class BrainRunner implements PlayerRunner {
  readonly loadErrors = new Map<string, { message: string; line?: number }>();
  disposed = false;
  private readonly rng: Rng;

  constructor(
    readonly player: RunnerPlayer,
    private readonly opts: BrainOptions = {},
  ) {
    this.rng = mulberry32(player.seed);
  }

  async spawn(): Promise<SpawnResult> {
    return { ok: true };
  }

  async tick(input: TickInput): Promise<TickResult> {
    const outputs: UnitOutput[] = [];
    for (const self of input.selves) outputs.push({ instanceId: self.id, action: actFor(self, input.enemies, input.allies, input.world, this.rng, this.opts) });
    return { status: 'ok', outputs, elapsedMs: 0, slow: false, forged: 0 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Unit designs and $5,000 archetypes (M8.8)
// ---------------------------------------------------------------------------

type UnitSpec = Omit<UnitStats, 'color' | 'size' | 'shape' | 'support' | 'supportPower' | 'supportRange'> & { size?: number; support?: SupportView };

/** A soldier or tower as the validator snapshots it (M8.8: element, splash and support always set). */
function unitStats(s: UnitSpec): StatsSnapshot {
  return Object.freeze({ color: '#888888', size: s.type === 'tower' ? 14 : 10, shape: 'circle', element: 'normal', splashRadius: 0, support: null, ...s }) as StatsSnapshot;
}

/** A wall or factory as the validator snapshots it (§5.2: no attack, no move, fixed size). */
function buildingStats(
  s: Pick<UnitStats, 'name' | 'type' | 'maxHealth' | 'productionInterval' | 'burst'> & { produces?: MinionKind; minionElement?: Element },
): StatsSnapshot {
  return Object.freeze({
    color: '#8A8F98',
    shape: 'square',
    element: 'normal',
    splashRadius: 0,
    support: null,
    ...(s.type === 'factory' ? { minionElement: 'normal' } : {}),
    ...s,
    damage: 0,
    range: 0,
    speed: 0,
    attackCooldown: 0,
    size: s.type === 'wall' ? 20 : 18,
  }) as StatsSnapshot;
}

/**
 * The economy the matrices are priced and fought on: the default config ($10,000
 * redesign). `BALANCE_FIT` (a JSON config patch; the balance CLI sets it for
 * `--config`) refits the archetypes to a tuning patch: the padded units, the
 * max-cost brick and every 'fill' are priced on it.
 */
export const BALANCE_CONFIG: GameConfig = process.env.BALANCE_FIT ? ConfigSchema.parse(deepMerge(DEFAULT_CONFIG, JSON.parse(process.env.BALANCE_FIT))) : DEFAULT_CONFIG;
const priceOf = (s: UnitSpec): number => computeCost(unitStats(s), BALANCE_CONFIG.cost, pricingOf(BALANCE_CONFIG)).cost;
const B = BALANCE_CONFIG.stats.bounds;

/** The Max-cost Brick: the most HP × damage (HP in 80s, damage in 4s; ties: more HP) under the unit cap, range 40, speed 1.5, size 16. */
function maxCostBrick(): UnitSpec {
  const base = { name: 'Brick', type: 'soldier', range: 40, speed: 1.5, attackCooldown: 60, size: 16 } as const;
  let best = { ...base, maxHealth: 1600, damage: 120 };
  for (let damage = 120; damage <= B.damage.max; damage += 4)
    for (let maxHealth = 1600; maxHealth <= B.maxHealth.max; maxHealth += 80) {
      const u = { ...base, maxHealth, damage };
      if (priceOf(u) > BALANCE_CONFIG.caps.unitCost) break;
      if (maxHealth * damage > best.maxHealth * best.damage || (maxHealth * damage === best.maxHealth * best.damage && maxHealth > best.maxHealth)) best = u;
    }
  return best;
}

/**
 * A unit padded to fill the budget at the fighter cap (the "12 fighters, make
 * them count" stress armies): `stat` (HP in 16s, damage in 2s, or both in
 * turn) raised from `base` until a fighter cap's worth costs the whole budget.
 */
function padded(base: UnitSpec, stat: 'maxHealth' | 'damage' | 'both'): UnitSpec {
  const n = BALANCE_CONFIG.caps.maxCopies;
  const fits = (u: UnitSpec) => u.maxHealth <= B.maxHealth.max && u.damage! <= B.damage.max && copiesCost(priceOf(u), n, u.type, BALANCE_CONFIG.caps.copyRamp) <= BALANCE_CONFIG.caps.budget && priceOf(u) <= BALANCE_CONFIG.caps.unitCost;
  let u: UnitSpec = { ...base };
  for (let i = 0; i < 2000; i++) {
    const hp = stat === 'maxHealth' || (stat === 'both' && i % 2 === 0);
    const next = hp ? { ...u, maxHealth: u.maxHealth + 16 } : { ...u, damage: u.damage! + 2 };
    if (!fits(next)) {
      if (stat !== 'both') break;
      const other = hp ? { ...u, damage: u.damage! + 2 } : { ...u, maxHealth: u.maxHealth + 16 };
      if (!fits(other)) break;
      u = other;
      continue;
    }
    u = next;
  }
  return u;
}

const SCOUT: UnitSpec = { name: 'Scout', type: 'soldier', maxHealth: 480, damage: 32, range: 20, speed: 2.5, attackCooldown: 60, size: 6 };
const BASIC_SOLDIER: UnitSpec = { name: 'Basic Soldier', type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60 };
const HALF_TANK: UnitSpec = { name: 'Half Tank', type: 'soldier', maxHealth: 2000, damage: 80, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };

/**
 * The designs the archetypes are built from (§6 reference units, walls,
 * minions and factories at the redesign scale: HP ×1.6, damage ×0.8 of M8.8).
 */
export const UNITS = {
  /** Basic Soldier (template). */
  soldier: unitStats(BASIC_SOLDIER),
  /** Basic Tower (template: range 140, CD 45). */
  tower: unitStats({ name: 'Basic Tower', type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45 }),
  /** The Max-cost Brick: the most HP × damage under the unit cap (computed). */
  brick: unitStats(maxCostBrick()),
  tank: unitStats(HALF_TANK),
  /** Huge Tank: about the most HP a damage-80 soldier gets under the unit cap (3,600). */
  hugeTank: unitStats({ name: 'Huge Tank', type: 'soldier', maxHealth: 3600, damage: 80, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }),
  /** Scout: a fast skirmisher, damage padded until a fighter cap's worth fills the budget (computed). */
  scout: unitStats(padded(SCOUT, 'damage')),
  /** The HP-padded scout (the `scoutsFilled` stress army, computed). */
  scoutFilled: unitStats(padded({ ...SCOUT, name: 'Padded Scout' }, 'maxHealth')),
  /** The Basic Soldier padded (HP and damage in turn) until 12 fill the budget (`soldiersFilled`, computed). */
  soldierFilled: unitStats(padded({ ...BASIC_SOLDIER, name: 'Padded Soldier' }, 'both')),
  /** The Half Tank padded with HP until a fighter cap's worth fills the budget (`tanksFilled`, computed). */
  tankFilled: unitStats(padded({ ...HALF_TANK, name: 'Padded Tank', maxHealth: 800, damage: 60 }, 'both')),
  sniper: unitStats({ name: 'Sniper Tower', type: 'tower', maxHealth: 640, damage: 160, range: 280, speed: 0, attackCooldown: 60 }),
  /** Max Sniper: max range. */
  maxSniper: unitStats({ name: 'Max Sniper', type: 'tower', maxHealth: 640, damage: 200, range: 300, speed: 0, attackCooldown: 60 }),
  /** Glass Cannon: max damage, little HP. */
  glass: unitStats({ name: 'Glass Cannon', type: 'soldier', maxHealth: 480, damage: B.damage.max, range: 40, speed: 2, attackCooldown: 60, size: 8 }),
  fireSoldier: unitStats({ ...BASIC_SOLDIER, name: 'Fire Soldier', element: 'fire' }),
  stormSoldier: unitStats({ ...BASIC_SOLDIER, name: 'Lightning Soldier', element: 'lightning' }),
  iceSoldier: unitStats({ ...BASIC_SOLDIER, name: 'Ice Soldier', element: 'ice' }),
  /** Frost Archer: a ranged ice soldier. */
  frostArcher: unitStats({ name: 'Frost Archer', type: 'soldier', maxHealth: 640, damage: 32, range: 140, speed: 1.5, attackCooldown: 60, size: 9, element: 'ice' }),
  /** Archer: the Frost Archer made normal (the shatter squad's twin). */
  archer: unitStats({ name: 'Archer', type: 'soldier', maxHealth: 640, damage: 32, range: 140, speed: 1.5, attackCooldown: 60, size: 9 }),
  iceTower: unitStats({ name: 'Ice Tower', type: 'tower', maxHealth: 1000, damage: 60, range: 140, speed: 0, attackCooldown: 45, element: 'ice' }),
  fireTower: unitStats({ name: 'Fire Tower', type: 'tower', maxHealth: 1000, damage: 60, range: 140, speed: 0, attackCooldown: 45, element: 'fire' }),
  frostSniper: unitStats({ name: 'Frost Sniper', type: 'tower', maxHealth: 640, damage: 144, range: 280, speed: 0, attackCooldown: 60, element: 'ice' }),
  /** Mortar Tower: splash 40. */
  mortar: unitStats({ name: 'Mortar Tower', type: 'tower', maxHealth: 1000, damage: 80, range: 140, speed: 0, attackCooldown: 60, splashRadius: 40 }),
  fireMortar: unitStats({ name: 'Fire Mortar', type: 'tower', maxHealth: 1000, damage: 80, range: 140, speed: 0, attackCooldown: 60, element: 'fire', splashRadius: 40 }),
  /** Fireball Catapult: fire splash 40. */
  catapult: unitStats({ name: 'Fireball Catapult', type: 'tower', maxHealth: 960, damage: 120, range: 220, speed: 0, attackCooldown: 60, element: 'fire', splashRadius: 40 }),
  /** Blizzard Totem: damage 0, ice splash 60. Not a fighter. */
  blizzardTotem: unitStats({ name: 'Blizzard Totem', type: 'tower', maxHealth: 1040, damage: 0, range: 160, speed: 0, attackCooldown: 60, element: 'ice', splashRadius: 60 }),
  /** The first exploit search's top build at the redesign scale: a slow ice splash-60 brawler... */
  iceBrawler: unitStats({ name: 'Ice Brawler', type: 'soldier', maxHealth: 960, damage: 80, range: 130, speed: 0.6, attackCooldown: 80, size: 10, element: 'ice', splashRadius: 60 }),
  /** ...behind fast-firing glass sniper towers. */
  glassSniper: unitStats({ name: 'Glass Sniper', type: 'tower', maxHealth: 480, damage: 112, range: 170, speed: 0, attackCooldown: 35 }),
  /** The redesign exploit search's top builds (2026-10-24, before the range and ice retune): a fast splash sniper soldier... */
  splashSniper: unitStats({ name: 'Splash Sniper', type: 'soldier', maxHealth: 480, damage: 160, range: 240, speed: 2.7, attackCooldown: 45, size: 6, splashRadius: 20 }),
  /** ...ranged lightning soldiers... */
  stormArcher: unitStats({ name: 'Storm Archer', type: 'soldier', maxHealth: 1280, damage: 80, range: 100, speed: 1.5, attackCooldown: 55, size: 10, element: 'lightning' }),
  /** ...and slow, small tanks; */
  slowTank: unitStats({ name: 'Slow Tank', type: 'soldier', maxHealth: 1760, damage: 84, range: 40, speed: 0.6, attackCooldown: 50, size: 6 }),
  /** an ice splash-80 caster with fast runners. */
  frostCaster: unitStats({ name: 'Frost Caster', type: 'soldier', maxHealth: 480, damage: 112, range: 130, speed: 2, attackCooldown: 65, size: 9, element: 'ice', splashRadius: 80 }),
  fastRunner: unitStats({ name: 'Fast Runner', type: 'soldier', maxHealth: 1360, damage: 44, range: 20, speed: 3.2, attackCooldown: 85, size: 10 }),
  /** Field Medic: damage 0, heal 96 in 120 px. Not a fighter. */
  medic: unitStats({ name: 'Field Medic', type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'heal', power: 96, range: 120 } }),
  /** Shield Bearer: a tough hitter with a 25% shield aura in 80 px. */
  shieldBearer: unitStats({ name: 'Shield Bearer', type: 'soldier', maxHealth: 1600, damage: 24, range: 30, speed: 1.2, attackCooldown: 60, size: 14, support: { kind: 'shield', power: 25, range: 80 } }),
  /** Healing Shrine: a damage-0 healing tower, heal 128 in 160 px. Not a fighter. */
  shrine: unitStats({ name: 'Healing Shrine', type: 'tower', maxHealth: 1280, damage: 0, range: 20, speed: 0, attackCooldown: 60, support: { kind: 'heal', power: 128, range: 160 } }),
  /** War Drummer: damage 0, might 30% in 100 px. Not a fighter. */
  drummer: unitStats({ name: 'War Drummer', type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'might', power: 30, range: 100 } }),
  /** Wind Banner: damage 0, haste 30% in 100 px. Not a fighter. */
  banner: unitStats({ name: 'Wind Banner', type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'haste', power: 30, range: 100 } }),
  /** Basic Wall (template). */
  wall: buildingStats({ name: 'Basic Wall', type: 'wall', maxHealth: 3200 }),
  /** Basic Factory (template): grunts every 10 s. */
  factory: buildingStats({ name: 'Basic Factory', type: 'factory', maxHealth: 2400, productionInterval: 600 }),
  /** Swarm Factory: grunts every 5 s (the most a factory makes). */
  swarmFactory: buildingStats({ name: 'Swarm Factory', type: 'factory', maxHealth: 2400, productionInterval: 300 }),
  /** Fortress Factory: max HP, slowest. */
  fortressFactory: buildingStats({ name: 'Fortress Factory', type: 'factory', maxHealth: 8000, productionInterval: 1200 }),
  archerNest: buildingStats({ name: 'Archer Nest', type: 'factory', maxHealth: 2400, productionInterval: 300, produces: 'archer' }),
  /** Runner Rush with burst 4. */
  runnerRush: buildingStats({ name: 'Runner Rush', type: 'factory', maxHealth: 2400, productionInterval: 720, produces: 'runner', burst: 4 }),
  /** The same Runner Rush releasing each runner at once (burst 1), for the burst comparison. */
  runnerTrickle: buildingStats({ name: 'Runner Trickle', type: 'factory', maxHealth: 2400, productionInterval: 720, produces: 'runner', burst: 1 }),
  bruteForge: buildingStats({ name: 'Brute Forge', type: 'factory', maxHealth: 2400, productionInterval: 720, produces: 'brute' }),
  iceArcherNest: buildingStats({ name: 'Ice Archer Nest', type: 'factory', maxHealth: 2400, productionInterval: 900, produces: 'archer', minionElement: 'ice' }),
  fireBrutePack: buildingStats({ name: 'Fire Brute Pack', type: 'factory', maxHealth: 2400, productionInterval: 900, produces: 'brute', minionElement: 'fire' }),
  /** Storm Runners: lightning runners, burst 4. */
  stormRunners: buildingStats({ name: 'Storm Runners', type: 'factory', maxHealth: 2400, productionInterval: 900, produces: 'runner', burst: 4, minionElement: 'lightning' }),
  /** Slower, cheaper factories (a minion every 15 s) for the five-factory army. */
  steadyFactory: buildingStats({ name: 'Steady Factory', type: 'factory', maxHealth: 2400, productionInterval: 900 }),
  steadyArchers: buildingStats({ name: 'Steady Archers', type: 'factory', maxHealth: 2400, productionInterval: 900, produces: 'archer' }),
  steadyBrutes: buildingStats({ name: 'Steady Brutes', type: 'factory', maxHealth: 2400, productionInterval: 900, produces: 'brute' }),
  steadyMedics: buildingStats({ name: 'Steady Medics', type: 'factory', maxHealth: 2400, productionInterval: 900, produces: 'medic' }),
  /** Medic Tent: medics. Not a fighter. */
  medicTent: buildingStats({ name: 'Medic Tent', type: 'factory', maxHealth: 2400, productionInterval: 600, produces: 'medic' }),
} as const;
export type UnitKey = keyof typeof UNITS;

export interface Archetype {
  key: string;
  label: string;
  /** Copies per design, placed in this order into the front cells. */
  army: Array<[UnitKey, number]>;
  /**
   * M8.5 wall layouts (otherwise every copy goes into the front cells in army order):
   *   'seal': the walls close the zone off (`sealCells`), the fighters fill the front cells inside;
   *   'u':    the plan §14 fortress, walls on the front row and both outer columns of rows 1-2,
   *           the fighters on rows 3-4 (`uCells`).
   */
  layout?: 'seal' | 'u' | 'nest';
  /** Its factories hold every tick (never build). */
  holdFactories?: boolean;
  /** M8.6: its factories' squad-order brain (default 'rally', the template); M8.8: or one per factory design. */
  factoryBrain?: FactoryBrain | Partial<Record<UnitKey, FactoryBrain>>;
  /** M8.8: its fighting soldiers' brain (default 'chase', the template). */
  soldierBrain?: SoldierBrain;
  /** Custom designs (exploit search, CLI armies): an army key found here is this design, not a UNITS one. */
  designs?: Partial<Record<string, StatsSnapshot>>;
}

/** The design an army fields under `k` (its own custom design, else the UNITS one). */
export const statsOf = (a: Archetype, k: UnitKey): StatsSnapshot => a.designs?.[k] ?? UNITS[k];

/** Plan §14's wall fortress: walls on row 0 and on cols 0 and 5 of rows 1-2; fighters on rows 3-4 first. */
export function uCells(facing: Facing, centred: boolean): { walls: Cell[]; fighters: Cell[] } {
  const walls: Cell[] = [];
  for (let col = 0; col < GRID_SIZE; col++) walls.push({ col, row: 0 });
  for (const row of [1, 2]) walls.push({ col: 0, row }, { col: GRID_SIZE - 1, row });
  const front = frontCells(facing, centred);
  return { walls, fighters: [...front.filter((c) => c.row >= 3 && c.row <= 4), ...front] };
}

/**
 * The cells a wall fortress fills, in order (zone-local, row 0 = front).
 * Diagonal zones: the two inner sides, row 0 and col 0, from the centre-most
 * cell out (11 cells seal the zone: its other two sides are the arena edge).
 * N/S/E/W zones whose back row is the arena edge: the most forward seal 11
 * walls allow, a pocket of rows 3-5 × cols 1-4 walled by row 2 (cols 1-4) and
 * both flanks of rows 3-5 (10 walls; walls that only touch at a corner leave
 * no gap), plus one doubling (2, 2). Other N/S/E/W zones (Lanes): a 7-wall ring round an L of three
 * cells, (2,1), (3,1) and (2,2), plus 4 more doubling the front row (walls
 * that only touch at a corner leave no gap). (M8.7: the old "front row + both
 * flanks" left rows 4-5 of the flanks open: closing a whole zone takes 16
 * walls, above the cap of 12. Units now route round walls, so they found that
 * back door.)
 */
export function sealCells(facing: Facing, backOnEdge = true): Cell[] {
  const cells: Cell[] = [{ col: 0, row: 0 }];
  if (facing !== 'diag' && backOnEdge) {
    cells.length = 0;
    for (const col of [2, 3, 1, 4]) cells.push({ col, row: 2 });
    for (const row of [3, 4, 5]) cells.push({ col: 0, row }, { col: GRID_SIZE - 1, row });
    cells.push({ col: 2, row: 1 });
    return cells;
  }
  if (facing === 'diag') {
    for (let i = 1; i < GRID_SIZE; i++) cells.push({ col: i, row: 0 }, { col: 0, row: i });
    return cells;
  }
  return [
    { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 1, row: 1 }, { col: 4, row: 1 }, { col: 1, row: 2 }, { col: 3, row: 2 }, { col: 2, row: 3 },
    { col: 1, row: 0 }, { col: 4, row: 0 }, { col: 0, row: 0 }, { col: 5, row: 0 },
  ];
}

/**
 * M8.7 walled sniper nest ('nest'): the towers sit in the zone's back, closed
 * off by the walls (routing walks melee round walls that don't enclose
 * anything, so the nest's walls now close its towers in). Diagonal zones: the
 * 2×2 arena corner (5,5)-(4,4) behind (3,5), (3,4), (4,3), (5,3), doubled at
 * (2,4) and (4,2). N/S/E/W zones with the back row on the arena edge: back-row
 * cells 1-3 behind (0,5), (4,5), (1,4), (2,4), (3,4), doubled at (2,3).
 * Elsewhere (Lanes) 6 walls can't close a pocket: the front cells as before.
 */
export function nestCells(facing: Facing, backOnEdge: boolean, front: Cell[]): { walls: Cell[]; fighters: Cell[] } {
  if (facing === 'diag') {
    return {
      walls: [{ col: 3, row: 5 }, { col: 3, row: 4 }, { col: 4, row: 3 }, { col: 5, row: 3 }, { col: 2, row: 4 }, { col: 4, row: 2 }],
      fighters: [{ col: 4, row: 4 }, { col: 5, row: 4 }, { col: 4, row: 5 }, { col: 5, row: 5 }],
    };
  }
  if (backOnEdge) {
    return {
      walls: [{ col: 0, row: 5 }, { col: 4, row: 5 }, { col: 1, row: 4 }, { col: 2, row: 4 }, { col: 3, row: 4 }, { col: 2, row: 3 }],
      fighters: [{ col: 2, row: 5 }, { col: 1, row: 5 }, { col: 3, row: 5 }],
    };
  }
  return { walls: front, fighters: front };
}

/** Where a sealed fortress's fighters go: inside the seal (diagonal zones: the front cells left). */
export function sealFighterCells(facing: Facing, front: Cell[], backOnEdge = true): Cell[] {
  if (facing === 'diag') return front;
  if (backOnEdge) {
    const pocket: Cell[] = [];
    for (const row of [3, 4, 5]) for (const col of [2, 3, 1, 4]) pocket.push({ col, row });
    return pocket;
  }
  return [{ col: 2, row: 1 }, { col: 3, row: 1 }, { col: 2, row: 2 }];
}


// ---------------------------------------------------------------------------
// The $10,000 archetypes (redesign, 2026-10-24)
// ---------------------------------------------------------------------------
//
// Each archetype is its fixed parts plus, where it had Basic Soldiers (or
// another filler) topping it up, a 'fill': as many copies as fit both the
// budget and the copy caps (fighters `caps.maxCopies`, walls
// `caps.maxWallCopies`). So the archetypes refit themselves when prices or
// caps change, and the cheap-unit armies (the template rush, the padded
// swarms) are held by the fighter cap, not the budget.

type Part = [UnitKey, number | 'fill'];
const costOf = (k: UnitKey): number => computeCost(UNITS[k], BALANCE_CONFIG.cost, pricingOf(BALANCE_CONFIG)).cost;
const isFighterKey = (k: UnitKey) => UNITS[k].type !== 'wall';

/**
 * Resolve the parts: fixed parts that break the budget lose copies first (one
 * copy of the dearest fixed fighter part at a time, never its last copy),
 * then a 'fill' part gets the most copies that fit the budget and the copy caps.
 */
function resolve(parts: Part[]): Array<[UnitKey, number]> {
  const caps = BALANCE_CONFIG.caps;
  const groupCost = (k: UnitKey, c: number) => copiesCost(costOf(k), c, UNITS[k].type, caps.copyRamp);
  const fixed = parts.filter((p): p is [UnitKey, number] => p[1] !== 'fill').map(([k, c]) => [k, c] as [UnitKey, number]);
  const total = () => fixed.reduce((n, [k, c]) => n + groupCost(k, c), 0);
  while (total() > caps.budget) {
    let dearest = -1;
    fixed.forEach(([k, c], i) => {
      if (c > 1 && isFighterKey(k) && (dearest < 0 || costOf(k) > costOf(fixed[dearest]![0]))) dearest = i;
    });
    if (dearest < 0) break;
    fixed[dearest]![1] -= 1;
  }
  const countOf = new Map(fixed);
  const filler = parts.find((p) => p[1] === 'fill')?.[0];
  if (!filler) return fixed;
  const spent = total();
  const used = fixed.reduce((n, [k, c]) => n + (isFighterKey(k) === isFighterKey(filler) ? c : 0), 0);
  const room = isFighterKey(filler) ? caps.maxCopies - used : caps.maxWallCopies - used;
  let n = 0;
  while (n < room && spent + groupCost(filler, n + 1) <= caps.budget) n++;
  return parts.map(([k, c]) => [k, c === 'fill' ? n : countOf.get(k)!] as [UnitKey, number]).filter(([, c]) => c > 0);
}

const plural = (name: string, n: number) =>
  n === 1 || name.endsWith('s') ? name : name.endsWith('y') ? `${name.slice(0, -1)}ies` : /(sh|ch)$/.test(name) ? `${name}es` : `${name}s`;
/** "8 Basic Soldiers, 6 Basic Towers" */
export const composition = (army: Array<[UnitKey, number]>) => army.map(([k, n]) => `${n} ${plural(UNITS[k].name, n)}`).join(', ');

/**
 * "12 fighters, make them count": an army that leaves money unspent has its
 * attacking soldier and tower designs padded, HP and damage raised together
 * (×1.02 steps, whole numbers, inside the bounds and the unit cap) until the
 * next step would break the budget. Support units, walls and factories keep
 * their stats. The padded designs go in `designs` under the same keys.
 */
function pad(army: Array<[UnitKey, number]>): Partial<Record<string, StatsSnapshot>> | undefined {
  const caps = BALANCE_CONFIG.caps;
  const pricing = pricingOf(BALANCE_CONFIG);
  const padKeys = army.filter(([k]) => (UNITS[k].type === 'soldier' || UNITS[k].type === 'tower') && UNITS[k].damage > 0 && !UNITS[k].support).map(([k]) => k);
  if (padKeys.length === 0) return undefined;
  const at = (m: number): Record<string, StatsSnapshot> | null => {
    const out: Record<string, StatsSnapshot> = {};
    for (const k of padKeys) {
      const u = UNITS[k];
      const d = { ...u, maxHealth: Math.round(u.maxHealth * m), damage: Math.round(u.damage * m) } as StatsSnapshot;
      if (d.maxHealth > B.maxHealth.max || d.damage > B.damage.max) return null;
      if (computeCost(d, BALANCE_CONFIG.cost, pricing).cost > caps.unitCost) return null;
      out[k] = d;
    }
    const total = army.reduce((n, [k, c]) => n + copiesCost(computeCost(out[k] ?? UNITS[k], BALANCE_CONFIG.cost, pricing).cost, c, UNITS[k].type, caps.copyRamp), 0);
    return total <= caps.budget ? out : null;
  };
  let best: Record<string, StatsSnapshot> | null = null;
  for (let m = 1.02; m < 4; m *= 1.02) {
    const next = at(m);
    if (!next) break;
    best = next;
  }
  return best ?? undefined;
}

function arch(key: string, title: string, parts: Part[], opts: Omit<Archetype, 'key' | 'label' | 'army'> & { pad?: boolean } = {}): Archetype {
  const { pad: padIt = true, ...rest } = opts;
  const army = resolve(parts);
  const designs = padIt ? pad(army) : undefined;
  const padded = designs ? ` padded to ${Object.entries(designs).map(([k, d]) => `${UNITS[k as UnitKey].name} ${d!.maxHealth}/${d!.damage}`).join(', ')}` : '';
  return { key, label: `${title} (${composition(army)}${padded})`, army, ...(designs ? { designs } : {}), ...rest };
}

/** The classic six (§14), at $10,000: twice the M8.8 copies, or filled to the caps. */
export const ARCHETYPES: Archetype[] = [
  arch('bricks', 'two max-cost bricks + soldiers', [['brick', 2], ['soldier', 'fill']]),
  arch('templates', 'templates', [['soldier', 'fill'], ['tower', 4]], { pad: false }),
  arch('tanks', 'tank army', [['tank', 'fill']]),
  arch('turtle', 'all-tower turtle', [['tower', 'fill']]),
  arch('scouts', 'scout swarm (damage-padded)', [['scout', 'fill']]),
  arch('snipers', 'sniper nest', [['sniper', 'fill']]),
];

/** The building archetypes (M8.5). The walled range armies seal their towers in (11 walls). */
export const BUILDING_ARCHETYPES: Archetype[] = [
  arch('fortress', 'wall fortress', [['wall', 11], ['tower', 'fill']], { layout: 'seal' }),
  arch('snipewall', 'walled sniper nest', [['wall', 11], ['sniper', 4], ['tower', 'fill']], { layout: 'seal' }),
  arch('swarm', 'factory swarm', [['soldier', 'fill'], ['swarmFactory', 3]]),
  arch('wallrush', 'walls + rush', [['wall', 8], ['soldier', 'fill']]),
  arch('mixed', 'mixed', [['soldier', 'fill'], ['wall', 12], ['tower', 4]]),
  arch('quad', 'all four templates', [['soldier', 'fill'], ['wall', 8], ['tower', 2], ['factory', 2]]),
  arch('bunker', 'all-building bunker', [['tower', 'fill'], ['swarmFactory', 4]]),
];

/** The plan §14 open fortress: 10 Basic Walls in a U (front row + both outer columns of rows 1-2), towers on rows 3-4. */
export const OPEN_FORTRESS: Archetype = arch('openfort', 'open wall fortress', [['wall', 10], ['tower', 'fill']], { layout: 'u' });

/** The minion-kind archetypes (M8.6): each kind with the order its CLAUDE.md example gives. */
export const KIND_ARCHETYPES: Archetype[] = [
  arch('archers', 'archer nest', [['wall', 4], ['tower', 'fill'], ['archerNest', 4]], { factoryBrain: 'guard' }),
  arch('runners', 'runner swarm', [['soldier', 'fill'], ['runnerRush', 3]], { factoryBrain: 'swarm' }),
  arch('brutes', 'brute breakers', [['soldier', 'fill'], ['bruteForge', 3]], { factoryBrain: 'breach' }),
  arch('homeguard', 'grunt home guard', [['tower', 'fill'], ['swarmFactory', 4]], { factoryBrain: 'defend' }),
];

/** Specialist archetypes: one stat pushed to the max, and the padded full-12 mono armies ("12 fighters, make them count"). */
export const SPECIALIST_ARCHETYPES: Archetype[] = [
  arch('hugetanks', 'Huge Tanks (max HP) + soldiers', [['hugeTank', 2], ['soldier', 'fill']]),
  arch('glass', 'Glass Cannons (max damage)', [['glass', 6], ['soldier', 'fill']]),
  arch('longbow', 'Max Snipers (max range)', [['soldier', 'fill'], ['maxSniper', 4]]),
  arch('soldiersFilled', 'padded soldiers (HP and damage)', [['soldierFilled', 'fill']]),
];

/** Element and support archetypes (§6 example armies at $10,000), the combo armies and the exploit search's top build. */
export const ELEMENT_ARCHETYPES: Archetype[] = [
  arch('firesquad', 'fire squad', [['fireSoldier', 'fill'], ['tower', 4]]),
  arch('shatter', 'shatter squad', [['fireSoldier', 'fill'], ['frostArcher', 4]]),
  arch('frostnest', 'frost nest', [['soldier', 'fill'], ['iceTower', 4], ['frostSniper', 2]], { soldierBrain: 'hold' }),
  arch('storm', 'storm crowd', [['stormSoldier', 'fill']]),
  arch('mortars', 'mortar battery', [['mortar', 'fill']]),
  arch('firenest', 'fire splash nest', [['wall', 11], ['fireMortar', 4], ['tower', 'fill']], { layout: 'seal' }),
  arch('icewall', 'ice wall + snipers', [['wall', 11], ['frostSniper', 2], ['iceTower', 2], ['tower', 'fill']], { layout: 'seal' }),
  arch('bombard', 'fire-splash bombard', [['soldier', 'fill'], ['catapult', 4]]),
  arch('blizzard', 'blizzard + fire', [['fireSoldier', 'fill'], ['blizzardTotem', 2]], { soldierBrain: 'hold' }),
  arch('healerball', 'healer ball', [['tank', 4], ['shieldBearer', 2], ['soldier', 'fill'], ['medic', 2]]),
  arch('buffedrush', 'buffed rush', [['soldier', 'fill'], ['drummer', 2], ['banner', 2], ['wall', 4]]),
  arch('shieldwall', 'shield wall', [['shieldBearer', 4], ['tower', 'fill']]),
  arch('bigFriends', 'Huge Tank + friends', [['hugeTank', 2], ['soldier', 'fill'], ['medic', 2], ['tower', 2]], { soldierBrain: 'hold' }),
  arch('elemfactories', 'elemental factories', [['soldier', 'fill'], ['iceArcherNest', 2], ['fireBrutePack', 2]], { factoryBrain: { iceArcherNest: 'guardTank', fireBrutePack: 'rally' } }),
  arch('stormrunners', 'storm runners', [['soldier', 'fill'], ['stormRunners', 2]]),
  arch('medictent', 'medic tent + tanks', [['tank', 4], ['soldier', 'fill'], ['medicTent', 2]], { factoryBrain: 'guardTank' }),
  // Redesign: the combo armies (kindle, brittle, overload) and five factories.
  arch('overload', 'overload (lightning soldiers round fire towers)', [['stormSoldier', 'fill'], ['fireTower', 4]], { soldierBrain: 'hold' }),
  arch('icebreak', 'brittle (ice towers freeze, soldiers and snipers hit harder)', [['soldier', 'fill'], ['iceTower', 3], ['sniper', 2]], { soldierBrain: 'hold' }),
  arch('factories5', 'five factories (grunts, archers, brutes, medics) + soldiers', [['soldier', 'fill'], ['steadyFactory', 2], ['steadyArchers', 1], ['steadyBrutes', 1], ['steadyMedics', 1]], {
    factoryBrain: { steadyFactory: 'rally', steadyArchers: 'guardTank', steadyBrutes: 'rally', steadyMedics: 'guardTank' },
  }),
  arch('exploit', 'exploit search: ice splash brawlers behind glass snipers', [['iceBrawler', 2], ['glassSniper', 4], ['soldier', 'fill']]),
  // The redesign exploit search's top two builds (kept in the pool so the prices answer them).
  arch('exploitIce', 'exploit search: frost casters and fast runners', [['frostCaster', 2], ['fastRunner', 4]], { pad: false }),
  // Redesign: mixed armies with a splash answer to soldier blobs (what a $10,000 player builds against a rush).
  arch('splashline', 'splash line (soldiers in front of mortars behind walls)', [['soldier', 'fill'], ['mortar', 3], ['wall', 4]], { soldierBrain: 'hold' }),
  arch('firebrawl', 'fire brawl (fire soldiers with fire mortars)', [['fireSoldier', 'fill'], ['fireMortar', 3]]),
  arch('guardedcatapults', 'guarded catapults (shield bearers in front of catapults)', [['shieldBearer', 3], ['catapult', 3], ['soldier', 'fill']], { soldierBrain: 'hold' }),
  arch('icemortars', 'ice and mortars (ice towers and mortars sealed in, soldiers holding)', [['wall', 11], ['iceTower', 2], ['mortar', 3], ['soldier', 'fill']], { layout: 'seal', soldierBrain: 'hold' }),
];

/** The burst-1 twin of the runner swarm (not in the round robin): the burst comparison. */
export const RUNNER_TRICKLE: Archetype = arch('trickle', 'runner trickle', [['soldier', 'fill'], ['runnerTrickle', 3]], { factoryBrain: 'swarm' });

/** The plain template armies, in the round robin since the $10,000 redesign: the template rush (the fighter cap of Basic Soldiers) and the template mix. */
export const RUSH: Archetype = arch('rush', 'template rush', [['soldier', 'fill']], { pad: false });
export const TEMPLATE_MIX: Archetype = arch('tmix', 'templates mixed', [['soldier', 'fill'], ['tower', 2], ['factory', 1], ['wall', 6]], { pad: false });
export const TEMPLATE_ARCHETYPES: Archetype[] = [RUSH, TEMPLATE_MIX];

/** Every round-robin archetype: the six, the building ones, the kind ones (the first 17), the specialist, element/support/combo and template ones. */
export const ALL_ARCHETYPES: Archetype[] = [...ARCHETYPES, ...BUILDING_ARCHETYPES, ...KIND_ARCHETYPES, ...SPECIALIST_ARCHETYPES, ...ELEMENT_ARCHETYPES, ...TEMPLATE_ARCHETYPES];

/** "No element dominates per dollar" twins (not in the round robin): the element army made `normal`, refilled. */
export const NORMAL_TWINS: Record<string, Archetype> = {
  firesquad: arch('firesquadNormal', 'fire squad made normal', [['soldier', 'fill'], ['tower', 4]]),
  shatter: arch('shatterNormal', 'shatter squad without ice', [['fireSoldier', 'fill'], ['archer', 4]]),
  storm: arch('stormNormal', 'storm crowd made normal', [['soldier', 'fill']]),
  frostnest: arch('frostnestNormal', 'frost nest made normal', [['soldier', 'fill'], ['tower', 4], ['sniper', 2]], { soldierBrain: 'hold' }),
};

/** The dormant-factory turtle (not in the round robin): walls in front of Fortress Factories that never build. */
export const DORMANT: Archetype = arch('dormant', 'dormant factories', [['wall', 10], ['fortressFactory', 5]], { holdFactories: true });

/** A side of damage-0 units only (pure support: not fighters), for the elimination check. */
export const SUPPORT_ONLY: Archetype = arch('supportonly', 'pure support', [['medic', 2], ['drummer', 2], ['banner', 2]]);

export const unitCost = (k: UnitKey, config: GameConfig = BALANCE_CONFIG): number => computeCost(UNITS[k], config.cost, pricingOf(config)).cost;


export function armyCost(a: Archetype, config: GameConfig = BALANCE_CONFIG): number {
  return a.army.reduce((sum, [k, n]) => sum + copiesCost(computeCost(statsOf(a, k), config.cost, pricingOf(config)).cost, n, statsOf(a, k).type, config.caps.copyRamp), 0);
}

/** Copies placed (`group` 'fighters' = everything but walls, §5.2 Copies). */
export function armyCopies(a: Archetype, group: 'all' | 'fighters' | 'walls' | 'factories' = 'all'): number {
  const counts = (k: UnitKey) => {
    const t = statsOf(a, k).type;
    return group === 'all' || (group === 'walls' ? t === 'wall' : group === 'factories' ? t === 'factory' : t !== 'wall');
  };
  return a.army.reduce((sum, [k, n]) => sum + (counts(k) ? n : 0), 0);
}

/** Whether a N/S/E/W zone's back row (row 5) lies on the arena edge. */
function backRowOnEdge(zone: MapZone): boolean {
  if (zone.facing === 'S') return zone.y === 0;
  if (zone.facing === 'N') return zone.y + zone.height === zone.arena;
  if (zone.facing === 'E') return zone.x === 0;
  if (zone.facing === 'W') return zone.x + zone.width === zone.arena;
  return true;
}

/** The brain options of an archetype (how its army plays). */
export function brainOptions(a: Archetype): BrainOptions {
  return {
    ...(a.holdFactories === true ? { holdFactories: true } : {}),
    ...(a.factoryBrain !== undefined ? { factoryBrain: a.factoryBrain } : {}),
    ...(a.soldierBrain !== undefined ? { soldierBrain: a.soldierBrain } : {}),
  };
}

/** Designs + front-first placements for an archetype in a zone. */
function deploy(a: Archetype, zone: MapZone, config: GameConfig): { units: BattleUnitDesign[]; placements: PlacementDTO[] } {
  const centred = zoneCentredOnLine(zone);
  const front = frontCells(zone.facing, centred);
  const u = a.layout === 'u' ? uCells(zone.facing, centred) : null;
  const backOnEdge = backRowOnEdge(zone);
  const nest = a.layout === 'nest' ? nestCells(zone.facing, backOnEdge, front) : null;
  const wallCells = a.layout === 'seal' ? sealCells(zone.facing, backOnEdge) : u ? u.walls : nest ? nest.walls : front;
  const fighterCells = u ? u.fighters : nest ? nest.fighters : a.layout === 'seal' ? sealFighterCells(zone.facing, front, backOnEdge) : front;
  const taken = new Set<string>();
  const take = (from: Cell[]): Cell => {
    // A layout with fewer cells than copies (a seal on a zone off the arena edge) spills into the front cells.
    const cell = from.find((c) => !taken.has(`${c.col},${c.row}`)) ?? front.find((c) => !taken.has(`${c.col},${c.row}`))!;
    taken.add(`${cell.col},${cell.row}`);
    return cell;
  };
  const units: BattleUnitDesign[] = [];
  const placements: PlacementDTO[] = [];
  // With a wall layout the walls go first, so the fighters fill the cells left inside.
  const order = a.layout ? [...a.army].sort(([x], [y]) => Number(statsOf(a, y).type === 'wall') - Number(statsOf(a, x).type === 'wall')) : a.army;
  for (const [k, n] of order) {
    const stats = statsOf(a, k);
    units.push({ unitId: k, stats, cost: computeCost(stats, config.cost, pricingOf(config)).cost });
    for (let i = 0; i < n; i++) {
      const cell = take(stats.type === 'wall' ? wallCells : fighterCells);
      placements.push({ unitId: k, col: cell.col, row: cell.row });
    }
  }
  return { units, placements };
}

// ---------------------------------------------------------------------------
// Battles
// ---------------------------------------------------------------------------

export interface Entrant {
  archetype: Archetype;
  /** Zone index on the map. */
  zone: number;
  /** Team mode only. */
  teamId?: number;
  /** M8.8 determinism check: hand the engine the placements in reverse order. */
  reversePlacements?: boolean;
}

export interface BalanceBattle {
  result: BattleResult;
  /** First tick an enemy unit took damage from another unit (null = never). */
  firstContactTick: number | null;
  /** First tick any unit lost HP to sudden death (null = never). */
  firstSuddenDeathTick: number | null;
  /** Per entrant: first tick one of its units stood outside the safe circle (null = never). */
  suddenDeathBy: Array<number | null>;
  /** Per entrant: placed units (not minions) that died before the battle ended. */
  lost: number[];
  /** Per entrant: what is still standing at the end, by type (minions included). */
  standing: Array<Partial<Record<string, number>>>;
  /** Wall-clock ms of the whole battle (lean runner: this is engine time). */
  ms: number;
  /** Ranks (1 = best) by entrant index. */
  places: number[];
  /** M8.8: every heal that restored HP (frame tick, healer, target, amount). */
  heals: Array<{ t: number; from: string; to: string; amount: number }>;
  /** M8.8: max HP per body (the hp it was first listed with: every body spawns at full HP). */
  maxHp: Map<string, number>;
  /** M8.8: per entrant, its burn damage, HP healed and cleanses; duels also credit its shatters and zaps (from the struck side). */
  effects: Array<{ shatters: number; arcs: number; overloads: number; burnDamage: number; healed: number; cleanses: number }>;
  /** M8.8: a hash of every frame (the determinism check). */
  frameHash: number;
}

/**
 * Run one battle with the given entrants on `style` with `players` zones.
 * Lean-runner battles without a frame hash are read from the result cache
 * (helpers/balanceCache.ts) when they were played before with the same
 * engine, config and armies; `ms` is then the time of that first run.
 */
export async function balanceBattle(
  style: MapStyle,
  players: number,
  entrants: Entrant[],
  seed: number,
  config: GameConfig = BALANCE_CONFIG,
  hashFrames = false,
  runner: BalanceRunnerKind = 'lean',
): Promise<BalanceBattle> {
  if (hashFrames || runner !== 'lean' || !cacheEnabled()) return playBalanceBattle(style, players, entrants, seed, config, hashFrames, runner);
  const ck = configKey(config);
  const sides = entrants.map((e) => `${entrantDigest(e.archetype, style, players, e.zone, config, ck)}/${e.teamId ?? '-'}/${e.reversePlacements === true}`);
  const key = sha(`battle ${engineHash()} ${ck} ${style} ${players} ${seed} ${sides.join(' ')}`);
  const cache = battleCache(config);
  const hit = cache.get(key);
  if (hit) return { ...(structuredClone(hit) as Omit<BalanceBattle, 'maxHp'>), maxHp: new Map(hit.maxHp) };
  const b = await playBalanceBattle(style, players, entrants, seed, config, false, 'lean');
  cache.putAll([[key, { ...b, maxHp: [...b.maxHp] }]]);
  return b;
}

type StoredBattle = Omit<BalanceBattle, 'maxHp'> & { maxHp: Array<[string, number]> };
const battleCaches = new Map<GameConfig, BattleCache<StoredBattle>>();
const battleCache = (config: GameConfig) => {
  let c = battleCaches.get(config);
  if (!c) battleCaches.set(config, (c = new BattleCache<StoredBattle>(config, undefined, 'battles')));
  return c;
};

/** `balanceBattle` without the cache. */
async function playBalanceBattle(
  style: MapStyle,
  players: number,
  entrants: Entrant[],
  seed: number,
  config: GameConfig = BALANCE_CONFIG,
  hashFrames = false,
  /** Who runs the brains: the lean in-process runner (default) or a real sandbox (the parity check, a confirmation pass). */
  runner: BalanceRunnerKind = 'lean',
): Promise<BalanceBattle> {
  const map: MapLayout = mapFor(style, players);
  const runners: PlayerRunner[] = [];
  const setups: BattlePlayerSetup[] = [];
  for (const [seat, e] of entrants.entries()) {
    const zone = map.zones[e.zone]!;
    const { units, placements } = deploy(e.archetype, zone, config);
    const player = { playerId: `p${seat}`, seat, seed: seed + seat };
    const r = runner === 'lean' ? new BrainRunner(player, brainOptions(e.archetype)) : await sandboxRunner(runner, player, units, brainOptions(e.archetype));
    runners.push(r);
    setups.push({
      playerId: `p${seat}`,
      seat,
      zone,
      ...(e.teamId !== undefined ? { teamId: e.teamId } : {}),
      units,
      placements: e.reversePlacements ? [...placements].reverse() : placements,
      runner: r,
    });
  }
  let firstContactTick: number | null = null;
  let firstSuddenDeathTick: number | null = null;
  const suddenDeathBy: Array<number | null> = entrants.map(() => null);
  const heals: BalanceBattle['heals'] = [];
  const maxHp = new Map<string, number>();
  const effects: BalanceBattle['effects'] = entrants.map(() => ({ shatters: 0, arcs: 0, overloads: 0, burnDamage: 0, healed: 0, cleanses: 0 }));
  const seatOf = (id: string) => Number(id.split('-')[0]);
  let frameHash = 0;
  const hashFrame = (f: FrameDTO) => {
    const text = JSON.stringify(f);
    for (let i = 0; i < text.length; i++) frameHash = (Math.imul(frameHash, 31) + text.charCodeAt(i)) | 0;
  };
  const started = performance.now();
  let result: BattleResult;
  try {
    result = await runBattle({
      players: setups,
      map,
      config,
      seed,
      yieldEveryTicks: 0,
      onFrame: (f) => {
        if (hashFrames) hashFrame(f);
        for (const ev of f.events) {
          // A minion may be hit before the first frame lists it: its max HP comes from its kind, not that frame.
          if (ev.type === 'spawn' && ev.kind) maxHp.set(ev.instanceId, config.factory.minions[ev.kind].maxHealth);
        }
        for (const [id, , , hp] of f.units) if (!maxHp.has(id)) maxHp.set(id, hp);
        for (const ev of f.events) {
          if (ev.type === 'hit') {
            firstContactTick ??= f.t;
            if (ev.kind === 'burn') effects[seatOf(ev.instanceId)]!.burnDamage += ev.damage;
          } else if (ev.type === 'heal') {
            heals.push({ t: f.t, from: ev.from, to: ev.to, amount: ev.amount });
            effects[seatOf(ev.from)]!.healed += ev.amount;
          } else if (ev.type === 'cleanse') effects[seatOf(ev.from)]!.cleanses++;
          else if (entrants.length === 2 && ev.type === 'shatter') effects[1 - seatOf(ev.id)]!.shatters++;
          else if (entrants.length === 2 && ev.type === 'arc') {
            // In a duel the struck target's enemy made the zap.
            const e = effects[1 - seatOf(ev.from)]!;
            e.arcs++;
            if (ev.to.length > 1) e.overloads++;
          }
        }
        // A unit outside the safe circle (with damage on) is losing HP to sudden death.
        if (config.suddenDeath.damagePctPerSecond <= 0) return;
        for (const [id, , , , flags] of f.units) {
          if (!(flags & FRAME_FLAGS.OUTSIDE_SAFE_ZONE)) continue;
          firstSuddenDeathTick ??= f.t;
          const seat = seatOf(id);
          suddenDeathBy[seat] ??= f.t;
        }
      },
    });
  } finally {
    for (const r of runners) r.dispose();
  }
  // Nobody reads the frames afterwards (the hash and the counters are taken as they come).
  delete (result as { frames?: unknown }).frames;
  const ms = performance.now() - started;
  const placeOf = new Map(result.ranking.map((r) => [r.playerId, r.place]));
  const lost = entrants.map((_, i) => result.units.filter((u) => u.playerId === `p${i}` && u.type !== 'minion' && !u.survived).length);
  const standing = entrants.map((_, i) => {
    const by: Partial<Record<string, number>> = {};
    for (const u of result.units) if (u.playerId === `p${i}` && u.survived) by[u.type ?? 'soldier'] = (by[u.type ?? 'soldier'] ?? 0) + 1;
    return by;
  });
  return {
    result,
    firstContactTick,
    firstSuddenDeathTick,
    suddenDeathBy,
    lost,
    standing,
    ms,
    places: entrants.map((_, i) => placeOf.get(`p${i}`) ?? 99),
    heals,
    maxHp,
    effects,
    frameHash,
  };
}

/** Outcome of A vs B in one battle: 1 = A won, 0 = draw (shared place), -1 = B won. */
export async function duel(style: MapStyle, players: number, a: Archetype, b: Archetype, zones: [number, number], seed: number, config?: GameConfig): Promise<{ outcome: 1 | 0 | -1; battle: BalanceBattle }> {
  const battle = await balanceBattle(style, players, [{ archetype: a, zone: zones[0] }, { archetype: b, zone: zones[1] }], seed, config);
  const [pa, pb] = battle.places as [number, number];
  return { outcome: pa < pb ? 1 : pa > pb ? -1 : 0, battle };
}

/** Where the 2-player duels are fought: [style, players, zone pairs (both orders are played)]. */
export const DUEL_SITES: Array<{ name: string; style: MapStyle; players: number; pairs: Array<[number, number]> }> = [
  // Corners 4: adjacent (TL-TR) and diagonal (TL-BR) neighbours.
  { name: 'Corners 4', style: 'corners', players: 4, pairs: [[0, 1], [0, 2]] },
  // Ring 8: edge-to-corner neighbours, and edge-to-edge across a corner.
  { name: 'Ring 8', style: 'ring', players: 8, pairs: [[0, 1], [0, 2]] },
];

export const SEEDS = [11, 4242];
/**
 * M8.8: the seeds of the big round robin. The default suite plays one seed (8
 * battles per pair); BALANCE_FULL=1 plays both (16, what docs/balance.md records).
 */
export const MATRIX_SEEDS: number[] = process.env.BALANCE_FULL ? SEEDS : SEEDS.slice(0, 1);

export interface MatchupCell {
  wins: number;
  draws: number;
  losses: number;
}

/** Whether a side still has a fighter standing (§5.2: soldiers, towers, factories, minions; never walls). */
export const hasFighter = (standing: Partial<Record<string, number>>): boolean =>
  Object.entries(standing).some(([type, n]) => type !== 'wall' && (n ?? 0) > 0);

/** A beats B when it wins more of their battles than it loses. */
export const beats = (c: MatchupCell) => c.wins > c.losses;

/** The round robin as a Markdown table: row archetype's wins-draws-losses against each column. */
export function matrixMarkdown(m: Map<string, Map<string, MatchupCell>>, archetypes: Archetype[] = ARCHETYPES): string {
  const keys = archetypes.map((a) => a.key);
  const lines = [`| vs | ${keys.join(' | ')} | beats |`, `|---|${keys.map(() => '---').join('|')}|---|`];
  for (const a of keys) {
    const row = m.get(a)!;
    const cells = keys.map((b) => {
      if (a === b) return '·';
      const c = row.get(b)!;
      return `${beats(c) ? '**' : ''}${c.wins}-${c.draws}-${c.losses}${beats(c) ? '**' : ''}`;
    });
    lines.push(`| ${a} | ${cells.join(' | ')} | ${[...row.values()].filter(beats).length}/${keys.length - 1} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// M8.8: the round robin in parallel worker processes
// ---------------------------------------------------------------------------

/** Every archetype a duel can name, by key: the round robin, the twins and the extra checks. */
export function archetypeByKey(key: string): Archetype {
  const pool = [...ALL_ARCHETYPES, ...Object.values(NORMAL_TWINS), RUSH, TEMPLATE_MIX, OPEN_FORTRESS, DORMANT, RUNNER_TRICKLE, SUPPORT_ONLY];
  const a = pool.find((x) => x.key === key);
  if (!a) throw new Error(`no archetype ${key}`);
  return a;
}

/** The balance config with a deep-partial patch on top (a tuning run), validated like a live config. */
export function balanceConfig(patch?: unknown): GameConfig {
  return patch === undefined ? BALANCE_CONFIG : ConfigSchema.parse(deepMerge(BALANCE_CONFIG, patch));
}

/** Element and support activity of one side, summed over its battles. */
export interface EffectTotals {
  shatters: number;
  arcs: number;
  overloads: number;
  burnDamage: number;
  healed: number;
  cleanses: number;
}

/** Everything a pair's battles tell the balance test (A's side of the cell). */
export interface PairResult {
  a: string;
  b: string;
  cell: MatchupCell;
  /** Battles won by a side with only walls standing (§5.2: must be none). */
  wallOnlyWins: number;
  /** Battles with at least one heal, the most HP any body got in one 60-tick window (as a fraction of its max HP), the last frame with a heal. */
  healBattles: number;
  worstHealWindow: number;
  lastHealTick: number;
  effects: [EffectTotals, EffectTotals];
  /** Engine time and ticks of all its battles. */
  ms: number;
  ticks: number;
}

const noEffects = (): EffectTotals => ({ shatters: 0, arcs: 0, overloads: 0, burnDamage: 0, healed: 0, cleanses: 0 });

/**
 * The heal limits of one battle (§5.5): HP restored per body per 60-tick
 * window (frames come every 2 ticks, and the two ticks of a frame are always
 * in the same window) as a fraction of the body's max HP, and the last frame
 * with a heal.
 */
export function healLimits(b: BalanceBattle, ticksPerWindow = 60): { worst: number; last: number } {
  const sums = new Map<string, number>();
  let last = 0;
  for (const h of b.heals) {
    const k = `${h.to}@${Math.floor((h.t - 1) / ticksPerWindow)}`;
    sums.set(k, (sums.get(k) ?? 0) + h.amount);
    last = Math.max(last, h.t);
  }
  let worst = 0;
  for (const [k, sum] of sums) worst = Math.max(worst, sum / (b.maxHp.get(k.split('@')[0]!) ?? Infinity));
  return { worst, last };
}

// ---------------------------------------------------------------------------
// Battle jobs, records and the result cache (fast balance runs)
// ---------------------------------------------------------------------------

/**
 * One duel of a round robin: A in zone `zones[0]`, B in `zones[1]`. The
 * archetypes travel whole (custom armies included), so a worker needs no lookup.
 */
export interface BattleJob {
  a: Archetype;
  b: Archetype;
  style: MapStyle;
  players: number;
  zones: [number, number];
  seed: number;
}

/** What a balance run keeps of one duel (A's side; a cache line). */
export interface BattleRecord {
  outcome: 1 | 0 | -1;
  /** Won by a side with only walls standing (§5.2: must never happen). */
  wallOnlyWin: boolean;
  /** Battles with heals: the worst 60-tick heal window and the last heal tick (healLimits). */
  heal: { worst: number; last: number } | null;
  effects: [EffectTotals, EffectTotals];
  /** Engine wall-clock ms when it was played (a cached record keeps its first time). */
  ms: number;
  ticks: number;
}

/** A pair's battles in the round-robin order: every site, zone pair, both orders, every seed. */
export function pairJobs(a: Archetype, b: Archetype, seeds: number[] = SEEDS): BattleJob[] {
  const jobs: BattleJob[] = [];
  for (const site of DUEL_SITES)
    for (const [z1, z2] of site.pairs)
      for (const [za, zb] of [[z1, z2], [z2, z1]] as Array<[number, number]>)
        for (const seed of seeds) jobs.push({ a, b, style: site.style, players: site.players, zones: [za, zb], seed });
  return jobs;
}

/** Play one duel and keep its record. */
export async function playJob(job: BattleJob, config: GameConfig = BALANCE_CONFIG, runner: BalanceRunnerKind = 'lean'): Promise<BattleRecord> {
  const battle = await playBalanceBattle(job.style, job.players, [{ archetype: job.a, zone: job.zones[0] }, { archetype: job.b, zone: job.zones[1] }], job.seed, config, false, runner);
  const [pa, pb] = battle.places as [number, number];
  const outcome = pa < pb ? 1 : pa > pb ? -1 : 0;
  return {
    outcome,
    wallOnlyWin: outcome !== 0 && !hasFighter(battle.standing[outcome === 1 ? 0 : 1]!),
    heal: battle.heals.length > 0 ? healLimits(battle, config.timers.ticksPerSecond) : null,
    effects: battle.effects as [EffectTotals, EffectTotals],
    ms: battle.ms,
    ticks: battle.result.endTick,
  };
}

const emptyPair = (a: string, b: string): PairResult => ({
  a,
  b,
  cell: { wins: 0, draws: 0, losses: 0 },
  wallOnlyWins: 0,
  healBattles: 0,
  worstHealWindow: 0,
  lastHealTick: 0,
  effects: [noEffects(), noEffects()],
  ms: 0,
  ticks: 0,
});

/** Add one duel's record to a pair's result. */
export function addRecord(r: PairResult, rec: BattleRecord): PairResult {
  if (rec.outcome === 1) r.cell.wins++;
  else if (rec.outcome === -1) r.cell.losses++;
  else r.cell.draws++;
  if (rec.wallOnlyWin) r.wallOnlyWins++;
  if (rec.heal) {
    r.healBattles++;
    r.worstHealWindow = Math.max(r.worstHealWindow, rec.heal.worst);
    r.lastHealTick = Math.max(r.lastHealTick, rec.heal.last);
  }
  rec.effects.forEach((e, i) => {
    const t = r.effects[i]!;
    for (const k of Object.keys(t) as Array<keyof EffectTotals>) t[k] += e[k];
  });
  r.ms += rec.ms;
  r.ticks += rec.ticks;
  return r;
}

/** A pair's result from its records (in `pairJobs` order). */
export function pairResult(a: string, b: string, records: BattleRecord[]): PairResult {
  const r = emptyPair(a, b);
  for (const rec of records) addRecord(r, rec);
  return r;
}

const entrantDigests = new Map<string, string>();

/** Everything a battle sees of one army in one zone: priced designs (with the cost breakdown), placements, brains. */
function entrantDigest(a: Archetype, style: MapStyle, players: number, zone: number, config: GameConfig, cfgKey: string): string {
  // The config key leaves the prices out (they are hashed through the priced designs), so the memo needs them.
  const memo = `${cfgKey} ${JSON.stringify(config.cost)} ${style} ${players} ${zone} ${JSON.stringify(a)}`;
  let d = entrantDigests.get(memo);
  if (!d) {
    const { units, placements } = deploy(a, mapFor(style, players).zones[zone]!, config);
    const priced = units.map((u) => ({ ...u, breakdown: computeCost(u.stats, config.cost, pricingOf(config)).breakdown }));
    d = sha(JSON.stringify({ units: priced, placements, brains: brainOptions(a) }));
    entrantDigests.set(memo, d);
  }
  return d;
}

/** The cache key of a duel (helpers/balanceCache.ts): engine, config, both armies as deployed, map, zones, seed, runner. */
export function jobKey(job: BattleJob, config: GameConfig, runner: BalanceRunnerKind = 'lean'): string {
  const ck = configKey(config);
  const da = entrantDigest(job.a, job.style, job.players, job.zones[0], config, ck);
  const db = entrantDigest(job.b, job.style, job.players, job.zones[1], config, ck);
  return sha(`${engineHash()} ${ck} ${job.style} ${job.players} ${job.zones.join(',')} ${job.seed} ${runner} ${da} ${db}`);
}

/** How `runJobs` plays: worker processes (BALANCE_WORKERS), the cache (BALANCE_CACHE), the runner. */
export interface RunOptions {
  workers?: number;
  cache?: boolean;
  runner?: BalanceRunnerKind;
  /** A pool to reuse (several calls with the same config; made on first need), else one for this call. */
  pool?: () => BalancePool;
  /** Called after each batch of played battles (progress). */
  onProgress?: (done: number, total: number) => void;
}

/** Counters of the last runs in this process (the CLI reports them). */
export const runStats = { cached: 0, played: 0 };

/**
 * Records of the jobs, in order: cached ones from disk, the rest played (in
 * worker processes when there are enough of them) and then cached.
 */
export async function runJobs(jobs: BattleJob[], configPatch?: unknown, opts: RunOptions = {}): Promise<BattleRecord[]> {
  const config = balanceConfig(configPatch);
  const runner = opts.runner ?? 'lean';
  const useCache = opts.cache ?? cacheEnabled();
  const cache = useCache ? new BattleCache<BattleRecord>(config) : undefined;
  const keys = useCache ? jobs.map((j) => jobKey(j, config, runner)) : [];
  const out: Array<BattleRecord | undefined> = jobs.map((_, i) => (cache ? cache.get(keys[i]!) : undefined));
  const missing = out.flatMap((r, i) => (r ? [] : [i]));
  runStats.cached += jobs.length - missing.length;
  runStats.played += missing.length;
  if (missing.length === 0) return out as BattleRecord[];
  const workers = opts.workers ?? balanceWorkers();
  let played: BattleRecord[];
  if (workers <= 1 || missing.length < 16) {
    played = [];
    for (const i of missing) played.push(await playJob(jobs[i]!, config, runner));
  } else if (opts.pool) played = await opts.pool().run(missing.map((i) => jobs[i]!), opts.onProgress);
  else {
    const pool = new BalancePool(Math.min(workers, missing.length), configPatch, runner);
    try {
      played = await pool.run(missing.map((i) => jobs[i]!), opts.onProgress);
    } finally {
      pool.close();
    }
  }
  missing.forEach((i, k) => (out[i] = played[k]));
  cache?.putAll(missing.map((i, k) => [keys[i]!, played[k]!]));
  return out as BattleRecord[];
}

/** One pair over every site, zone pair, both orders and the seeds (the round-robin cell plus the M8.8 checks). */
export async function playPair(a: Archetype, b: Archetype, seeds: number[] = SEEDS, config: GameConfig = BALANCE_CONFIG): Promise<PairResult> {
  const r = emptyPair(a.key, b.key);
  for (const job of pairJobs(a, b, seeds)) addRecord(r, await playJob(job, config));
  return r;
}

/** Worker processes for `playPairs` (env BALANCE_WORKERS; 0 or 1 = in this process). */
export function balanceWorkers(): number {
  const env = process.env.BALANCE_WORKERS;
  if (env !== undefined && env !== '') return Math.max(1, Math.floor(Number(env)) || 1);
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

/**
 * Play the pairs (by archetype key): a full M8.8 round robin is several
 * thousand battles, so they are shared out over worker processes
 * (helpers/balancePool.ts), and every battle already in the result cache
 * (helpers/balanceCache.ts) is read instead of played. Results come back in
 * the order of `pairs`; the sim is deterministic, so this is the same as
 * playing them one by one.
 */
export async function playPairs(pairs: Array<[string, string]>, seeds: number[] = SEEDS, configPatch?: unknown, workers = balanceWorkers(), opts: Omit<RunOptions, 'workers'> = {}): Promise<PairResult[]> {
  const perPair = pairs.map(([a, b]) => pairJobs(archetypeByKey(a), archetypeByKey(b), seeds));
  const records = await runJobs(perPair.flat(), configPatch, { ...opts, workers });
  let at = 0;
  return pairs.map(([a, b], i) => {
    const n = perPair[i]!.length;
    const r = pairResult(a, b, records.slice(at, at + n));
    at += n;
    return r;
  });
}

/** Every pair of the keys (i < j), in round-robin order. */
export const allPairs = (keys: string[]): Array<[string, string]> => keys.flatMap((a, i) => keys.slice(i + 1).map((b) => [a, b] as [string, string]));

/** The matrix (row: W-D-L against each column) of pair results, restricted to `keys`. */
export function matrixOf(results: PairResult[], keys: string[]): Map<string, Map<string, MatchupCell>> {
  const m = new Map<string, Map<string, MatchupCell>>(keys.map((k) => [k, new Map<string, MatchupCell>()]));
  for (const r of results) {
    if (!m.has(r.a) || !m.has(r.b)) continue;
    m.get(r.a)!.set(r.b, { ...r.cell });
    m.get(r.b)!.set(r.a, { wins: r.cell.losses, draws: r.cell.draws, losses: r.cell.wins });
  }
  // Keep each row in `keys` order (the Markdown table and the reports read it that way).
  for (const [k, row] of m) m.set(k, new Map(keys.filter((b) => b !== k && row.has(b)).map((b) => [b, row.get(b)!])));
  return m;
}

/** A row's round-robin wins and battles. */
export function rowRate(row: Map<string, MatchupCell>): { wins: number; battles: number; rate: number } {
  let wins = 0;
  let battles = 0;
  for (const c of row.values()) {
    wins += c.wins;
    battles += c.wins + c.draws + c.losses;
  }
  return { wins, battles, rate: battles ? wins / battles : 0 };
}

/** A 2-team Lanes battle: team 0 takes block `round % 2` (zones 0..n-1 = the top row), team 1 the other (§9.2 team blocks). */
export async function lanesTeams(players: 4 | 8, team0: Archetype[], team1: Archetype[], round: number, seed: number, config?: GameConfig): Promise<BalanceBattle & { winner: 0 | 1 | null }> {
  const n = players / 2;
  if (team0.length !== n || team1.length !== n) throw new Error(`Lanes ${players} needs ${n} players per team`);
  const block = (t: number) => ((t + round) % 2) * n;
  const entrants: Entrant[] = [
    ...team0.map((archetype, m) => ({ archetype, zone: block(0) + ((m + round) % n), teamId: 0 })),
    ...team1.map((archetype, m) => ({ archetype, zone: block(1) + ((m + round) % n), teamId: 1 })),
  ];
  const b = await balanceBattle('lanes', players, entrants, seed, config);
  const teams = b.result.teams ?? [];
  const first = teams.filter((t) => t.place === 1);
  return { ...b, winner: first.length === 1 ? (first[0]!.teamId as 0 | 1) : null };
}
