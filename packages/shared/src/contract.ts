// packages/shared/src/contract.ts
//
// The unit contract. The block between the BEGIN/END markers is the verbatim
// contract served by `get_unit_contract` and copied into the kit's CLAUDE.md
// (packages/starter-kit/CLAUDE.md.tmpl): keep the two identical. Engine-side
// additions follow below the END marker.

// --- BEGIN CONTRACT (verbatim) ---
export type UnitType = 'soldier' | 'tower' | 'wall' | 'factory';
export type BodyType = UnitType | 'minion'; // minions are made by factories: you see them, you never submit one
export type MinionKind = 'grunt' | 'archer' | 'runner' | 'brute' | 'medic'; // what a factory builds
export type MinionOrder = 'attack' | 'defend' | 'swarm' | 'guard'; // what a factory's minions do
export type Element = 'normal' | 'fire' | 'ice' | 'lightning';     // one per unit
export type SupportKind = 'heal' | 'haste' | 'might' | 'shield';  // one per unit
export type MapStyle = 'duel' | 'triangle' | 'corners' | 'ring' | 'lanes' | 'islands';
export type Shape = 'circle' | 'square' | 'triangle' | 'diamond';

/** Fields the constructor MUST set as plain data properties on `this` (which ones depends on `type`). */
export interface UnitStats {
  name: string;          // 1-24 chars, shown on screen
  type: UnitType;        // soldiers move; towers, walls and factories are buildings and never move
  maxHealth: number;     // soldier/tower 80-4000, wall 400-12000, factory 120-1200
  damage?: number;       // soldier/tower: required, 0-240. wall/factory: leave it out (they can't attack)
  range?: number;        // required: soldier 20-160 px, tower 20-300 px (towers out-range soldiers), EDGE to edge (gap between the two bodies). wall/factory: leave it out
  speed?: number;        // soldier: required, 0.5-5 px per tick (60 ticks = 1 s). tower/wall/factory: 0 or leave it out
  attackCooldown?: number;// soldier/tower: required, integer ticks between attacks (and heals). wall/factory: leave it out
  element?: Element;     // soldier/tower, optional (default 'normal'): fire burns, ice freezes, lightning zaps. Price ×1.3 (ice ×1.75)
  splashRadius?: number; // soldier/tower, optional (default 0 = one target): 0-80 px; other enemies this close to the target take half
  support?: SupportKind; // soldier/tower, optional: heal = an action you return; haste/might/shield = an aura that works by itself
  supportPower?: number; // required with support. heal: HP per heal 15-400. haste/might: 5-50 (%). shield: 5-40 (%)
  supportRange?: number; // required with support, EDGE to edge. heal: 20-200 px reach. haste/might/shield: 40-150 px aura
  productionInterval?: number; // factory only, required: integer ticks between two minions, 300-1200 (5-20 s)
  produces?: MinionKind; // factory only, optional (default 'grunt'): the minion it builds; the price follows
  minionElement?: Element; // factory only, optional (default 'normal'): the element of every minion it builds (medics ignore it)
  burst?: number;        // factory only, optional (default 1): integer 1-4; minions wait inside until this many are ready, then leave together
  color: string;         // "#RRGGBB": projectiles, particles, fallback sprite; a wall's block colour; a factory's minion colour
  size?: number;         // soldier/tower: body radius in px = hitbox AND drawn size, 6-20 (default 10 / 14), $8 per px above 6. Walls always fill their 40 px cell, factories are always 18: size is ignored for them.
  shape?: Shape;         // optional; only used by the fallback sprite when sprite() is missing
}

/** Pixel-art look, returned by the optional sprite() method. */
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

/** What is on a body right now. Every number is 0 when nothing applies. */
export interface StatusView {
  burning: number;   // ticks until the burn ends (max 180)
  burnLeft: number;  // HP the burn will still take
  frozen: number;    // ticks until the freeze ends (max 120): moves, reloads and builds 35% slower
  haste: number;     // % from the strongest haste aura on it
  might: number;     // % from the strongest might aura on it
  shield: number;    // % from the strongest shield aura on it
  healRoom: number;  // HP it can still be healed this second (0: full, a wall/factory, the cap is used, or sudden death)
}
export interface SupportView { kind: SupportKind; power: number; range: number }

export interface FactoryView {
  productionInterval: number;
  nextMinionIn: number;  // ticks until the next minion (it waits while you hold, or while the factory is full)
  producing: boolean;    // true, unless the host turned on 'Factories stop at sudden death': then false once no new minion can appear before sudden death (tick 4500)
  minionsLeft: number;   // minions this factory can still make this battle (0 once producing is false)
  minionsAlive: number; maxAlive: number; // minionsAlive = out on the field; maxAlive caps minionsAlive + stored
  stored: number;        // built minions waiting inside: safe from attacks, but LOST if the factory is destroyed
  burst: number;         // stored minions leave together when stored reaches burst (or on { action: 'release' })
  produces: MinionKind;
  minionElement: Element;
  order: MinionOrder;    // starts 'attack'; a swarm whose target died becomes 'attack', a guard whose ally died 'defend'
  orderTargetId: string | null; // swarm: the enemy, guard: the ally, else null
  rally: { x: number; y: number }; // where 'attack' minions go; starts at world.center
}
export interface MinionView {     // self.minion, only inside a factory's updateMinion()
  kind: MinionKind;      // what this minion is
  factoryId: string;     // the id of its factory (the one running this updateMinion)
  order: MinionOrder; orderTargetId: string | null; rally: { x: number; y: number }; // its factory's order, orderTargetId and rally right now
  builtIn: Action;       // the action the built-in minion logic picks for it this tick
}
export interface SelfView {
  id: string;            // instanceId of this copy, e.g. "2-0-3"
  unitId: string;        // the design this copy was made from
  ownerId: string; teamId: number; type: BodyType; name: string;
  x: number; y: number; radius: number; hp: number; maxHp: number;
  damage: number; range: number; speed: number; // the BASE stats: might, haste and a freeze change them in battle (status)
  attackCooldown: number; cooldownRemaining: number; // 0 = can attack (or heal) this tick
  element: Element; splashRadius: number; support: SupportView | null;
  status: StatusView;
  blockedBy: string | null; // id of the wall that stopped my last move, else null
  blockedTicks: number;     // ticks in a row a wall has stopped me (no progress; 0 = free)
  pathing: 'direct' | 'detour' | 'no-route'; // my last move: straight there, round walls and buildings by a route the game found, or walled off (it walks to the best wall to break and waits there)
  factory: FactoryView | null; // factories only
  minion?: MinionView;   // only in updateMinion(): self is then the minion (type 'minion', name its kind, unitId its factory's design, factory null)
}
export interface OtherView {
  id: string; ownerId: string; teamId: number; type: BodyType; name: string;
  x: number; y: number; radius: number; hp: number; maxHp: number; range: number;
  element: Element;      // a minion's is its factory's minionElement; walls and factories 'normal'
  splashRadius: number;  // its splash radius (0 = one target)
  support: SupportView | null; // its support { kind, power, range }, or null
  status: StatusView;
  moving: boolean;       // it moved last tick: ranged shots at a moving body can miss
  currentSpeed: number;  // px it moved last tick (0 standing, blocked or stopped); misses grow with it
  factoryId?: string;    // minions only: the id of the factory that made it (missing on every other body)
  ownerName?: string;    // only when the match setting 'Show enemy names to units' is on: its player's name (a minion: its factory's player)
  teamName?: string;     // team mode, only with that setting on: its team's name, e.g. 'Team 2'
}
// A wall has radius 20: for range it counts as a circle of radius 20 (so inRange works unchanged),
// but its body blocks the whole 40×40 square. Walls and factories have range 0.
// A minion's name is its kind: 'Grunt', 'Archer', 'Runner', 'Brute' or 'Medic'. Stored minions are invisible.
// cooldownRemaining is Math.ceil of an internal float that counts down by the tempo: 0.65 frozen, ×(1 + haste%) hasted.
export interface WorldView {
  width: number; height: number;        // arena size this battle: 800 (2-4 players), 1040 (5-6), 1200 (7-8)
  tick: number; ticksLeft: number;
  mapStyle: MapStyle;
  myCorner: { x: number; y: number };   // centre of my start zone this round (name kept from the 4-corner map; a zone need not be a corner)
  center: { x: number; y: number };     // = { x: width / 2, y: height / 2 }
  safeZone: { x: number; y: number; radius: number }; // centred on `center`; shrinks from tick 4500 (sudden death)
  players?: { id: string; name: string; teamId: number; teamName?: string }[]; // only when 'Show enemy names to units' is on: every player in this battle, you too (id = ownerId; teamName in team mode)
}
// teamId: free-for-all = the owner's seat (0-7), so every player is their own team.
// Team mode = the team index (0-3). Same teamId = friend, different = enemy.
// Helper semantics (also documented in CLAUDE.md):
// inRange(self, other) === Math.hypot(other.x - self.x, other.y - self.y) - self.radius - other.radius <= self.range

export type Action =
  | { action: 'idle' }
  | { action: 'move'; destination: { x: number; y: number } }   // soldiers and minions
  | { action: 'attack'; targetId: string }                     // soldiers, towers and minions
  | { action: 'heal'; targetId: string }                       // support 'heal' only (and medic minions): heal one ally in supportRange (uses the attack cooldown)
  | { action: 'rally'; destination: { x: number; y: number } }  // factories: order 'attack' and send my minions here
  | { action: 'command'; order: MinionOrder; targetId?: string; destination?: { x: number; y: number } } // factories: squad order; swarm/guard need targetId
  | { action: 'release' }                                       // factories: send the stored minions out now
  | { action: 'hold' };                                         // factories: don't build this tick

export interface Unit extends UnitStats {
  update?(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView): Action | undefined; // soldier, tower, factory: required. wall: none
  updateMinion?(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView): Action | undefined; // factory only, optional: once per tick for each of its minions on the field; undefined/null = the built-in logic
  sprite?(): SpriteSpec; // called ONCE at validation, never in battle
}
// --- END CONTRACT ---

// ---------------------------------------------------------------------------
// Engine-side additions (not part of the player-facing contract text).
// ---------------------------------------------------------------------------

export const UNIT_TYPES: readonly UnitType[] = ['soldier', 'tower', 'wall', 'factory'];
export const SHAPES: readonly Shape[] = ['circle', 'square', 'triangle', 'diamond'];

/** The minion kinds a factory can build, in display order. */
export const MINION_KINDS: readonly MinionKind[] = ['grunt', 'archer', 'runner', 'brute', 'medic'];
/** The squad orders a factory can give. Index = the order code in frames (`FrameFactory[9]`). */
export const MINION_ORDERS: readonly MinionOrder[] = ['attack', 'defend', 'swarm', 'guard'];
/** A minion's name in views: its kind's name. */
export const MINION_KIND_NAMES: Readonly<Record<MinionKind, string>> = {
  grunt: 'Grunt',
  archer: 'Archer',
  runner: 'Runner',
  brute: 'Brute',
  medic: 'Medic',
};
/** The default minion kind and burst of a factory that doesn't set them. */
export const DEFAULT_MINION_KIND: MinionKind = 'grunt';
export const DEFAULT_BURST = 1;

export function isMinionKind(v: unknown): v is MinionKind {
  return typeof v === 'string' && (MINION_KINDS as readonly string[]).includes(v);
}
export function isMinionOrder(v: unknown): v is MinionOrder {
  return typeof v === 'string' && (MINION_ORDERS as readonly string[]).includes(v);
}
/** A factory's minion kind (stored factories from before M8.6 have none: grunt). */
export function producesOf(stats: { produces?: MinionKind | undefined }): MinionKind {
  return isMinionKind(stats.produces) ? stats.produces : DEFAULT_MINION_KIND;
}
/** A factory's burst (default 1). */
export function burstOf(stats: { burst?: number | undefined }): number {
  return typeof stats.burst === 'number' && Number.isInteger(stats.burst) && stats.burst >= 1 ? stats.burst : DEFAULT_BURST;
}

// ---------------------------------------------------------------------------
// M8.8: elements, splash and support
// ---------------------------------------------------------------------------

/** The four elements, in display order. */
export const ELEMENTS: readonly Element[] = ['normal', 'fire', 'ice', 'lightning'];
/** The four support kinds, in display order: heal is an action, the others are auras. */
export const SUPPORT_KINDS: readonly SupportKind[] = ['heal', 'haste', 'might', 'shield'];
/** The aura kinds (always on, no action). */
export const AURA_KINDS = ['haste', 'might', 'shield'] as const;
export type AuraKind = (typeof AURA_KINDS)[number];

/** A unit's support as the snapshot stores it (`support` + `supportPower` + `supportRange`). */
export type SupportSpec = SupportView;

export function isElement(v: unknown): v is Element {
  return typeof v === 'string' && (ELEMENTS as readonly string[]).includes(v);
}
export function isSupportKind(v: unknown): v is SupportKind {
  return typeof v === 'string' && (SUPPORT_KINDS as readonly string[]).includes(v);
}
export function isAuraKind(v: unknown): v is AuraKind {
  return typeof v === 'string' && (AURA_KINDS as readonly string[]).includes(v);
}
/** A unit's element (older stored units have none: normal). */
export function elementOf(stats: { element?: Element | undefined }): Element {
  return isElement(stats.element) ? stats.element : 'normal';
}
/** A unit's splash radius (older stored units have none: 0). */
export function splashOf(stats: { splashRadius?: number | undefined }): number {
  return typeof stats.splashRadius === 'number' && Number.isFinite(stats.splashRadius) && stats.splashRadius > 0 ? stats.splashRadius : 0;
}
/** A unit's support (older stored units have none: null). */
export function supportOf(stats: { support?: SupportSpec | null | undefined }): SupportSpec | null {
  const s = stats.support;
  return s && typeof s === 'object' && isSupportKind(s.kind) ? s : null;
}
/**
 * The element of a factory's minions: its `minionElement` (default
 * normal). Medics never attack, so a medic factory's minions are always normal.
 */
export function minionElementOf(stats: { produces?: MinionKind | undefined; minionElement?: Element | undefined }): Element {
  if (producesOf(stats) === 'medic') return 'normal';
  return isElement(stats.minionElement) ? stats.minionElement : 'normal';
}

/**
 * A design that can win a battle (M8.8): a soldier or tower
 * with damage > 0, or a factory that doesn't build medics. Walls, pure
 * support units (damage 0) and medic factories are not fighters.
 */
export function isFighterDesign(stats: { type: UnitType; damage?: number | undefined; produces?: MinionKind | undefined }): boolean {
  if (stats.type === 'wall') return false;
  if (stats.type === 'factory') return producesOf(stats) !== 'medic';
  return (stats.damage ?? 0) > 0;
}

/** Soldiers are "units"; towers, walls and factories are "buildings". */
export type UnitGroup = 'unit' | 'building';
export function groupOf(type: UnitType): UnitGroup {
  return type === 'soldier' ? 'unit' : 'building';
}

/** Types whose `update()` runs in battle (walls have no code). */
export function runsCode(type: UnitType): boolean {
  return type !== 'wall';
}

/** Buildings that can't attack or move and price HP on their own curve. */
export function isNonCombatBuilding(type: UnitType): type is 'wall' | 'factory' {
  return type === 'wall' || type === 'factory';
}

/** A wall's body: a 40×40 square filling its cell; for range it is a circle of this radius. */
export const WALL_HALF = 20;
/** A factory's fixed body radius. */
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
  'produces',
  'minionElement',
  'burst',
  'element',
  'splashRadius',
  'support',
  'supportPower',
  'supportRange',
  'color',
  'size',
  'shape',
] as const;
export type StatField = (typeof STAT_FIELDS)[number];

/**
 * The fields that feed the cost formula. `type` picks the default size
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
  /** Factories: the minion kind (default grunt); its price sets the production cost. */
  produces?: MinionKind | undefined;
  /** Factories (M8.8): the minions' element (default normal; medics ignore it). */
  minionElement?: Element | undefined;
  /** Soldiers and towers (M8.8): the element (default normal) and the splash radius (default 0). */
  element?: Element | undefined;
  splashRadius?: number | undefined;
  /** Soldiers and towers (M8.8): the support, or null / absent for none. */
  support?: SupportSpec | null | undefined;
}

/**
 * The frozen stats taken at validation time. Combat reads only
 * this. `name` is trimmed, and `size` and `shape` are always filled in (type
 * defaults). Walls and factories get damage/range/speed/attackCooldown 0 and
 * their fixed size (20 / 18); `productionInterval`, `produces`, `minionElement`
 * and `burst` are set for factories only. M8.8: the validator always
 * sets `element` ('normal'), `splashRadius` (0) and `support` (null, or
 * `{kind, power, range}`); older stored units lack them (read them with
 * `elementOf`, `splashOf`, `supportOf`, `minionElementOf`).
 */
export type StatsSnapshot = Readonly<
  Required<
    Omit<UnitStats, 'productionInterval' | 'produces' | 'burst' | 'minionElement' | 'element' | 'splashRadius' | 'support' | 'supportPower' | 'supportRange'>
  > & {
    productionInterval?: number;
    /** Factories (M8.6): always set by the validator; absent in older stored factories (= grunt). */
    produces?: MinionKind;
    /** Factories (M8.6): always set by the validator; absent in older stored factories (= 1). */
    burst?: number;
    /** Factories (M8.8): always set by the validator; absent in older stored factories (= normal). */
    minionElement?: Element;
    /** M8.8: always set by the validator; absent in older stored units (= normal). */
    element?: Element;
    /** M8.8: always set by the validator; absent in older stored units (= 0). */
    splashRadius?: number;
    /** M8.8: always set by the validator (null = none); absent in older stored units. */
    support?: SupportSpec | null;
  }
>;

/** Default body radius (`size`) per unit type. */
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
