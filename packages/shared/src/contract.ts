// packages/shared/src/contract.ts
//
// The unit contract (plan §5). The block between the BEGIN/END markers is the
// verbatim contract served by `get_unit_contract` and copied into the kit's
// CLAUDE.md: keep it identical to the plan. Engine-side additions follow below
// the END marker.

// --- BEGIN CONTRACT (plan §5, verbatim) ---
export type UnitType = 'soldier' | 'tower';
export type MapStyle = 'duel' | 'triangle' | 'corners' | 'ring' | 'lanes' | 'islands'; // §9.2
export type Shape = 'circle' | 'square' | 'triangle' | 'diamond';

/** Fields the constructor MUST set as plain data properties on `this`. */
export interface UnitStats {
  name: string;          // 1-24 chars, shown on screen
  type: UnitType;        // towers never move
  maxHealth: number;     // see bounds table
  damage: number;
  range: number;         // pixels, EDGE to edge (gap between the two bodies)
  speed: number;         // pixels per tick (60 ticks = 1 s); towers: 0
  attackCooldown: number;// integer ticks between attacks
  color: string;         // "#RRGGBB": projectiles, particles, fallback sprite
  size?: number;         // body radius in px = hitbox AND drawn size. 6-20. Default soldier 10, tower 14. Costs $0.5 per px above 6 (more near the max).
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

export interface SelfView {
  id: string;            // instanceId of this copy, e.g. "2-0-3"
  unitId: string;        // the design this copy was made from
  ownerId: string; teamId: number; type: UnitType; name: string;
  x: number; y: number; radius: number; hp: number; maxHp: number;
  damage: number; range: number; speed: number;
  attackCooldown: number; cooldownRemaining: number; // 0 = can attack this tick
}
export interface OtherView {
  id: string; ownerId: string; teamId: number; type: UnitType; name: string;
  x: number; y: number; radius: number; hp: number; maxHp: number; range: number;
}
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
  | { action: 'move'; destination: { x: number; y: number } }
  | { action: 'attack'; targetId: string };

export interface Unit extends UnitStats {
  update(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView): Action | undefined;
  sprite?(): SpriteSpec; // called ONCE at validation, never in battle (§5.1)
}
// --- END CONTRACT ---

// ---------------------------------------------------------------------------
// Engine-side additions (not part of the player-facing contract text).
// ---------------------------------------------------------------------------

export const UNIT_TYPES: readonly UnitType[] = ['soldier', 'tower'];
export const SHAPES: readonly Shape[] = ['circle', 'square', 'triangle', 'diamond'];

/** The stat fields read from a constructed unit, in the order they are checked. */
export const STAT_FIELDS = [
  'name',
  'type',
  'maxHealth',
  'damage',
  'range',
  'speed',
  'attackCooldown',
  'color',
  'size',
  'shape',
] as const;
export type StatField = (typeof STAT_FIELDS)[number];

/**
 * The fields that feed the cost formula (§6). `type` picks the default size
 * when `size` is omitted (defaults are priced too).
 */
export type CostStats = Pick<UnitStats, 'type' | 'maxHealth' | 'damage' | 'range' | 'speed' | 'attackCooldown' | 'size'>;

/**
 * The frozen stats taken at validation time (§5 rule 1). Combat reads only
 * this. `name` is trimmed, and `size` and `shape` are always filled in (type
 * defaults).
 */
export type StatsSnapshot = Readonly<Required<UnitStats>>;

/** Default body radius (`size`) per unit type (§5 bounds table). */
export const DEFAULT_SIZE: Readonly<Record<UnitType, number>> = {
  soldier: 10,
  tower: 14,
};

/** The resolved size of a unit: its own `size`, or the type default. */
export function sizeOf(stats: Pick<UnitStats, 'type' | 'size'>): number {
  return stats.size ?? DEFAULT_SIZE[stats.type];
}

/** Default cosmetic shape per unit type (fallback sprite only). */
export const DEFAULT_SHAPE: Readonly<Record<UnitType, Shape>> = {
  soldier: 'circle',
  tower: 'square',
};
