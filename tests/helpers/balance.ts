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

/** The designs the archetypes are built from (§6 M8.8 reference units, walls, minions and factories). */
export const UNITS = {
  /** Basic Soldier (template, $522). */
  soldier: unitStats({ name: 'Basic Soldier', type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60 }),
  /** Basic Tower (template, $970: range 140, 625 HP). */
  tower: unitStats({ name: 'Basic Tower', type: 'tower', maxHealth: 625, damage: 75, range: 140, speed: 0, attackCooldown: 45 }),
  /** The Max-cost Brick: the most HP × damage under the $2,500 cap ($2,493, power ×1.37). */
  brick: unitStats({ name: 'Brick', type: 'soldier', maxHealth: 1700, damage: 270, range: 40, speed: 1.5, attackCooldown: 60, size: 16 }),
  /** Half Tank ($1,120). */
  tank: unitStats({ name: 'Half Tank', type: 'soldier', maxHealth: 1250, damage: 100, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }),
  /** Huge Tank: max HP ($2,459). */
  hugeTank: unitStats({ name: 'Huge Tank', type: 'soldier', maxHealth: 2500, damage: 100, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }),
  scout: unitStats({ name: 'Scout', type: 'soldier', maxHealth: 300, damage: 40, range: 20, speed: 2.5, attackCooldown: 60, size: 6 }),
  /** The stress scout: the same Scout with its HP raised until 11 copies fill the budget (§14 M8.8 `scoutsFilled`). */
  scoutFilled: unitStats({ name: 'Padded Scout', type: 'soldier', maxHealth: 340, damage: 40, range: 20, speed: 2.5, attackCooldown: 60, size: 6 }),
  /** Sniper Tower ($1,544). */
  sniper: unitStats({ name: 'Sniper Tower', type: 'tower', maxHealth: 400, damage: 200, range: 280, speed: 0, attackCooldown: 60 }),
  /** Max Sniper: max range ($1,905). */
  maxSniper: unitStats({ name: 'Max Sniper', type: 'tower', maxHealth: 400, damage: 250, range: 300, speed: 0, attackCooldown: 60 }),
  /** Glass Cannon: max damage, minimum-ish HP ($1,347). */
  glass: unitStats({ name: 'Glass Cannon', type: 'soldier', maxHealth: 300, damage: 300, range: 40, speed: 2, attackCooldown: 60, size: 8 }),
  /** The Basic Soldier with an element ($626 each). */
  fireSoldier: unitStats({ name: 'Fire Soldier', type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, element: 'fire' }),
  stormSoldier: unitStats({ name: 'Lightning Soldier', type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, element: 'lightning' }),
  /** Frost Archer: a ranged ice soldier ($765). */
  frostArcher: unitStats({ name: 'Frost Archer', type: 'soldier', maxHealth: 400, damage: 40, range: 140, speed: 1.5, attackCooldown: 60, size: 9, element: 'ice' }),
  /** Archer: the Frost Archer made normal (the shatter squad's twin). */
  archer: unitStats({ name: 'Archer', type: 'soldier', maxHealth: 400, damage: 40, range: 140, speed: 1.5, attackCooldown: 60, size: 9 }),
  /** Ice Tower: the Basic Tower in ice ($1,164). */
  iceTower: unitStats({ name: 'Ice Tower', type: 'tower', maxHealth: 625, damage: 75, range: 140, speed: 0, attackCooldown: 45, element: 'ice' }),
  /** Frost Sniper: the Sniper Tower in ice ($1,853). */
  frostSniper: unitStats({ name: 'Frost Sniper', type: 'tower', maxHealth: 400, damage: 200, range: 280, speed: 0, attackCooldown: 60, element: 'ice' }),
  /** Mortar Tower: splash 40 ($1,198). */
  mortar: unitStats({ name: 'Mortar Tower', type: 'tower', maxHealth: 625, damage: 100, range: 140, speed: 0, attackCooldown: 60, splashRadius: 40 }),
  /** Fire Mortar: the Mortar Tower in fire ($1,438). */
  fireMortar: unitStats({ name: 'Fire Mortar', type: 'tower', maxHealth: 625, damage: 100, range: 140, speed: 0, attackCooldown: 60, element: 'fire', splashRadius: 40 }),
  /** Fireball Catapult: fire splash 40 ($2,153). */
  catapult: unitStats({ name: 'Fireball Catapult', type: 'tower', maxHealth: 600, damage: 150, range: 220, speed: 0, attackCooldown: 60, element: 'fire', splashRadius: 40 }),
  /** Blizzard Totem: damage 0, ice splash 60 ($1,275). Not a fighter. */
  blizzardTotem: unitStats({ name: 'Blizzard Totem', type: 'tower', maxHealth: 650, damage: 0, range: 160, speed: 0, attackCooldown: 60, element: 'ice', splashRadius: 60 }),
  /** Field Medic: damage 0, heal 60 in 120 px ($751). Not a fighter. */
  medic: unitStats({ name: 'Field Medic', type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'heal', power: 60, range: 120 } }),
  /** Shield Bearer: a tough hitter with a 25% shield aura in 80 px ($977). */
  shieldBearer: unitStats({ name: 'Shield Bearer', type: 'soldier', maxHealth: 1000, damage: 30, range: 30, speed: 1.2, attackCooldown: 60, size: 14, support: { kind: 'shield', power: 25, range: 80 } }),
  /** Healing Shrine: a damage-0 healing tower, heal 80 in 160 px ($1,009). Not a fighter. */
  shrine: unitStats({ name: 'Healing Shrine', type: 'tower', maxHealth: 800, damage: 0, range: 20, speed: 0, attackCooldown: 60, support: { kind: 'heal', power: 80, range: 160 } }),
  /** War Drummer: damage 0, might 30% in 100 px ($595). Not a fighter. */
  drummer: unitStats({ name: 'War Drummer', type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'might', power: 30, range: 100 } }),
  /** Wind Banner: damage 0, haste 30% in 100 px ($652). Not a fighter. */
  banner: unitStats({ name: 'Wind Banner', type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'haste', power: 30, range: 100 } }),
  /** Basic Wall (template, $149). */
  wall: buildingStats({ name: 'Basic Wall', type: 'wall', maxHealth: 2000 }),
  /** Basic Factory (template, $982): 5 grunts. */
  factory: buildingStats({ name: 'Basic Factory', type: 'factory', maxHealth: 1500, productionInterval: 900 }),
  /** Swarm Factory ($1,423): 8 grunts, one every 10 s. */
  swarmFactory: buildingStats({ name: 'Swarm Factory', type: 'factory', maxHealth: 1500, productionInterval: 600 }),
  /** Fortress Factory ($1,544): max HP, slowest (2 grunts). */
  fortressFactory: buildingStats({ name: 'Fortress Factory', type: 'factory', maxHealth: 5000, productionInterval: 1800 }),
  /** Archer Nest (M8.6, $1,807): 8 archers, one every 10 s. */
  archerNest: buildingStats({ name: 'Archer Nest', type: 'factory', maxHealth: 1500, productionInterval: 600, produces: 'archer' }),
  /** Runner Rush with burst 4 (M8.6, $1,655): 8 runners, released 4 at a time. */
  runnerRush: buildingStats({ name: 'Runner Rush', type: 'factory', maxHealth: 1500, productionInterval: 600, produces: 'runner', burst: 4 }),
  /** The same Runner Rush releasing each runner at once (burst 1), for the burst comparison. */
  runnerTrickle: buildingStats({ name: 'Runner Trickle', type: 'factory', maxHealth: 1500, productionInterval: 600, produces: 'runner', burst: 1 }),
  /** Brute Forge (M8.6, $1,935): 8 brutes, one every 10 s. */
  bruteForge: buildingStats({ name: 'Brute Forge', type: 'factory', maxHealth: 1500, productionInterval: 600, produces: 'brute' }),
  /** Ice Archer Nest (M8.8, $2,119): 8 ice archers. */
  iceArcherNest: buildingStats({ name: 'Ice Archer Nest', type: 'factory', maxHealth: 1500, productionInterval: 600, produces: 'archer', minionElement: 'ice' }),
  /** Fire Brute Pack (M8.8, $1,512): 5 fire brutes. */
  fireBrutePack: buildingStats({ name: 'Fire Brute Pack', type: 'factory', maxHealth: 1500, productionInterval: 900, produces: 'brute', minionElement: 'fire' }),
  /** Storm Runners (M8.8, $1,935): 8 lightning runners, burst 4. */
  stormRunners: buildingStats({ name: 'Storm Runners', type: 'factory', maxHealth: 1500, productionInterval: 600, produces: 'runner', burst: 4, minionElement: 'lightning' }),
  /** Medic Tent (M8.8, $1,272): 5 medics. Not a fighter. */
  medicTent: buildingStats({ name: 'Medic Tent', type: 'factory', maxHealth: 1500, productionInterval: 900, produces: 'medic' }),
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

/** The §14 archetypes, $5,000 budget each (checked by the test). M8.8: Half Tanks 5 → 4 (5 cost $5,610). */
export const ARCHETYPES: Archetype[] = [
  { key: 'bricks', label: '2 max-cost bricks', army: [['brick', 2]] },
  { key: 'templates', label: '7 templates (4 soldiers + 3 towers)', army: [['soldier', 4], ['tower', 3]] },
  { key: 'tanks', label: 'tank army (4 Half Tanks)', army: [['tank', 4]] },
  { key: 'turtle', label: 'all-tower turtle (5 Basic Towers)', army: [['tower', 5]] },
  { key: 'scouts', label: 'scout swarm (11 Scouts)', army: [['scout', 11]] },
  { key: 'snipers', label: 'sniper nest (3 Sniper Towers)', army: [['sniper', 3]] },
];

/**
 * The M8.5 building archetypes (§6 "Example armies with buildings"). Copies
 * are placed in army order into the front cells, so the walls listed first
 * form the front line and the fighters listed after them stand behind it.
 * M8.8 refit: walls + rush 9 → 8 soldiers, all four templates 5 → 4.
 */
export const BUILDING_ARCHETYPES: Archetype[] = [
  { key: 'fortress', label: 'wall fortress (11 Basic Walls sealing in 3 Basic Towers)', army: [['wall', 11], ['tower', 3]], layout: 'seal' },
  { key: 'snipewall', label: 'walled sniper nest (6 Basic Walls in front of 2 Sniper Towers + 1 Basic Tower)', army: [['wall', 6], ['sniper', 2], ['tower', 1]], layout: 'nest' },
  { key: 'swarm', label: 'factory swarm (4 Basic Soldiers in front of 2 Swarm Factories)', army: [['soldier', 4], ['swarmFactory', 2]] },
  { key: 'wallrush', label: 'walls + rush (4 Basic Walls in front of 8 Basic Soldiers)', army: [['wall', 4], ['soldier', 8]] },
  { key: 'mixed', label: 'mixed (4 Basic Soldiers, 6 Basic Walls, 2 Basic Towers behind them)', army: [['soldier', 4], ['wall', 6], ['tower', 2]] },
  { key: 'quad', label: 'all four templates (4 Basic Soldiers, 4 Basic Walls, 1 Basic Tower, 1 Basic Factory)', army: [['soldier', 4], ['wall', 4], ['tower', 1], ['factory', 1]] },
  { key: 'bunker', label: 'all-building bunker (2 Basic Towers in front of 2 Swarm Factories)', army: [['tower', 2], ['swarmFactory', 2]] },
];

/** The plan §14 wall fortress: 10 Basic Walls in a U (front row + both outer columns of rows 1-2), 3 Basic Towers on rows 3-4. */
export const OPEN_FORTRESS: Archetype = { key: 'openfort', label: 'open wall fortress (10 Basic Walls in a U round 3 Basic Towers)', army: [['wall', 10], ['tower', 3]], layout: 'u' };

/**
 * The M8.6 minion-kind archetypes (§5.3, §14): each kind with the order its
 * CLAUDE.md example gives, and a burst. M8.8 refit: the archer nest 4 → 2
 * walls, the brute breakers 3 → 2 soldiers.
 */
export const KIND_ARCHETYPES: Archetype[] = [
  { key: 'archers', label: 'archer nest (2 Basic Walls, 1 Basic Tower, 2 Archer Nests guarding it)', army: [['wall', 2], ['tower', 1], ['archerNest', 2]], factoryBrain: 'guard' },
  { key: 'runners', label: 'runner swarm (2 Basic Soldiers, 2 burst-4 Runner Rushes swarming the weakest enemy)', army: [['soldier', 2], ['runnerRush', 2]], factoryBrain: 'swarm' },
  { key: 'brutes', label: 'brute breakers (2 Basic Soldiers, 2 Brute Forges swarming the nearest enemy wall)', army: [['soldier', 2], ['bruteForge', 2]], factoryBrain: 'breach' },
  { key: 'homeguard', label: 'grunt home guard (2 Basic Towers, 2 Swarm Factories on defend)', army: [['tower', 2], ['swarmFactory', 2]], factoryBrain: 'defend' },
];

/**
 * M8.8 specialist archetypes (§14 M8.8 balance, item 2): one stat pushed to
 * the max now that a maxed stat costs 2× (was 3×), and the scout-swarm stress
 * army (the spec's watch item).
 */
export const SPECIALIST_ARCHETYPES: Archetype[] = [
  { key: 'hugetanks', label: '2 Huge Tanks (max HP)', army: [['hugeTank', 2]] },
  { key: 'glass', label: '3 Glass Cannons (max damage) + 1 Basic Soldier', army: [['glass', 3], ['soldier', 1]] },
  { key: 'longbow', label: '2 Max Snipers (max range) + 2 Basic Soldiers', army: [['soldier', 2], ['maxSniper', 2]] },
  { key: 'scoutsFilled', label: 'padded scout swarm (11 Scouts with HP raised to fill the budget)', army: [['scoutFilled', 11]] },
];

/**
 * M8.8 element and support archetypes (§6 "M8.8 example armies", §14 M8.8
 * balance, item 3), plus the fire-splash bombard and the storm-runner factories.
 */
export const ELEMENT_ARCHETYPES: Archetype[] = [
  { key: 'firesquad', label: 'fire squad (4 Fire Soldiers, 1 Basic Soldier, 2 Basic Towers)', army: [['fireSoldier', 4], ['soldier', 1], ['tower', 2]] },
  { key: 'shatter', label: 'shatter squad (5 Fire Soldiers + 2 Frost Archers)', army: [['fireSoldier', 5], ['frostArcher', 2]] },
  { key: 'frostnest', label: 'frost nest (1 Basic Soldier holding by 2 Ice Towers and 1 Frost Sniper)', army: [['soldier', 1], ['iceTower', 2], ['frostSniper', 1]], soldierBrain: 'hold' },
  { key: 'storm', label: 'storm crowd (7 Lightning Soldiers)', army: [['stormSoldier', 7]] },
  { key: 'mortars', label: 'mortar battery (4 Mortar Towers)', army: [['mortar', 4]] },
  { key: 'firenest', label: 'fire splash nest (6 Basic Walls closing in 2 Fire Mortars + 1 Basic Tower)', army: [['wall', 6], ['fireMortar', 2], ['tower', 1]], layout: 'nest' },
  { key: 'icewall', label: 'ice wall + snipers (6 Basic Walls closing in 1 Frost Sniper, 1 Ice Tower, 1 Basic Tower)', army: [['wall', 6], ['frostSniper', 1], ['iceTower', 1], ['tower', 1]], layout: 'nest' },
  { key: 'bombard', label: 'fire-splash bombard (1 Basic Soldier, 2 Fireball Catapults)', army: [['soldier', 1], ['catapult', 2]] },
  { key: 'blizzard', label: 'blizzard + fire (5 Fire Soldiers and 1 Basic Soldier holding by 1 Blizzard Totem)', army: [['fireSoldier', 5], ['soldier', 1], ['blizzardTotem', 1]], soldierBrain: 'hold' },
  { key: 'healerball', label: 'healer ball (2 Half Tanks, 1 Shield Bearer, 1 Basic Soldier, 1 Field Medic)', army: [['tank', 2], ['shieldBearer', 1], ['soldier', 1], ['medic', 1]] },
  { key: 'buffedrush', label: 'buffed rush (6 Basic Soldiers, 1 War Drummer, 1 Wind Banner, 2 Basic Walls)', army: [['soldier', 6], ['drummer', 1], ['banner', 1], ['wall', 2]] },
  { key: 'shieldwall', label: 'shield wall (2 Shield Bearers in front of 3 Basic Towers)', army: [['shieldBearer', 2], ['tower', 3]] },
  { key: 'bigFriends', label: 'Huge Tank + friends (1 Huge Tank, 1 Basic Soldier and 1 Field Medic holding by 1 Basic Tower)', army: [['hugeTank', 1], ['soldier', 1], ['medic', 1], ['tower', 1]], soldierBrain: 'hold' },
  {
    key: 'elemfactories',
    label: 'elemental factories (2 Basic Soldiers, an Ice Archer Nest guarding them, a Fire Brute Pack)',
    army: [['soldier', 2], ['iceArcherNest', 1], ['fireBrutePack', 1]],
    factoryBrain: { iceArcherNest: 'guardTank', fireBrutePack: 'rally' },
  },
  { key: 'stormrunners', label: 'storm runners (1 Basic Soldier, 2 burst-4 lightning Runner factories)', army: [['soldier', 1], ['stormRunners', 2]] },
  { key: 'medictent', label: 'medic tent + tanks (2 Half Tanks, 2 Basic Soldiers, a Medic Tent guarding the tank)', army: [['tank', 2], ['soldier', 2], ['medicTent', 1]], factoryBrain: 'guardTank' },
];

/** The burst-1 twin of the runner swarm (not in the round robin): the burst comparison. */
export const RUNNER_TRICKLE: Archetype = {
  key: 'trickle',
  label: 'runner trickle (2 Basic Soldiers, 2 burst-1 Runner Rushes swarming the weakest enemy)',
  army: [['soldier', 2], ['runnerTrickle', 2]],
  factoryBrain: 'swarm',
};

/**
 * Every round-robin archetype: the six §14 ones, the M8.5 building ones, the
 * M8.6 kind ones (the first 17: the M8.7 matrix), then the M8.8 specialist and
 * element/support ones.
 */
export const ALL_ARCHETYPES: Archetype[] = [...ARCHETYPES, ...BUILDING_ARCHETYPES, ...KIND_ARCHETYPES, ...SPECIALIST_ARCHETYPES, ...ELEMENT_ARCHETYPES];

/**
 * M8.8 "no element dominates per dollar" twins (not in the round robin): the
 * element army made `normal`, with the leftover money spent on Basic Soldiers.
 */
export const NORMAL_TWINS: Record<string, Archetype> = {
  firesquad: { key: 'firesquadNormal', label: 'fire squad made normal (5 Basic Soldiers, 2 Basic Towers)', army: [['soldier', 5], ['tower', 2]] },
  shatter: { key: 'shatterNormal', label: 'shatter squad without ice (5 Fire Soldiers, 2 Archers, 1 Basic Soldier)', army: [['fireSoldier', 5], ['archer', 2], ['soldier', 1]] },
  storm: { key: 'stormNormal', label: 'storm crowd made normal (9 Basic Soldiers)', army: [['soldier', 9]] },
  frostnest: {
    key: 'frostnestNormal',
    label: 'frost nest made normal (2 Basic Soldiers holding by 2 Basic Towers and 1 Sniper Tower)',
    army: [['soldier', 2], ['tower', 2], ['sniper', 1]],
    soldierBrain: 'hold',
  },
};

/**
 * The dormant-factory turtle (not in the round robin): walls in front of two
 * Fortress Factories that never build. It deals no damage; unbuilt minions
 * must not keep it alive or win it the timeout (§9.3 canMake).
 */
export const DORMANT: Archetype = {
  key: 'dormant',
  label: 'dormant factories (10 Basic Walls in front of 2 holding Fortress Factories)',
  army: [['wall', 10], ['fortressFactory', 2]],
  holdFactories: true,
};

/** The "soldier rush" of the turtle-vs-rush check: 9 Basic Soldiers (M8.8: 10 cost $5,220). */
export const RUSH: Archetype = { key: 'rush', label: 'soldier rush (9 Basic Soldiers)', army: [['soldier', 9]] };
/** The other plain template army (watch item, measured by scripts/balance-matrix.ts, not in the round robin): 5 Basic Soldiers + 2 Basic Towers. */
export const TEMPLATE_MIX: Archetype = { key: 'tmix', label: 'templates mixed (5 Basic Soldiers + 2 Basic Towers)', army: [['soldier', 5], ['tower', 2]] };

/** M8.8: a side of damage-0 units only (pure support: not fighters, §9.4), for the elimination check. */
export const SUPPORT_ONLY: Archetype = { key: 'supportonly', label: 'pure support (2 Field Medics, 2 War Drummers, 2 Wind Banners)', army: [['medic', 2], ['drummer', 2], ['banner', 2]] };

/** The economy the matrices are priced and fought on: the default config (M8.8). */
export const BALANCE_CONFIG: GameConfig = DEFAULT_CONFIG;

export const unitCost = (k: UnitKey, config: GameConfig = BALANCE_CONFIG): number => computeCost(UNITS[k], config.cost, pricingOf(config)).cost;

export function armyCost(a: Archetype, config: GameConfig = BALANCE_CONFIG): number {
  return a.army.reduce((sum, [k, n]) => sum + n * computeCost(statsOf(a, k), config.cost, pricingOf(config)).cost, 0);
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
    const cell = from.find((c) => !taken.has(`${c.col},${c.row}`))!;
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
