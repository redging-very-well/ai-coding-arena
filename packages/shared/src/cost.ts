// Cost formula (plan §6, M8.8 economy).
//
//   term_i  = c_i * x_i * (1 + k * r_i^2)       r_i = x_i / max_i   (the "curve", k = curveK = 1)
//   heal    = cHeal * P * (1 + k * (P/250)^2) * reach(R/200)          support 'heal'
//   aura    = cKind * P * (1 + k * (P/Pmax)^2) * reach(R/150)         haste/might (Pmax 50), shield (40)
//   reach(ρ)= 0.5 + ρ(2 − ρ)
//   core    = Base + Σ term_i + heal
//   raw     = core * max(1, 60 / attackCooldown)                     cooldown factor (clamped at 1)
//                  * (1 + q * HP/2500 * damage/300)                  power factor (q = powerFactor)
//                  * (1 + s * ρs(2 − ρs))                            splash factor, ρs = splashRadius / 80
//                  * e                                               element factor (normal 1, others 1.2)
//           + aura                                                   always on: after the factors
//   cost    = ceil(raw - 1e-9)
//
// x_i are maxHealth, damage, range, speed and (size - 6). max_i are the §5
// stat maxima at the default (×5) bounds (2500, 300, 300, 5 and 20 - 6 = 14),
// so a stat at its max costs (1 + k) times its linear price (2× with the
// default k = 1) and a stat at half its max costs (1 + k/4) = 1.25×. The curve
// makes every term convex, so one unit with doubled stats costs more than two
// normal ones (once a stat reaches about 65% of its max, §6 concentration
// property); the power factor makes that dearer still for units that are both
// tough and strong.
//
// The cooldown factor scales the whole core and is clamped at 1, so slow
// attackers (cooldown > 60) get no discount. The heal term sits inside it (a
// faster healer heals more); the aura is added after every factor (it is
// always on). An omitted size is priced at its type default (soldier 10, tower 14).
//
// Walls and factories (§6 Walls and factories) have their own formulas with
// the same curve k and no factors (they can't attack):
//
//   wall:     raw = BaseW + cW·HP·(1 + k·(HP/7500)²)
//   factory:  cost = ceil(BaseF + cF·HP·(1 + k·(HP/5000)²)) + minionValue × E
//             E = min(maxMinionsPerFactory, floor((battleTicks − 1) / productionInterval))
//             minionValue = ceil(minionCost × minionDiscount), minionCost = the
//             unit formula above on the minion kind's stats × its element factor.
//
// M8.6 (§6 Minion kinds): minionValue follows the factory's `produces` kind
// (grunt, archer, runner, brute; M8.8 medic; default grunt), each priced as a
// soldier on its `factory.minions.<kind>` stats. M8.8: the factory's
// `minionElement` multiplies the minion price (medics ignore it, and their
// heal is in their soldier formula). `burst` never changes the price.
//
// The factory price depends on more than `cost` (the minion stats, the battle
// length), so `computeCost` takes an optional `PricingContext`; pass
// `pricingOf(config)` whenever a full config is at hand.

import { DEFAULT_CONFIG, type CostCoefficients, type FactoryConfig, type GameConfig, type StatBounds } from './config.js';
import {
  MINION_KIND_NAMES,
  elementOf,
  isAuraKind,
  isNonCombatBuilding,
  minionElementOf,
  producesOf,
  sizeOf,
  splashOf,
  supportOf,
  type CostStats,
  type Element,
  type MinionKind,
  type SupportKind,
  type SupportSpec,
  type UnitType,
} from './contract.js';
import type { ValidationError, ValidationWarning } from './errors.js';

/** Size is free up to this radius; each px above it costs `cSize` (§6). */
export const MIN_PRICED_SIZE = 6;

/** Guards against float noise like 99.50000000000001 rounding up to 100 → 101. */
export const COST_EPSILON = 1e-9;

/** A stat ratio at or above this gives the W_STAT_NEAR_MAX warning. */
export const NEAR_MAX_RATIO = 0.8;

/** A power factor at or above this gives the W_POWER_HIGH warning (§7 M8.8). */
export const POWER_HIGH = 1.25;

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

/** M8.8: where the splash factor saturates (the default splashRadius max, 80 px). */
export const SPLASH_CURVE_MAX = B.splashRadius.max;

/** M8.8: the support curve maxima (power: the curve; range: the reach factor), fixed to the default bounds. */
export const SUPPORT_CURVE_MAX: Readonly<Record<SupportKind, { power: number; range: number }>> = {
  heal: { power: B.support.heal.power.max, range: B.support.heal.range.max },
  haste: { power: B.support.haste.power.max, range: B.support.haste.range.max },
  might: { power: B.support.might.power.max, range: B.support.might.range.max },
  shield: { power: B.support.shield.power.max, range: B.support.shield.range.max },
};

/** The stat terms before the factors (each one linear part + curve surcharge). */
export interface CostTerms {
  base: number;
  maxHealth: number;
  damage: number;
  range: number;
  speed: number;
  /** (size - MIN_PRICED_SIZE) * cSize, plus its curve surcharge. */
  size: number;
  /** M8.8: the heal term (support 'heal'), inside the cooldown factor; 0 without. */
  heal: number;
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
  /** "maxHealth 1750 costs $782.25: $525 base + $257.25 for being at 70% of the max". */
  text: string;
}

/** A factory's production part (§6): what it pays up front for its minions. */
export interface CostProduction {
  /** Ticks between two minions. */
  interval: number;
  /** M8.6: the minion kind it builds (`produces`, default grunt). */
  kind: MinionKind;
  /** M8.8: the minions' element (`minionElement`; medics: always normal). */
  element?: Element;
  /** The kind's minion priced as a soldier (rounded), element included. */
  minionCost: number;
  /** ceil(minionCost × minionDiscount): what one expected minion costs the factory. */
  minionValue: number;
  /** E: minions the factory can make in one battle. */
  expected: number;
  /** minionValue × expected. */
  total: number;
  /** "Production: 5 minions × $148 (half of a $296 minion, because they arrive during the battle) = $740". */
  text: string;
}

/** M8.8: a whole-unit multiplier of the unit formula (§6 M8.8 breakdown). */
export interface CostFactorPart {
  factor: number;
  text: string;
}

/** M8.8: the heal term or the aura term (§6 M8.8 formula). */
export interface CostSupportPart {
  kind: SupportKind;
  /** supportPower and its ratio to the curve max (heal 250; haste/might 50; shield 40). */
  power: number;
  ratio: number;
  /** supportRange and its reach factor 0.5 + ρ(2 − ρ). */
  range: number;
  reach: number;
  /** c × power: the price before the curve and the reach factor. */
  linear: number;
  /** 1 + k × ratio². */
  multiplier: number;
  /** linear × multiplier × reach. */
  total: number;
  /** "Heal 60 HP up to 120 px away: $382.64 (faster healing costs more)" / "Might aura 30% within 100 px: +$226.67, added on top". */
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
  /** M8.8 (unit formula): Base + Σ c·x (the "Linear" column of §6). */
  linear?: number;
  /** M8.8 (unit formula): Σ curve surcharges (the "Curve" column of §6). */
  curve?: number;
  /** Sum of all terms (M8.8: base + stats + heal = the "Sum" column). */
  sum: number;
  /** max(1, referenceCooldown / attackCooldown). */
  factor: number;
  /** M8.8: × (1 + q · HP/2500 · damage/300). */
  power?: CostFactorPart & { hpRatio: number; damageRatio: number };
  /** M8.8: × (1 + s · ρ(2 − ρ)), ρ = splashRadius / 80. */
  splash?: CostFactorPart & { radius: number };
  /** M8.8: × the element factor (normal 1). */
  element?: CostFactorPart & { element: Element };
  /** M8.8: the heal term (inside `sum`, so the cooldown factor applies). */
  heal?: CostSupportPart;
  /** M8.8: the aura term, added after every factor. */
  aura?: CostSupportPart;
  /** sum × factors (+ aura), unrounded. */
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

/** M8.8 reach factor 0.5 + ρ(2 − ρ): 0.5 at reach 0, 1.5 at the max (§6 M8.8 formula). */
export function reachFactor(rho: number): number {
  return 0.5 + rho * (2 - rho);
}

/** M8.8 power factor 1 + q · HP/2500 · damage/300 (§6). */
export function powerFactor(stats: Pick<CostStats, 'maxHealth' | 'damage'>, coeffs: Pick<CostCoefficients, 'powerFactor'>): number {
  return 1 + coeffs.powerFactor * (stats.maxHealth / CURVE_MAX.maxHealth) * (stats.damage / CURVE_MAX.damage);
}

/** M8.8 splash factor 1 + s · ρ(2 − ρ), ρ = radius / 80 (§6). */
export function splashFactor(radius: number, coeffs: Pick<CostCoefficients, 'splash'>): number {
  const rs = radius / SPLASH_CURVE_MAX;
  return 1 + coeffs.splash * rs * (2 - rs);
}

/** M8.8 element factor (normal 1). */
export function elementFactor(element: Element, coeffs: Pick<CostCoefficients, 'element'>): number {
  return element === 'normal' ? 1 : coeffs.element[element];
}

const COEFF_OF: Record<PricedStat, 'hp' | 'damage' | 'range' | 'speed' | 'size'> = {
  maxHealth: 'hp',
  damage: 'damage',
  range: 'range',
  speed: 'speed',
  size: 'size',
};

/** One curved term, computed exactly like the §6 reference implementation (lin, lin·k·r², lin + curve). */
function curvedTerm(c: number, x: number, max: number, k: number): { linear: number; curve: number; total: number; ratio: number } {
  const linear = c * x;
  const ratio = x / max;
  const curve = linear * k * ratio ** 2;
  return { linear, curve, total: linear + curve, ratio };
}

function nearText(ratio: number): string {
  const pct = Math.round(ratio * 100);
  return ratio >= NEAR_MAX_RATIO ? `near the max (${pct}% of max)` : `at ${pct}% of the max`;
}

function statPart(stats: CostStats, stat: PricedStat, coeffs: CostCoefficients): CostStatPart {
  const t = curvedTerm(coeffs[COEFF_OF[stat]], pricedAmount(stats, stat), CURVE_MAX[stat], coeffs.curveK);
  const value = stat === 'size' ? sizeOf(stats) : stats[stat];
  const text =
    t.linear === 0
      ? `${stat} ${fmt(value)} costs $0`
      : `${stat} ${fmt(value)} costs ${money(t.total)}: ${money(t.linear)} base + ${money(t.curve)} for being ${nearText(t.ratio)}`;
  return { value, ratio: t.ratio, linear: t.linear, curve: t.curve, total: t.total, multiplier: t.linear === 0 ? 1 : t.total / t.linear, text };
}

/** The aura kinds as card words ("Might aura 30% within 100 px"). */
const AURA_WORD: Readonly<Record<Exclude<SupportKind, 'heal'>, string>> = { haste: 'Haste', might: 'Might', shield: 'Shield' };

/** The element note: what the element does, for the price breakdown ("Fire (hits burn) ×1.2"). */
const ELEMENT_NOTE: Readonly<Record<Element, string>> = {
  normal: 'No element',
  fire: 'Fire (hits burn)',
  ice: 'Ice (frozen enemies move, reload and build slower)',
  lightning: 'Lightning (hits can zap a nearby enemy)',
};

/** The heal term or the aura term of a unit's support (§6 M8.8 formula); null without support. */
export function supportPart(support: SupportSpec | null, coeffs: CostCoefficients): CostSupportPart | null {
  if (!support) return null;
  const { kind, power, range } = support;
  const max = SUPPORT_CURVE_MAX[kind];
  const c = kind === 'heal' ? coeffs.heal : coeffs.aura[kind];
  const k = coeffs.curveK;
  const ratio = power / max.power;
  const multiplier = 1 + k * ratio ** 2;
  const reach = reachFactor(range / max.range);
  // Evaluated left to right like the §6 reference: c · P · (1 + k·r²) · reach.
  const total = c * power * multiplier * reach;
  const text =
    kind === 'heal'
      ? `Heal ${fmt(power)} HP up to ${fmt(range)} px away: ${money(total)} (faster healing costs more)`
      : `${AURA_WORD[kind as Exclude<SupportKind, 'heal'>]} aura ${fmt(power)}% within ${fmt(range)} px: +${money(total)}, added on top`;
  return { kind, power, ratio, range, reach, linear: c * power, multiplier, total, text };
}

/** What a factory's price depends on besides `cost` (§6 Re-pricing). */
export interface PricingContext {
  battleTicks: number;
  factory: Pick<FactoryConfig, 'maxMinionsPerFactory' | 'minions'>;
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

/**
 * A minion kind's stats as a soldier (for its price, §5.2, §6 Minion kinds).
 * M8.8: the element (medics: always normal) and, for the medic, its heal
 * support (`heal` HP, `reach` px).
 */
export function minionCostStats(pricing: PricingContext = DEFAULT_PRICING, kind: MinionKind = 'grunt', element: Element = 'normal'): CostStats {
  const m = pricing.factory.minions[kind];
  const support: SupportSpec | null = kind === 'medic' ? { kind: 'heal', power: m.heal ?? 0, range: m.reach ?? 0 } : null;
  return {
    type: 'soldier',
    maxHealth: m.maxHealth,
    damage: m.damage,
    range: m.range,
    speed: m.speed,
    attackCooldown: m.attackCooldown,
    size: m.size,
    element: kind === 'medic' ? 'normal' : element,
    support,
  };
}

/**
 * minionCost (the soldier price of a minion of that kind and element) and
 * minionValue (what a factory pays per expected minion, §6). Medics ignore the element.
 */
export function minionPrice(
  coeffs: CostCoefficients,
  pricing: PricingContext = DEFAULT_PRICING,
  kind: MinionKind = 'grunt',
  element: Element = 'normal',
): { minionCost: number; minionValue: number } {
  const minionCost = computeCost(minionCostStats(pricing, kind, element), coeffs, pricing).cost;
  return { minionCost, minionValue: roundCost(minionCost * coeffs.factory.minionDiscount) };
}

/** "archer" / "archers" etc. for production texts; grunts are just "minion(s)" (the M8.5 wording). M8.8: "fire brutes". */
export function minionKindWord(kind: MinionKind, count: number, element: Element = 'normal'): string {
  const w = kind === 'grunt' ? 'minion' : MINION_KIND_NAMES[kind].toLowerCase();
  const word = count === 1 ? w : `${w}s`;
  return element === 'normal' || kind === 'medic' ? word : `${element} ${word}`;
}

const ZERO_STATS: readonly PricedStat[] = ['damage', 'range', 'speed', 'size'];

function freePart(stat: PricedStat): CostStatPart {
  return { value: 0, ratio: 0, linear: 0, curve: 0, total: 0, multiplier: 1, text: `${stat} costs $0 (buildings that can't attack don't pay for it)` };
}

/** Price a wall or factory (§6 Walls and factories). */
function computeBuildingCost(stats: CostStats & { type: 'wall' | 'factory' }, coeffs: CostCoefficients, pricing: PricingContext): CostResult {
  const c = stats.type === 'wall' ? coeffs.wall : coeffs.factory;
  const hp = stats.maxHealth;
  const t = curvedTerm(c.hp, hp, BUILDING_HP_CURVE_MAX[stats.type], coeffs.curveK);
  const hpPart: CostStatPart = {
    value: hp,
    ratio: t.ratio,
    linear: t.linear,
    curve: t.curve,
    total: t.total,
    multiplier: t.linear === 0 ? 1 : t.total / t.linear,
    text:
      t.linear === 0
        ? `maxHealth ${fmt(hp)} costs $0`
        : `maxHealth ${fmt(hp)} costs ${money(t.total)}: ${money(t.linear)} base + ${money(t.curve)} for being ${nearText(t.ratio)}`,
  };
  const parts = { maxHealth: hpPart } as Record<PricedStat, CostStatPart>;
  for (const st of ZERO_STATS) parts[st] = freePart(st);
  const terms: CostTerms = { base: c.base, maxHealth: t.total, damage: 0, range: 0, speed: 0, size: 0, heal: 0 };
  const sum = c.base + t.total;
  if (stats.type === 'wall') {
    const cost = roundCost(sum);
    return { raw: sum, cost, breakdown: { formula: 'wall', terms, parts, curveK: coeffs.curveK, sum, factor: 1, raw: sum, cost } };
  }
  const body = roundCost(sum);
  const interval = stats.productionInterval ?? 0;
  const expected = expectedMinions(interval, pricing);
  const kind = producesOf(stats);
  const element = minionElementOf(stats);
  const { minionCost, minionValue } = minionPrice(coeffs, pricing, kind, element);
  const prodTotal = minionValue * expected;
  const share = coeffs.factory.minionDiscount === 0.5 ? 'half' : `${fmt(coeffs.factory.minionDiscount * 100)}%`;
  const production: CostProduction = {
    interval,
    kind,
    element,
    minionCost,
    minionValue,
    expected,
    total: prodTotal,
    text:
      `Production: ${expected} ${minionKindWord(kind, expected, element)} × ${money(minionValue)} (${share} of a ${money(minionCost)} ${minionKindWord(kind, 1, element)}, ` +
      `because they arrive during the battle) = ${money(prodTotal)}`,
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
 * Price a unit (§6, M8.8). Pure; callers check finiteness and the cap. Walls
 * and factories use their own formulas; `pricing` (default: the default
 * config's) sets the battle length and minion stats a factory's production is
 * priced on.
 */
export function computeCost(stats: CostStats, coeffs: CostCoefficients, pricing: PricingContext = DEFAULT_PRICING): CostResult {
  if (isNonCombatBuilding(stats.type)) return computeBuildingCost(stats as CostStats & { type: 'wall' | 'factory' }, coeffs, pricing);
  const parts = {} as Record<PricedStat, CostStatPart>;
  // Summed in the §6 reference order (linear parts, then curve parts), so the cents match exactly.
  let linSum = 0;
  let curveSum = 0;
  for (const stat of PRICED_STATS) {
    const part = statPart(stats, stat, coeffs);
    parts[stat] = part;
    linSum += part.linear;
    curveSum += part.curve;
  }
  const support = supportOf(stats);
  const sp = supportPart(support, coeffs);
  const heal = sp && sp.kind === 'heal' ? sp : undefined;
  const aura = sp && isAuraKind(sp.kind) ? sp : undefined;
  const terms: CostTerms = {
    base: coeffs.base,
    maxHealth: parts.maxHealth.total,
    damage: parts.damage.total,
    range: parts.range.total,
    speed: parts.speed.total,
    size: parts.size.total,
    heal: heal?.total ?? 0,
  };
  const linear = coeffs.base + linSum;
  const sum = linear + curveSum + terms.heal;
  const factor = cooldownFactor(stats.attackCooldown, coeffs);
  const hpRatio = stats.maxHealth / CURVE_MAX.maxHealth;
  const damageRatio = stats.damage / CURVE_MAX.damage;
  const power = powerFactor(stats, coeffs);
  const radius = splashOf(stats);
  const splash = splashFactor(radius, coeffs);
  const el = elementOf(stats);
  const elem = elementFactor(el, coeffs);
  const raw = sum * factor * power * splash * elem + (aura?.total ?? 0);
  const cost = roundCost(raw);
  return {
    raw,
    cost,
    breakdown: {
      formula: 'unit',
      terms,
      parts,
      curveK: coeffs.curveK,
      linear,
      curve: curveSum,
      sum,
      factor,
      power: {
        factor: power,
        hpRatio,
        damageRatio,
        text:
          power >= 1 + 5e-3
            ? `Power ×${fmt(power)}: tough (${Math.round(hpRatio * 100)}% of max HP) AND strong (${Math.round(damageRatio * 100)}% of max damage).` +
              (power >= POWER_HIGH ? ' One tough unit plus one strong unit is cheaper.' : '')
            : 'Power ×1: not both tough and strong.',
      },
      splash: {
        factor: splash,
        radius,
        text: radius > 0 ? `Splash ×${fmt(splash)} (radius ${fmt(radius)}: everyone within ${fmt(radius)} px of the target takes half)` : 'Splash ×1 (one target)',
      },
      element: { factor: elem, element: el, text: `${ELEMENT_NOTE[el]} ×${fmt(elem)}` },
      ...(heal ? { heal } : {}),
      ...(aura ? { aura } : {}),
      raw,
      cost,
    },
  };
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

/** Money with thousands separators (§12): "$2,993", "$1,043.5" (up to 2 decimals). */
export function money(n: number): string {
  // By hand, not toLocaleString: every computeCost builds its breakdown texts, and Intl is slow.
  const r = Math.round(n * 100) / 100;
  if (!Number.isFinite(r)) return `$${r}`;
  const [whole, cents] = String(Math.abs(r)).split('.');
  return `${r < 0 ? '-' : ''}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? `.${cents}` : ''}`;
}

/** Step used when suggesting a lower value for a stat. */
const SUGGEST_STEP: Record<PricedStat, number> = { maxHealth: 50, damage: 5, range: 10, speed: 0.5, size: 1 };

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
    `The most expensive stat is ${big}: ${fmt(part.value)} costs ${money(part.total)}${breakdown.formula === 'unit' ? ' before the factors' : ''} ` +
    `(${money(part.linear)} base + ${money(part.curve)} for being ${Math.round(part.ratio * 100)}% of the max).`;
  const sug = suggestLowerStat(stats, big, cap, coeffs, bounds, pricing);
  if (sug && sug.saves > 0) {
    s += ` Lowering ${big} from ${fmt(sug.from)} to ${fmt(sug.to)} saves ${money(sug.saves)} (${money(sug.newCost)})`;
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
 * "Raising productionInterval from 600 to 900 makes 5 minions instead of 8 and saves $441."
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
  const kind = producesOf(stats);
  const element = minionElementOf(stats);
  // M8.6: a cheaper kind that fits is often the simplest lever (M8.8: normal minions too).
  let cheaper = '';
  if (kind !== 'grunt') {
    const grunts = computeCost({ ...stats, produces: 'grunt' }, coeffs, pricing);
    if (grunts.cost < result.cost) {
      cheaper = ` Making grunts instead of ${minionKindWord(kind, 2)} (this.produces = 'grunt') saves ${money(result.cost - grunts.cost)} (${money(grunts.cost)}).`;
    }
  }
  if (element !== 'normal') {
    const plain = computeCost({ ...stats, minionElement: 'normal' }, coeffs, pricing);
    if (plain.cost < result.cost) cheaper += ` Normal minions instead of ${element} ones save ${money(result.cost - plain.cost)} (${money(plain.cost)}).`;
  }
  if (to <= from) return `The production of ${fromE} ${minionKindWord(kind, fromE, element)} is the biggest cost; lower maxHealth instead.${cheaper}`;
  const next = computeCost({ ...stats, productionInterval: to }, coeffs, pricing);
  const toE = expectedMinions(to, pricing);
  return (
    `The production (${fromE} ${minionKindWord(kind, fromE, element)} × ${money(result.breakdown.production?.minionValue ?? 0)}) is the biggest cost: ` +
    `raising productionInterval from ${fmt(from)} to ${to} makes ${toE} ${minionKindWord(kind, toE, element)} instead of ${fromE} and saves ${money(result.cost - next.cost)} (${money(next.cost)}).` +
    cheaper
  );
}

/**
 * The power-factor lever (§6 M8.8 levers): lower the more maxed of HP and
 * damage until the power factor is POWER_HIGH, e.g. "Lowering damage from 265
 * to 175 drops the power factor from ×1.37 to ×1.25 and saves $370 ($2,123)."
 */
function powerLever(stats: CostStats, result: CostResult, coeffs: CostCoefficients, bounds: StatBounds, pricing: PricingContext): string | null {
  const p = result.breakdown.power;
  if (!p || p.factor < POWER_HIGH || coeffs.powerFactor <= 0) return null;
  const stat: PricedStat = p.damageRatio >= p.hpRatio ? 'damage' : 'maxHealth';
  const keep = stat === 'damage' ? p.hpRatio : p.damageRatio;
  const target = (POWER_HIGH - 1) / (coeffs.powerFactor * keep);
  const to = Math.max(statMin(stats, stat, bounds), floorTo(target * CURVE_MAX[stat], SUGGEST_STEP[stat]));
  const from = stats[stat];
  if (!(to < from)) return null;
  const next = computeCost(withStat(stats, stat, to), coeffs, pricing);
  return (
    `Lowering ${stat} from ${fmt(from)} to ${fmt(to)} drops the power factor from ×${fmt(p.factor)} to ×${fmt(next.breakdown.power?.factor ?? 1)} ` +
    `and saves ${money(result.cost - next.cost)} (${money(next.cost)}): one tough unit plus one strong unit is cheaper than one unit that is both.`
  );
}

/** The splash lever: halve the radius (§6 M8.8 levers), e.g. "Splash 80 → 40 saves $X". */
function splashLever(stats: CostStats, result: CostResult, coeffs: CostCoefficients, pricing: PricingContext): string | null {
  const r = splashOf(stats);
  if (r <= 0) return null;
  const to = r > 20 ? floorTo(r / 2, 10) : 0;
  const next = computeCost({ ...stats, splashRadius: to }, coeffs, pricing);
  return `Splash ${fmt(r)} → ${fmt(to)} (this.splashRadius = ${fmt(to)}) saves ${money(result.cost - next.cost)} (${money(next.cost)}).`;
}

/** The element lever: "normal instead of fire saves $X". */
function elementLever(stats: CostStats, result: CostResult, coeffs: CostCoefficients, pricing: PricingContext): string | null {
  const el = elementOf(stats);
  if (el === 'normal') return null;
  const next = computeCost({ ...stats, element: 'normal' }, coeffs, pricing);
  return `normal instead of ${el} (leave this.element out) saves ${money(result.cost - next.cost)} (${money(next.cost)}).`;
}

/** The support lever: halve supportPower (kept inside its bounds). */
function supportLever(stats: CostStats, result: CostResult, coeffs: CostCoefficients, bounds: StatBounds, pricing: PricingContext): string | null {
  const s = supportOf(stats);
  if (!s) return null;
  const min = bounds.support[s.kind].power.min;
  const to = Math.max(min, floorTo(s.power / 2, 5));
  if (!(to < s.power)) return null;
  const next = computeCost({ ...stats, support: { ...s, power: to } }, coeffs, pricing);
  return `Lowering supportPower (${s.kind}) from ${fmt(s.power)} to ${fmt(to)} saves ${money(result.cost - next.cost)} (${money(next.cost)}).`;
}

/**
 * The levers of a too-expensive unit (the UNIT_TOO_EXPENSIVE `fix` after its
 * "Cost is $X but the max is $Y." head; the M8.8 ×5 migration advice reuses it).
 */
export function tooExpensiveLevers(
  stats: CostStats,
  result: CostResult,
  cap: number,
  coeffs: CostCoefficients,
  bounds: StatBounds = DEFAULT_CONFIG.stats.bounds,
  pricing: PricingContext = DEFAULT_PRICING,
): string {
  const { breakdown } = result;
  const statSentence = leverSentence(stats, result, cap, coeffs, bounds, pricing);
  const prod = breakdown.production;
  if (prod && prod.total >= breakdown.terms.maxHealth) {
    // Factory whose production is the bigger lever: a slower interval buys fewer minions.
    return `${productionLever(stats, result, cap, coeffs, bounds, pricing)} ${statSentence}`;
  }
  if (breakdown.factor > 1) {
    // Try doubling the cooldown until it fits or the factor reaches 1.
    let cd = stats.attackCooldown;
    let next: CostResult | undefined;
    while (cd < coeffs.referenceCooldown) {
      cd = Math.min(coeffs.referenceCooldown, Math.ceil(cd * 2));
      next = computeCost({ ...stats, attackCooldown: cd }, coeffs, pricing);
      if (next.cost <= cap) break;
    }
    if (next && next.cost <= cap) {
      return (
        `The ×${fmt(breakdown.factor)} cooldown factor is the biggest cost: ` +
        `raising attackCooldown from ${stats.attackCooldown} to ${cd} makes it ×${fmt(next.breakdown.factor)} (${money(next.cost)}). ` +
        statSentence
      );
    }
    return `Raise attackCooldown towards ${coeffs.referenceCooldown} (currently ×${fmt(breakdown.factor)}) and lower the stats. ${statSentence}`;
  }
  // Factor is 1: the M8.8 multipliers and the support, then the stats.
  const lever =
    powerLever(stats, result, coeffs, bounds, pricing) ??
    splashLever(stats, result, coeffs, pricing) ??
    elementLever(stats, result, coeffs, pricing) ??
    supportLever(stats, result, coeffs, bounds, pricing);
  let fix = `${lever ? `${lever} ` : ''}${statSentence}`;
  // Only true when the curve is on (curveK = 0 is the old linear price).
  if (coeffs.curveK > 0) fix += ` Maxed stats cost up to ${fmt(1 + coeffs.curveK)}× their normal price, so spread them over two units instead.`;
  return fix;
}

/**
 * Build the §7 UNIT_TOO_EXPENSIVE error, with a `fix` naming the biggest
 * lever, checked in this order (§6 M8.8): a factory's production, the
 * cooldown factor, the power factor, splash, the element, the support, and
 * always the most expensive stat with a concrete lower value, e.g.
 * "Lowering maxHealth from 2500 to 1750 saves $640 ($2,100)."
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
  const head = `Cost is ${money(result.cost)} but the max is ${money(cap)}.`;
  const fix = `${head} ${tooExpensiveLevers(stats, result, cap, coeffs, bounds, pricing)}`;
  return {
    code: 'UNIT_TOO_EXPENSIVE',
    field: 'cost',
    value: result.cost,
    allowed: { max: cap },
    message: `This unit costs ${money(result.cost)} but the most a unit may cost is ${money(cap)}.`,
    fix,
    breakdown,
  };
}

/**
 * W_STAT_NEAR_MAX (non-fatal): one warning per stat at ≥ 80% of its max,
 * e.g. "maxHealth is at 96% of max and costs 1.92× its normal price; two
 * medium units usually beat one maxed one." M8.8: supportPower too (the heal
 * and aura terms are curved). None when curveK = 0: with no curve a maxed
 * stat costs its normal price, so the advice would be false.
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
    // Suggest 60% of the max (1 + k·0.36 ≈ 1.36× with k = 1).
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
        ? `If you don't need it this high, set this.${stat} to ${fmt(target)}: that saves ${money(saving)} (cost ${money(lower.cost)}) to spend on another unit.`
        : `Consider a lower ${stat} and spend the savings on a second unit.`,
    });
  }
  const sp = result.breakdown.heal ?? result.breakdown.aura;
  const support = supportOf(stats);
  if (sp && support && sp.ratio >= NEAR_MAX_RATIO && sp.multiplier > 1) {
    const max = SUPPORT_CURVE_MAX[sp.kind].power;
    const target = Math.max(bounds.support[sp.kind].power.min, floorTo(0.6 * max, 5));
    const lower = target < sp.power ? computeCost({ ...stats, support: { ...support, power: target } }, coeffs, pricing) : undefined;
    out.push({
      code: 'W_STAT_NEAR_MAX',
      field: 'supportPower',
      value: sp.power,
      allowed: { max, ratio: Math.round(sp.ratio * 100) / 100 },
      message: `supportPower is at ${Math.round(sp.ratio * 100)}% of max and costs ${fmt(sp.multiplier)}× its normal price; two medium supports usually beat one maxed one.`,
      fix: lower
        ? `If you don't need it this high, set this.supportPower to ${fmt(target)}: that saves ${money(result.cost - lower.cost)} (cost ${money(lower.cost)}).`
        : 'Consider a lower supportPower and spend the savings on a second unit.',
    });
  }
  return out;
}

/**
 * W_POWER_HIGH (non-fatal, §7 M8.8): the power factor is ≥ 1.25, e.g. "Very
 * tough AND very strong costs ×1.37 here; one tough unit plus one strong unit
 * is cheaper". Null below the threshold.
 */
export function powerHighWarning(
  stats: CostStats,
  result: CostResult,
  coeffs: CostCoefficients,
  bounds: StatBounds = DEFAULT_CONFIG.stats.bounds,
  pricing: PricingContext = DEFAULT_PRICING,
): ValidationWarning | null {
  const p = result.breakdown.power;
  if (!p || p.factor < POWER_HIGH) return null;
  const lever = powerLever(stats, result, coeffs, bounds, pricing);
  return {
    code: 'W_POWER_HIGH',
    field: p.damageRatio >= p.hpRatio ? 'damage' : 'maxHealth',
    value: Math.round(p.factor * 100) / 100,
    allowed: { max: POWER_HIGH },
    message: `Very tough AND very strong costs ×${fmt(p.factor)} here (${Math.round(p.hpRatio * 100)}% of max HP and ${Math.round(p.damageRatio * 100)}% of max damage); one tough unit plus one strong unit is cheaper.`,
    fix: lever ?? 'Lower maxHealth or damage, and put the rest into a second unit.',
  };
}
