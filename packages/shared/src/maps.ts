// Map styles, player counts and zone-local cells (plan §9.2).
//
// Pure data + functions, shared by the server (round, battle, visibility) and
// the client (/admin previews, /play grid, /screen). Arena sizes and zone
// tables are code, not config, so geometry and tests can't drift apart.
//
//   * `mapFor(style, players)` → the layout: arena side S and one 240×240 zone
//     per player, listed in INDEX order (clockwise from the top / top-left).
//     Index order drives rotation and team blocks.
//   * `cellCenter(zone, col, row)` / `cellAt(zone, x, y)` → zone-local cells.
//     Row 0 is always the front edge (facing the centre, or on Lanes the other
//     row). On diagonal and off-centre zones (0,0) is the front cell nearest
//     the centre; on a N/S/E/W zone centred on the arena's centre line col 0
//     is the edge cell (col grows towards +x / +y), so its centre-most front
//     cells are cols 2 and 3 (`zoneCentredOnLine`). Diagonal zones keep the
//     original Corners rule exactly. A `Corner` ('TL'…) is still accepted and
//     means that zone of the 4-player Corners map.
//   * `assignMapZones` (free-for-all) / `assignTeamZones` (team blocks) → the
//     per-round zone of every player. `isValidMapSetup` refuses a style for a
//     team mode whose blocks are unfair (Islands 6 with 2 teams);
//     `teamBlocksEven` says whether every team block is a mirror/rotation of
//     the others (if not, only a multiple of T rounds evens it out).
//   * `scaleSuddenDeath(sd, S)` → the safe-circle radii for an S arena.

import type { GameConfig } from './config.js';
import type { MapStyle } from './contract.js';
import type { MapDTO, MapZoneDTO } from './protocol.js';
import { equalTeamSizes, teamCountOf, type TeamMode } from './teams.js';
import {
  CELL_SIZE,
  GRID_SIZE,
  ZONE_SIZE,
  isValidCell,
  type Cell,
  type Corner,
  type Point,
  type Rect,
} from './geometry.js';

/** Where a zone's front edge points (§9.2 Facing). */
export type Facing = 'diag' | 'N' | 'S' | 'E' | 'W';

/** One player zone of a map. */
export interface MapZone extends Rect {
  /** Position in the style's index order (rotation and team blocks). */
  index: number;
  facing: Facing;
  /** Side S of the arena this zone belongs to (the cell mapping needs the centre S/2). */
  arena: number;
}

/** A resolved map: the style, its player count, the arena and the zones. */
export interface MapLayout {
  style: MapStyle;
  /** Number of zones (= players the layout is for). */
  players: number;
  width: number;
  height: number;
  zones: MapZone[];
}

export const MAP_STYLES: readonly MapStyle[] = ['duel', 'triangle', 'corners', 'ring', 'lanes', 'islands'];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/** Display info per style (§9.2 table). */
export const MAP_STYLE_INFO: Readonly<Record<MapStyle, { label: string; players: readonly number[]; idea: string; suitedTo: string }>> = {
  duel: { label: 'Duel', players: [2], idea: 'opposite corners', suitedTo: '1v1' },
  triangle: { label: 'Triangle', players: [3], idea: '3 bases around the centre', suitedTo: 'free-for-all' },
  corners: { label: 'Corners', players: [3, 4], idea: 'a base in each corner', suitedTo: 'free-for-all, 2v2' },
  ring: { label: 'Ring', players: [5, 6, 7, 8], idea: 'bases evenly spaced on a ring around the centre', suitedTo: 'free-for-all, any team mode' },
  lanes: { label: 'Lanes', players: [4, 6, 8], idea: "two rows of bases facing each other across a no-man's-land", suitedTo: '2 teams' },
  islands: { label: 'Islands', players: [6, 8], idea: 'pairs of bases in clusters', suitedTo: 'teams of 2' },
};

/** Styles whose neighbours sit close together on purpose (meant for teams; the preview says "close neighbours"). */
export const CLOSE_NEIGHBOUR_STYLES: readonly MapStyle[] = ['lanes', 'islands'];

/** Arena side S by player count (§9.2): 800 for 2-4, 1040 for 5-6, 1200 for 7-8 (whole 40 px cells). */
export function arenaSizeFor(players: number): number {
  if (players <= 4) return 800;
  if (players <= 6) return 1040;
  return 1200;
}

/** Default style by player count: 2 Duel, 3 Triangle, 4 Corners, 5-8 Ring (1 player: Duel zone 0). */
export function defaultMapStyle(players: number): MapStyle {
  if (players <= 2) return 'duel';
  if (players === 3) return 'triangle';
  if (players === 4) return 'corners';
  return 'ring';
}

export function isMapStyle(v: unknown): v is MapStyle {
  return typeof v === 'string' && (MAP_STYLES as readonly string[]).includes(v);
}

/** Whether `style` has a layout for `players` (1 player: only Duel). */
export function isValidMapStyle(style: MapStyle, players: number): boolean {
  if (players === 1) return style === 'duel';
  return MAP_STYLE_INFO[style].players.includes(players);
}

/**
 * (style:players:mode) setups that are refused although the style fits P:
 * Islands 6 with 2 teams (3v3) has to cut a cluster between the teams, so one
 * block has a base 600 px from its teammates but 120 px from an enemy.
 */
export const REFUSED_TEAM_SETUPS: readonly string[] = ['islands:6:teams2'];

/**
 * Styles whose layout only works for equal teams (rows / clusters): unequal
 * teams (e.g. 3v2, or 4v2 after a move) fall back to the default style.
 */
export const EQUAL_TEAMS_ONLY_STYLES: readonly MapStyle[] = ['lanes', 'islands'];

/**
 * Whether the teams are equal: `sizes` when given, else whether T splits P
 * evenly (the snake deal). Free-for-all: true.
 */
function teamsEqual(mode: TeamMode, players: number, sizes?: readonly number[]): boolean {
  const T = teamCountOf(mode);
  if (T < 2) return true;
  return sizes && sizes.length === T ? equalTeamSizes(sizes) : players % T === 0;
}

/**
 * Whether `style` works for P players in team mode `mode` (free-for-all: any
 * valid style). `teamSizes` (the draft/match team sizes) defaults to the
 * snake deal; Lanes and Islands need equal teams.
 */
export function isValidMapSetup(style: MapStyle, mode: TeamMode, players: number, teamSizes?: readonly number[]): boolean {
  if (!isValidMapStyle(style, players) || REFUSED_TEAM_SETUPS.includes(`${style}:${players}:${mode}`)) return false;
  return !EQUAL_TEAMS_ONLY_STYLES.includes(style) || teamsEqual(mode, players, teamSizes);
}

/** The styles valid for a player count (and team mode / sizes), the default first. */
export function validMapStyles(players: number, mode: TeamMode = 'ffa', teamSizes?: readonly number[]): MapStyle[] {
  const def = defaultMapStyle(players);
  return [def, ...MAP_STYLES.filter((s) => s !== def && isValidMapSetup(s, mode, players, teamSizes))];
}

/**
 * The style to use for P players (§9.2 Map resolution): the host's override if
 * it is valid for P (and the team mode), otherwise the default. `fellBack` is
 * true when an override was given but replaced (admin toast "Map changed to
 * Ring for 5 players").
 */
export function resolveMapStyle(
  requested: MapStyle | null | undefined,
  players: number,
  mode: TeamMode = 'ffa',
  teamSizes?: readonly number[],
): { style: MapStyle; fellBack: boolean } {
  if (requested && isValidMapSetup(requested, mode, players, teamSizes)) return { style: requested, fellBack: false };
  return { style: defaultMapStyle(players), fellBack: requested !== null && requested !== undefined };
}

// ---------------------------------------------------------------------------
// Zone tables (§9.2 Zone positions): top-left corner and facing, index order.
// ---------------------------------------------------------------------------

type ZoneSpec = readonly [x: number, y: number, facing: Facing];

const ZONE_TABLE: Readonly<Record<string, readonly ZoneSpec[]>> = {
  'duel:2': [[0, 0, 'diag'], [560, 560, 'diag']],
  'triangle:3': [[280, 0, 'S'], [520, 440, 'W'], [40, 440, 'E']],
  'corners:3': [[0, 0, 'diag'], [560, 0, 'diag'], [560, 560, 'diag']],
  'corners:4': [[0, 0, 'diag'], [560, 0, 'diag'], [560, 560, 'diag'], [0, 560, 'diag']],
  'ring:5': [[400, 0, 'S'], [800, 280, 'W'], [640, 720, 'N'], [160, 720, 'N'], [0, 280, 'E']],
  'ring:6': [[400, 0, 'S'], [800, 160, 'W'], [800, 640, 'W'], [400, 800, 'N'], [0, 640, 'E'], [0, 160, 'E']],
  'ring:7': [[480, 0, 'S'], [880, 160, 'W'], [960, 600, 'W'], [720, 960, 'N'], [240, 960, 'N'], [0, 600, 'E'], [80, 160, 'E']],
  'ring:8': [[480, 0, 'S'], [960, 0, 'diag'], [960, 480, 'W'], [960, 960, 'diag'], [480, 960, 'N'], [0, 960, 'diag'], [0, 480, 'E'], [0, 0, 'diag']],
  'lanes:4': [[80, 0, 'S'], [480, 0, 'S'], [480, 560, 'N'], [80, 560, 'N']],
  'lanes:6': [[0, 120, 'S'], [400, 120, 'S'], [800, 120, 'S'], [800, 680, 'N'], [400, 680, 'N'], [0, 680, 'N']],
  'lanes:8': [[0, 200, 'S'], [320, 200, 'S'], [640, 200, 'S'], [960, 200, 'S'], [960, 760, 'N'], [640, 760, 'N'], [320, 760, 'N'], [0, 760, 'N']],
  'islands:6': [[240, 0, 'S'], [560, 0, 'S'], [800, 400, 'W'], [800, 720, 'W'], [0, 720, 'E'], [0, 400, 'E']],
  'islands:8': [[0, 0, 'diag'], [320, 0, 'S'], [960, 0, 'diag'], [960, 320, 'W'], [960, 960, 'diag'], [640, 960, 'N'], [0, 960, 'diag'], [0, 640, 'E']],
};

/**
 * Facing derived from d = arena centre − zone centre (§9.2): |dx| = |dy| →
 * diag; |dy| > |dx| → S if dy > 0 else N; |dx| > |dy| → E if dx > 0 else W.
 * (Lanes overrides this: its rows face each other.)
 */
export function derivedFacing(zone: Rect, arena: number): Facing {
  const dx = arena / 2 - (zone.x + zone.width / 2);
  const dy = arena / 2 - (zone.y + zone.height / 2);
  if (Math.abs(dx) === Math.abs(dy)) return 'diag';
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? 'S' : 'N';
  return dx > 0 ? 'E' : 'W';
}

const layoutCache = new Map<string, MapLayout>();

/**
 * The layout of `style` for `players` (§9.2). 1 player: Duel zone 0 only.
 * Throws a RangeError when the style isn't valid for that count (use
 * `resolveMapStyle` first). The returned object is frozen and shared.
 */
export function mapFor(style: MapStyle, players: number): MapLayout {
  if (!Number.isInteger(players) || players < 1 || players > MAX_PLAYERS) {
    throw new RangeError(`unsupported player count ${players} (1-${MAX_PLAYERS})`);
  }
  if (!isValidMapStyle(style, players)) throw new RangeError(`map style ${style} is not valid for ${players} players`);
  const key = `${style}:${players}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;
  const specs = players === 1 ? ZONE_TABLE['duel:2']!.slice(0, 1) : ZONE_TABLE[key]!;
  const arena = arenaSizeFor(players);
  const zones = specs.map(([x, y, facing], index) =>
    Object.freeze({ index, x, y, width: ZONE_SIZE, height: ZONE_SIZE, facing, arena }),
  );
  const layout: MapLayout = Object.freeze({ style, players, width: arena, height: arena, zones: Object.freeze(zones) as MapZone[] });
  layoutCache.set(key, layout);
  return layout;
}

/** The default map for P players. */
export function defaultMapFor(players: number): MapLayout {
  return mapFor(defaultMapStyle(players), players);
}

/** Every (style, players) pair that has a layout (players 2-8), for previews and tests. */
export function allMapLayouts(): MapLayout[] {
  const out: MapLayout[] = [];
  for (const style of MAP_STYLES) for (const p of MAP_STYLE_INFO[style].players) out.push(mapFor(style, p));
  return out;
}

// ---------------------------------------------------------------------------
// Corner bridge (the original 4-corner API, §9 Zones)
// ---------------------------------------------------------------------------

const CORNER_INDEX: Readonly<Record<Corner, number>> = { TL: 0, TR: 1, BR: 2, BL: 3 };

/** A corner as a zone of the 4-player Corners map (same rectangle and cell rule). */
export function cornerZone(corner: Corner): MapZone {
  return mapFor('corners', 4).zones[CORNER_INDEX[corner]]!;
}

/**
 * The `Corner` a zone sits in when it is one of the 800 arena's corner zones
 * (every Duel and Corners zone), else null. For the older Corner-typed DTO
 * fields (`zone`), which new clients replace with the map zone.
 */
export function legacyCornerOf(zone: Rect & { arena?: number }): Corner | null {
  if (zone.arena !== undefined && zone.arena !== 800) return null;
  if (zone.width !== ZONE_SIZE || zone.height !== ZONE_SIZE) return null;
  const far = 800 - ZONE_SIZE;
  const col = zone.x === 0 ? 'L' : zone.x === far ? 'R' : null;
  const row = zone.y === 0 ? 'T' : zone.y === far ? 'B' : null;
  return col && row ? ((row + col) as Corner) : null;
}

/** A `Corner` or a map zone. */
export type ZoneRef = Corner | MapZone;

function toZone(z: ZoneRef): MapZone {
  return typeof z === 'string' ? cornerZone(z) : z;
}

/** Centre of a zone (`world.myCorner`). */
export function zoneCenterOf(zone: ZoneRef): Point {
  const z = toZone(zone);
  return { x: z.x + z.width / 2, y: z.y + z.height / 2 };
}

/** The arena centre (S/2, S/2). */
export function arenaCenter(arena: number): Point {
  return { x: arena / 2, y: arena / 2 };
}

// ---------------------------------------------------------------------------
// Zone-local cells (§9.2 Facing and zone-local cells)
// ---------------------------------------------------------------------------

/**
 * How zone-local col/row map to arena axes. `colAxis` is the arena axis `col`
 * runs along (`row` runs along the other); a sign of +1 means the arena
 * coordinate grows with col/row.
 */
export interface ZoneAxes {
  colAxis: 'x' | 'y';
  colSign: 1 | -1;
  rowSign: 1 | -1;
}

/**
 * A N/S/E/W zone whose centre lies on the arena's centre line along its col
 * axis (Triangle 0, Ring 0, Lanes 6 zone 1…). Its col 0 is an edge cell and
 * the centre-most front cells are cols 2 and 3.
 */
export function zoneCentredOnLine(zone: ZoneRef): boolean {
  const z = toZone(zone);
  if (z.facing === 'diag') return false;
  const mid = z.arena / 2;
  const c = z.facing === 'N' || z.facing === 'S' ? z.x + z.width / 2 : z.y + z.height / 2;
  return c === mid;
}

/** Away from the centre line: +1 when the zone centre is at or past it (a centred zone grows towards +). */
const awayFrom = (zoneMid: number, line: number): 1 | -1 => (zoneMid >= line ? 1 : -1);

export function zoneAxes(zone: ZoneRef): ZoneAxes {
  const z = toZone(zone);
  const mid = z.arena / 2;
  const cx = z.x + z.width / 2;
  const cy = z.y + z.height / 2;
  switch (z.facing) {
    case 'diag':
      // The original rule: col along x, row along y, each away from the centre.
      return { colAxis: 'x', colSign: awayFrom(cx, mid), rowSign: awayFrom(cy, mid) };
    case 'S': // front edge at the bottom: rows grow upwards
      return { colAxis: 'x', colSign: awayFrom(cx, mid), rowSign: -1 };
    case 'N': // front edge at the top: rows grow downwards
      return { colAxis: 'x', colSign: awayFrom(cx, mid), rowSign: 1 };
    case 'E': // front edge on the right: rows grow leftwards
      return { colAxis: 'y', colSign: awayFrom(cy, mid), rowSign: -1 };
    case 'W': // front edge on the left: rows grow rightwards
      return { colAxis: 'y', colSign: awayFrom(cy, mid), rowSign: 1 };
  }
}

/** Arena coordinate of the i-th cell centre along an axis, starting at the edge the sign grows from. */
function along(start: number, size: number, sign: 1 | -1, i: number): number {
  const edge = sign === 1 ? start : start + size;
  return edge + sign * (i * CELL_SIZE + CELL_SIZE / 2);
}

/** Index of the cell containing coordinate v along an axis (v inside [start, start + size)). */
function indexAlong(start: number, size: number, sign: 1 | -1, v: number): number {
  const d = sign === 1 ? v - start : start + size - v;
  return Math.min(GRID_SIZE - 1, Math.floor(d / CELL_SIZE));
}

/** Arena-space centre of zone-local cell (col,row). Throws on an invalid cell. */
export function cellCenter(zone: ZoneRef, col: number, row: number): Point {
  if (!isValidCell(col, row)) throw new RangeError(`cell (${col},${row}) is outside the ${GRID_SIZE}x${GRID_SIZE} zone`);
  const z = toZone(zone);
  const a = zoneAxes(z);
  if (a.colAxis === 'x') {
    return { x: along(z.x, z.width, a.colSign, col), y: along(z.y, z.height, a.rowSign, row) };
  }
  return { x: along(z.x, z.width, a.rowSign, row), y: along(z.y, z.height, a.colSign, col) };
}

/** Inverse of `cellCenter`: the zone-local cell containing an arena point, or null. */
export function cellAt(zone: ZoneRef, x: number, y: number): Cell | null {
  const z = toZone(zone);
  if (x < z.x || x >= z.x + z.width || y < z.y || y >= z.y + z.height) return null;
  const a = zoneAxes(z);
  if (a.colAxis === 'x') {
    return { col: indexAlong(z.x, z.width, a.colSign, x), row: indexAlong(z.y, z.height, a.rowSign, y) };
  }
  return { col: indexAlong(z.y, z.height, a.colSign, y), row: indexAlong(z.x, z.width, a.rowSign, x) };
}

// ---------------------------------------------------------------------------
// Zone rotation per round (§9.2)
// ---------------------------------------------------------------------------

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Free-for-all: active players in join order get `zones[(i + round) % P]`.
 * The layout must have exactly one zone per player.
 */
export function assignMapZones(layout: MapLayout, playerIdsInJoinOrder: readonly string[], round: number): Map<string, MapZone> {
  const n = playerIdsInJoinOrder.length;
  if (n !== layout.zones.length) throw new RangeError(`${layout.style} layout has ${layout.zones.length} zones for ${n} players`);
  const out = new Map<string, MapZone>();
  playerIdsInJoinOrder.forEach((id, i) => out.set(id, layout.zones[mod(i + round, n)]!));
  return out;
}

/** A team's members for block rotation: join order, fixed at Start match. */
export interface TeamSlots {
  /** Member player ids in join order. A kicked member keeps their slot (pass it in `inactive`, or as null). */
  members: ReadonlyArray<string | null>;
}

/**
 * Team mode (§9.2): the zone list is cut into T blocks of consecutive
 * indices, one per team, sized to the team (n_t = its slots). In round r the
 * blocks are laid out from zone 0 in team order starting with team
 * `(−r) mod T`, so with equal teams team t takes block `(t + r) % T` (blocks
 * of n = zones/T); member m takes block zone `(m + r) % n_t`. Kicked members
 * (null or in `inactive`) get no zone, and their zone stays empty.
 */
export function assignTeamZones(
  layout: MapLayout,
  teams: readonly TeamSlots[],
  round: number,
  inactive: ReadonlySet<string> = new Set(),
): Map<string, MapZone> {
  const T = teams.length;
  const total = teams.reduce((sum, t) => sum + t.members.length, 0);
  if (T < 1 || total !== layout.zones.length || teams.some((t) => t.members.length < 1)) {
    throw new RangeError(`${layout.zones.length} zones can't be split into team blocks of ${teams.map((t) => t.members.length).join('+')}`);
  }
  const out = new Map<string, MapZone>();
  let start = 0;
  for (let k = 0; k < T; k++) {
    const team = teams[mod(k - round, T)]!;
    const n = team.members.length;
    team.members.forEach((id, m) => {
      if (id === null || inactive.has(id)) return;
      out.set(id, layout.zones[start + mod(m + round, n)]!);
    });
    start += n;
  }
  return out;
}

/** The 8 symmetries of the square about its centre, on centre-relative points. */
const SQUARE_SYMMETRIES: ReadonlyArray<(x: number, y: number) => [number, number]> = [
  (x, y) => [x, y],
  (x, y) => [-y, x],
  (x, y) => [-x, -y],
  (x, y) => [y, -x],
  (x, y) => [-x, y],
  (x, y) => [x, -y],
  (x, y) => [y, x],
  (x, y) => [-y, -x],
];

const evenCache = new Map<string, boolean>();

/**
 * Whether every team block of `layout` (T blocks) is a rotation or mirror
 * image of block 0 (zone centres, about the arena centre). When it isn't, a
 * team's block depends on the round and only a multiple of T rounds is fair.
 */
export function teamBlocksEven(layout: MapLayout, teams: number): boolean {
  if (teams < 2 || layout.zones.length % teams !== 0) return true;
  const key = `${layout.style}:${layout.players}:${teams}`;
  const cached = evenCache.get(key);
  if (cached !== undefined) return cached;
  const mid = layout.width / 2;
  const pointsOf = (b: number) => teamBlock(layout, teams, b).map((z) => [z.x + z.width / 2 - mid, z.y + z.height / 2 - mid] as const);
  const keyOf = (pts: ReadonlyArray<readonly [number, number]>) => pts.map(([x, y]) => `${x},${y}`).sort().join(' ');
  const base = pointsOf(0);
  let even = true;
  for (let b = 1; b < teams && even; b++) {
    const target = keyOf(pointsOf(b));
    even = SQUARE_SYMMETRIES.some((f) => keyOf(base.map(([x, y]) => f(x, y))) === target);
  }
  evenCache.set(key, even);
  return even;
}

/** Team mode on a map whose blocks differ (see `teamBlocksEven`); false for free-for-all. */
export function unevenTeamBlocks(style: MapStyle, mode: TeamMode, players: number): boolean {
  const T = teamCountOf(mode);
  if (T < 2 || !isValidMapStyle(style, players) || players % T !== 0) return false;
  return !teamBlocksEven(mapFor(style, players), T);
}

/** The zone indices of team block b (team mode). */
export function teamBlock(layout: MapLayout, teams: number, block: number): MapZone[] {
  const n = layout.zones.length / teams;
  return layout.zones.slice(block * n, block * n + n);
}

// ---------------------------------------------------------------------------
// Arena helpers that depend on S
// ---------------------------------------------------------------------------

/**
 * Sudden-death settings for an S arena (§9.2): the config radii are for the
 * 800 arena and are scaled by S/800 and rounded (570 → 741 / 855, 60 → 78 / 90).
 */
export function scaleSuddenDeath(sd: GameConfig['suddenDeath'], arena: number): GameConfig['suddenDeath'] {
  if (arena === 800) return sd;
  const k = arena / 800;
  return { ...sd, startRadius: Math.round(sd.startRadius * k), endRadius: Math.round(sd.endRadius * k) };
}

/** Centre-to-centre distance between the closest cells of two zones. */
export function nearestCellDistance(a: ZoneRef, b: ZoneRef): number {
  let best = Infinity;
  for (let c1 = 0; c1 < GRID_SIZE; c1++)
    for (let r1 = 0; r1 < GRID_SIZE; r1++) {
      const p = cellCenter(a, c1, r1);
      for (let c2 = 0; c2 < GRID_SIZE; c2++)
        for (let r2 = 0; r2 < GRID_SIZE; r2++) {
          const q = cellCenter(b, c2, r2);
          best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        }
    }
  return best;
}

/** One zone as its public DTO (no arena field). */
export function mapZoneDTO(zone: MapZone): MapZoneDTO {
  return { index: zone.index, x: zone.x, y: zone.y, width: zone.width, height: zone.height, facing: zone.facing };
}

/** The public map DTO (§9.2): no owners. */
export function mapDTO(layout: MapLayout): MapDTO {
  return {
    style: layout.style,
    players: layout.players,
    width: layout.width,
    height: layout.height,
    zones: layout.zones.map(mapZoneDTO),
  };
}
