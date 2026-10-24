// Pure /play logic (plan §12.1), DOM-free so tests/play.test.ts can run it:
// zone grid orientation, placement edits with budget/copy/cell rules, "Copy
// last layout", selection toggling, stat bars, cost breakdown rows, the
// "Ask Claude" prompts and Claude-terminal links.
//
// M8.5 (§5.2, §12.5): soldiers are "units", towers, walls and factories are
// "buildings". A round picks up to 4 of each; placement caps fighters
// (soldiers, towers, factories), factories among them, and walls apart.

import {
  layoutSpent,
  nextCopyCost,
  type CopyRamp,
  CELL_SIZE,
  DEFAULT_CONFIG,
  GRID_SIZE,
  burstOf,
  cellAt,
  elementOf,
  minionElementOf,
  splashOf,
  supportOf,
  type Element,
  type SupportKind,
  groupOf,
  producesOf,
  isValidCell,
  sizeOf,
  trappedCells,
  zoneAxes,
  zoneRect,
  type MinionKind,
  type MinionOrder,
  type UnitGroup,
  type UnitType,
  type ZoneRef,
  type BadgeId,
  type BattleReportDTO,
  type BattleReportErrorDTO,
  type CostBreakdown,
  type Corner,
  type PlacementDTO,
  type RankingEntryDTO,
  type StatBounds,
  type StatsSnapshot,
  type UnitCardDTO,
} from '@pixel-clash/shared';
import { KIND_ICON, kindPlural } from '../common/render/buildings.js';
import { ELEMENT_ICON, SUPPORT_ICON } from '../common/render/effects.js';
import { formatMoney } from '../common/ui.js';

// ---------------------------------------------------------------------------
// Caps and unit types (M8.5)
// ---------------------------------------------------------------------------

/** Round caps (§5.2, M8.5): up to 4 unit + 4 building types; fighters, factories and walls counted apart. */
export interface PlayCaps {
  budget: number;
  /** Soldier types per round. */
  maxUnitTypes: number;
  /** Tower, wall and factory types per round. */
  maxBuildingTypes: number;
  /** Fighters placed: soldiers + towers + factories. */
  maxCopies: number;
  /** Of the fighters, factories. */
  maxFactoryCopies: number;
  /** Walls placed (on top of the fighters). */
  maxWallCopies: number;
  /** Redesign (§6 copy ramp): copies of one design beyond freeCopies cost more (pctPerCopy 0 = off). */
  copyRamp: CopyRamp;
}

/** The caps from GET /rules (`caps`), falling back to `prev` (an older server's single `maxTypes` caps both groups). */
export function capsFromRules(caps: Partial<Record<string, number>>, budget: number | undefined, prev: PlayCaps, copyRamp?: CopyRamp): PlayCaps {
  const legacy = caps.maxTypes;
  return {
    copyRamp: copyRamp ? { freeCopies: copyRamp.freeCopies, pctPerCopy: copyRamp.pctPerCopy } : prev.copyRamp,
    budget: caps.budget ?? budget ?? prev.budget,
    maxUnitTypes: caps.maxUnitTypes ?? legacy ?? prev.maxUnitTypes,
    maxBuildingTypes: caps.maxBuildingTypes ?? legacy ?? prev.maxBuildingTypes,
    maxCopies: caps.maxCopies ?? prev.maxCopies,
    maxFactoryCopies: caps.maxFactoryCopies ?? prev.maxFactoryCopies,
    maxWallCopies: caps.maxWallCopies ?? prev.maxWallCopies,
  };
}

export const DEFAULT_PLAY_CAPS: PlayCaps = {
  budget: DEFAULT_CONFIG.caps.budget,
  maxUnitTypes: DEFAULT_CONFIG.caps.maxUnitTypes,
  maxBuildingTypes: DEFAULT_CONFIG.caps.maxBuildingTypes,
  maxCopies: DEFAULT_CONFIG.caps.maxCopies,
  maxFactoryCopies: DEFAULT_CONFIG.caps.maxFactoryCopies,
  maxWallCopies: DEFAULT_CONFIG.caps.maxWallCopies,
  copyRamp: DEFAULT_CONFIG.caps.copyRamp,
};


/** Card tag per type (§12.5). */
export const TYPE_TAGS: Readonly<Record<UnitType, string>> = {
  soldier: '⚔️ soldier',
  tower: '🏹 tower',
  wall: '🧱 wall',
  factory: '🏭 factory',
};

/** The tag text of a design: its type, and for a factory (M8.6) its minion kind ("🏭 factory · 🎯 Archers"). */
export function typeTitle(stats: { type: UnitType; produces?: MinionKind }): string {
  if (stats.type !== 'factory') return TYPE_TAGS[stats.type];
  const chip = factoryKindChip(stats);
  return `${TYPE_TAGS.factory} · ${chip.icon} ${chip.label}`;
}

/** "Units" / "Buildings" (section headers, counters). */
export const GROUP_TITLES: Readonly<Record<UnitGroup, string>> = { unit: 'Units', building: 'Buildings' };

/** The type of a design looked up by id (palette, selection), undefined when unknown. */
export type TypeOf = (unitId: string) => UnitType | undefined;

/** A `TypeOf` over cards. */
export function typeLookup(cards: ReadonlyArray<{ unitId: string; stats: { type: UnitType } }>): TypeOf {
  const m = new Map(cards.map((c) => [c.unitId, c.stats.type]));
  return (id) => m.get(id);
}


// ---------------------------------------------------------------------------
// Zone grid in its true (top-down) orientation
// ---------------------------------------------------------------------------

export interface GridCell {
  /** Screen column/row of the drawn grid (0 = left / top). */
  gx: number;
  gy: number;
  /**
   * Zone-local cell (row 0 = the front, §9.2). (0,0) is the front cell nearest
   * the centre, except on a zone centred on the centre line, where col 0 is
   * the edge (-x / -y side) and cols 2-3 are the middle.
   */
  col: number;
  row: number;
}

function zoneOrigin(zone: ZoneRef): { x: number; y: number } {
  return typeof zone === 'string' ? zoneRect(zone) : { x: zone.x, y: zone.y };
}

/**
 * The 36 cells of a zone in screen order (row-major, top-left first), each
 * with its zone-local col/row. The grid is drawn exactly as the zone sits in
 * the top-down arena (its true orientation, §12.1), so row 0 lands on the
 * front edge for every facing, and (0,0) on the front cell nearest the centre
 * (on a zone centred on the centre line: the front cell on the -x / -y edge).
 * A `Corner` means that zone of the 4-player Corners map.
 */
export function zoneGrid(zone: ZoneRef): GridCell[] {
  const r = zoneOrigin(zone);
  const out: GridCell[] = [];
  for (let gy = 0; gy < GRID_SIZE; gy++) {
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const c = cellAt(zone, r.x + gx * CELL_SIZE + CELL_SIZE / 2, r.y + gy * CELL_SIZE + CELL_SIZE / 2)!;
      out.push({ gx, gy, col: c.col, row: c.row });
    }
  }
  return out;
}

export type Step = -1 | 0 | 1;

/**
 * Where the arena centre lies from the zone, as a screen direction for the
 * grid's arrow: diagonal for corner zones (towards the corner nearest the
 * centre), straight out of the front edge for N/S/E/W zones.
 */
export function towardCentre(zone: ZoneRef): { dx: Step; dy: Step; arrow: string } {
  const facing = typeof zone === 'string' ? 'diag' : zone.facing;
  let dx: Step = 0;
  let dy: Step = 0;
  if (facing === 'diag') {
    const a = zoneAxes(zone);
    // col/row grow away from the centre, so the centre is the other way.
    dx = (a.colAxis === 'x' ? -a.colSign : -a.rowSign) as Step;
    dy = (a.colAxis === 'x' ? -a.rowSign : -a.colSign) as Step;
  } else if (facing === 'S') dy = 1;
  else if (facing === 'N') dy = -1;
  else if (facing === 'E') dx = 1;
  else dx = -1;
  return { dx, dy, arrow: ARROWS[`${dx},${dy}`] ?? '•' };
}

const ARROWS: Readonly<Record<string, string>> = {
  '1,1': '↘',
  '-1,1': '↙',
  '-1,-1': '↖',
  '1,-1': '↗',
  '0,1': '↓',
  '0,-1': '↑',
  '1,0': '→',
  '-1,0': '←',
};

/**
 * Front cells, highlighted on the grid: row 0 (the front edge). Corner
 * (diag) zones have two front edges, the row and the column nearest the centre.
 */
export function isFrontCell(zone: ZoneRef, col: number, row: number): boolean {
  const facing = typeof zone === 'string' ? 'diag' : zone.facing;
  return row === 0 || (facing === 'diag' && col === 0);
}

/** Plain words for a corner (top-down, matching the placement grid). */
export const CORNER_WORDS: Readonly<Record<Corner, string>> = {
  TL: 'top-left',
  TR: 'top-right',
  BR: 'bottom-right',
  BL: 'bottom-left',
};

/** Drawn width of a unit in a grid cell, as a fraction of the cell (size 20 fills it). */
export function cellFill(stats: Pick<StatsSnapshot, 'type' | 'size'>): number {
  return Math.min(1, (2 * sizeOf(stats)) / CELL_SIZE);
}

// ---------------------------------------------------------------------------
// Placement edits
// ---------------------------------------------------------------------------

export interface PlacementRules {
  /** unitId → cost, for the units allowed this round (the palette). */
  costs: ReadonlyMap<string, number>;
  budget: number;
  /** Fighters (soldiers, towers, factories); every copy when `typeOf` is missing. */
  maxCopies: number;
  /** M8.5: the palette's types; with it walls and factories get their own caps. */
  typeOf?: TypeOf;
  maxWallCopies?: number;
  maxFactoryCopies?: number;
  /** Redesign: the copy ramp (absent or pctPerCopy 0 = every copy costs the same). */
  copyRamp?: CopyRamp;
}

export type PlaceResult =
  | { ok: true; placements: PlacementDTO[]; removed?: boolean }
  | { ok: false; code: 'OVER_BUDGET' | 'TOO_MANY_COPIES' | 'NOT_SELECTED' | 'CELL_OUT_OF_ZONE'; message: string };

/** Copies placed per group (§5.2 Copies): fighters (incl. factories), factories, walls. */
export interface CopyCounts {
  fighters: number;
  factories: number;
  walls: number;
}

export function copyCounts(placements: readonly PlacementDTO[], typeOf?: TypeOf): CopyCounts {
  const out: CopyCounts = { fighters: 0, factories: 0, walls: 0 };
  for (const p of placements) {
    const t = typeOf?.(p.unitId);
    if (t === 'wall') out.walls++;
    else {
      out.fighters++;
      if (t === 'factory') out.factories++;
    }
  }
  return out;
}

/** The fighter cap message, in the counter's and the server's words (§5.2 Copies). */
export function fighterCapMessage(max: number): string {
  return `That's the most fighters you can place (${max}): soldiers, towers and factories together.`;
}

/** Why one more copy of a `type` doesn't fit the copy caps, or null. */
export function copyCapProblem(counts: CopyCounts, type: UnitType | undefined, rules: Pick<PlacementRules, 'maxCopies' | 'maxWallCopies' | 'maxFactoryCopies'>): string | null {
  if (type === 'wall') {
    const max = rules.maxWallCopies ?? DEFAULT_CONFIG.caps.maxWallCopies;
    return counts.walls >= max ? `That's the most walls you can place (${max}).` : null;
  }
  if (counts.fighters >= rules.maxCopies) return fighterCapMessage(rules.maxCopies);
  if (type === 'factory') {
    const max = rules.maxFactoryCopies ?? DEFAULT_CONFIG.caps.maxFactoryCopies;
    if (counts.factories >= max) return `That's the most factories you can place (${max}).`;
  }
  return null;
}

/** "Fighters 7/12 · Factories 1/2 · Walls 6/12" (factories and walls only when the palette has them). */
export function copyCounterText(counts: CopyCounts, rules: Pick<PlacementRules, 'maxCopies' | 'maxWallCopies' | 'maxFactoryCopies'>, has: { walls: boolean; factories: boolean }): string {
  const parts = [`Fighters ${counts.fighters}/${rules.maxCopies}`];
  if (has.factories) parts.push(`Factories ${counts.factories}/${rules.maxFactoryCopies ?? DEFAULT_CONFIG.caps.maxFactoryCopies}`);
  if (has.walls) parts.push(`Walls ${counts.walls}/${rules.maxWallCopies ?? DEFAULT_CONFIG.caps.maxWallCopies}`);
  return parts.join(' · ');
}

/** Cells ("col,row") of the soldiers and factories boxed in by walls (W_TRAPPED, §9.3), for the red outline. */
export function trappedKeys(zone: ZoneRef, placements: readonly PlacementDTO[], typeOf: TypeOf): Set<string> {
  return new Set(trappedCells(zone, placements, typeOf).map((p) => `${p.col},${p.row}`));
}

/** What the placements cost (with the copy ramp when `rules` carry one). */
export function spentOf(placements: readonly PlacementDTO[], costs: ReadonlyMap<string, number>, rules?: Pick<PlacementRules, 'typeOf' | 'copyRamp'>): number {
  const ids = placements.map((p) => p.unitId).filter((id) => costs.has(id));
  return layoutSpent(ids, (id) => costs.get(id), (id) => rules?.typeOf?.(id), rules?.copyRamp) ?? 0;
}

/** What one more copy of `unitId` costs on top of `placements` (the copy ramp), or undefined when it isn't in the palette. */
export function nextCostOf(placements: readonly PlacementDTO[], unitId: string, rules: Pick<PlacementRules, 'costs' | 'typeOf' | 'copyRamp'>): number | undefined {
  const cost = rules.costs.get(unitId);
  if (cost === undefined) return undefined;
  return nextCopyCost(placements.map((p) => p.unitId), unitId, cost, rules.typeOf?.(unitId), rules.copyRamp);
}

export function placementAt(placements: readonly PlacementDTO[], col: number, row: number): PlacementDTO | undefined {
  return placements.find((p) => p.col === col && p.row === row);
}

export function removeAt(placements: readonly PlacementDTO[], col: number, row: number): PlacementDTO[] {
  return placements.filter((p) => p.col !== col || p.row !== row);
}

/**
 * Tap a cell with `unitId` chosen in the palette (null = nothing chosen).
 *  - Empty cell + chosen unit → place it (if budget and copies allow).
 *  - Occupied cell → remove it, whatever is chosen (§12.1 "Tap a placed unit
 *    to remove it"; the hint on the page says the same).
 */
export function tapCell(
  placements: readonly PlacementDTO[],
  col: number,
  row: number,
  unitId: string | null,
  rules: PlacementRules,
): PlaceResult {
  if (!isValidCell(col, row)) return { ok: false, code: 'CELL_OUT_OF_ZONE', message: 'That square is outside your zone.' };
  if (placementAt(placements, col, row)) {
    return { ok: true, placements: removeAt(placements, col, row), removed: true };
  }
  if (unitId === null) return { ok: false, code: 'NOT_SELECTED', message: 'Tap a unit below first, then tap a square.' };
  const without = placements.slice();
  const cost = nextCostOf(without, unitId, rules);
  if (cost === undefined) return { ok: false, code: 'NOT_SELECTED', message: "That unit isn't in your army this round." };
  if (rules.typeOf) {
    const problem = copyCapProblem(copyCounts(without, rules.typeOf), rules.typeOf(unitId), rules);
    if (problem) return { ok: false, code: 'TOO_MANY_COPIES', message: problem };
  } else if (without.length >= rules.maxCopies) {
    return { ok: false, code: 'TOO_MANY_COPIES', message: fighterCapMessage(rules.maxCopies) };
  }
  const spent = spentOf(without, rules.costs, rules) + cost;
  if (spent > rules.budget) {
    const left = rules.budget - spentOf(without, rules.costs, rules);
    return {
      ok: false,
      code: 'OVER_BUDGET',
      message: `Not enough money! It costs ${formatMoney(cost)} but you only have ${formatMoney(Math.max(0, left))} left.`,
    };
  }
  return { ok: true, placements: [...without, { unitId, col, row }] };
}

/**
 * "Copy last layout": keep the old placements whose unit is in this round's
 * palette, in order, while the budget and copy cap allow. Returns what was
 * kept and how many were dropped.
 */
export function copyLastLayout(
  lastLayout: readonly PlacementDTO[] | null,
  rules: PlacementRules,
): { placements: PlacementDTO[]; dropped: number } {
  const out: PlacementDTO[] = [];
  let dropped = 0;
  let spent = 0;
  const cells = new Set<string>();
  for (const p of lastLayout ?? []) {
    const cost = nextCostOf(out, p.unitId, rules);
    const key = `${p.col},${p.row}`;
    const full = rules.typeOf ? copyCapProblem(copyCounts(out, rules.typeOf), rules.typeOf(p.unitId), rules) !== null : out.length >= rules.maxCopies;
    if (cost === undefined || !isValidCell(p.col, p.row) || cells.has(key) || full || spent + cost > rules.budget) {
      dropped++;
      continue;
    }
    cells.add(key);
    spent += cost;
    out.push({ unitId: p.unitId, col: p.col, row: p.row });
  }
  return { placements: out, dropped };
}

/** Copies per unitId. */
export function copiesOf(placements: readonly PlacementDTO[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of placements) m.set(p.unitId, (m.get(p.unitId) ?? 0) + 1);
  return m;
}

/** Redesign (§6 copy ramp): "Copy 4+ of one design costs +15%, +30%, … (walls never)". */
export function copyRampHint(r: CopyRamp): string {
  const n = r.freeCopies + 1;
  return `Copy ${n}+ of one design costs more: +${r.pctPerCopy}%, +${2 * r.pctPerCopy}%, … (walls never).`;
}

/** "$4,370 / $5,000 — $630 left" pieces. */
export function budgetText(spent: number, budget: number): string {
  const f = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const left = budget - spent;
  return left >= 0 ? `${f(spent)} / ${f(budget)} — ${f(left)} left` : `${f(spent)} / ${f(budget)} — ${f(-left)} too much!`;
}

// ---------------------------------------------------------------------------
// Selection (PLAN)
// ---------------------------------------------------------------------------

export type ToggleResult = { ok: true; selection: string[] } | { ok: false; reason: 'full' | 'invalid' };

/** Picked types per group. */
export function pickCounts(selection: readonly string[], typeOf: TypeOf): Record<UnitGroup, number> {
  const out: Record<UnitGroup, number> = { unit: 0, building: 0 };
  for (const id of selection) {
    const t = typeOf(id);
    if (t) out[groupOf(t)]++;
  }
  return out;
}

export type GroupedToggleResult = { ok: true; selection: string[] } | { ok: false; reason: 'full'; group: UnitGroup; max: number } | { ok: false; reason: 'invalid' };

/**
 * Tap a roster card (M8.5, §5.2): select/deselect with up to `limits.unit`
 * soldier types and `limits.building` tower/wall/factory types; invalid
 * units can't be picked.
 */
export function toggleGroupedSelection(
  selection: readonly string[],
  unit: Pick<UnitCardDTO, 'unitId' | 'status'> & { stats: { type: UnitType } },
  typeOf: TypeOf,
  limits: Record<UnitGroup, number>,
): GroupedToggleResult {
  if (selection.includes(unit.unitId)) return { ok: true, selection: selection.filter((id) => id !== unit.unitId) };
  if (unit.status !== 'valid') return { ok: false, reason: 'invalid' };
  const group = groupOf(unit.stats.type);
  const counts = pickCounts(selection, typeOf);
  if (counts[group] >= limits[group]) return { ok: false, reason: 'full', group, max: limits[group] };
  return { ok: true, selection: [...selection, unit.unitId] };
}

/** "4 buildings max. Tap a picked one to swap it out." */
export function groupFullText(group: UnitGroup, max: number): string {
  return `${max} ${group === 'unit' ? (max === 1 ? 'unit' : 'units') : max === 1 ? 'building' : 'buildings'} max. Tap a picked one to swap it out.`;
}

/** "Units 2/4 · Buildings 1/4" */
export function pickCounterText(counts: Record<UnitGroup, number>, limits: Record<UnitGroup, number>): string {
  return `Units ${counts.unit}/${limits.unit} · Buildings ${counts.building}/${limits.building}`;
}

/**
 * The over-cap warning (§5.2): a picked design revised into the other group
 * can leave more picks in a group than its cap. Ready is refused until one is
 * un-picked (the server's TOO_MANY_TYPES says the same). null when it fits.
 */
export function overCapText(counts: Record<UnitGroup, number>, limits: Record<UnitGroup, number>): string | null {
  for (const g of ['unit', 'building'] as const) {
    if (counts[g] > limits[g]) return `You picked ${counts[g]} ${g === 'unit' ? 'units' : 'buildings'}; ${limits[g]} max. Tap one to un-pick it.`;
  }
  return null;
}

/** Only walls picked: Ready is refused with NO_FIGHTERS (walls protect, they don't win, §5.2). */
export function onlyWallsPicked(selection: readonly string[], typeOf: TypeOf): boolean {
  return selection.length > 0 && selection.every((id) => typeOf(id) === 'wall');
}

/** Tap a roster card: select/deselect, at most `max` types; invalid units can't be picked. */
export function toggleSelection(selection: readonly string[], unit: Pick<UnitCardDTO, 'unitId' | 'status'>, max: number): ToggleResult {
  if (selection.includes(unit.unitId)) return { ok: true, selection: selection.filter((id) => id !== unit.unitId) };
  if (unit.status !== 'valid') return { ok: false, reason: 'invalid' };
  if (selection.length >= max) return { ok: false, reason: 'full' };
  return { ok: true, selection: [...selection, unit.unitId] };
}

// ---------------------------------------------------------------------------
// PLAN Ready ("my army is picked", §12.1)
// ---------------------------------------------------------------------------

export interface PlanReadyView {
  /** The button can be pressed (un-ready always; ready needs ≥ 1 picked type). */
  enabled: boolean;
  label: string;
  /** Small text under the button. */
  hint: string;
}

/** The PLAN "I'm ready!" toggle for a selection of `picked` types (`placementIn`: a countdown to placement runs). */
export function planReadyView(
  picked: number,
  ready: boolean,
  max: number,
  placementIn?: number,
  /** M8.5: only walls picked (NO_FIGHTERS), and the "Units 2/4 · Buildings 1/4" counter to show instead of "Picked 2 of 3". */
  opts: { onlyWalls?: boolean; counter?: string } = {},
): PlanReadyView {
  if (opts.onlyWalls && !ready) {
    return { enabled: false, label: "I'm ready!", hint: 'Pick a soldier, tower or factory too: walls alone can’t win!' };
  }
  if (placementIn !== undefined) {
    // A countdown to placement runs (host or auto): say so whatever Ready is.
    return { enabled: ready || picked > 0, label: ready ? "✓ I'm ready!" : "I'm ready!", hint: `Placement starts in ${placementIn}…` };
  }
  if (ready) {
    return { enabled: true, label: "✓ I'm ready!", hint: 'Waiting for the others. Change your picks any time (then press Ready again).' };
  }
  if (picked === 0) return { enabled: false, label: "I'm ready!", hint: opts.counter ? 'Pick your units and buildings first' : `Pick up to ${max} units first` };
  return { enabled: true, label: "I'm ready!", hint: `${opts.counter ?? `Picked ${picked} of ${max}`}. Happy with your army? Press Ready!` };
}

/**
 * Show "You changed your army: press Ready again" when PLAN Ready went from
 * on to off without the player pressing the button (a new pick, or Claude
 * sent a new or revised unit). Same phase only: a phase change also resets it.
 */
export function readyWasCleared(prev: { phase: string; ready: boolean } | null, next: { phase: string; ready: boolean }, ownToggle: boolean): boolean {
  return !!prev && !ownToggle && prev.phase === 'PLAN' && next.phase === 'PLAN' && prev.ready && !next.ready;
}

// ---------------------------------------------------------------------------
// Stat bars and cost breakdown
// ---------------------------------------------------------------------------

export interface StatBar {
  key: string;
  label: string;
  /** Text shown next to the bar. */
  display: string;
  /** 0-1 fill. */
  frac: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const frac = (v: number, min: number, max: number) => (max > min ? clamp01((v - min) / (max - min)) : 0);
const num = (v: number) => (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1));

/** "15 s" / "12.5 s" from ticks. */
function seconds(ticks: number): string {
  const s = ticks / 60;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/** Factory card lines (§12.5): "1 minion every 15 s", "makes 5 minions". */
export function factoryLines(stats: Pick<StatsSnapshot, 'type'> & { productionInterval?: number }, expected?: number): string[] {
  if (stats.type !== 'factory' || !stats.productionInterval) return [];
  const out = [`1 minion every ${seconds(stats.productionInterval)}`];
  if (expected !== undefined) out.push(`makes ${expected} minion${expected === 1 ? '' : 's'}`);
  return out;
}

/** M8.6 (§12.5): the factory card's minion-kind chip, e.g. { icon: '🎯', label: 'Archers' }. */
export function factoryKindChip(stats: { produces?: MinionKind }): { kind: MinionKind; icon: string; label: string } {
  const kind = producesOf(stats);
  return { kind, icon: KIND_ICON[kind], label: kindPlural(kind) };
}

/** M8.6: "Burst 3" (saved up inside, then sent out together) or "one at a time". */
export function burstText(stats: { burst?: number }): string {
  const n = burstOf(stats);
  return n > 1 ? `Burst ${n}` : 'one at a time';
}

/** M8.6: the orders the dry run saw ("Orders: swarm, attack"); none recorded = the default attack. */
export function ordersText(orders: readonly MinionOrder[] | undefined): string {
  return `Orders: ${(orders && orders.length > 0 ? orders : ['attack']).join(', ')}`;
}

/**
 * Stat bars for a unit card. Attack speed is attacks per second (60 /
 * cooldown). Walls show health only; factories health and build speed (§12.5).
 */
export function statBars(stats: StatsSnapshot, bounds: StatBounds = DEFAULT_CONFIG.stats.bounds): StatBar[] {
  if (stats.type === 'wall') {
    return [{ key: 'hp', label: 'Health', display: num(stats.maxHealth), frac: frac(stats.maxHealth, 0, bounds.wallHealth.max) }];
  }
  if (stats.type === 'factory') {
    const iv = stats.productionInterval ?? bounds.productionInterval.max;
    const { min, max } = bounds.productionInterval;
    return [
      { key: 'hp', label: 'Health', display: num(stats.maxHealth), frac: frac(stats.maxHealth, 0, bounds.factoryHealth.max) },
      // Faster production fills the bar: the minimum interval is a full bar, the maximum still shows a sliver.
      { key: 'rate', label: 'Builds', display: seconds(iv), frac: max > min ? 0.15 + 0.85 * clamp01((max - iv) / (max - min)) : 1 },
    ];
  }
  const perSec = 60 / stats.attackCooldown;
  const maxPerSec = 60 / bounds.attackCooldown.min;
  const size = sizeOf(stats);
  return [
    { key: 'hp', label: 'Health', display: num(stats.maxHealth), frac: frac(stats.maxHealth, 0, bounds.maxHealth.max) },
    { key: 'damage', label: 'Damage', display: num(stats.damage), frac: frac(stats.damage, 0, bounds.damage.max) },
    { key: 'range', label: 'Range', display: num(stats.range), frac: frac(stats.range, 0, bounds.range.max) },
    {
      key: 'speed',
      label: 'Speed',
      display: stats.type === 'tower' ? 'tower' : num(stats.speed),
      frac: frac(stats.speed, 0, bounds.soldierSpeed.max),
    },
    {
      key: 'rate',
      label: 'Attacks',
      display: `${perSec >= 10 ? Math.round(perSec) : perSec.toFixed(perSec >= 1 && Number.isInteger(perSec) ? 0 : 1)}/s`,
      frac: frac(perSec, 0, maxPerSec),
    },
    { key: 'size', label: 'Size', display: num(size), frac: frac(size, 0, bounds.size.max) },
  ];
}

export interface BreakdownRow {
  label: string;
  value: string;
}

/** A breakdown amount: whole numbers plain, else 2 decimals; thousands separators (M8.8: prices are 5× bigger). */
const money = (n: number) =>
  Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n).toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
/** "×1.37" (no trailing zeros). */
const times = (f: number) => `×${Math.round(f * 100) / 100}`;

/**
 * Rows of the "cost breakdown" pop-up: each term, the sum, the factor, the
 * total. Walls and factories (§6) only pay for health; a factory adds its
 * production line ("5 minions × $28").
 */
export function breakdownRows(b: CostBreakdown): BreakdownRow[] {
  const t = b.terms;
  if (b.formula === 'wall' || b.formula === 'factory') {
    const rows: BreakdownRow[] = [
      { label: 'Base', value: money(t.base) },
      { label: 'Health', value: money(t.maxHealth) },
    ];
    const p = b.production;
    if (b.formula === 'factory' && p) {
      rows.push({ label: 'Body', value: formatMoney(b.body ?? Math.ceil(b.sum)) });
      const el = p.element && p.element !== 'normal' ? `${ELEMENT_ICON[p.element]} ` : '';
      rows.push({ label: `${el}${kindPlural(p.kind ?? 'grunt')}`, value: `${p.expected} × ${formatMoney(p.minionValue)}` });
    }
    rows.push({ label: 'Cost', value: formatMoney(b.cost) });
    return rows;
  }
  const rows: BreakdownRow[] = [
    { label: 'Base', value: money(t.base) },
    { label: 'Health', value: money(t.maxHealth) },
    { label: 'Damage', value: money(t.damage) },
    { label: 'Range', value: money(t.range) },
    { label: 'Speed', value: money(t.speed) },
    { label: 'Size', value: money(t.size) },
  ];
  // M8.8 (§6): the heal term sits inside the sum; power, splash and element multiply; an aura adds on after.
  if (b.heal) rows.push({ label: `${SUPPORT_ICON.heal} Heal`, value: money(b.heal.total) });
  rows.push({ label: 'Sum', value: money(b.sum) });
  rows.push({ label: 'Fast-attack ×', value: b.factor === 1 ? '×1' : times(b.factor) });
  if (b.power && b.power.factor > 1 + 1e-9) rows.push({ label: 'Tough + strong ×', value: times(b.power.factor) });
  if (b.splash && b.splash.factor > 1 + 1e-9) rows.push({ label: 'Splash ×', value: times(b.splash.factor) });
  if (b.element && b.element.element !== 'normal') rows.push({ label: `${ELEMENT_ICON[b.element.element]} ${elementName(b.element.element)} ×`, value: times(b.element.factor) });
  if (b.aura) rows.push({ label: `${SUPPORT_ICON[b.aura.kind]} Aura +`, value: money(b.aura.total) });
  rows.push({ label: 'Cost', value: formatMoney(b.cost) });
  return rows;
}

/**
 * M8.8: the sentences under the price table that explain the new parts
 * ("Power ×1.37: tough AND strong…", "Splash ×1.53 (radius 40…)", the heal
 * and aura lines), straight from the server's breakdown.
 */
export function breakdownNotes(b: CostBreakdown): string[] {
  const out: string[] = [];
  if (b.power && b.power.factor > 1 + 1e-9 && b.power.factor >= 1.1) out.push(b.power.text);
  if (b.splash && b.splash.factor > 1 + 1e-9) out.push(b.splash.text);
  if (b.element && b.element.element !== 'normal') out.push(b.element.text);
  if (b.heal) out.push(b.heal.text);
  if (b.aura) out.push(b.aura.text);
  if (b.production?.text) out.push(b.production.text);
  return out;
}

// ---------------------------------------------------------------------------
// Elements, splash and support on cards (M8.8, §12.5)
// ---------------------------------------------------------------------------

const ELEMENT_NAME: Readonly<Record<Element, string>> = { normal: 'Normal', fire: 'Fire', ice: 'Ice', lightning: 'Lightning' };
const ELEMENT_WHAT: Readonly<Record<Element, string>> = {
  normal: 'plain hits',
  fire: 'burns: half the hit again over 3 s',
  ice: 'freezes for 2 s: 35% slower',
  lightning: '35% chance to zap a nearby enemy',
};
const SUPPORT_NAME: Readonly<Record<SupportKind, string>> = { heal: 'Heal', haste: 'Haste', might: 'Might', shield: 'Shield' };

export function elementName(e: Element): string {
  return ELEMENT_NAME[e];
}

export interface CombatChip {
  key: 'element' | 'splash' | 'support' | 'minionElement';
  /** CSS modifier, e.g. "el-fire", "sup-heal", "splash". */
  tone: string;
  icon: string;
  label: string;
  /** What it does (the chip's title / tooltip). */
  title: string;
}

/**
 * M8.8: the element, splash and support chips of a unit card (none for a
 * plain unit or a wall). A factory shows its minions' element instead.
 */
export function combatChips(stats: Pick<StatsSnapshot, 'type'> & Partial<Pick<StatsSnapshot, 'element' | 'splashRadius' | 'support' | 'minionElement' | 'produces'>>): CombatChip[] {
  const out: CombatChip[] = [];
  if (stats.type === 'wall') return out;
  if (stats.type === 'factory') {
    const el = minionElementOf(stats);
    if (el !== 'normal') out.push({ key: 'minionElement', tone: `el-${el}`, icon: ELEMENT_ICON[el], label: `${ELEMENT_NAME[el]} minions`, title: `Its minions' hits: ${ELEMENT_WHAT[el]}` });
    return out;
  }
  const el = elementOf(stats);
  if (el !== 'normal') out.push({ key: 'element', tone: `el-${el}`, icon: ELEMENT_ICON[el], label: ELEMENT_NAME[el], title: `${ELEMENT_NAME[el]}: ${ELEMENT_WHAT[el]}` });
  const splash = splashOf(stats);
  if (splash > 0) out.push({ key: 'splash', tone: 'splash', icon: '💥', label: `Splash ${splash}`, title: `Every other enemy within ${splash} px of the target takes half the hit` });
  const sup = supportOf(stats);
  if (sup) {
    // §12.6: the heal chip shows its reach (phones and the projector never show the title).
    const label = sup.kind === 'heal' ? `Heal ${sup.power} · ${sup.range} px` : `${SUPPORT_NAME[sup.kind]} ${sup.power}%`;
    const title =
      sup.kind === 'heal'
        ? `Heals an ally ${sup.power} HP within ${sup.range} px (puts out fire and thaws ice first)`
        : `${SUPPORT_NAME[sup.kind]} aura: allies within ${sup.range} px get ${sup.kind === 'haste' ? `${sup.power}% faster` : sup.kind === 'might' ? `${sup.power}% more damage` : `${sup.power}% less damage taken`}`;
    out.push({ key: 'support', tone: `sup-${sup.kind}`, icon: SUPPORT_ICON[sup.kind], label, title });
  }
  return out;
}

/** M8.8: a design with damage 0 that only supports ("support only" on the card). */
export function isSupportOnly(stats: Pick<StatsSnapshot, 'type' | 'damage'> & Partial<Pick<StatsSnapshot, 'support'>>): boolean {
  return (stats.type === 'soldier' || stats.type === 'tower') && stats.damage === 0 && supportOf(stats) !== null;
}

// ---------------------------------------------------------------------------
// "Ask Claude" prompts (RESULTS, §12.1)
// ---------------------------------------------------------------------------

/**
 * One prompt per battle error: "My unit X had an error at line N: '…'. Please fix it."
 * A borrowed Open Armory unit can't be fixed (§9.1): ask for an own version instead.
 */
export function errorPrompt(e: Pick<BattleReportErrorDTO, 'unitName' | 'line' | 'message' | 'borrowedFrom'>): string {
  const where = e.line !== undefined ? ` at line ${e.line}` : '';
  const msg = e.message.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (e.borrowedFrom !== undefined) {
    return `My borrowed unit ${e.unitName} (borrowed from ${e.borrowedFrom}) had an error${where}: '${msg}'. Borrowed units can't be changed, so please build me my own improved version.`;
  }
  return `My unit ${e.unitName} had an error${where}: '${msg}'. Please fix it.`;
}

/** The same unit/line/message reported many times collapses into one prompt (with a count). */
export function groupErrors(errors: readonly BattleReportErrorDTO[]): Array<{ error: BattleReportErrorDTO; count: number; prompt: string }> {
  const groups = new Map<string, { error: BattleReportErrorDTO; count: number; prompt: string }>();
  for (const e of errors) {
    const key = `${e.unitId}|${e.line ?? ''}|${e.message}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { error: e, count: 1, prompt: errorPrompt(e) });
  }
  return [...groups.values()];
}

/** Extra prompts for units that napped (disabled) or never did damage. */
export function unitPrompts(roster: readonly UnitCardDTO[], round: number, report: BattleReportDTO | null): string[] {
  const out: string[] = [];
  const errored = new Set(report?.errors.map((e) => e.unitId) ?? []);
  for (const u of roster) {
    const lb = u.lastBattle;
    if (!lb || lb.round !== round) continue;
    if (lb.disabled > 0 && !errored.has(u.unitId)) {
      out.push(`My unit ${u.name} fell asleep in the last battle (too many errors or too slow). Please call get_battle_report and fix it.`);
    } else if (lb.damageDealt === 0 && u.stats.damage > 0) {
      out.push(`My unit ${u.name} did no damage last battle. Can you find out why?`);
    }
  }
  return out;
}

/** Factory lines of the battle report (§12.5): "🏭 Basic Factory made 5 minions (2 lost), 120 minion damage". */
export function factoryReportLines(report: Pick<BattleReportDTO, 'types'> | null | undefined): string[] {
  return (report?.types ?? [])
    .filter((t) => t.type === 'factory')
    .map((t) => {
      const made = t.minionsMade ?? 0;
      const lost = t.minionsLost ?? 0;
      const dmg = Math.round(t.minionDamage ?? 0);
      return `🏭 ${t.name} made ${made} minion${made === 1 ? '' : 's'}${lost > 0 ? ` (${lost} lost)` : ''}${dmg > 0 ? `, ${dmg.toLocaleString('en-US')} minion damage` : ''}`;
    });
}

/**
 * M8.8 report lines per unit type (§9.4 reports): how its damage was dealt
 * (burn, splash, zaps, shatters), what it healed and cleansed, and what its
 * auras helped with ("📯 War Drummer's aura helped with 1,240 damage"). Plain hit-only types get none.
 */
export function effectReportLines(report: Pick<BattleReportDTO, 'types'> | null | undefined): string[] {
  const out: string[] = [];
  const n = (v: number) => Math.round(v).toLocaleString('en-US');
  for (const t of report?.types ?? []) {
    const sp = t.damageSplit;
    if (sp) {
      const parts: string[] = [];
      if (sp.burn >= 1) parts.push(`🔥 ${n(sp.burn)} burn`);
      if (sp.splash >= 1) parts.push(`💥 ${n(sp.splash)} splash`);
      if (sp.zap >= 1) parts.push(`⚡ ${n(sp.zap)} zaps`);
      if (sp.shatter >= 1) parts.push(`❄️ ${n(sp.shatter)} shatter`);
      if (parts.length > 0) out.push(`${t.name}: ${parts.join(', ')} (of ${n(t.damageDealt)} damage)`);
    }
    const heal = t.healing ?? 0;
    const cleanses = t.cleanses ?? 0;
    if (heal >= 1 || cleanses > 0) {
      const bits = [heal >= 1 ? `healed ${n(heal)} HP` : '', cleanses > 0 ? `put out ${cleanses} fire${cleanses === 1 ? '' : 's'} or freeze${cleanses === 1 ? '' : 's'}` : ''].filter(Boolean);
      out.push(`💚 ${t.name} ${bits.join(' and ')}`);
    }
    // assist = might's extra damage + what shield auras blocked, so the line names both (a shield adds no damage).
    if ((t.assist ?? 0) >= 1) out.push(`📯 ${t.name}'s aura helped with ${n(t.assist!)} damage (extra damage dealt or damage blocked)`);
  }
  return out;
}

/**
 * "Got stuck behind walls" prompts (§12.5): a soldier type blocked for more
 * than 30% of the battle (or the report's own hints) becomes an Ask-Claude prompt.
 */
export function stuckPrompts(report: Pick<BattleReportDTO, 'types' | 'hints'> | null | undefined, battleTicks: number): string[] {
  const out = new Set<string>(report?.hints ?? []);
  for (const t of report?.types ?? []) {
    if (t.type !== 'soldier' || !t.blockedTicksMax || battleTicks <= 0) continue;
    if (t.blockedTicksMax / battleTicks > 0.3) {
      out.add(`My ${t.name} got stuck behind walls a lot last battle. Can you find out why?`);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Claude terminal: adults' direct link (§11.2 b "Fallback")
// ---------------------------------------------------------------------------

export const TTYD_BASE_PORT = 7780;
/** Seat containers on the Claude box: seat1..seat8 on ports 7781-7788 (§11.1, §11.2). */
export const CLAUDE_SEATS = 8;

/** Host part of a Claude box address ("192.168.8.20", "http://box:8080/x" → "box"). */
export function claudeBoxHost(address: string | null | undefined): string | null {
  if (!address) return null;
  let s = address.trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/)[0] ?? '';
  // [ipv6]:port or host:port
  const v6 = /^\[([^\]]+)\]/.exec(s);
  if (v6) return `[${v6[1]}]`;
  s = s.replace(/:\d+$/, '');
  return /^[a-z0-9.-]+$/i.test(s) ? s : null;
}

/**
 * `http://<box>:778N/terminal/N/` for Claude seat 1-8: ttyd directly on the
 * Claude box, bypassing the game server's proxy. It asks for the seat password,
 * so it is only the grown-ups' fallback; players use /terminal/N/ inside /play.
 */
export function claudeTerminalUrl(address: string | null | undefined, claudeSeat: number): string | null {
  const host = claudeBoxHost(address);
  if (!host || !Number.isInteger(claudeSeat) || claudeSeat < 1 || claudeSeat > CLAUDE_SEATS) return null;
  return `http://${host}:${TTYD_BASE_PORT + claudeSeat}/terminal/${claudeSeat}/`;
}

// ---------------------------------------------------------------------------
// Join form
// ---------------------------------------------------------------------------

export const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
export const PIN_RE = /^\d{4}$/;

/** Friendly problem with a name, or null when it's fine. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Type your player name.';
  if (n.length > 16) return 'That name is too long (16 letters max).';
  if (!NAME_RE.test(n)) return 'Use only letters, numbers, spaces, - and _.';
  return null;
}

/** Append a keypad digit / backspace to a PIN (max 4 digits). */
export function pinKey(pin: string, key: string): string {
  if (key === 'back') return pin.slice(0, -1);
  if (key === 'clear') return '';
  if (/^\d$/.test(key) && pin.length < 4) return pin + key;
  return pin;
}

// ---------------------------------------------------------------------------
// Round score in friendly language (§9 Points, Badges; §12.4 friendly language)
// ---------------------------------------------------------------------------

function pts(n: number): string {
  return `+${n} point${n === 1 ? '' : 's'}`;
}

function nth(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

export interface ScoreLine {
  icon: string;
  text: string;
  points: number;
}

type ScoreParts = Pick<RankingEntryDTO, 'place' | 'pointsGained' | 'placePoints' | 'damage' | 'damageBonus' | 'valueDestroyed' | 'valueBonus' | 'badges' | 'inventorUsedBy'>;

/**
 * A ranking entry with the scoring fields filled in. Results saved before the
 * scoring metrics existed only carry place and pointsGained; they read as
 * place points only (same fallbacks as /screen's model).
 */
export function scoreParts(entry: Pick<RankingEntryDTO, 'place'> & Partial<ScoreParts>): ScoreParts {
  const placePoints = entry.placePoints ?? entry.pointsGained ?? 0;
  const damageBonus = entry.damageBonus ?? 0;
  const valueBonus = entry.valueBonus ?? 0;
  return {
    place: entry.place,
    pointsGained: entry.pointsGained ?? placePoints + damageBonus + valueBonus,
    placePoints,
    damage: entry.damage ?? 0,
    damageBonus,
    valueDestroyed: entry.valueDestroyed ?? 0,
    valueBonus,
    badges: entry.badges ?? [],
    ...(entry.inventorUsedBy !== undefined ? { inventorUsedBy: entry.inventorUsedBy } : {}),
  };
}

/**
 * One line per part of the round score: place, damage bonus, value bonus. In
 * team mode the place (and its points) are the team's (§9.2 Team scoring),
 * while the bonuses stay your own.
 */
export function scoreLines(raw: Pick<RankingEntryDTO, 'place'> & Partial<ScoreParts>, opts: { team?: boolean } = {}): ScoreLine[] {
  const entry = scoreParts(raw);
  const who = opts.team ? 'Your team came' : 'You came';
  const dmg = Math.round(entry.damage);
  const value = `$${Math.round(entry.valueDestroyed).toLocaleString('en-US')}`;
  return [
    { icon: '🏅', text: `${who} ${nth(entry.place)}: ${pts(entry.placePoints)}!`, points: entry.placePoints },
    {
      icon: '💥',
      text:
        dmg === 0
          ? 'No damage this time: +0 points. Next battle!'
          : `You dealt ${dmg.toLocaleString('en-US')} damage: ${pts(entry.damageBonus)}${entry.damageBonus > 0 ? '!' : '. Hit harder for a bonus!'}`,
      points: entry.damageBonus,
    },
    {
      icon: '🗡️',
      text:
        entry.valueDestroyed === 0
          ? 'No knockouts this time: +0 points. Next battle!'
          : `You knocked out ${value} of enemy units: ${pts(entry.valueBonus)}${entry.valueBonus > 0 ? '!' : '.'}`,
      points: entry.valueBonus,
    },
  ];
}

/** What each badge means, said to the player who won it. */
export const BADGE_PLAYER_TEXT: Readonly<Record<BadgeId, string>> = {
  lastStanding: 'You came 1st!',
  biggestHitter: 'You dealt the most damage!',
  giantSlayer: 'Your knockouts were worth the most $!',
  ironWall: 'Your army had the most still standing at the end!',
  inventor: 'Another player borrowed your unit from the Open Armory!',
  bestMedic: 'Your healers healed the most!',
  comboMaster: 'You pulled off the most shatters and overload zaps!',
};

// ---------------------------------------------------------------------------
// Past battles (§12.1): the round picker and a round's ranking rows
// ---------------------------------------------------------------------------

/**
 * The rounds of this match whose results are public: every finished round
 * (RESULTS / MATCH_RESULTS include the current one; PLAN, PLACEMENT and BATTLE
 * only the earlier ones: a battle still playing is never shown). None in LOBBY.
 */
export function releasedRounds(g: { phase: string; round: number } | null | undefined): number[] {
  if (!g || g.phase === 'LOBBY') return [];
  const latest = g.phase === 'RESULTS' || g.phase === 'MATCH_RESULTS' ? g.round : g.round - 1;
  return Array.from({ length: Math.max(0, latest) }, (_, i) => i + 1);
}

/** Keep the picked round while it is still listed, else show the latest. */
export function pickRound(rounds: readonly number[], current: number | null): number | null {
  if (rounds.length === 0) return null;
  return current !== null && rounds.includes(current) ? current : rounds[rounds.length - 1]!;
}

export interface PastRankRow {
  playerId: string;
  name: string;
  seat: number;
  place: number;
  placePoints: number;
  damageBonus: number;
  valueBonus: number;
  pointsGained: number;
  damage: number;
  badges: BadgeId[];
  me: boolean;
}

/** A released round's ranking with names (from that round's scoreboard, else the live player list). */
export function pastRankRows(
  end: { ranking: readonly RankingEntryDTO[]; scoreboard?: ReadonlyArray<{ playerId: string; name: string; seat: number }> },
  players: ReadonlyArray<{ id: string; name: string; seat: number }>,
  meId: string | undefined,
): PastRankRow[] {
  const board = new Map((end.scoreboard ?? []).map((s) => [s.playerId, s]));
  const live = new Map(players.map((p) => [p.id, p]));
  return [...end.ranking]
    .sort((a, b) => a.place - b.place)
    .map((r) => {
      const who = board.get(r.playerId) ?? live.get(r.playerId);
      const parts = scoreParts(r);
      return {
        playerId: r.playerId,
        name: who?.name ?? '?',
        seat: who?.seat ?? -1,
        place: r.place,
        placePoints: parts.placePoints,
        damageBonus: parts.damageBonus,
        valueBonus: parts.valueBonus,
        pointsGained: r.pointsGained,
        damage: Math.round(r.damage ?? 0),
        badges: [...r.badges],
        me: r.playerId === meId,
      };
    });
}
