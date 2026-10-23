// Balance harness (plan §14 balance.test.ts, §6 "no single archetype
// dominates", §9 sudden death). Headless battles between $1,000 archetype
// armies with simple "chase nearest" bots, on real §9.2 maps.
//
// The runner here is a lean stand-in for the sandbox (no isolates, no deep
// copies: the brains never mutate their inputs), so a full 5400-tick battle
// takes tens of milliseconds and the test can afford a round robin over
// several maps, zone pairs and seeds. `npx tsx --conditions=source
// scripts/balance-matrix.ts` prints the same matrix for docs/balance.md.
//
// M8.5: the brains follow the wall-aware templates (skip walls as targets,
// smash an enemy wall after 120 ticks blocked; factories rally on the
// nearest enemy that isn't a wall), and BUILDING_ARCHETYPES add walls and
// factories. Walls run no code (the engine never asks the runner for them);
// minions run the engine's built-in AI.

import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  computeCost,
  pricingOf,
  mapFor,
  zoneCentredOnLine,
  GRID_SIZE,
  type Cell,
  type Facing,
  type GameConfig,
  type MapLayout,
  type MapStyle,
  type MapZone,
  type OtherView,
  type PlacementDTO,
  type SelfView,
  type StatsSnapshot,
  type UnitStats,
  type WorldView,
} from '@pixel-clash/shared';
import type { PlayerRunner, RunnerPlayer, SpawnResult, TickInput, TickResult, UnitOutput } from '../../packages/server/src/sandbox/runner.js';
import { runBattle, type BattlePlayerSetup, type BattleResult, type BattleUnitDesign } from '../../packages/server/src/sim/engine.js';
import { frontCells } from '../../packages/server/src/sim/autoPlace.js';
import { mulberry32 } from '../../packages/server/src/sim/prng.js';

type Rng = () => number;
type Action =
  | { action: 'idle' }
  | { action: 'move'; destination: { x: number; y: number } }
  | { action: 'attack'; targetId: string }
  | { action: 'rally'; destination: { x: number; y: number } }
  | { action: 'hold' };
type BrainFn = (self: SelfView, enemies: OtherView[], world: WorldView, rng: Rng) => Action;

const gap = (a: { x: number; y: number; radius: number }, b: { x: number; y: number; radius: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;

/**
 * "Chase nearest" (basic_soldier.js): walk to the nearest enemy that isn't a
 * wall (the nearest wall when only walls are left), hit it when in range;
 * stuck behind an enemy wall for 120 ticks: smash it (M8.5). The seed only
 * breaks near-ties (enemies within 8 px of the nearest gap), so seeds give
 * slightly different but sensible fights.
 */
const chaseNearest: BrainFn = (self, enemies, world, rng) => {
  if (enemies.length === 0) return { action: 'move', destination: world.center };
  const hit = (target: OtherView): Action => {
    if (gap(self, target) <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: target.id } : { action: 'idle' };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  };
  if (self.blockedTicks >= 120) {
    const wall = enemies.find((e) => e.id === self.blockedBy);
    if (wall) return hit(wall);
  }
  const fighters = enemies.filter((e) => e.type !== 'wall');
  const pool = fighters.length > 0 ? fighters : enemies;
  let best = Infinity;
  for (const e of pool) best = Math.min(best, gap(self, e));
  const near = pool.filter((e) => gap(self, e) <= best + 8);
  return hit(near[Math.floor(rng() * near.length)] ?? pool[0]!);
};

/** basic_tower.js: shoot the nearest enemy in range; a wall only when nothing else is in range. */
const shootNearest: BrainFn = (self, enemies) => {
  if (self.cooldownRemaining > 0) return { action: 'idle' };
  let target: OtherView | null = null;
  let best = Infinity;
  let wall: OtherView | null = null;
  let bestWall = Infinity;
  for (const e of enemies) {
    const g = gap(self, e);
    if (g > self.range) continue;
    if (e.type === 'wall') {
      if (g < bestWall) {
        bestWall = g;
        wall = e;
      }
    } else if (g < best) {
      best = g;
      target = e;
    }
  }
  const t = target ?? wall;
  return t ? { action: 'attack', targetId: t.id } : { action: 'idle' };
};

/** basic_factory.js: rally the minions on the nearest enemy that isn't a wall (else the centre). */
const rallyNearest: BrainFn = (self, enemies, world) => {
  let spot = world.center;
  let best = Infinity;
  for (const e of enemies) {
    if (e.type === 'wall') continue;
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < best) {
      best = d;
      spot = { x: e.x, y: e.y };
    }
  }
  return { action: 'rally', destination: spot };
};

/** A factory that never builds: it holds every tick. */
const holdForever: BrainFn = () => ({ action: 'hold' });

/** A sandbox stand-in: every instance runs the brain for its type; the PRNG is seeded per player (§8). */
export class BrainRunner implements PlayerRunner {
  readonly loadErrors = new Map<string, { message: string; line?: number }>();
  disposed = false;
  private readonly rng: Rng;

  constructor(
    readonly player: RunnerPlayer,
    /** The factories hold every tick (they never build: the dormant-factory turtle). */
    private readonly holdFactories = false,
  ) {
    this.rng = mulberry32(player.seed);
  }

  async spawn(): Promise<SpawnResult> {
    return { ok: true };
  }

  async tick(input: TickInput): Promise<TickResult> {
    const outputs: UnitOutput[] = [];
    for (const self of input.selves) {
      const brain = self.type === 'tower' ? shootNearest : self.type === 'factory' ? (this.holdFactories ? holdForever : rallyNearest) : chaseNearest;
      outputs.push({ instanceId: self.id, action: brain(self, input.enemies, input.world, this.rng) });
    }
    return { status: 'ok', outputs, elapsedMs: 0, slow: false, forged: 0 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Unit designs and $1,000 archetypes
// ---------------------------------------------------------------------------

function unitStats(s: Omit<UnitStats, 'color' | 'size' | 'shape'> & { size?: number }): StatsSnapshot {
  return Object.freeze({ color: '#888888', size: s.type === 'tower' ? 14 : 10, shape: 'circle', ...s }) as StatsSnapshot;
}

/** A wall or factory as the validator snapshots it (§5.2: no attack, no move, fixed size). */
function buildingStats(s: Pick<UnitStats, 'name' | 'type' | 'maxHealth' | 'productionInterval'>): StatsSnapshot {
  return Object.freeze({ color: '#8A8F98', shape: 'square', ...s, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: s.type === 'wall' ? 20 : 18 }) as StatsSnapshot;
}

/** The designs the archetypes are built from (§6 reference units where there is one). */
export const UNITS = {
  soldier: unitStats({ name: 'Basic Soldier', type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60 }),
  tower: unitStats({ name: 'Basic Tower', type: 'tower', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45 }),
  /** A ~$500 "brick": everything poured into one body. */
  brick: unitStats({ name: 'Brick', type: 'soldier', maxHealth: 430, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 16 }),
  /** §6 "Half Tank": the Big Tank at the HP that lets five fit in $1,000. */
  tank: unitStats({ name: 'Half Tank', type: 'soldier', maxHealth: 250, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }),
  bigTank: unitStats({ name: 'Big Tank', type: 'soldier', maxHealth: 500, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }),
  scout: unitStats({ name: 'Scout', type: 'soldier', maxHealth: 60, damage: 8, range: 20, speed: 2.5, attackCooldown: 60, size: 6 }),
  sniper: unitStats({ name: 'Sniper Tower', type: 'tower', maxHealth: 80, damage: 40, range: 280, speed: 0, attackCooldown: 60 }),
  /** §6 Basic Wall (template, M8.5). */
  wall: buildingStats({ name: 'Basic Wall', type: 'wall', maxHealth: 400 }),
  /** §6 Basic Factory (template): 5 minions. */
  factory: buildingStats({ name: 'Basic Factory', type: 'factory', maxHealth: 300, productionInterval: 900 }),
  /** §6 Swarm Factory: 8 minions, one every 10 s. */
  swarmFactory: buildingStats({ name: 'Swarm Factory', type: 'factory', maxHealth: 300, productionInterval: 600 }),
  /** A max-HP, slowest factory: mostly body (2 minions). */
  fortressFactory: buildingStats({ name: 'Fortress Factory', type: 'factory', maxHealth: 1000, productionInterval: 1800 }),
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
  layout?: 'seal' | 'u';
  /** Its factories hold every tick (never build). */
  holdFactories?: boolean;
}

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
 * N/S/E/W zones: the front row, then both flanks from the front back.
 */
export function sealCells(facing: Facing): Cell[] {
  const cells: Cell[] = [{ col: 0, row: 0 }];
  if (facing === 'diag') {
    for (let i = 1; i < GRID_SIZE; i++) cells.push({ col: i, row: 0 }, { col: 0, row: i });
    return cells;
  }
  for (let col = 1; col < GRID_SIZE; col++) cells.push({ col, row: 0 });
  for (let row = 1; row < GRID_SIZE; row++) cells.push({ col: 0, row }, { col: GRID_SIZE - 1, row });
  return cells;
}

/** The §14 archetypes, $1,000 budget each (checked by the test). */
export const ARCHETYPES: Archetype[] = [
  { key: 'bricks', label: '2 max-cost bricks', army: [['brick', 2]] },
  { key: 'templates', label: '7 templates (4 soldiers + 3 towers)', army: [['soldier', 4], ['tower', 3]] },
  { key: 'tanks', label: 'Big Tank army (5 Half Tanks)', army: [['tank', 5]] },
  { key: 'turtle', label: 'all-tower turtle (5 Basic Towers)', army: [['tower', 5]] },
  { key: 'scouts', label: 'scout swarm (11 Scouts)', army: [['scout', 11]] },
  { key: 'snipers', label: 'sniper nest (3 Sniper Towers)', army: [['sniper', 3]] },
];

/**
 * The M8.5 building archetypes (§6 "Example armies with buildings"). Copies
 * are placed in army order into the front cells, so the walls listed first
 * form the front line and the fighters listed after them stand behind it.
 */
export const BUILDING_ARCHETYPES: Archetype[] = [
  { key: 'fortress', label: 'wall fortress (11 Basic Walls sealing in 3 Basic Towers)', army: [['wall', 11], ['tower', 3]], layout: 'seal' },
  { key: 'snipewall', label: 'walled sniper nest (6 Basic Walls in front of 2 Sniper Towers + 1 Basic Tower)', army: [['wall', 6], ['sniper', 2], ['tower', 1]] },
  { key: 'swarm', label: 'factory swarm (4 Basic Soldiers in front of 2 Swarm Factories)', army: [['soldier', 4], ['swarmFactory', 2]] },
  { key: 'wallrush', label: 'walls + rush (4 Basic Walls in front of 9 Basic Soldiers)', army: [['wall', 4], ['soldier', 9]] },
  { key: 'mixed', label: 'mixed (4 Basic Soldiers, 6 Basic Walls, 2 Basic Towers behind them)', army: [['soldier', 4], ['wall', 6], ['tower', 2]] },
  { key: 'quad', label: 'all four templates (5 Basic Soldiers, 4 Basic Walls, 1 Basic Tower, 1 Basic Factory)', army: [['soldier', 5], ['wall', 4], ['tower', 1], ['factory', 1]] },
  { key: 'bunker', label: 'all-building bunker (2 Basic Towers in front of 2 Swarm Factories)', army: [['tower', 2], ['swarmFactory', 2]] },
];

/** The plan §14 wall fortress: 10 Basic Walls in a U (front row + both outer columns of rows 1-2), 3 Basic Towers on rows 3-4. */
export const OPEN_FORTRESS: Archetype = { key: 'openfort', label: 'open wall fortress (10 Basic Walls in a U round 3 Basic Towers)', army: [['wall', 10], ['tower', 3]], layout: 'u' };

/** Every round-robin archetype: the six §14 ones, then the M8.5 building ones. */
export const ALL_ARCHETYPES: Archetype[] = [...ARCHETYPES, ...BUILDING_ARCHETYPES];

/**
 * The dormant-factory turtle (not in the round robin): walls in front of two
 * Fortress Factories that never build. It deals no damage; unbuilt minions
 * must not keep it alive or win it the timeout (§9.3 canMake).
 */
export const DORMANT: Archetype = {
  key: 'dormant',
  label: 'dormant factories (4 Basic Walls in front of 2 holding Fortress Factories)',
  army: [['wall', 4], ['fortressFactory', 2]],
  holdFactories: true,
};

/** The "soldier rush" of the turtle-vs-rush check: 10 Basic Soldiers. */
export const RUSH: Archetype = { key: 'rush', label: 'soldier rush (10 Basic Soldiers)', army: [['soldier', 10]] };

export const unitCost = (k: UnitKey, config: GameConfig = DEFAULT_CONFIG): number => computeCost(UNITS[k], config.cost, pricingOf(config)).cost;

export function armyCost(a: Archetype, config: GameConfig = DEFAULT_CONFIG): number {
  return a.army.reduce((sum, [k, n]) => sum + n * unitCost(k, config), 0);
}

/** Copies placed (`group` 'fighters' = everything but walls, §5.2 Copies). */
export function armyCopies(a: Archetype, group: 'all' | 'fighters' | 'walls' | 'factories' = 'all'): number {
  const counts = (k: UnitKey) => {
    const t = UNITS[k].type;
    return group === 'all' || (group === 'walls' ? t === 'wall' : group === 'factories' ? t === 'factory' : t !== 'wall');
  };
  return a.army.reduce((sum, [k, n]) => sum + (counts(k) ? n : 0), 0);
}

/** Designs + front-first placements for an archetype in a zone. */
function deploy(a: Archetype, zone: MapZone, config: GameConfig): { units: BattleUnitDesign[]; placements: PlacementDTO[] } {
  const centred = zoneCentredOnLine(zone);
  const front = frontCells(zone.facing, centred);
  const u = a.layout === 'u' ? uCells(zone.facing, centred) : null;
  const wallCells = a.layout === 'seal' ? sealCells(zone.facing) : u ? u.walls : front;
  const fighterCells = u ? u.fighters : front;
  const taken = new Set<string>();
  const take = (from: Cell[]): Cell => {
    const cell = from.find((c) => !taken.has(`${c.col},${c.row}`))!;
    taken.add(`${cell.col},${cell.row}`);
    return cell;
  };
  const units: BattleUnitDesign[] = [];
  const placements: PlacementDTO[] = [];
  // With a wall layout the walls go first, so the fighters fill the cells left inside.
  const order = a.layout ? [...a.army].sort(([x], [y]) => Number(UNITS[y].type === 'wall') - Number(UNITS[x].type === 'wall')) : a.army;
  for (const [k, n] of order) {
    units.push({ unitId: k, stats: UNITS[k], cost: unitCost(k, config) });
    for (let i = 0; i < n; i++) {
      const cell = take(UNITS[k].type === 'wall' ? wallCells : fighterCells);
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
}

/** Run one battle with the given entrants on `style` with `players` zones. */
export async function balanceBattle(style: MapStyle, players: number, entrants: Entrant[], seed: number, config: GameConfig = DEFAULT_CONFIG): Promise<BalanceBattle> {
  const map: MapLayout = mapFor(style, players);
  const setups: BattlePlayerSetup[] = entrants.map((e, seat) => {
    const zone = map.zones[e.zone]!;
    const { units, placements } = deploy(e.archetype, zone, config);
    return {
      playerId: `p${seat}`,
      seat,
      zone,
      ...(e.teamId !== undefined ? { teamId: e.teamId } : {}),
      units,
      placements,
      runner: new BrainRunner({ playerId: `p${seat}`, seat, seed: seed + seat }, e.archetype.holdFactories === true),
    };
  });
  let firstContactTick: number | null = null;
  let firstSuddenDeathTick: number | null = null;
  const suddenDeathBy: Array<number | null> = entrants.map(() => null);
  const started = performance.now();
  const result = await runBattle({
    players: setups,
    map,
    config,
    seed,
    yieldEveryTicks: 0,
    onFrame: (f) => {
      if (firstContactTick === null && f.events.some((ev) => ev.type === 'hit')) firstContactTick = f.t;
      // A unit outside the safe circle (with damage on) is losing HP to sudden death.
      if (config.suddenDeath.damagePctPerSecond <= 0) return;
      for (const [id, , , , flags] of f.units) {
        if (!(flags & FRAME_FLAGS.OUTSIDE_SAFE_ZONE)) continue;
        firstSuddenDeathTick ??= f.t;
        const seat = Number(id.split('-')[0]);
        suddenDeathBy[seat] ??= f.t;
      }
    },
  });
  const ms = performance.now() - started;
  const placeOf = new Map(result.ranking.map((r) => [r.playerId, r.place]));
  const lost = entrants.map((_, i) => result.units.filter((u) => u.playerId === `p${i}` && u.type !== 'minion' && !u.survived).length);
  const standing = entrants.map((_, i) => {
    const by: Partial<Record<string, number>> = {};
    for (const u of result.units) if (u.playerId === `p${i}` && u.survived) by[u.type ?? 'soldier'] = (by[u.type ?? 'soldier'] ?? 0) + 1;
    return by;
  });
  return { result, firstContactTick, firstSuddenDeathTick, suddenDeathBy, lost, standing, ms, places: entrants.map((_, i) => placeOf.get(`p${i}`) ?? 99) };
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

export interface MatchupCell {
  wins: number;
  draws: number;
  losses: number;
}

/** Round robin of every archetype pair over every site, zone pair (both orders) and seed. */
export async function roundRobin(
  archetypes: Archetype[] = ARCHETYPES,
  config?: GameConfig,
  onBattle?: (a: Archetype, b: Archetype, battle: BalanceBattle, outcome: 1 | 0 | -1) => void,
): Promise<Map<string, Map<string, MatchupCell>>> {
  const m = new Map<string, Map<string, MatchupCell>>();
  for (const a of archetypes) m.set(a.key, new Map(archetypes.filter((b) => b !== a).map((b) => [b.key, { wins: 0, draws: 0, losses: 0 }])));
  for (let i = 0; i < archetypes.length; i++)
    for (let j = i + 1; j < archetypes.length; j++) {
      const a = archetypes[i]!;
      const b = archetypes[j]!;
      for (const site of DUEL_SITES)
        for (const [z1, z2] of site.pairs)
          for (const [za, zb] of [[z1, z2], [z2, z1]] as Array<[number, number]>)
            for (const seed of SEEDS) {
              const { outcome, battle } = await duel(site.style, site.players, a, b, [za, zb], seed, config);
              onBattle?.(a, b, battle, outcome);
              const ab = m.get(a.key)!.get(b.key)!;
              const ba = m.get(b.key)!.get(a.key)!;
              if (outcome === 1) {
                ab.wins++;
                ba.losses++;
              } else if (outcome === -1) {
                ab.losses++;
                ba.wins++;
              } else {
                ab.draws++;
                ba.draws++;
              }
            }
    }
  return m;
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
