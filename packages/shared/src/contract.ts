// packages/shared/src/contract.ts
//
// The unit contract (plan §5). The block between the BEGIN/END markers is the
// verbatim contract served by `get_unit_contract` and copied into the kit's
// CLAUDE.md: keep it identical to the plan. Engine-side additions follow below
// the END marker.

// --- BEGIN CONTRACT (plan §5, verbatim) ---
export type UnitType = 'soldier' | 'tower' | 'wall' | 'factory';   // §5.2
export type BodyType = UnitType | 'minion'; // minions are made by factories: you see them, you never submit one
export type MapStyle = 'duel' | 'triangle' | 'corners' | 'ring' | 'lanes' | 'islands'; // §9.2
export type Shape = 'circle' | 'square' | 'triangle' | 'diamond';

/** Fields the constructor MUST set as plain data properties on `this` (which ones depends on `type`, §5.2 table). */
export interface UnitStats {
  name: string;          // 1-24 chars, shown on screen
  type: UnitType;        // soldiers move; towers, walls and factories are buildings and never move
  maxHealth: number;     // soldier/tower 10-500, wall 50-1500, factory 100-1000
  damage?: number;       // soldier/tower: required, 0-60. wall/factory: leave it out (they can't attack)
  range?: number;        // soldier/tower: required, 20-300 px, EDGE to edge (gap between the two bodies). wall/factory: leave it out
  speed?: number;        // soldier: required, 0.5-5 px per tick (60 ticks = 1 s). tower/wall/factory: 0 or leave it out
  attackCooldown?: number;// soldier/tower: required, integer ticks between attacks. wall/factory: leave it out
  productionInterval?: number; // factory only, required: integer ticks between two minions, 600-1800 (10-30 s)
  color: string;         // "#RRGGBB": projectiles, particles, fallback sprite; a wall's block colour; a factory's minion colour
  size?: number;         // soldier/tower: body radius in px = hitbox AND drawn size, 6-20 (default 10 / 14), $0.5 per px above 6. Walls always fill their 40 px cell, factories are always 18: size is ignored for them.
  shape?: Shape;         // optional; only used by the fallback sprite when sprite() is missing
}

/** Pixel-art look, returned by the optional sprite() method (§5.1). */
export type SpriteFrame = string[];       // `grid` rows, each exactly `grid` chars; '.' = transparent
export interface SpriteSpec {
  grid: 8 | 12 | 16 | 24 | 32;            // square pixel grid per frame
  palette: Record<string, string>;        // 1-16 entries, single-char keys (not '.'), "#RRGGBB" values
  frames: {
    idle: SpriteFrame[];                  // required, 1-4 frames
    walk?: SpriteFrame[];                 // 1-4 (falls back to idle)
    attack?: SpriteFrame[];               // 1-4 (falls back to idle)
    hit?: SpriteFrame[];                  // 1 (falls back to a white flash of idle)
    death?: SpriteFrame[];                // 1-4 (falls back to a fade-out)
  };
}

export interface FactoryView {
  productionInterval: number;
  nextMinionIn: number;  // ticks until the next minion (it waits while you hold, or while the factory is full)
  minionsLeft: number;   // minions this factory can still make this battle
  minionsAlive: number; maxAlive: number;
  rally: { x: number; y: number }; // where its minions go; starts at world.center
}
export interface SelfView {
  id: string;            // instanceId of this copy, e.g. "2-0-3"
  unitId: string;        // the design this copy was made from
  ownerId: string; teamId: number; type: UnitType; name: string;
  x: number; y: number; radius: number; hp: number; maxHp: number;
  damage: number; range: number; speed: number;
  attackCooldown: number; cooldownRemaining: number; // 0 = can attack this tick
  blockedBy: string | null; // id of the wall that stopped or turned my last move, else null
  blockedTicks: number;     // ticks in a row a wall has been in my way (0 = free)
  factory: FactoryView | null; // factories only
}
export interface OtherView {
  id: string; ownerId: string; teamId: number; type: BodyType; name: string;
  x: number; y: number; radius: number; hp: number; maxHp: number; range: number;
}
// A wall has radius 20: for range it counts as a circle of radius 20 (so inRange works unchanged),
// but its body blocks the whole 40×40 square. Walls and factories have range 0.
export interface WorldView {
  width: number; height: number;        // arena size this battle: 800 (2-4 players), 1040 (5-6), 1200 (7-8), §9.2
  tick: number; ticksLeft: number;
  mapStyle: MapStyle;                   // §9.2
  myCorner: { x: number; y: number };   // centre of my start zone this round (name kept from the 4-corner map; a zone need not be a corner)
  center: { x: number; y: number };     // = { x: width / 2, y: height / 2 }
  safeZone: { x: number; y: number; radius: number }; // centred on `center`; shrinks from tick 3000 (sudden death, §9)
}
// teamId: free-for-all = the owner's seat (0-7), so every player is their own team.
// Team mode = the team index (0-3). Same teamId = friend, different = enemy.
// Helper semantics (also documented in CLAUDE.md):
// inRange(self, other) === Math.hypot(other.x - self.x, other.y - self.y) - self.radius - other.radius <= self.range

export type Action =
  | { action: 'idle' }
  | { action: 'move'; destination: { x: number; y: number } }   // soldiers
  | { action: 'attack'; targetId: string }                     // soldiers and towers
  | { action: 'rally'; destination: { x: number; y: number } }  // factories: send my minions here
  | { action: 'hold' };                                         // factories: don't build this tick

export interface Unit extends UnitStats {
  update?(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView): Action | undefined; // soldier, tower, factory: required. wall: none
  sprite?(): SpriteSpec; // called ONCE at validation, never in battle (§5.1)
}
// --- END CONTRACT ---

// ---------------------------------------------------------------------------
// Engine-side additions (not part of the player-facing contract text).
// ---------------------------------------------------------------------------

export const UNIT_TYPES: readonly UnitType[] = ['soldier', 'tower', 'wall', 'factory'];
export const SHAPES: readonly Shape[] = ['circle', 'square', 'triangle', 'diamond'];

/** §5.2 groups: soldiers are "units"; towers, walls and factories are "buildings". */
export type UnitGroup = 'unit' | 'building';
export function groupOf(type: UnitType): UnitGroup {
  return type === 'soldier' ? 'unit' : 'building';
}

/** Types whose `update()` runs in battle (walls have no code, §5.2). */
export function runsCode(type: UnitType): boolean {
  return type !== 'wall';
}

/** Buildings that can't attack or move and price HP on their own curve (§5.2, §6). */
export function isNonCombatBuilding(type: UnitType): type is 'wall' | 'factory' {
  return type === 'wall' || type === 'factory';
}

/** A wall's body: a 40×40 square filling its cell; for range it is a circle of this radius (§5.2). */
export const WALL_HALF = 20;
/** A factory's fixed body radius (§5.2). */
export const FACTORY_RADIUS = 18;

/** The stat fields read from a constructed unit, in the order they are checked. */
export const STAT_FIELDS = [
  'name',
  'type',
  'maxHealth',
  'damage',
  'range',
  'speed',
  'attackCooldown',
  'productionInterval',
  'color',
  'size',
  'shape',
] as const;
export type StatField = (typeof STAT_FIELDS)[number];

/**
 * The fields that feed the cost formula (§6). `type` picks the default size
 * when `size` is omitted (defaults are priced too) and the formula: walls and
 * factories are priced on HP (and factories on `productionInterval`) only.
 */
export interface CostStats {
  type: UnitType;
  maxHealth: number;
  damage: number;
  range: number;
  speed: number;
  attackCooldown: number;
  size?: number | undefined;
  productionInterval?: number | undefined;
}

/**
 * The frozen stats taken at validation time (§5 rule 1). Combat reads only
 * this. `name` is trimmed, and `size` and `shape` are always filled in (type
 * defaults). Walls and factories get damage/range/speed/attackCooldown 0 and
 * their fixed size (20 / 18); `productionInterval` is set for factories only.
 */
export type StatsSnapshot = Readonly<Required<Omit<UnitStats, 'productionInterval'>> & { productionInterval?: number }>;

/** Default body radius (`size`) per unit type (§5 bounds table, §5.2). */
export const DEFAULT_SIZE: Readonly<Record<UnitType, number>> = {
  soldier: 10,
  tower: 14,
  wall: WALL_HALF,
  factory: FACTORY_RADIUS,
};

/** The resolved size of a unit: its own `size`, or the type default (walls and factories: always fixed). */
export function sizeOf(stats: Pick<UnitStats, 'type' | 'size'>): number {
  if (isNonCombatBuilding(stats.type)) return DEFAULT_SIZE[stats.type];
  return stats.size ?? DEFAULT_SIZE[stats.type];
}

/** Default cosmetic shape per unit type (fallback sprite only). */
export const DEFAULT_SHAPE: Readonly<Record<UnitType, Shape>> = {
  soldier: 'circle',
  tower: 'square',
  wall: 'square',
  factory: 'square',
};
