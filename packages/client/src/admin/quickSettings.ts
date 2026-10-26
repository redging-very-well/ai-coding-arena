// Quick settings: the high-level config knobs as a
// labelled form above the full JSON editor. DOM-free and tested
// (tests/admin-quick-settings.test.ts).
//
// Each field is one row of QUICK_GROUPS: a config path (dots; numeric segments
// index arrays), a label, help text, the unit shown, optional display
// conversions (seconds ↔ minutes, ticks ↔ seconds) and display-unit bounds.
// The zod ConfigSchema is checked too (validateDraft), so its bounds and
// cross-field rules (e.g. sudden death start < end) show inline as well.

import { configDiff } from './configDiff.js';
import { ConfigSchema, checkStats, computeCost, copiesCost, isNonCombatBuilding, pricingOf, type CostStats, type GameConfig } from '@pixel-clash/shared';

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
  /** One line under the section title in /admin (what the section is for). */
  blurb: string;
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
    id: 'economy',
    title: 'Budget & limits',
    blurb: 'Seats, the budget each round and how much one player can field.',
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
    title: 'Rounds & timers',
    blurb: 'How long each phase lasts.',
    fields: [
      { path: 'timers.defaultRounds', label: 'Rounds per match', help: 'Default for the Start match box (1-10).', min: 1, max: 10, step: 1, integer: true },
      { ...minutes, path: 'timers.planFirstRoundSec', label: 'Plan time, round 1', help: 'Time to design units with the AI helper in the first round.', min: 0.5 },
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
    title: 'Unit prices',
    blurb: 'What each stat costs, with a live price check.',
    fields: [
      { ...money, path: 'cost.base', label: 'Base cost per unit', help: 'Every unit pays this before its stats.', step: 1 },
      { ...money, path: 'cost.hp', label: '$ per HP', help: 'Price of each point of maxHealth (before the curve).' },
      { ...money, path: 'cost.damage', label: '$ per damage', help: 'Price of each point of damage per hit.' },
      { ...money, path: 'cost.range', label: '$ per px range', help: 'Price of each pixel of attack range.' },
      { ...money, path: 'cost.speed', label: '$ per speed', help: 'Price of each px/tick of movement speed (towers have 0).', step: 0.5 },
      { ...money, path: 'cost.size', label: '$ per px size (above 6)', help: 'Price of each pixel of body radius above 6.' },
      { path: 'cost.curveK', label: 'Max-stat steepness k (maxed stat costs 1+k ×)', help: '0 = straight-line prices. With k = 1 (the default) a maxed stat costs 2× and a half-max stat 1.25×; k = 2 makes them 3× and 1.5×.', min: 0, max: 5, step: 0.25 },
      // M8.8: the whole-unit factors and the support prices.
      {
        path: 'cost.powerFactor',
        label: 'Tough-and-strong surcharge q',
        help: 'Units that are tough AND hard-hitting pay × (1 + q × HP/2500 × damage/300): q = 0.6 makes a maxed brick ×1.6 and barely touches specialists. 0 turns it off.',
        unit: '×',
        min: 0,
        max: 2,
        step: 0.05,
      },
      { path: 'cost.splash', label: 'Splash surcharge s', help: 'Splash multiplies the whole price by 1 + s × ρ(2 − ρ), ρ = radius / 80: with s = 0.7 splash 40 is ×1.53 and splash 80 ×1.7.', unit: '×', min: 0, max: 2, step: 0.05 },
      ...(['fire', 'ice', 'lightning'] as const).map((e) => ({
        path: `cost.element.${e}`,
        label: `${e[0]!.toUpperCase()}${e.slice(1)} price factor`,
        help: `A ${e} unit (or a factory's ${e} minions) costs × this. 1 = free; the default 1.2 matches what the element is worth on average.`,
        unit: '×',
        min: 1,
        max: 3,
        step: 0.05,
      })),
      { ...money, path: 'cost.heal', label: 'Heal $ per HP per heal', help: 'Price of each HP a heal-support unit restores per heal (before the curve, the reach factor and the cooldown factor).', step: 0.1 },
      ...(['haste', 'might', 'shield'] as const).map((k) => ({
        ...money,
        path: `cost.aura.${k}`,
        label: `${k[0]!.toUpperCase()}${k.slice(1)} aura $ per %`,
        help: `Price of each % of a ${k} aura (before the curve and the radius factor). Auras are always on, so they are added after the cooldown and other factors.`,
        step: 0.5,
      })),
    ],
  },
  {
    // M8.5: wall and factory prices, their stat ranges, the minion and the factory caps.
    id: 'buildings',
    title: 'Walls & factories',
    blurb: 'Wall and factory prices, health ranges and what happens to factories.',
    fields: [
      { ...money, path: 'cost.wall.base', label: 'Wall base cost', help: 'Every wall pays this before its health.', step: 1 },
      { ...money, path: 'cost.wall.hp', label: 'Wall $ per HP', help: 'Price of each point of wall health (before the curve). Walls are cheap per HP: they can’t move or fight and count $0 at the end.', step: 0.01 },
      { ...money, path: 'cost.factory.base', label: 'Factory base cost', help: 'Every factory pays this before its health and minions.', step: 1 },
      { ...money, path: 'cost.factory.hp', label: 'Factory $ per HP', help: 'Price of each point of factory health (before the curve).', step: 0.01 },
      {
        path: 'cost.factory.minionDiscount',
        label: 'Minion price share',
        help: 'A factory pays this share of a minion’s soldier price for each minion it can make (before sudden death when factories stop there).',
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
      { path: 'factory.crumbleRadius', label: 'Crumble distance', help: "With 'Minions die with their factory' on: only the minions within this distance of the factory (centre to centre) crumble with it; the ones further away keep fighting. 0 = all of them, wherever they are.", unit: 'px', min: 0, step: 10 },
    ],
    toggles: [
      {
        path: 'factory.dieAtSuddenDeath',
        label: 'Factories die at sudden death',
        help: 'Every factory still standing is destroyed when the safe circle starts shrinking (nobody gets the credit; stored minions are lost; minions already out keep fighting unless "Minions die with their factory" is on). Off: factories live on into sudden death.',
      },
      {
        path: 'factory.stopAtSuddenDeath',
        label: 'Factories stop at sudden death',
        help: 'No new minions once the safe circle starts shrinking (minions already out keep fighting); factory prices count only the minions made before it. Off: factories build until the end of the battle.',
      },
      {
        path: 'factory.minionsDieWithFactory',
        label: 'Minions die with their factory',
        help: 'When a factory is destroyed, its minions within the crumble distance of it crumble at once (the unit that destroyed it gets the kills and their value); minions further away keep fighting. Prices are unchanged. Off: they all keep fighting.',
      },
    ],
  },
  {
    id: 'minions',
    title: 'Minions',
    blurb: 'How many minions factories make and how strong each kind is.',
    fields: [
      { path: 'factory.maxMinionsPerFactory', label: 'Minions per factory per battle', help: 'The most minions one factory makes in a battle (its price counts them).', min: 1, step: 1, integer: true },
      { path: 'factory.maxAlivePerFactory', label: 'Minions alive per factory', help: 'A factory waits while this many of its minions are alive.', min: 1, step: 1, integer: true },
      { path: 'factory.maxAlivePerPlayer', label: 'Minions alive per player', help: 'All of a player’s factories together (also limited to 40 ÷ players).', min: 1, step: 1, integer: true },
      { path: 'factory.maxAlivePerBattle', label: 'Minions alive per battle', help: 'The most minions in the whole arena at once (keeps big battles smooth).', min: 1, step: 1, integer: true },
      // M8.6: the four minion kinds (each must stay within the soldier bounds; prices follow).
      ...(['grunt', 'archer', 'runner', 'brute'] as const).flatMap((k) => {
        const name = k[0]!.toUpperCase() + k.slice(1);
        return [
          { path: `factory.minions.${k}.maxHealth`, label: `${name} health`, help: `HP of a factory's ${k}s (must stay within the soldier bounds).`, min: 1, step: 5 },
          { path: `factory.minions.${k}.damage`, label: `${name} damage`, help: `Damage per ${k} hit${k === 'archer' ? ' (a shot)' : ' (melee)'}.`, min: 0, step: 1 },
          { path: `factory.minions.${k}.speed`, label: `${name} speed`, help: 'Pixels per tick (60 ticks = 1 s).', unit: 'px/tick', min: 0.1, step: 0.1 },
        ];
      }),
      { path: 'factory.minions.brute.wallDamageMultiplier', label: 'Brute wall damage', help: 'Brute hits on walls deal damage × this (1-5).', unit: '×', min: 1, max: 5, step: 0.5 },
      // M8.8: the medic minion (never attacks; its heal and reach must stay within the heal support bounds).
      { path: 'factory.minions.medic.maxHealth', label: 'Medic health', help: "HP of a factory's medics (must stay within the soldier bounds).", min: 1, step: 5 },
      { path: 'factory.minions.medic.speed', label: 'Medic speed', help: 'Pixels per tick (60 ticks = 1 s).', unit: 'px/tick', min: 0.1, step: 0.1 },
      { path: 'factory.minions.medic.heal', label: 'Medic heal', help: 'HP one medic heal restores (within the heal support bounds; the 5%-per-second heal room still caps it).', unit: 'HP', min: 1, step: 5 },
      { path: 'factory.minions.medic.reach', label: 'Medic reach', help: 'How far a medic heals, edge to edge (within the heal support bounds).', unit: 'px', min: 1, step: 5 },
    ],
  },
  {
    // M8.8: how strong the elements, combos, splash and heals are (prices are under Costs).
    id: 'effects',
    title: 'Elements & support',
    blurb: 'How strong elements, combos, splash, misses and heals are (their prices are under Unit prices).',
    fields: [
      { path: 'elements.fire.burnPct', label: 'Fire burn', help: 'A fire hit adds this % of its damage again as a burn over the next few seconds.', unit: '%', min: 0, max: 200, step: 5 },
      { path: 'elements.ice.slowPct', label: 'Ice slow', help: 'A frozen body moves, reloads and builds this % slower.', unit: '%', min: 0, max: 99, step: 5 },
      { ...tickSeconds, path: 'elements.ice.ticks', label: 'Freeze lasts', help: 'How long an ice hit freezes (refreshes, never stacks).', min: 0.1, step: 0.5 },
      { path: 'elements.lightning.chancePct', label: 'Lightning zap chance', help: 'Share of lightning hits that also zap the nearest other enemy for the same damage.', unit: '%', min: 0, max: 100, step: 5 },
      { path: 'elements.lightning.hopRange', label: 'Zap reach', help: 'How far a zap jumps, edge to edge.', unit: 'px', min: 0, step: 10 },
      { path: 'elements.shatterPct', label: 'Shatter bonus', help: 'A fire hit on a frozen body does this % extra and thaws it.', unit: '%', min: 0, max: 200, step: 5 },
      { path: 'elements.kindlePct', label: 'Kindle bonus', help: 'A burning body takes this % extra from every hit that isn’t fire (mix fire with other units).', unit: '%', min: 0, max: 200, step: 5 },
      { path: 'elements.brittlePct', label: 'Brittle bonus', help: 'A frozen body takes this % extra from every hit that isn’t ice or fire (fire shatters instead).', unit: '%', min: 0, max: 200, step: 5 },
      { path: 'elements.lightning.burningExtraHops', label: 'Overload hops', help: 'Extra hops a lightning zap makes when its target is burning.', min: 0, max: 5, step: 1, integer: true },
      { path: 'elements.splashPct', label: 'Splash damage', help: 'Enemies near the target of a splash unit take this % of the hit.', unit: '%', min: 0, max: 100, step: 5 },
      { path: 'accuracy.missMaxPct', label: 'Ranged miss chance (max)', help: 'A ranged shot at a body moving at full speed misses this often (less for slower bodies; never for standing ones or melee).', unit: '%', min: 0, max: 100, step: 5 },
      { path: 'accuracy.speedRef', label: 'Full-speed for misses', help: 'A body moving this many px per tick (or faster) is missed the most.', unit: 'px/tick', min: 0.1, step: 0.5 },
      { path: 'support.healRoomPctPerSecond', label: 'Heal limit (% max HP / s)', help: 'All healers together can restore at most this share of a body’s max HP per second. Heals stop when sudden death starts.', unit: '%/s', min: 0, max: 100, step: 0.5 },
    ],
  },
  {
    id: 'battle',
    title: 'Battle & scoring',
    blurb: 'Sudden death, bonus points and how units move.',
    fields: [
      { ...tickSeconds, path: 'suddenDeath.startTick', label: 'Sudden death starts at', help: 'Seconds into the battle when the safe circle starts shrinking. Must be before the circle finishes shrinking (normally the end of the battle).', min: 0 },
      { path: 'suddenDeath.damagePctPerSecond', label: 'Damage outside the circle (% max HP / s)', help: 'Units outside the safe circle lose this share of their max HP every second.', unit: '%/s', min: 0, max: 100, step: 0.5 },
      // Place points are a formula (1st gets players − 1 … last 0), not config.
      { path: 'scoring.damageBonusMax', label: 'Max damage bonus (at 4 players)', help: 'Extra points for the top damage dealer; others get a share. Scaled × players/4.', unit: 'pts', min: 0, step: 1, integer: true },
      { path: 'scoring.valueBonusMax', label: 'Max value-destroyed bonus (at 4 players)', help: 'Extra points for destroying the most enemy value; others get a share. Scaled × players/4.', unit: 'pts', min: 0, step: 1, integer: true },
    ],
    toggles: [
      {
        path: 'sim.routeRoundBuildings',
        label: 'Units walk round towers and factories',
        help: 'Routing treats towers and factories as solid (units squeeze through a gap only when they fit). Off: only walls are routed round, buildings are just pushed past.',
      },
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

/** The stat fields a design of this type sets (walls and factories leave the attack stats out). */
function ownStats(stats: CostStats): Record<string, unknown> {
  if (!isNonCombatBuilding(stats.type)) {
    // M8.8: a support is three contract fields in a design.
    const { support, ...rest } = stats;
    return support ? { ...rest, support: support.kind, supportPower: support.power, supportRange: support.range } : rest;
  }
  const out: Record<string, unknown> = { type: stats.type, maxHealth: stats.maxHealth };
  if (stats.type === 'factory') out.productionInterval = stats.productionInterval;
  if (stats.type === 'factory' && stats.produces) out.produces = stats.produces;
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
  key:
    | 'basicSoldier'
    | 'basicTower'
    | 'bigTank'
    | 'allMax'
    | 'basicWall'
    | 'basicFactory'
    | 'swarmFactory'
    | 'archerFactory'
    | 'runnerFactory'
    | 'bruteFactory'
    | 'fireSoldier'
    | 'mortarTower'
    | 'fieldMedic'
    | 'warDrummer'
    | 'medicFactory';
  label: string;
  stats: CostStats;
  /** A starter template: if it goes over the cap the server refuses the save. */
  template: boolean;
}

// The $10,000 redesign: the starter templates and the reference Huge Tank.
export const BASIC_SOLDIER: CostStats = { type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
export const BASIC_TOWER: CostStats = { type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45, size: 14 };
export const BIG_TANK: CostStats = { type: 'soldier', maxHealth: 3600, damage: 80, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
/** The wall and factory templates and the reference Swarm Factory. */
export const BASIC_WALL: CostStats = { type: 'wall', maxHealth: 3200, damage: 0, range: 0, speed: 0, attackCooldown: 60 };
export const BASIC_FACTORY: CostStats = { type: 'factory', maxHealth: 360, damage: 0, range: 0, speed: 0, attackCooldown: 60, productionInterval: 600 };
export const SWARM_FACTORY: CostStats = { ...BASIC_FACTORY, productionInterval: 300 };
/** The Mortar Tower and the damage-0 support body (Field Medic, War Drummer). */
export const MORTAR_TOWER: CostStats = { type: 'tower', maxHealth: 1000, damage: 80, range: 140, speed: 0, attackCooldown: 60, size: 14, splashRadius: 40 };
export const SUPPORT_BODY: CostStats = { type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10 };

/** The preview units; the all-max one uses the draft's stat bounds. */
export function previewUnits(cfg: GameConfig): PreviewUnit[] {
  const b = cfg.stats.bounds;
  const allMax: CostStats = {
    type: 'soldier',
    maxHealth: b.maxHealth.max,
    damage: b.damage.max,
    range: b.soldierRange.max,
    speed: b.soldierSpeed.max,
    attackCooldown: b.attackCooldown.min,
    size: b.size.max,
  };
  return [
    { key: 'basicSoldier', label: 'Basic Soldier', stats: BASIC_SOLDIER, template: true },
    { key: 'basicTower', label: 'Basic Tower', stats: BASIC_TOWER, template: true },
    { key: 'bigTank', label: 'Huge Tank (3,600 HP soldier)', stats: BIG_TANK, template: false },
    { key: 'allMax', label: 'Everything maxed', stats: allMax, template: false },
    { key: 'basicWall', label: 'Basic Wall (3,200 HP)', stats: BASIC_WALL, template: true },
    { key: 'basicFactory', label: 'Basic Factory (11 minions)', stats: BASIC_FACTORY, template: true },
    { key: 'swarmFactory', label: 'Swarm Factory (12 minions)', stats: SWARM_FACTORY, template: false },
    // M8.6: the Basic Factory building each other kind.
    { key: 'archerFactory', label: 'Archer Factory (11 archers)', stats: { ...BASIC_FACTORY, produces: 'archer' }, template: false },
    { key: 'runnerFactory', label: 'Runner Factory (11 runners)', stats: { ...BASIC_FACTORY, produces: 'runner' }, template: false },
    { key: 'bruteFactory', label: 'Brute Factory (11 brutes)', stats: { ...BASIC_FACTORY, produces: 'brute' }, template: false },
    // M8.8: an element, splash and the support kinds.
    { key: 'fireSoldier', label: 'Fire Soldier', stats: { ...BASIC_SOLDIER, element: 'fire' }, template: false },
    { key: 'mortarTower', label: 'Mortar Tower (splash 40)', stats: MORTAR_TOWER, template: false },
    { key: 'fieldMedic', label: 'Field Medic (heal 96)', stats: { ...SUPPORT_BODY, support: { kind: 'heal', power: 96, range: 120 } }, template: false },
    { key: 'warDrummer', label: 'War Drummer (might 30%)', stats: { ...SUPPORT_BODY, support: { kind: 'might', power: 30, range: 100 } }, template: false },
    { key: 'medicFactory', label: 'Medic Tent (11 medics)', stats: { ...BASIC_FACTORY, produces: 'medic' }, template: false },
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
  /** 5 Basic Soldiers + 3 Basic Towers, with the copy ramp. */
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
  const ramp = cfg.caps.copyRamp;
  const total = copiesCost(soldier, 5, 'soldier', ramp) + copiesCost(tower, 3, 'tower', ramp);
  return { rows, cap, budget: cfg.caps.budget, army: { soldiers: 5, towers: 3, total, overBudget: total > cfg.caps.budget } };
}

// --- immediate save (each field saves on its own) -------------------------------------

/** A budget per player above this (the event's tuned $10,000 economy + 50%) shifts the game balance. */
export const BALANCE_BUDGET_LIMIT = 15_000;

/** The facilitator-only note next to a budget field ('' when the budget is fine). */
export function budgetBalanceWarning(budget: number | null | undefined): string {
  return typeof budget === 'number' && Number.isFinite(budget) && budget > BALANCE_BUDGET_LIMIT ? 'Above $15,000 changes game balance' : '';
}

/** Every config path a section edits (its number fields and toggles). */
export function groupPaths(g: Pick<QuickGroup, 'fields' | 'toggles'>): string[] {
  return [...g.fields.map((f) => f.path), ...(g.toggles ?? []).map((t) => t.path)];
}

/** How many of the section's settings differ from the defaults. */
export function changedFromDefaults(g: Pick<QuickGroup, 'fields' | 'toggles'>, cfg: unknown, defaults: unknown): number {
  return groupPaths(g).filter((path) => fieldChanged({ path }, defaults, cfg)).length;
}

/**
 * The PUT /admin/config patch that puts a section back to the defaults, or
 * undefined when it already is. Resetting the battle length also resets the
 * sudden-death end when it followed the battle length.
 */
export function sectionResetPatch(g: Pick<QuickGroup, 'fields' | 'toggles'>, cfg: GameConfig, defaults: GameConfig): unknown {
  let next = cfg;
  for (const path of groupPaths(g)) {
    const d = getPath(defaults, path);
    if (d !== undefined) next = typeof d === 'number' ? applyField(next, path, d) : setPath(next, path, d);
  }
  return configDiff(cfg, next);
}

export type FieldCheck = { ok: true; stored: number; patch: unknown; draft: GameConfig } | { ok: false; error: string };

/**
 * What typing `raw` into a quick field would save: the stored value and the
 * minimal patch (undefined when nothing changes), or the reason it can't be
 * saved (the field's own rules, then the schema's rules for that field, e.g.
 * "sudden death must start before the circle finishes shrinking").
 */
export function checkField(field: QuickField, raw: string, cfg: GameConfig): FieldCheck {
  const r = parseFieldInput(field, raw, cfg);
  if (!r.ok) return r;
  const draft = applyField(cfg, field.path, r.stored);
  const problems = validateDraft(draft).byField[field.path];
  if (problems?.length) return { ok: false, error: problems[0]! };
  return { ok: true, stored: r.stored, patch: configDiff(cfg, draft), draft };
}

/** The message for one field from a refused save (its own issue, else the refusal's text). */
export function fieldRefusal(
  err: { code?: string; message: string; hint?: string; details?: Record<string, unknown> },
  path: string,
  base: unknown,
  draft: unknown,
): string {
  const r = refusalIssues(err, base, draft);
  return r.byField[path]?.[0] ?? r.other[0] ?? (err.hint && err.hint !== err.message ? `${err.message} ${err.hint}` : err.message);
}
