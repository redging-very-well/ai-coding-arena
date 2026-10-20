// GET /rules + MCP get_rules, GET /contract + MCP get_unit_contract (§10).

import { readFileSync } from 'node:fs';
import {
  ARENA,
  BADGES,
  CELL_SIZE,
  DEFAULT_CONFIG,
  DEFAULT_SIZE,
  GRID_SIZE,
  PHASES,
  ZONE_SIZE,
  type ContractDTO,
  type GameConfig,
  type RulesDTO,
} from '@pixel-clash/shared';
import { repoPath } from '../util/paths.js';
import { templateSource } from './units.js';

/** The Open Armory paragraph of the rules (§9.1). */
export function armoryRules(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    text: enabled
      ? 'Open Armory is ON this match: every unit type that fought in a battle becomes borrowable by all OTHER players from the next Plan phase, as a frozen copy named "Unit (Creator)". Pick borrowed units on the Pixel Clash page (they count toward the 3 types). list_armory shows them.'
      : 'Open Armory is off this match: players only use their own units.',
    rules: [
      'Only units fielded in a battle enter the Armory, when that battle ends. Unfielded designs stay private.',
      'An entry is frozen at the version that fought; when the creator fields a newer version, it replaces the entry.',
      "Borrowed units can't be changed and their code is never shared. Build your own counter or improved version instead.",
      "A borrowed unit fights for the borrower: its damage and points are the borrower's.",
      '💡 Inventor badge (no points) when another player fields your unit.',
    ],
  };
}

export function buildRules(config: GameConfig, armoryEnabled = false): RulesDTO {
  const t = config.timers;
  return {
    phases: PHASES,
    timers: {
      planFirstRoundSec: t.planFirstRoundSec,
      planLaterRoundsSec: t.planLaterRoundsSec,
      placementSec: t.placementSec,
      battleSeconds: t.battleTicks / t.ticksPerSecond,
      ticksPerSecond: t.ticksPerSecond,
      defaultRounds: t.defaultRounds,
    },
    budget: config.caps.budget,
    caps: { ...config.caps },
    costFormula:
      'each stat term = linear * (1 + c.curveK * (x / max)^2) with linear = maxHealth*c.hp (max 500), damage*c.damage (max 60), range*c.range (max 300), speed*c.speed (max 5), (size - 6)*c.size (max 14); ' +
      'raw = (c.base + sum of the terms) * max(1, c.referenceCooldown / attackCooldown); cost = ceil(raw), where c = coefficients and size defaults to bounds.defaultSize[type]. ' +
      curveSentence(config.cost.curveK),
    coefficients: { ...config.cost },
    bounds: {
      ...config.stats.bounds,
      towerSpeed: 0,
      defaultSize: DEFAULT_SIZE,
      color: '#RRGGBB',
      shape: ['circle', 'square', 'triangle', 'diamond'],
    },
    scoring: scoringRules(config),
    arena: {
      width: ARENA.width,
      height: ARENA.height,
      zoneSize: ZONE_SIZE,
      cellSize: CELL_SIZE,
      gridSize: GRID_SIZE,
      zones: '2 players: TL+BR; 3 players: TL, TR, BR; 4 players: all corners. Zones rotate every round.',
      rangeIs: 'edge to edge: distance - self.radius - other.radius <= range',
    },
    suddenDeath: {
      ...config.suddenDeath,
      text: `From ${config.suddenDeath.startTick / t.ticksPerSecond} s a safe circle around (400,400) shrinks; units outside lose ${config.suddenDeath.damagePctPerSecond}% of max health per second.`,
    },
    submissions: 'submit_unit works only in the PLAN phase; validate_unit works any time.',
    armory: armoryRules(armoryEnabled),
    ranking: 'Survivors rank above the eliminated. At the time limit, survivors are ranked by the total cost of their living units.',
    pointsSummary: `Round points = place points (${config.scoring.placePoints.join('/')}) + damage bonus (0-${config.scoring.damageBonusMax}) + value-destroyed bonus (0-${config.scoring.valueBonusMax}). See scoring.`,
  };
}

/** §9 Points / Badges / Match standings, with the numbers from config. */
export function scoringRules(config: GameConfig): RulesDTO['scoring'] {
  const sc = config.scoring;
  const place = sc.placePoints.map((p, i) => `${ordinal(i + 1)} ${p}`).join(', ');
  return {
    placePoints: [...sc.placePoints],
    damageBonusMax: sc.damageBonusMax,
    valueBonusMax: sc.valueBonusMax,
    formula: 'round points = place points + damage bonus + value bonus',
    place: `Place points: ${place} (the same table for 2-4 players; tied players share the better place).`,
    damageBonus: `Damage bonus: round(${sc.damageBonusMax} x myDamage / topDamage), 0-${sc.damageBonusMax}. Damage is EFFECTIVE damage to enemy units: a hit counts at most the hp the target had left (no overkill). It is credited when the hit lands (projectiles on impact), even if the shooter died meanwhile.`,
    valueBonus: `Value bonus: round(${sc.valueBonusMax} x myValueDestroyed / topValueDestroyed), 0-${sc.valueBonusMax}. When your hit finishes an enemy unit you get its FULL unit cost as value destroyed (and a KO). Hits in the same tick resolve in seat order, then instanceId order.`,
    rounding: 'Rounding is half-up (0.5 rounds up). A bonus is 0 when the top value is 0.',
    suddenDeath: 'Damage and KOs from the sudden-death circle count for nobody.',
    badges: Object.values(BADGES).map((b) => `${b.emoji} ${b.title}: ${b.rule}`),
    badgeRules: 'Badges are titles only (no points). Ties share a badge; a badge needs a value above 0.',
    kicked: 'A player removed during a battle gets no points or badges; damage dealt to their units still counts.',
    matchStandings: 'Match standings: total points, then total damage over the match, then a shared place.',
    tip: 'Units that hit hard score damage points even if they do not survive: an aggressive army that comes 2nd can outscore a turtle that survives.',
  };
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

let contractText: string | undefined;

/** The verbatim §5 contract block from packages/shared/src/contract.ts. */
export function contractTypescript(): string {
  if (contractText !== undefined) return contractText;
  try {
    const src = readFileSync(repoPath('packages', 'shared', 'src', 'contract.ts'), 'utf8');
    const start = src.indexOf('// --- BEGIN CONTRACT');
    const end = src.indexOf('// --- END CONTRACT ---');
    const body = start >= 0 && end > start ? src.slice(src.indexOf('\n', start) + 1, end) : src;
    contractText = body.trimEnd();
  } catch {
    contractText = '(contract source not found)';
  }
  return contractText;
}

export const ENGINE_RULES = [
  '1. Stats are snapshotted at validation. Changing this.damage inside update() has no effect.',
  '2. Extra fields on `this` persist between ticks for that copy. Module-level variables are shared by all your copies of the same type.',
  '3. update() is called once per tick (60 ticks = 1 s) with fresh plain copies. Mutating the inputs does nothing.',
  "4. The returned action is a request: attack needs a living enemy within range (EDGE to edge, +0.5 px) and cooldownRemaining = 0, else the unit idles. move: soldiers only, at most `speed` px per tick, clamped to the arena. Anything else (or a throw) means idle; throws count strikes and 30 strikes disable the unit for the battle.",
  '5. No import, require, network, timers or async. They do not exist in the sandbox.',
];

/** The costFormula sentence on the curve, built from curveK (k = 0 is linear: no "spread" claim). */
function curveSentence(curveK: number): string {
  if (!(curveK > 0)) return 'With curveK = 0 the price is linear: a stat at its max costs its normal price.';
  return `A stat at its max costs ${fmtX(1 + curveK)}x its normal price and one at half its max ${fmtX(1 + curveK / 4)}x, so two medium units are cheaper than one maxed unit.`;
}

/** Multiplier with up to 2 decimals, no trailing zeros. */
function fmtX(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** The cost-curve tip, with the multipliers from curveK. */
export function curveTip(curveK: number): string {
  if (!(curveK > 0)) return 'Cost grows in a straight line with each stat (curveK = 0). 4-8 units per $1,000 is a good army.';
  return `Maxing a stat costs ${fmtX(1 + curveK)}× its normal price (half its max costs ${fmtX(1 + curveK / 4)}×): spread your stats. Two or three medium units usually beat one giant one. 4-8 units per $1,000 is a good army.`;
}

/** Strategy tips; the cost-curve tip follows `curveK`. */
export function strategyTips(curveK: number = DEFAULT_CONFIG.cost.curveK): string[] {
  return STRATEGY_TIPS.map((t) => (t === CURVE_TIP_SLOT ? curveTip(curveK) : t));
}

const CURVE_TIP_SLOT = '(curve tip)';

export const STRATEGY_TIPS = [
  'attackCooldown 60 is free; a faster cooldown multiplies the WHOLE cost (cooldown 30 = ×2).',
  "attackCooldown above 60 gives NO discount: it's the same price for less damage. Use 60.",
  'Range is edge to edge: bigger bodies (size) reach further but are easier to hit.',
  CURVE_TIP_SLOT,
  'Points come from your place AND from damage (up to +2) and enemy value destroyed (up to +1). Aggressive units score damage points even if they do not survive.',
  'After 60 s a safe circle shrinks toward the centre; units outside it lose health. Towers far from the centre will suffer.',
  'Add a sprite() method with pixel art (drawn facing right); without it the unit gets a plain fallback look.',
];

export function buildContract(config: GameConfig = DEFAULT_CONFIG): ContractDTO {
  return {
    typescript: contractTypescript(),
    templates: { basic_soldier: templateSource('basic_soldier'), basic_tower: templateSource('basic_tower') },
    notes: [...ENGINE_RULES, ...strategyTips(config.cost.curveK).map((t) => `Tip: ${t}`)],
  };
}
