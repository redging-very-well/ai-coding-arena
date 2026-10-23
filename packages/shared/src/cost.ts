// Cost formula (plan §6).
//
//   term_i = c_i * x_i * (1 + k * r_i^2)       r_i = x_i / max_i   (the "curve")
//   raw    = (Base + Σ term_i) * max(1, 60 / attackCooldown)
//   cost   = ceil(raw - 1e-9)
//
// x_i are maxHealth, damage, range, speed and (size - 6). max_i are the §5
// stat maxima (500, 60, 300, 5 and 20 - 6 = 14), so a stat at its max costs
// (1 + k) times its linear price (3× with the default k = 2) and a stat at half
// its max costs (1 + k/4) = 1.5×. The curve makes every term convex, so one
// unit with doubled stats costs more than two normal ones: spreading stats over
// several units is cheaper than stacking them into one.
//
// The cooldown factor scales the whole stat sum and is clamped at 1, so slow
// attackers (cooldown > 60) get no discount. An omitted size is priced at its
// type default (soldier 10, tower 14).
//
// Walls and factories (M8.5, §6 Walls and factories) have their own formulas
// with the same curve k and no cooldown factor (they can't attack):
//
//   wall:     raw = BaseW + cW·HP·(1 + k·(HP/1500)²)
//   factory:  cost = ceil(BaseF + cF·HP·(1 + k·(HP/1000)²)) + minionValue × E
//             E = min(maxMinionsPerFactory, floor((battleTicks − 1) / productionInterval))
//             minionValue = ceil(minionCost × minionDiscount), minionCost = the
//             unit formula above on the built-in minion's stats.
//
// The factory price depends on more than `cost` (the minion stats, the battle
// length), so `computeCost` takes an optional `PricingContext`; pass
// `pricingOf(config)` whenever a full config is at hand.

import { DEFAULT_CONFIG, type CostCoefficients, type FactoryConfig, type GameConfig, type StatBounds } from './config.js';
import { isNonCombatBuilding, sizeOf, type CostStats, type UnitType } from './contract.js';
import type { ValidationError, ValidationWarning } from './errors.js';

/** Size is free up to this radius; each px above it costs `cSize` (§6). */
export const MIN_PRICED_SIZE = 6;

/** Guards against float noise like 99.50000000000001 rounding up to 100 → 101. */
export const COST_EPSILON = 1e-9;

/** A stat ratio at or above this gives the W_STAT_NEAR_MAX warning. */
export const NEAR_MAX_RATIO = 0.8;

/** The priced stats, in breakdown order. */
export const PRICED_STATS = ['maxHealth', 'damage', 'range', 'speed', 'size'] as const;
export type PricedStat = (typeof PRICED_STATS)[number];

const B = DEFAULT_CONFIG.stats.bounds;
/**
 * Where each curve ratio reaches 1: the §5 stat maxima (size counts above 6).
 * Fixed to the default bounds so a live bounds retune doesn't silently change
 * the price curve.
 */
export const CURVE_MAX: Readonly<Record<PricedStat, number>> = {
  maxHealth: B.maxHealth.max,
  damage: B.damage.max,
  range: B.range.max,
  speed: B.soldierSpeed.max,
  size: B.size.max - MIN_PRICED_SIZE,
};

/** The stat terms before the cooldown factor (each one linear part + curve surcharge). */
export interface CostTerms {
  base: number;
  maxHealth: number;
  damage: number;
  range: number;
  speed: number;
  /** (size - MIN_PRICED_SIZE) * cSize, plus its curve surcharge. */
  size: number;
}
export type CostTermName = keyof CostTerms;

/** How one stat's term is made up (shown by validate/submit and on cards). */
export interface CostStatPart {
  /** The stat as the unit set it (size: the radius, not size - 6). */
  value: number;
  /** How far towards the max the stat is: 0-1 inside the bounds. */
  ratio: number;
  /** c_i * x_i: the price before the curve. */
  linear: number;
  /** linear * k * ratio²: the extra for being near the max. */
  curve: number;
  /** linear + curve (= the matching entry of `terms`). */
  total: number;
  /** total / linear = 1 + k * ratio² (1 when the stat is free). */
  multiplier: number;
  /** "maxHealth 500 costs $375: $125 base + $250 for being near the max (100% of max)". */
  text: string;
}

/** A factory's production part (§6): what it pays up front for its minions. */
export interface CostProduction {
  /** Ticks between two minions. */
  interval: number;
  /** The built-in minion priced as a soldier (rounded). */
  minionCost: number;
  /** ceil(minionCost × minionDiscount): what one expected minion costs the factory. */
  minionValue: number;
  /** E: minions the factory can make in one battle. */
  expected: number;
  /** minionValue × expected. */
  total: number;
  /** "Production: 5 minions × $28 (half of a $55 minion, because they arrive during the battle) = $140". */
  text: string;
}

/** Everything shown on a unit card / returned by validate & submit. */
export interface CostBreakdown {
  /** Which formula priced it: 'unit' (soldier, tower), 'wall' or 'factory' (§6). */
  formula: 'unit' | 'wall' | 'factory';
  terms: CostTerms;
  /** Per-stat detail: linear part and curve surcharge. */
  parts: Record<PricedStat, CostStatPart>;
  /** The curve strength k used. */
  curveK: number;
  /** Sum of all terms. */
  sum: number;
  /** max(1, referenceCooldown / attackCooldown). */
  factor: number;
  /** sum * factor, unrounded. */
  raw: number;
  /** Whole credits: ceil(raw - 1e-9) (factories: the rounded body plus production). */
  cost: number;
  /** Factories only: the body's rounded price (base + HP). */
  body?: number;
  /** Factories only: the production part. */
  production?: CostProduction;
}

export interface CostResult {
  raw: number;
  cost: number;
  breakdown: CostBreakdown;
}

/** Cooldown factor: >1 for fast attackers, clamped to 1 for slow ones. */
export function cooldownFactor(attackCooldown: number, coeffs: CostCoefficients): number {
  return Math.max(1, coeffs.referenceCooldown / attackCooldown);
}

/** Round a raw cost to whole credits (§6). */
export function roundCost(raw: number): number {
  return Math.ceil(raw - COST_EPSILON);
}

/** The amount of a stat that is priced (size counts above MIN_PRICED_SIZE). */
export function pricedAmount(stats: CostStats, stat: PricedStat): number {
  return stat === 'size' ? sizeOf(stats) - MIN_PRICED_SIZE : stats[stat];
}

/** Curve multiplier 1 + k·r² for a ratio r. */
export function curveMultiplier(ratio: number, k: number): number {
  return 1 + k * ratio * ratio;
}

const COEFF_OF: Record<PricedStat, 'hp' | 'damage' | 'range' | 'speed' | 'size'> = {
  maxHealth: 'hp',
  damage: 'damage',
  range: 'range',
  speed: 'speed',
  size: 'size',
};

function statPart(stats: CostStats, stat: PricedStat, coeffs: CostCoefficients): CostStatPart {
  const x = pricedAmount(stats, stat);
  const ratio = x / CURVE_MAX[stat];
  const linear = x * coeffs[COEFF_OF[stat]];
  const multiplier = curveMultiplier(ratio, coeffs.curveK);
  const total = linear * multiplier;
  const curve = total - linear;
  const value = stat === 'size' ? sizeOf(stats) : stats[stat];
  const pct = Math.round(ratio * 100);
  const text =
    linear === 0
      ? `${stat} ${fmt(value)} costs $0`
      : `${stat} ${fmt(value)} costs $${fmt(total)}: $${fmt(linear)} base + $${fmt(curve)} for being ` +
        (ratio >= NEAR_MAX_RATIO ? `near the max (${pct}% of max)` : `at ${pct}% of the max`);
  return { value, ratio, linear, curve, total, multiplier: linear === 0 ? 1 : multiplier, text };
}

/** What a factory's price depends on besides `cost` (§6 Re-pricing). */
export interface PricingContext {
  battleTicks: number;
  factory: Pick<FactoryConfig, 'maxMinionsPerFactory' | 'minion'>;
}

/** The pricing context of the default config. */
export const DEFAULT_PRICING: PricingContext = {
  battleTicks: DEFAULT_CONFIG.timers.battleTicks,
  factory: DEFAULT_CONFIG.factory,
};

/** The pricing context of a config. */
export function pricingOf(config: Pick<GameConfig, 'timers' | 'factory'>): PricingContext {
  return { battleTicks: config.timers.battleTicks, factory: config.factory };
}

/** HP curve maxima of the buildings (fixed to the default bounds, like CURVE_MAX). */
export const BUILDING_HP_CURVE_MAX: Readonly<Record<'wall' | 'factory', number>> = {
  wall: B.wallHealth.max,
  factory: B.factoryHealth.max,
};

/** Where a stat's curve reaches 1 for a unit type (walls and factories price HP on their own max). */
export function curveMaxFor(type: UnitType, stat: PricedStat): number {
  if (stat === 'maxHealth' && isNonCombatBuilding(type)) return BUILDING_HP_CURVE_MAX[type];
  return CURVE_MAX[stat];
}

/** E (§6): the minions a factory with this interval can make in one battle. */
export function expectedMinions(productionInterval: number, pricing: PricingContext = DEFAULT_PRICING): number {
  if (!(productionInterval > 0)) return 0;
  return Math.max(0, Math.min(pricing.factory.maxMinionsPerFactory, Math.floor((pricing.battleTicks - 1) / productionInterval)));
}

/** The built-in minion's stats as a soldier (for its price, §5.2). */
export function minionCostStats(pricing: PricingContext = DEFAULT_PRICING): CostStats {
  const m = pricing.factory.minion;
  return { type: 'soldier', maxHealth: m.maxHealth, damage: m.damage, range: m.range, speed: m.speed, attackCooldown: m.attackCooldown, size: m.size };
}

/** minionCost (the soldier price of a minion) and minionValue (what a factory pays per expected minion, §6). */
export function minionPrice(coeffs: CostCoefficients, pricing: PricingContext = DEFAULT_PRICING): { minionCost: number; minionValue: number } {
  const minionCost = computeCost(minionCostStats(pricing), coeffs, pricing).cost;
  return { minionCost, minionValue: roundCost(minionCost * coeffs.factory.minionDiscount) };
}

const ZERO_STATS: readonly PricedStat[] = ['damage', 'range', 'speed', 'size'];

function freePart(stat: PricedStat): CostStatPart {
  return { value: 0, ratio: 0, linear: 0, curve: 0, total: 0, multiplier: 1, text: `${stat} costs $0 (buildings that can't attack don't pay for it)` };
}

/** Price a wall or factory (§6 Walls and factories). */
function computeBuildingCost(stats: CostStats & { type: 'wall' | 'factory' }, coeffs: CostCoefficients, pricing: PricingContext): CostResult {
  const c = stats.type === 'wall' ? coeffs.wall : coeffs.factory;
  const hp = stats.maxHealth;
  const ratio = hp / BUILDING_HP_CURVE_MAX[stats.type];
  const linear = hp * c.hp;
  const multiplier = curveMultiplier(ratio, coeffs.curveK);
  const total = linear * multiplier;
  const curve = total - linear;
  const pct = Math.round(ratio * 100);
  const hpPart: CostStatPart = {
    value: hp,
    ratio,
    linear,
    curve,
    total,
    multiplier: linear === 0 ? 1 : multiplier,
    text:
      linear === 0
        ? `maxHealth ${fmt(hp)} costs $0`
        : `maxHealth ${fmt(hp)} costs $${fmt(total)}: $${fmt(linear)} base + $${fmt(curve)} for being ` +
          (ratio >= NEAR_MAX_RATIO ? `near the max (${pct}% of max)` : `at ${pct}% of the max`),
  };
  const parts = { maxHealth: hpPart } as Record<PricedStat, CostStatPart>;
  for (const st of ZERO_STATS) parts[st] = freePart(st);
  const terms: CostTerms = { base: c.base, maxHealth: total, damage: 0, range: 0, speed: 0, size: 0 };
  const sum = c.base + total;
  if (stats.type === 'wall') {
    const cost = roundCost(sum);
    return { raw: sum, cost, breakdown: { formula: 'wall', terms, parts, curveK: coeffs.curveK, sum, factor: 1, raw: sum, cost } };
  }
  const body = roundCost(sum);
  const interval = stats.productionInterval ?? 0;
  const expected = expectedMinions(interval, pricing);
  const { minionCost, minionValue } = minionPrice(coeffs, pricing);
  const prodTotal = minionValue * expected;
  const share = coeffs.factory.minionDiscount === 0.5 ? 'half' : `${fmt(coeffs.factory.minionDiscount * 100)}%`;
  const production: CostProduction = {
    interval,
    minionCost,
    minionValue,
    expected,
    total: prodTotal,
    text:
      `Production: ${expected} minion${expected === 1 ? '' : 's'} × $${minionValue} (${share} of a $${minionCost} minion, ` +
      `because they arrive during the battle) = $${prodTotal}`,
  };
  const raw = sum + prodTotal;
  const cost = body + prodTotal;
  return {
    raw,
    cost,
    breakdown: { formula: 'factory', terms, parts, curveK: coeffs.curveK, sum, factor: 1, raw, cost, body, production },
  };
}

/**
 * Price a unit (§6). Pure; callers check finiteness and the cap. Walls and
 * factories use their own formulas; `pricing` (default: the default config's)
 * sets the battle length and minion stats a factory's production is priced on.
 */
export function computeCost(stats: CostStats, coeffs: CostCoefficients, pricing: PricingContext = DEFAULT_PRICING): CostResult {
  if (isNonCombatBuilding(stats.type)) return computeBuildingCost(stats as CostStats & { type: 'wall' | 'factory' }, coeffs, pricing);
  const parts = {} as Record<PricedStat, CostStatPart>;
  for (const stat of PRICED_STATS) parts[stat] = statPart(stats, stat, coeffs);
  const terms: CostTerms = {
    base: coeffs.base,
    maxHealth: parts.maxHealth.total,
    damage: parts.damage.total,
    range: parts.range.total,
    speed: parts.speed.total,
    size: parts.size.total,
  };
  const sum = terms.base + terms.maxHealth + terms.damage + terms.range + terms.speed + terms.size;
  const factor = cooldownFactor(stats.attackCooldown, coeffs);
  const raw = sum * factor;
  const cost = roundCost(raw);
  return { raw, cost, breakdown: { formula: 'unit', terms, parts, curveK: coeffs.curveK, sum, factor, raw, cost } };
}

/** The largest stat term (excluding base), used to name the biggest lever. */
export function biggestStatTerm(terms: CostTerms): { name: PricedStat; value: number } {
  const entries = PRICED_STATS.map((name) => ({ name, value: terms[name] }));
  return entries.reduce((a, b) => (b.value > a.value ? b : a));
}

/** Human-friendly number: up to 2 decimals, no trailing zeros. */
export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Step used when suggesting a lower value for a stat. */
const SUGGEST_STEP: Record<PricedStat, number> = { maxHealth: 10, damage: 1, range: 10, speed: 0.5, size: 1 };

/** Lowest legal value of a stat. */
function statMin(stats: CostStats, stat: PricedStat, bounds: StatBounds): number {
  switch (stat) {
    case 'maxHealth':
      return stats.type === 'wall' ? bounds.wallHealth.min : stats.type === 'factory' ? bounds.factoryHealth.min : bounds.maxHealth.min;
    case 'damage':
      return bounds.damage.min;
    case 'range':
      return bounds.range.min;
    case 'speed':
      return stats.type === 'soldier' ? bounds.soldierSpeed.min : 0;
    case 'size':
      return bounds.size.min;
  }
}

function withStat(stats: CostStats, stat: PricedStat, value: number): CostStats {
  return { ...stats, [stat]: value };
}

/** Round down to a multiple of `step` (no float noise). */
function floorTo(v: number, step: number): number {
  return Math.round(Math.floor(v / step + COST_EPSILON) * step * 1000) / 1000;
}

export interface StatSuggestion {
  stat: PricedStat;
  from: number;
  to: number;
  /** Credits saved (rounded cost now - rounded cost with `to`). */
  saves: number;
  /** Cost with `to`. */
  newCost: number;
  /** Whether that change alone brings the unit to `cap` or below. */
  fits: boolean;
}

/**
 * A concrete lower value for `stat`: the highest value (on a round step) at
 * which the unit fits under `cap`, or, if lowering that stat alone can't do
 * it, about 60% of the current value.
 */
export function suggestLowerStat(
  stats: CostStats,
  stat: PricedStat,
  cap: number,
  coeffs: CostCoefficients,
  bounds: StatBounds = DEFAULT_CONFIG.stats.bounds,
  pricing: PricingContext = DEFAULT_PRICING,
): StatSuggestion | null {
  const from = stat === 'size' ? sizeOf(stats) : stats[stat];
  const step = SUGGEST_STEP[stat];
  const min = statMin(stats, stat, bounds);
  if (!(from > min)) return null;
  const now = computeCost(stats, coeffs, pricing).cost;
  const costAt = (v: number) => computeCost(withStat(stats, stat, v), coeffs, pricing).cost;
  let to: number | undefined;
  if (costAt(min) <= cap) {
    // Cost is non-decreasing in the stat: walk down from the current value.
    for (let v = floorTo(from - COST_EPSILON, step); v > min; v = floorTo(v - step, step)) {
      if (costAt(v) <= cap) {
        to = v;
        break;
      }
    }
    to ??= min;
  } else {
    to = Math.max(min, floorTo(from * 0.6, step));
    if (to >= from) to = min;
  }
  const newCost = costAt(to);
  return { stat, from, to, saves: now - newCost, newCost, fits: newCost <= cap };
}

/**
 * The "biggest lever" sentence for a stat: what it costs, split into linear
 * part and curve surcharge, and how much a concrete lower value saves.
 */
function leverSentence(
  stats: CostStats,
  result: CostResult,
  cap: number,
  coeffs: CostCoefficients,
  bounds: StatBounds,
  pricing: PricingContext,
): string {
  const { breakdown } = result;
  const order = [...PRICED_STATS].sort((a, b) => breakdown.terms[b] - breakdown.terms[a]);
  const big = order[0]!;
  const part = breakdown.parts[big];
  let s =
    // Walls and factories have no cooldown factor (§6), so "before the factor" would only confuse.
    `The most expensive stat is ${big}: ${fmt(part.value)} costs $${fmt(part.total)}${breakdown.formula === 'unit' ? ' before the factor' : ''} ` +
    `($${fmt(part.linear)} base + $${fmt(part.curve)} for being ${Math.round(part.ratio * 100)}% of the max).`;
  const sug = suggestLowerStat(stats, big, cap, coeffs, bounds, pricing);
  if (sug && sug.saves > 0) {
    s += ` Lowering ${big} from ${fmt(sug.from)} to ${fmt(sug.to)} saves $${sug.saves} ($${sug.newCost})`;
    if (sug.fits) s += '.';
    else {
      const next = order[1];
      s += next ? `; that alone isn't enough, so also lower ${next}.` : '; that alone isn\'t enough.';
    }
  }
  return s;
}

/**
 * The factory production lever (§6 Breakdown): the smallest slower
 * productionInterval (a multiple of 60 ticks) that fits under the cap, e.g.
 * "Raising productionInterval from 600 to 900 makes 5 minions instead of 8 and saves $84."
 */
function productionLever(
  stats: CostStats,
  result: CostResult,
  cap: number,
  coeffs: CostCoefficients,
  bounds: StatBounds,
  pricing: PricingContext,
): string {
  const from = stats.productionInterval ?? bounds.productionInterval.min;
  const max = bounds.productionInterval.max;
  const fromE = expectedMinions(from, pricing);
  let to = max;
  for (let v = Math.ceil((from + 1) / 60) * 60; v <= max; v += 60) {
    if (computeCost({ ...stats, productionInterval: v }, coeffs, pricing).cost <= cap) {
      to = v;
      break;
    }
  }
  if (to <= from) return `The production of ${fromE} minions is the biggest cost; lower maxHealth instead.`;
  const next = computeCost({ ...stats, productionInterval: to }, coeffs, pricing);
  const toE = expectedMinions(to, pricing);
  return (
    `The production (${fromE} minions × $${result.breakdown.production?.minionValue ?? 0}) is the biggest cost: ` +
    `raising productionInterval from ${fmt(from)} to ${to} makes ${toE} minion${toE === 1 ? '' : 's'} instead of ${fromE} and saves $${result.cost - next.cost} ($${next.cost}).`
  );
}

/**
 * Build the §7 UNIT_TOO_EXPENSIVE error, with a `fix` naming the biggest lever.
 *
 * If the cooldown factor is above 1, the fix suggests doubling attackCooldown
 * (capped at the reference cooldown) until the unit fits. It always names the
 * most expensive stat and says how much a concrete lower value saves, e.g.
 * "Lowering maxHealth from 500 to 350 saves $160 ($470)."
 */
export function tooExpensiveError(
  stats: CostStats,
  result: CostResult,
  cap: number,
  coeffs: CostCoefficients,
  bounds: StatBounds = DEFAULT_CONFIG.stats.bounds,
  pricing: PricingContext = DEFAULT_PRICING,
): ValidationError {
  const { breakdown } = result;
  const statSentence = leverSentence(stats, result, cap, coeffs, bounds, pricing);
  let fix: string;

  const prod = breakdown.production;
  if (prod && prod.total >= breakdown.terms.maxHealth) {
    // Factory whose production is the bigger lever: a slower interval buys fewer minions.
    fix = `Cost is $${result.cost} but the max is $${cap}. ${productionLever(stats, result, cap, coeffs, bounds, pricing)} ${statSentence}`;
  } else if (breakdown.factor > 1) {
    // Try doubling the cooldown until it fits or the factor reaches 1.
    let cd = stats.attackCooldown;
    let next: CostResult | undefined;
    while (cd < coeffs.referenceCooldown) {
      cd = Math.min(coeffs.referenceCooldown, Math.ceil(cd * 2));
      next = computeCost({ ...stats, attackCooldown: cd }, coeffs, pricing);
      if (next.cost <= cap) break;
    }
    if (next && next.cost <= cap) {
      fix =
        `Cost is $${result.cost} but the max is $${cap}. The ×${fmt(breakdown.factor)} cooldown factor is the biggest cost: ` +
        `raising attackCooldown from ${stats.attackCooldown} to ${cd} makes it ×${fmt(next.breakdown.factor)} ($${next.cost}). ` +
        statSentence;
    } else {
      fix =
        `Cost is $${result.cost} but the max is $${cap}. Raise attackCooldown towards ${coeffs.referenceCooldown} ` +
        `(currently ×${fmt(breakdown.factor)}) and lower the stats. ` +
        statSentence;
    }
  } else {
    // Factor is 1: only the stats can come down.
    fix = `Cost is $${result.cost} but the max is $${cap}. ${statSentence}`;
    // Only true when the curve is on (curveK = 0 is the old linear price).
    if (coeffs.curveK > 0) fix += ` Maxed stats cost up to ${fmt(1 + coeffs.curveK)}× their normal price, so spread them over two units instead.`;
  }

  return {
    code: 'UNIT_TOO_EXPENSIVE',
    field: 'cost',
    value: result.cost,
    allowed: { max: cap },
    message: `This unit costs $${result.cost} but the most a unit may cost is $${cap}.`,
    fix,
    breakdown,
  };
}

/**
 * W_STAT_NEAR_MAX (non-fatal): one warning per stat at ≥ 80% of its max,
 * e.g. "maxHealth is at 96% of max and costs 2.84× its normal price; two
 * medium units usually beat one maxed one." None when curveK = 0: with no
 * curve a maxed stat costs its normal price, so the advice would be false.
 */
export function nearMaxWarnings(
  stats: CostStats,
  result: CostResult,
  coeffs: CostCoefficients,
  bounds: StatBounds = DEFAULT_CONFIG.stats.bounds,
  pricing: PricingContext = DEFAULT_PRICING,
): ValidationWarning[] {
  const out: ValidationWarning[] = [];
  for (const stat of PRICED_STATS) {
    const part = result.breakdown.parts[stat];
    if (part.ratio < NEAR_MAX_RATIO || part.linear === 0 || part.multiplier <= 1) continue;
    const curveMax = curveMaxFor(stats.type, stat);
    // Suggest 60% of the max (1 + k·0.36 ≈ 1.7× with k = 2).
    const target = Math.max(statMin(stats, stat, bounds), floorTo(0.6 * curveMax + (stat === 'size' ? MIN_PRICED_SIZE : 0), SUGGEST_STEP[stat]));
    const lower = target < part.value ? computeCost(withStat(stats, stat, target), coeffs, pricing) : undefined;
    const saving = lower ? result.cost - lower.cost : 0;
    out.push({
      code: 'W_STAT_NEAR_MAX',
      field: stat,
      value: part.value,
      allowed: { max: stat === 'size' ? CURVE_MAX.size + MIN_PRICED_SIZE : curveMax, ratio: Math.round(part.ratio * 100) / 100 },
      message:
        `${stat} is at ${Math.round(part.ratio * 100)}% of max and costs ${fmt(part.multiplier)}× its normal price; ` +
        'two medium units usually beat one maxed one.',
      fix: lower
        ? `If you don't need it this high, set this.${stat} to ${fmt(target)}: that saves $${saving} (cost $${lower.cost}) to spend on another unit.`
        : `Consider a lower ${stat} and spend the savings on a second unit.`,
    });
  }
  return out;
}
