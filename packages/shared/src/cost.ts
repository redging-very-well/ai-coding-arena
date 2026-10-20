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

import { DEFAULT_CONFIG, type CostCoefficients, type StatBounds } from './config.js';
import { sizeOf, type CostStats } from './contract.js';
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

/** Everything shown on a unit card / returned by validate & submit. */
export interface CostBreakdown {
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
  /** Whole credits: ceil(raw - 1e-9). */
  cost: number;
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

/** Price a unit. Pure; callers check finiteness and the cap. */
export function computeCost(stats: CostStats, coeffs: CostCoefficients): CostResult {
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
  return { raw, cost, breakdown: { terms, parts, curveK: coeffs.curveK, sum, factor, raw, cost } };
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
      return bounds.maxHealth.min;
    case 'damage':
      return bounds.damage.min;
    case 'range':
      return bounds.range.min;
    case 'speed':
      return stats.type === 'tower' ? 0 : bounds.soldierSpeed.min;
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
): StatSuggestion | null {
  const from = stat === 'size' ? sizeOf(stats) : stats[stat];
  const step = SUGGEST_STEP[stat];
  const min = statMin(stats, stat, bounds);
  if (!(from > min)) return null;
  const now = computeCost(stats, coeffs).cost;
  const costAt = (v: number) => computeCost(withStat(stats, stat, v), coeffs).cost;
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
): string {
  const { breakdown } = result;
  const order = [...PRICED_STATS].sort((a, b) => breakdown.terms[b] - breakdown.terms[a]);
  const big = order[0]!;
  const part = breakdown.parts[big];
  let s =
    `The most expensive stat is ${big}: ${fmt(part.value)} costs $${fmt(part.total)} before the factor ` +
    `($${fmt(part.linear)} base + $${fmt(part.curve)} for being ${Math.round(part.ratio * 100)}% of the max).`;
  const sug = suggestLowerStat(stats, big, cap, coeffs, bounds);
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
): ValidationError {
  const { breakdown } = result;
  const statSentence = leverSentence(stats, result, cap, coeffs, bounds);
  let fix: string;

  if (breakdown.factor > 1) {
    // Try doubling the cooldown until it fits or the factor reaches 1.
    let cd = stats.attackCooldown;
    let next: CostResult | undefined;
    while (cd < coeffs.referenceCooldown) {
      cd = Math.min(coeffs.referenceCooldown, Math.ceil(cd * 2));
      next = computeCost({ ...stats, attackCooldown: cd }, coeffs);
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
): ValidationWarning[] {
  const out: ValidationWarning[] = [];
  for (const stat of PRICED_STATS) {
    const part = result.breakdown.parts[stat];
    if (part.ratio < NEAR_MAX_RATIO || part.linear === 0 || part.multiplier <= 1) continue;
    // Suggest 60% of the max (1 + k·0.36 ≈ 1.7× with k = 2).
    const target = Math.max(statMin(stats, stat, bounds), floorTo(0.6 * CURVE_MAX[stat] + (stat === 'size' ? MIN_PRICED_SIZE : 0), SUGGEST_STEP[stat]));
    const lower = target < part.value ? computeCost(withStat(stats, stat, target), coeffs) : undefined;
    const saving = lower ? result.cost - lower.cost : 0;
    out.push({
      code: 'W_STAT_NEAR_MAX',
      field: stat,
      value: part.value,
      allowed: { max: stat === 'size' ? CURVE_MAX.size + MIN_PRICED_SIZE : CURVE_MAX[stat], ratio: Math.round(part.ratio * 100) / 100 },
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
