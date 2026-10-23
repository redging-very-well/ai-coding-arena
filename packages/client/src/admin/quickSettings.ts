// Quick settings (plan §12.3 config editor): the high-level config knobs as a
// labelled form above the full JSON editor. DOM-free and tested
// (tests/admin-quick-settings.test.ts).
//
// Each field is one row of QUICK_GROUPS: a config path (dots; numeric segments
// index arrays), a label, help text, the unit shown, optional display
// conversions (seconds ↔ minutes, ticks ↔ seconds) and display-unit bounds.
// The zod ConfigSchema is checked too (validateDraft), so its bounds and
// cross-field rules (e.g. sudden death start < end) show inline as well.

import { ConfigSchema, checkStats, computeCost, isNonCombatBuilding, pricingOf, type CostStats, type GameConfig } from '@pixel-clash/shared';

export interface QuickField {
  /** Config path, e.g. "caps.budget" or "scoring.placePoints.0". */
  path: string;
  label: string;
  help: string;
  /** Shown after the input ("$", "min", "s", "%/s", "pts"…). */
  unit?: string;
  /** Stored value → shown value (default: identity). */
  toDisplay?: (stored: number, cfg: GameConfig) => number;
  /** Shown value → stored value (default: identity). */
  fromDisplay?: (shown: number, cfg: GameConfig) => number;
  /** Bounds and step, in display units. */
  min?: number;
  max?: number;
  step?: number;
  /** The shown value must be a whole number. */
  integer?: boolean;
}

/** An on/off setting shown as a checkbox (a boolean at `path`). */
export interface QuickToggle {
  path: string;
  label: string;
  help: string;
}

export interface QuickGroup {
  id: string;
  title: string;
  fields: QuickField[];
  toggles?: QuickToggle[];
}

const minutes = {
  unit: 'min',
  toDisplay: (s: number) => s / 60,
  fromDisplay: (m: number) => Math.round(m * 60),
  step: 0.5,
} satisfies Partial<QuickField>;

const tickSeconds = {
  unit: 's',
  toDisplay: (t: number, cfg: GameConfig) => t / cfg.timers.ticksPerSecond,
  fromDisplay: (s: number, cfg: GameConfig) => Math.round(s * cfg.timers.ticksPerSecond),
  step: 1,
} satisfies Partial<QuickField>;

const money = { unit: '$', min: 0, step: 0.05 } satisfies Partial<QuickField>;

export const QUICK_GROUPS: QuickGroup[] = [
  {
    id: 'match',
    title: 'Match',
    fields: [
      {
        path: 'match.maxPlayers',
        label: 'Max players (seats)',
        help: 'How many players can join one match (2-8). The map and arena size follow the player count automatically; a full game answers "All seats are taken".',
        min: 2,
        max: 8,
        step: 1,
        integer: true,
      },
    ],
  },
  {
    id: 'economy',
    title: 'Economy',
    fields: [
      { path: 'caps.budget', label: 'Budget per round ($)', help: 'Credits each player gets to place units every round (resets each round).', unit: '$', min: 1, step: 50, integer: true },
      { path: 'caps.unitCost', label: 'Max cost of one unit ($)', help: 'A unit priced above this is rejected. The starter templates must stay under it.', unit: '$', min: 1, step: 10, integer: true },
      { path: 'caps.maxUnitTypes', label: 'Unit types per round', help: 'How many different soldier designs a player can field in one round.', min: 1, step: 1, integer: true },
      { path: 'caps.maxBuildingTypes', label: 'Building types per round', help: 'How many different tower, wall and factory designs a player can field in one round.', min: 1, step: 1, integer: true },
      { path: 'caps.maxCopies', label: 'Max fighters placed per player', help: 'Soldiers, towers and factories a player can put on the arena in one round (walls count separately).', min: 1, step: 1, integer: true },
      { path: 'caps.maxWallCopies', label: 'Max walls placed per player', help: 'Walls a player can put on the arena in one round, on top of the fighters.', min: 0, step: 1, integer: true },
      { path: 'caps.maxFactoryCopies', label: 'Max factories placed per player', help: 'Of the fighters, how many can be factories.', min: 0, step: 1, integer: true },
      { path: 'caps.maxDesigns', label: 'Max designs per player', help: 'Active designs each player can keep (the two templates don’t count).', min: 1, step: 1, integer: true },
    ],
  },
  {
    id: 'timers',
    title: 'Timers',
    fields: [
      { path: 'timers.defaultRounds', label: 'Rounds per match', help: 'Default for the Start match box (1-10).', min: 1, max: 10, step: 1, integer: true },
      { ...minutes, path: 'timers.planFirstRoundSec', label: 'Plan time, round 1', help: 'Time to design units with Claude in the first round.', min: 0.5 },
      { ...minutes, path: 'timers.planLaterRoundsSec', label: 'Plan time, later rounds', help: 'Plan time in rounds 2 and later.', min: 0.5 },
      { ...minutes, path: 'timers.placementSec', label: 'Placement time', help: 'Time to pick units and place them on the arena.', min: 0.5 },
      {
        ...tickSeconds,
        path: 'timers.battleTicks',
        label: 'Battle length',
        help: 'How long a battle lasts. The sudden-death circle finishes shrinking at the end of the battle: if it ended exactly at the old length, its end moves with this.',
        min: 10,
      },
    ],
    toggles: [
      {
        path: 'timers.autoAdvanceWhenAllReady',
        label: 'Start placement automatically when everyone is ready',
        help: 'In Plan time, placement starts 3 seconds after every player pressed Ready (un-readying cancels it; a paused timer holds it). The battle itself still waits for your START.',
      },
    ],
  },
  {
    id: 'costs',
    title: 'Costs',
    fields: [
      { ...money, path: 'cost.base', label: 'Base cost per unit', help: 'Every unit pays this before its stats.', step: 1 },
      { ...money, path: 'cost.hp', label: '$ per HP', help: 'Price of each point of maxHealth (before the curve).' },
      { ...money, path: 'cost.damage', label: '$ per damage', help: 'Price of each point of damage per hit.' },
      { ...money, path: 'cost.range', label: '$ per px range', help: 'Price of each pixel of attack range.' },
      { ...money, path: 'cost.speed', label: '$ per speed', help: 'Price of each px/tick of movement speed (towers have 0).', step: 0.5 },
      { ...money, path: 'cost.size', label: '$ per px size (above 6)', help: 'Price of each pixel of body radius above 6.' },
      { path: 'cost.curveK', label: 'Max-stat steepness k (maxed stat costs 1+k ×)', help: '0 = straight-line prices. With k = 2 a maxed stat costs 3× and a half-max stat 1.5×.', min: 0, max: 5, step: 0.25 },
    ],
  },
  {
    // M8.5 (§5.2, §6, §9.3): wall and factory prices, their stat ranges, the minion and the factory caps.
    id: 'buildings',
    title: 'Walls & factories',
    fields: [
      { ...money, path: 'cost.wall.base', label: 'Wall base cost', help: 'Every wall pays this before its health.', step: 1 },
      { ...money, path: 'cost.wall.hp', label: 'Wall $ per HP', help: 'Price of each point of wall health (before the curve). Walls are cheap per HP: they can’t move or fight and count $0 at the end.', step: 0.01 },
      { ...money, path: 'cost.factory.base', label: 'Factory base cost', help: 'Every factory pays this before its health and minions.', step: 1 },
      { ...money, path: 'cost.factory.hp', label: 'Factory $ per HP', help: 'Price of each point of factory health (before the curve).', step: 0.01 },
      {
        path: 'cost.factory.minionDiscount',
        label: 'Minion price share',
        help: 'A factory pays this share of a minion’s soldier price for each minion it can make (they arrive during the battle, so less than 100%).',
        unit: '%',
        toDisplay: (v: number) => v * 100,
        fromDisplay: (v: number) => v / 100,
        min: 1,
        max: 100,
        step: 5,
      },
      { path: 'stats.bounds.wallHealth.min', label: 'Wall health: min', help: 'The least HP a wall can have.', min: 1, step: 10, integer: true },
      { path: 'stats.bounds.wallHealth.max', label: 'Wall health: max', help: 'The most HP a wall can have.', min: 1, step: 50, integer: true },
      { path: 'stats.bounds.factoryHealth.min', label: 'Factory health: min', help: 'The least HP a factory can have.', min: 1, step: 10, integer: true },
      { path: 'stats.bounds.factoryHealth.max', label: 'Factory health: max', help: 'The most HP a factory can have.', min: 1, step: 50, integer: true },
      { ...tickSeconds, path: 'stats.bounds.productionInterval.min', label: 'Fastest minion every', help: 'The shortest time a factory can take to build one minion.', min: 1 },
      { ...tickSeconds, path: 'stats.bounds.productionInterval.max', label: 'Slowest minion every', help: 'The longest time a factory can take to build one minion.', min: 1 },
      { path: 'factory.maxMinionsPerFactory', label: 'Minions per factory per battle', help: 'The most minions one factory makes in a battle (its price counts them).', min: 1, step: 1, integer: true },
      { path: 'factory.maxAlivePerFactory', label: 'Minions alive per factory', help: 'A factory waits while this many of its minions are alive.', min: 1, step: 1, integer: true },
      { path: 'factory.maxAlivePerPlayer', label: 'Minions alive per player', help: 'All of a player’s factories together (also limited to 40 ÷ players).', min: 1, step: 1, integer: true },
      { path: 'factory.maxAlivePerBattle', label: 'Minions alive per battle', help: 'The most minions in the whole arena at once (keeps big battles smooth).', min: 1, step: 1, integer: true },
      // M8.6 (§5.3): the four minion kinds (each must stay within the soldier bounds; prices follow).
      ...(['grunt', 'archer', 'runner', 'brute'] as const).flatMap((k) => {
        const name = k[0]!.toUpperCase() + k.slice(1);
        return [
          { path: `factory.minions.${k}.maxHealth`, label: `${name} health`, help: `HP of a factory's ${k}s (must stay within the soldier bounds).`, min: 1, step: 5 },
          { path: `factory.minions.${k}.damage`, label: `${name} damage`, help: `Damage per ${k} hit${k === 'archer' ? ' (a shot)' : ' (melee)'}.`, min: 0, step: 1 },
          { path: `factory.minions.${k}.speed`, label: `${name} speed`, help: 'Pixels per tick (60 ticks = 1 s).', unit: 'px/tick', min: 0.1, step: 0.1 },
        ];
      }),
      { path: 'factory.minions.brute.wallDamageMultiplier', label: 'Brute wall damage', help: 'Brute hits on walls deal damage × this (1-5).', unit: '×', min: 1, max: 5, step: 0.5 },
    ],
  },
  {
    id: 'scoring',
    title: 'Scoring',
    fields: [
      // Place points are a formula (1st gets players − 1 … last 0, §9 Points), not config.
      { path: 'scoring.damageBonusMax', label: 'Max damage bonus (at 4 players)', help: 'Extra points for the top damage dealer; others get a share. Scaled × players/4.', unit: 'pts', min: 0, step: 1, integer: true },
      { path: 'scoring.valueBonusMax', label: 'Max value-destroyed bonus (at 4 players)', help: 'Extra points for destroying the most enemy value; others get a share. Scaled × players/4.', unit: 'pts', min: 0, step: 1, integer: true },
    ],
  },
  {
    id: 'suddenDeath',
    title: 'Sudden death',
    fields: [
      { ...tickSeconds, path: 'suddenDeath.startTick', label: 'Sudden death starts at', help: 'Seconds into the battle when the safe circle starts shrinking. Must be before the circle finishes shrinking (normally the end of the battle).', min: 0 },
      { path: 'suddenDeath.damagePctPerSecond', label: 'Damage outside the circle (% max HP / s)', help: 'Units outside the safe circle lose this share of their max HP every second.', unit: '%/s', min: 0, max: 100, step: 0.5 },
    ],
  },
];

export const QUICK_FIELDS: QuickField[] = QUICK_GROUPS.flatMap((g) => g.fields);
export const QUICK_TOGGLES: QuickToggle[] = QUICK_GROUPS.flatMap((g) => g.toggles ?? []);

/** A quick toggle's value in the draft (false when missing). */
export function toggleValue(cfg: unknown, path: string): boolean {
  return getPath(cfg, path) === true;
}

// --- paths --------------------------------------------------------------------

function segments(path: string): (string | number)[] {
  return path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** The value at `path`, or undefined when any step is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of segments(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** A copy of `obj` with `path` set to `value` (copies only the objects/arrays on the way). */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const segs = segments(path);
  const go = (cur: unknown, i: number): unknown => {
    const seg = segs[i]!;
    const node = (
      Array.isArray(cur) ? [...cur] : cur !== null && typeof cur === 'object' ? { ...cur } : typeof seg === 'number' ? [] : {}
    ) as Record<string | number, unknown>;
    node[seg] = i === segs.length - 1 ? value : go(node[seg], i + 1);
    return node;
  };
  return go(obj, 0) as T;
}

// --- display conversion ---------------------------------------------------------

/** Round away float noise (0.1 + 0.2) for display. */
export function tidy(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function toDisplay(field: QuickField, stored: number, cfg: GameConfig): number {
  return tidy(field.toDisplay ? field.toDisplay(stored, cfg) : stored);
}

export function fromDisplay(field: QuickField, shown: number, cfg: GameConfig): number {
  return field.fromDisplay ? field.fromDisplay(shown, cfg) : shown;
}

/** The field's value as shown, or undefined when the draft has no number there. */
export function displayValue(field: QuickField, cfg: GameConfig): number | undefined {
  const v = getPath(cfg, field.path);
  return typeof v === 'number' ? toDisplay(field, v, cfg) : undefined;
}

/** "15 min", "$1000", "3 pts". */
export function formatShown(field: QuickField, shown: number | undefined): string {
  if (shown === undefined) return '—';
  if (field.unit === '$') return `$${shown}`;
  return field.unit ? `${shown} ${field.unit}` : String(shown);
}

// --- validation -------------------------------------------------------------------

export type FieldInput = { ok: true; stored: number } | { ok: false; error: string };

/** Check what the facilitator typed (display units) against the table's rules. */
export function parseFieldInput(field: QuickField, raw: string, cfg: GameConfig): FieldInput {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'Enter a number.' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, error: 'That is not a number.' };
  if (field.integer && !Number.isInteger(n)) return { ok: false, error: 'Use a whole number.' };
  if (field.min !== undefined && n < field.min) return { ok: false, error: `The smallest allowed is ${formatShown(field, field.min)}.` };
  if (field.max !== undefined && n > field.max) return { ok: false, error: `The largest allowed is ${formatShown(field, field.max)}.` };
  return { ok: true, stored: fromDisplay(field, n, cfg) };
}

/** Problems with a whole draft config: per quick-field path, plus the rest. */
export interface DraftIssues {
  byField: Record<string, string[]>;
  other: string[];
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/**
 * Validate the draft with the shared zod ConfigSchema. Each issue goes to the
 * quick field at its path, or (for an object-level rule such as
 * "startTick must be < endTick") to every quick field under that object.
 * Issues that touch no quick field land in `other`.
 */
export function validateDraft(draft: unknown): DraftIssues {
  const out: DraftIssues = { byField: {}, other: [] };
  const r = ConfigSchema.safeParse(draft);
  if (r.success) return out;
  for (const issue of r.error.issues) {
    const path = issuePath(issue.path);
    if (path === 'suddenDeath' && issue.message === SD_ORDER_MESSAGE) addSuddenDeathOrder(out, draft);
    else addIssue(out, path, issue.message);
  }
  return out;
}

/** The schema's object-level suddenDeath rule (config.ts). */
const SD_ORDER_MESSAGE = 'startTick must be < endTick';

/**
 * "startTick must be < endTick" belongs on the start field (not on every
 * sudden-death field), and also on Battle length when the circle's end follows
 * the battle length: shortening the battle is then what broke it.
 */
function addSuddenDeathOrder(out: DraftIssues, draft: unknown): void {
  const end = getPath(draft, 'suddenDeath.endTick');
  const tps = getPath(draft, 'timers.ticksPerSecond');
  const endText = typeof end === 'number' && typeof tps === 'number' && tps > 0 ? ` (at ${tidy(end / tps)} s)` : '';
  const followsBattle = typeof end === 'number' && end === getPath(draft, 'timers.battleTicks');
  const message = `Sudden death must start before the circle finishes shrinking${endText}${followsBattle ? ', which is the end of the battle' : ''}.`;
  (out.byField['suddenDeath.startTick'] ??= []).push(message);
  if (followsBattle) (out.byField['timers.battleTicks'] ??= []).push(message);
}

/** Attach `message` at `path` to the matching quick fields (or `other`). */
export function addIssue(out: DraftIssues, path: string, message: string): void {
  const hits = QUICK_FIELDS.filter((f) => f.path === path || (path !== '' && f.path.startsWith(`${path}.`)) || (path !== '' && path.startsWith(`${f.path}.`)));
  if (!hits.length) {
    out.other.push(path ? `${path}: ${message}` : message);
    return;
  }
  for (const f of hits) (out.byField[f.path] ??= []).push(message);
}

// --- editing ------------------------------------------------------------------------

/**
 * Set one quick field (stored units) in the draft. Keeps linked settings
 * consistent: when the battle length changes and the sudden-death circle used
 * to finish exactly at the end of the battle, its end moves with it.
 */
export function applyField(cfg: GameConfig, path: string, stored: number): GameConfig {
  let next = setPath(cfg, path, stored);
  if (path === 'timers.battleTicks') {
    const oldLen = cfg.timers?.battleTicks;
    if (cfg.suddenDeath && cfg.suddenDeath.endTick === oldLen) next = setPath(next, 'suddenDeath.endTick', stored);
  }
  return next;
}

/**
 * What typing `raw` into a quick field does to the draft. A valid number is
 * applied; anything else (including an intermediate keystroke such as the
 * "1" on the way to "12" when only 1-10 is allowed, then "12") puts the field
 * back to its saved value, so the draft never keeps a number that was not
 * what the facilitator meant. `error` is the field's input error ('' = fine).
 */
export function typeIntoField(field: QuickField, raw: string, base: GameConfig, draft: GameConfig): { draft: GameConfig; error: string } {
  const r = parseFieldInput(field, raw, draft);
  if (r.ok) return { draft: applyField(draft, field.path, r.stored), error: '' };
  const saved = getPath(base, field.path);
  if (typeof saved === 'number' && saved !== getPath(draft, field.path)) return { draft: applyField(draft, field.path, saved), error: r.error };
  return { draft, error: r.error };
}

/** "Rounds per match: The largest allowed is 10." per field with an input error ('' when none). */
export function inputErrorText(errors: Readonly<Record<string, string>>): string {
  return QUICK_FIELDS.filter((f) => errors[f.path])
    .map((f) => `${f.label}: ${errors[f.path]}`)
    .join(' ');
}

/** Messages without repeats, in first-seen order. */
export function unique(messages: readonly string[]): string[] {
  return [...new Set(messages)];
}

/** Whether a quick field differs between the saved config and the draft. */
export function fieldChanged(field: Pick<QuickField, 'path'>, base: unknown, draft: unknown): boolean {
  return JSON.stringify(getPath(base, field.path)) !== JSON.stringify(getPath(draft, field.path));
}

/**
 * Turn a refused PUT /admin/config into inline messages. Zod issues (BAD_REQUEST
 * details.issues) go to their fields; any other refusal (e.g.
 * TEMPLATE_WOULD_BREAK) goes to every changed quick field, since one of those
 * changes caused it, and to `other` when no quick field changed.
 */
export function refusalIssues(
  err: { code?: string; message: string; hint?: string; details?: Record<string, unknown> },
  base: unknown,
  draft: unknown,
): DraftIssues {
  const out: DraftIssues = { byField: {}, other: [] };
  const issues = err.details?.issues;
  if (Array.isArray(issues) && issues.length) {
    for (const i of issues as { path?: PropertyKey[]; message?: string }[]) addIssue(out, issuePath(i.path ?? []), i.message ?? err.message);
    return out;
  }
  const text = err.hint && err.hint !== err.message ? `${err.message} ${err.hint}` : err.message;
  if (err.code === 'PHASE_CLOSED') {
    out.other.push(text);
    return out;
  }
  let changed = QUICK_FIELDS.filter((f) => fieldChanged(f, base, draft));
  if (err.code === 'TEMPLATE_WOULD_BREAK') {
    // Find the cause locally: a stat bound (only in the JSON) or the price
    // (the cost coefficients and the max unit cost).
    let broken: TemplateProblems | null = null;
    try {
      broken = templateProblems(draft as GameConfig);
    } catch {
      broken = null;
    }
    if (broken?.outOfBounds.length) {
      out.other.push(text);
      return out;
    }
    const priceFields = changed.filter((f) => f.path.startsWith('cost.') || f.path === 'caps.unitCost');
    if (priceFields.length) changed = priceFields;
  }
  if (!changed.length) out.other.push(text);
  for (const f of changed) (out.byField[f.path] ??= []).push(text);
  return out;
}

const TEMPLATE_LOOKS: Partial<Record<PreviewUnit['key'], { name: string; color: string; shape: string }>> = {
  basicSoldier: { name: 'Basic Soldier', color: '#3399FF', shape: 'circle' },
  basicTower: { name: 'Basic Tower', color: '#FF9933', shape: 'square' },
  basicWall: { name: 'Basic Wall', color: '#8A8F98', shape: 'square' },
  basicFactory: { name: 'Basic Factory', color: '#C0A060', shape: 'square' },
};

/** The stat fields a design of this type sets (walls and factories leave the attack stats out, §5.2). */
function ownStats(stats: CostStats): Record<string, unknown> {
  if (!isNonCombatBuilding(stats.type)) return { ...stats };
  const out: Record<string, unknown> = { type: stats.type, maxHealth: stats.maxHealth };
  if (stats.type === 'factory') out.productionInterval = stats.productionInterval;
  return out;
}

/** The stat-bound error (checkStats, as the server's templateBreaks runs it) for a preview unit, or null. */
export function boundsError(u: Pick<PreviewUnit, 'key' | 'label' | 'stats'>, cfg: GameConfig): string | null {
  const looks = TEMPLATE_LOOKS[u.key] ?? { name: 'Preview', color: '#888888', shape: 'circle' };
  const r = checkStats({ ...looks, ...ownStats(u.stats) }, cfg.stats.bounds);
  return r.ok ? null : (r.errors[0]?.message ?? 'Out of bounds.');
}

interface TemplateProblems {
  outOfBounds: string[];
  overCap: string[];
}

/** Which starter templates the draft would break, and how (the server refuses either). */
function templateProblems(cfg: GameConfig): TemplateProblems {
  const out: TemplateProblems = { outOfBounds: [], overCap: [] };
  for (const u of previewUnits(cfg).filter((x) => x.template)) {
    if (boundsError(u, cfg)) out.outOfBounds.push(u.label);
    const r = computeCost(u.stats, cfg.cost, pricingOf(cfg));
    if (!Number.isFinite(r.raw) || r.cost > cfg.caps.unitCost) out.overCap.push(u.label);
  }
  return out;
}

// --- live cost preview -------------------------------------------------------------

export interface PreviewUnit {
  key: 'basicSoldier' | 'basicTower' | 'bigTank' | 'allMax' | 'basicWall' | 'basicFactory' | 'swarmFactory' | 'archerFactory' | 'runnerFactory' | 'bruteFactory';
  label: string;
  stats: CostStats;
  /** A starter template: if it goes over the cap the server refuses the save. */
  template: boolean;
}

export const BASIC_SOLDIER: CostStats = { type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
export const BASIC_TOWER: CostStats = { type: 'tower', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45, size: 14 };
export const BIG_TANK: CostStats = { type: 'soldier', maxHealth: 500, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
/** M8.5 templates (§11) and the plan's Swarm Factory (§6). */
export const BASIC_WALL: CostStats = { type: 'wall', maxHealth: 400, damage: 0, range: 0, speed: 0, attackCooldown: 60 };
export const BASIC_FACTORY: CostStats = { type: 'factory', maxHealth: 300, damage: 0, range: 0, speed: 0, attackCooldown: 60, productionInterval: 900 };
export const SWARM_FACTORY: CostStats = { ...BASIC_FACTORY, productionInterval: 600 };

/** The preview units; the all-max one uses the draft's stat bounds. */
export function previewUnits(cfg: GameConfig): PreviewUnit[] {
  const b = cfg.stats.bounds;
  const allMax: CostStats = {
    type: 'soldier',
    maxHealth: b.maxHealth.max,
    damage: b.damage.max,
    range: b.range.max,
    speed: b.soldierSpeed.max,
    attackCooldown: b.attackCooldown.min,
    size: b.size.max,
  };
  return [
    { key: 'basicSoldier', label: 'Basic Soldier', stats: BASIC_SOLDIER, template: true },
    { key: 'basicTower', label: 'Basic Tower', stats: BASIC_TOWER, template: true },
    { key: 'bigTank', label: 'Big Tank (500 HP soldier)', stats: BIG_TANK, template: false },
    { key: 'allMax', label: 'Everything maxed', stats: allMax, template: false },
    { key: 'basicWall', label: 'Basic Wall (400 HP)', stats: BASIC_WALL, template: true },
    { key: 'basicFactory', label: 'Basic Factory (5 minions)', stats: BASIC_FACTORY, template: true },
    { key: 'swarmFactory', label: 'Swarm Factory (8 minions)', stats: SWARM_FACTORY, template: false },
    // M8.6 (§6 Minion kinds): the Basic Factory building each other kind.
    { key: 'archerFactory', label: 'Archer Factory (5 archers)', stats: { ...BASIC_FACTORY, produces: 'archer' }, template: false },
    { key: 'runnerFactory', label: 'Runner Factory (5 runners)', stats: { ...BASIC_FACTORY, produces: 'runner' }, template: false },
    { key: 'bruteFactory', label: 'Brute Factory (5 brutes)', stats: { ...BASIC_FACTORY, produces: 'brute' }, template: false },
  ];
}

export interface PreviewRow extends PreviewUnit {
  cost: number;
  /** Over the max cost of one unit (or not a finite price). */
  overCap: boolean;
  /** Breaks the draft's stat bounds (checkStats): the first reason, or null. */
  outOfBounds: string | null;
}

export interface CostPreview {
  rows: PreviewRow[];
  cap: number;
  budget: number;
  /** 4 Basic Soldiers + 3 Basic Towers. */
  army: { soldiers: number; towers: number; total: number; overBudget: boolean };
}

/** Prices the preview units with the shared computeCost under the draft. */
export function costPreview(cfg: GameConfig): CostPreview {
  const cap = cfg.caps.unitCost;
  const pricing = pricingOf(cfg);
  const rows = previewUnits(cfg).map((u) => {
    const r = computeCost(u.stats, cfg.cost, pricing);
    return { ...u, cost: r.cost, overCap: !Number.isFinite(r.raw) || r.cost > cap, outOfBounds: boundsError(u, cfg) };
  });
  const soldier = rows.find((r) => r.key === 'basicSoldier')!.cost;
  const tower = rows.find((r) => r.key === 'basicTower')!.cost;
  const total = 4 * soldier + 3 * tower;
  return { rows, cap, budget: cfg.caps.budget, army: { soldiers: 4, towers: 3, total, overBudget: total > cfg.caps.budget } };
}
