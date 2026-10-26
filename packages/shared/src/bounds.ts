// Hard guards on the stats read from a constructed unit.
//
// Input is the JSON-copied bag of own data properties produced by step 5
// (values are `unknown`: player code can set anything). No coercion: the string
// "100" is STAT_WRONG_TYPE, not 100. Every problem found is reported (not just
// the first), each as a error object with code/field/value/allowed/message/fix.

import type { StatBounds } from './config.js';
import {
  DEFAULT_BURST,
  DEFAULT_MINION_KIND,
  DEFAULT_SHAPE,
  DEFAULT_SIZE,
  ELEMENTS,
  MINION_KINDS,
  SHAPES,
  SUPPORT_KINDS,
  UNIT_TYPES,
  isElement,
  isMinionKind,
  isNonCombatBuilding,
  isSupportKind,
  type Element,
  type MinionKind,
  type Shape,
  type StatsSnapshot,
  type SupportKind,
  type SupportSpec,
  type UnitType,
} from './contract.js';
import type { ValidationError, ValidationWarning } from './errors.js';

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

export type StatsCheckResult =
  /** `warnings`: W_STAT_IGNORED for fields this type doesn't use, never stored. */
  | { ok: true; stats: StatsSnapshot; warnings: ValidationWarning[] }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/** JSON-safe rendering of an arbitrary value for the `value` field. */
function safeValue(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') return String(v);
  if (typeof v === 'undefined') return 'undefined';
  return v;
}

/** An example value inside the allowed range, for `fix` texts. */
function example(field: string, min: number, max: number): number {
  const preferred: Record<string, number> = {
    maxHealth: 600,
    damage: 50,
    range: 40,
    speed: 1.5,
    attackCooldown: 60,
    size: 10,
    productionInterval: 900,
    splashRadius: 40,
  };
  const p = preferred[field];
  if (p !== undefined && p >= min && p <= max) return p;
  return min;
}

function wrongType(field: string, value: unknown, expected: string, fix: string): ValidationError {
  return {
    code: 'STAT_WRONG_TYPE',
    field,
    value: safeValue(value),
    allowed: { type: expected },
    message: `${field} must be a ${expected} but it is ${value === null ? 'null' : typeof value}${
      typeof value === 'string' ? ` ("${value}")` : ''
    }.`,
    fix,
  };
}

/**
 * Check one numeric stat: typeof number, finite, within [min, max].
 * Returns the number when valid, or pushes an error and returns undefined.
 */
function checkNumber(
  errors: ValidationError[],
  field: string,
  value: unknown,
  range: { min: number; max: number },
  opts: { integer?: boolean; integerCode?: 'COOLDOWN_NOT_INTEGER' | 'INTERVAL_NOT_INTEGER' | 'BURST_NOT_INTEGER'; fix?: string; example?: number } = {},
): number | undefined {
  const eg = opts.example ?? example(field, range.min, range.max);
  const setFix =
    opts.fix ?? `In the constructor set this.${field} to a number from ${range.min} to ${range.max}, e.g. this.${field} = ${eg}.`;
  if (typeof value !== 'number') {
    errors.push(wrongType(field, value, 'number', `${setFix} Use a plain number, not text or a calculation result that might be undefined.`));
    return undefined;
  }
  if (!Number.isFinite(value)) {
    errors.push({
      code: 'STAT_NOT_FINITE',
      field,
      value: safeValue(value),
      allowed: { min: range.min, max: range.max },
      message: `${field} is ${String(value)}, which is not a real number.`,
      fix: setFix,
    });
    return undefined;
  }
  if (value < range.min || value > range.max) {
    errors.push({
      code: 'STAT_OUT_OF_RANGE',
      field,
      value,
      allowed: { min: range.min, max: range.max },
      message: `${field} is ${value} but must be between ${range.min} and ${range.max}.`,
      fix: setFix,
    });
    return undefined;
  }
  if (opts.integer && !Number.isInteger(value)) {
    const rounded = Math.min(range.max, Math.max(range.min, Math.round(value)));
    errors.push({
      code: opts.integerCode ?? 'COOLDOWN_NOT_INTEGER',
      field,
      value,
      allowed: { min: range.min, max: range.max, integer: true },
      message: `${field} is ${value} but must be a whole number of ticks.`,
      fix: `In the constructor set this.${field} to a whole number, e.g. this.${field} = ${rounded}.`,
    });
    return undefined;
  }
  return value;
}

/** The fields each type must set. */
const REQUIRED: Readonly<Record<UnitType, readonly string[]>> = {
  soldier: ['name', 'type', 'maxHealth', 'damage', 'range', 'speed', 'attackCooldown', 'color'],
  tower: ['name', 'type', 'maxHealth', 'damage', 'range', 'speed', 'attackCooldown', 'color'],
  wall: ['name', 'type', 'maxHealth', 'color'],
  factory: ['name', 'type', 'maxHealth', 'productionInterval', 'color'],
};

/** Type-specific `fix` for a missing field. */
function missingFix(type: UnitType | undefined, field: string, bounds: StatBounds): string {
  // The ranges come from the live bounds; the example is clamped into them.
  const range = (r: { min: number; max: number }, eg: number) =>
    `from ${r.min} to ${r.max}. Try ${Math.min(r.max, Math.max(r.min, eg))}`;
  if (type === 'factory' && field === 'productionInterval') {
    const p = bounds.productionInterval;
    const eg = Math.min(p.max, Math.max(p.min, 900));
    return `A factory needs this.productionInterval: ticks between two minions, ${p.min}-${p.max}. Try ${eg}${eg === 900 ? ' (one every 15 s)' : ''}.`;
  }
  if (type === 'wall' && field === 'maxHealth') return `A wall needs this.maxHealth, ${range(bounds.wallHealth, 3200)}.`;
  if (type === 'factory' && field === 'maxHealth') return `A factory needs this.maxHealth, ${range(bounds.factoryHealth, 360)}.`;
  return `In the constructor add this.${field} = …; as a plain data property (see the contract).`;
}

function ignored(field: string, type: UnitType, value: unknown): ValidationWarning {
  return {
    code: 'W_STAT_IGNORED',
    field,
    value: safeValue(value),
    message: `A ${type} doesn't use ${field}, so it is ignored.`,
    fix: `Remove this.${field} from the constructor (a ${type} ${
      field === 'productionInterval' || field === 'produces' || field === 'burst'
        ? "doesn't build minions: only factories do"
        : field === 'size'
          ? 'has a fixed size'
          : "can't attack"
    }).`,
  };
}

/** Words players and Claude might use for a minion kind. */
const KIND_ALIASES: Readonly<Record<string, MinionKind>> = {
  minion: 'grunt', soldier: 'grunt', warrior: 'grunt', footman: 'grunt', robot: 'grunt', basic: 'grunt',
  bow: 'archer', bowman: 'archer', ranger: 'archer', shooter: 'archer', sniper: 'archer', ranged: 'archer', gunner: 'archer',
  scout: 'runner', ninja: 'runner', speedy: 'runner', fast: 'runner', rusher: 'runner', sprinter: 'runner',
  tank: 'brute', knight: 'brute', giant: 'brute', ogre: 'brute', smasher: 'brute', breaker: 'brute', heavy: 'brute', golem: 'brute',
};

/** The kind a near-miss value probably meant ('Archers' → archer, 'knight' → brute), if any. */
export function closestMinionKind(v: string): MinionKind | undefined {
  const w = v.trim().toLowerCase();
  const candidates = [w, w.replace(/e?s$/, ''), w.replace(/s$/, '')];
  for (const c of candidates) {
    if (isMinionKind(c)) return c;
    const alias = KIND_ALIASES[c];
    if (alias) return alias;
  }
  return undefined;
}

const KIND_LIST = MINION_KINDS.map((k) => `'${k}'`).join(', ');

/** `produces`: a string naming one of the minion kinds. */
function checkProduces(errors: ValidationError[], value: unknown): MinionKind | undefined {
  if (typeof value !== 'string') {
    errors.push(
      wrongType('produces', value, 'string', `Set this.produces to one of ${KIND_LIST} (text in quotes), or leave it out for grunts.`),
    );
    return undefined;
  }
  if (isMinionKind(value)) return value;
  const guess = closestMinionKind(value);
  errors.push({
    code: 'STAT_OUT_OF_RANGE',
    field: 'produces',
    value,
    allowed: { oneOf: [...MINION_KINDS] },
    message: `produces is "${value}" but must be one of ${KIND_LIST}.`,
    fix: `Set this.produces = '${guess ?? 'grunt'}' (one of ${KIND_LIST}), or leave it out for grunts.`,
  });
  return undefined;
}

/** Words players and Claude might use for an element. */
const ELEMENT_ALIASES: Readonly<Record<string, Element>> = {
  none: 'normal', plain: 'normal', physical: 'normal', default: 'normal', basic: 'normal',
  flame: 'fire', flames: 'fire', burn: 'fire', burning: 'fire', fiery: 'fire', heat: 'fire', lava: 'fire', inferno: 'fire',
  frost: 'ice', freeze: 'ice', freezing: 'ice', frozen: 'ice', cold: 'ice', snow: 'ice', icy: 'ice', water: 'ice',
  lightening: 'lightning', lighting: 'lightning', electric: 'lightning', electricity: 'lightning', shock: 'lightning', thunder: 'lightning', zap: 'lightning', storm: 'lightning', spark: 'lightning',
};

/** Words players and Claude might use for a support kind. */
const SUPPORT_ALIASES: Readonly<Record<string, SupportKind>> = {
  healing: 'heal', healer: 'heal', medic: 'heal', repair: 'heal', regen: 'heal', cure: 'heal', health: 'heal',
  speed: 'haste', fast: 'haste', swift: 'haste', quick: 'haste', rush: 'haste', hasten: 'haste',
  strength: 'might', power: 'might', damage: 'might', strong: 'might', rage: 'might', buff: 'might', attack: 'might', fury: 'might',
  armor: 'shield', armour: 'shield', defense: 'shield', defence: 'shield', protect: 'shield', protection: 'shield', guard: 'shield', block: 'shield', barrier: 'shield',
};

/** The allowed word a near-miss value probably meant ('Fire' → fire, 'lightening' → lightning, 'healing' → heal), if any. */
function closestWord<T extends string>(v: string, allowed: readonly T[], aliases: Readonly<Record<string, T>>): T | undefined {
  const w = v.trim().toLowerCase();
  for (const c of [w, w.replace(/e?s$/, ''), w.replace(/s$/, '')]) {
    if ((allowed as readonly string[]).includes(c)) return c as T;
    const alias = aliases[c];
    if (alias) return alias;
  }
  return undefined;
}

export function closestElement(v: string): Element | undefined {
  return closestWord(v, ELEMENTS, ELEMENT_ALIASES);
}
export function closestSupportKind(v: string): SupportKind | undefined {
  return closestWord(v, SUPPORT_KINDS, SUPPORT_ALIASES);
}

const ELEMENT_LIST = ELEMENTS.map((k) => `'${k}'`).join(', ');
const SUPPORT_LIST = SUPPORT_KINDS.map((k) => `'${k}'`).join(', ');

/** `element` / `minionElement`: a string naming one of the four elements. */
function checkElement(errors: ValidationError[], field: 'element' | 'minionElement', value: unknown): Element | undefined {
  const leave = field === 'element' ? 'or leave it out for a normal unit' : 'or leave it out for normal minions';
  if (typeof value !== 'string') {
    errors.push(wrongType(field, value, 'string', `Set this.${field} to one of ${ELEMENT_LIST} (text in quotes), ${leave}.`));
    return undefined;
  }
  if (isElement(value)) return value;
  const guess = closestElement(value);
  errors.push({
    code: 'STAT_OUT_OF_RANGE',
    field,
    value,
    allowed: { oneOf: [...ELEMENTS] },
    message: `${field} is "${value}" but must be one of ${ELEMENT_LIST}.`,
    fix: `Set this.${field} = '${guess ?? 'fire'}' (one of ${ELEMENT_LIST}), ${leave}.`,
  });
  return undefined;
}

/** An example supportPower / supportRange per kind, for `fix` texts. */
const SUPPORT_EXAMPLE: Readonly<Record<SupportKind, { power: number; range: number; says: string }>> = {
  heal: { power: 60, range: 120, says: 'heal 60 HP, reach 120 px' },
  haste: { power: 30, range: 100, says: '+30% speed and attack speed in a 100 px aura' },
  might: { power: 30, range: 100, says: '+30% damage in a 100 px aura' },
  shield: { power: 25, range: 80, says: '25% less damage taken in an 80 px aura' },
};

/** `support`: a string naming one support kind. */
function checkSupportKind(errors: ValidationError[], value: unknown): SupportKind | undefined {
  if (typeof value !== 'string') {
    errors.push(wrongType('support', value, 'string', `Set this.support to one of ${SUPPORT_LIST} (text in quotes), or leave it out.`));
    return undefined;
  }
  if (isSupportKind(value)) return value;
  const guess = closestSupportKind(value) ?? 'heal';
  const eg = SUPPORT_EXAMPLE[guess];
  errors.push({
    code: 'STAT_OUT_OF_RANGE',
    field: 'support',
    value,
    allowed: { oneOf: [...SUPPORT_KINDS] },
    message: `support is "${value}" but must be one of ${SUPPORT_LIST}.`,
    fix: `Set this.support = '${guess}' (one of ${SUPPORT_LIST}) with this.supportPower = ${eg.power}; this.supportRange = ${eg.range}; (${eg.says}), or leave all three out.`,
  });
  return undefined;
}

/** W_STAT_IGNORED with a type-specific fix. */
function ignoredWith(field: string, type: UnitType, value: unknown, why: string): ValidationWarning {
  return {
    code: 'W_STAT_IGNORED',
    field,
    value: safeValue(value),
    message: `A ${type} doesn't use ${field}, so it is ignored.`,
    fix: `Remove this.${field} from the constructor (${why}).`,
  };
}

/** The M8.8 fields every type may carry. */
const SUPPORT_FIELDS = ['support', 'supportPower', 'supportRange'] as const;

/**
 * Run the step-6 guards on raw stats, per type. On success returns
 * a frozen `StatsSnapshot` with the trimmed name and the size and shape filled
 * in; walls and factories get damage, range, speed and attackCooldown 0 and
 * their fixed size (20 / 18), and only factories keep `productionInterval`.
 * Fields a type doesn't use give W_STAT_IGNORED warnings.
 *
 * Missing fields (`undefined`) are reported as STAT_MISSING so this function
 * is safe to call on its own; the validator's step 5 normally catches them first.
 */
export function checkStats(raw: Readonly<Record<string, unknown>>, bounds: StatBounds): StatsCheckResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const has = (f: string) => raw[f] !== undefined;

  // type first: it decides which fields are required (no type → the soldier list; a bad one → the common fields).
  let type: UnitType | undefined;
  if (has('type')) {
    const v = raw.type;
    if (typeof v !== 'string') {
      errors.push(wrongType('type', v, 'string', `In the constructor set this.type to "soldier", "tower", "wall" or "factory".`));
    } else if (!(UNIT_TYPES as readonly string[]).includes(v)) {
      errors.push({
        code: 'STAT_OUT_OF_RANGE',
        field: 'type',
        value: v,
        allowed: { oneOf: [...UNIT_TYPES] },
        message: `type is "${v}" but must be "soldier", "tower", "wall" or "factory".`,
        fix: `In the constructor set this.type = "soldier" (moves and fights), "tower" (stays and shoots), "wall" (a block that stops everyone) or "factory" (builds minions).`,
      });
    } else {
      type = v as UnitType;
    }
  }
  const building = type !== undefined && isNonCombatBuilding(type);

  // A type that is set but not one of the four: ask only for what every type needs
  // (the type error comes first; listing soldier stats would send a wall-maker the wrong way).
  const required = type ?? (has('type') ? 'wall' : 'soldier');
  for (const field of REQUIRED[required]) {
    if (raw[field] === undefined) {
      errors.push({
        code: 'STAT_MISSING',
        field,
        message: `The unit does not set ${field}.`,
        fix: missingFix(type, field, bounds),
      });
    }
  }

  // name: string, 1-24 chars after trim, no control chars.
  let name: string | undefined;
  if (has('name')) {
    const v = raw.name;
    const { min, max } = bounds.nameLength;
    if (typeof v !== 'string') {
      errors.push(wrongType('name', v, 'string', `In the constructor set this.name to text, e.g. this.name = "Swift Ninja".`));
    } else {
      const trimmed = v.trim();
      // Count code points, not UTF-16 units, so an emoji is one character.
      const length = [...trimmed].length;
      if (length < min || length > max || CONTROL_CHARS_RE.test(trimmed)) {
        errors.push({
          code: 'BAD_NAME',
          field: 'name',
          value: v,
          allowed: { minLength: min, maxLength: max, controlChars: false },
          message: `name must be ${min}-${max} characters (after trimming spaces) with no control characters; it is ${length} characters.`,
          fix: `In the constructor set this.name to a short name of ${min}-${max} characters, e.g. this.name = "Swift Ninja".`,
        });
      } else {
        name = trimmed;
      }
    }
  }

  const hpRange = type === 'wall' ? bounds.wallHealth : type === 'factory' ? bounds.factoryHealth : bounds.maxHealth;
  // The example is the type's starter template value (Basic Wall 3200, Basic Factory 360).
  const hpExample = type === 'wall' ? 3200 : type === 'factory' ? 360 : undefined;
  const maxHealth = has('maxHealth')
    ? checkNumber(errors, 'maxHealth', raw.maxHealth, hpRange, hpExample !== undefined && hpExample >= hpRange.min && hpExample <= hpRange.max ? { example: hpExample } : {})
    : undefined;

  let damage: number | undefined;
  let range: number | undefined;
  let attackCooldown: number | undefined;
  let speed: number | undefined;
  let productionInterval: number | undefined;
  let produces: MinionKind | undefined;
  let burst: number | undefined;
  // M8.8: walls and factories get 'normal', 0 and null.
  let element: Element | undefined = 'normal';
  let splashRadius: number | undefined = 0;
  let support: SupportSpec | null | undefined = null;
  let minionElement: Element | undefined;

  if (building) {
    const t = type!;
    // damage: absent or 0.
    if (has('damage')) {
      const v = raw.damage;
      if (typeof v === 'number' && v === 0) {
        // fine: nothing to attack with
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        errors.push({
          code: 'BUILDING_CANNOT_ATTACK',
          field: 'damage',
          value: v,
          allowed: { equals: 0 },
          message: `A ${t} can't attack, so damage must be left out (or 0), but it is ${v}.`,
          fix: `Walls and factories can't attack. Remove this.damage. Want something that shoots? Make a tower.`,
        });
      } else {
        checkNumber(errors, 'damage', v, { min: 0, max: 0 }, { fix: `Remove this.damage: a ${t} can't attack.` });
      }
    }
    // speed: absent or 0.
    if (has('speed')) {
      const v = raw.speed;
      if (typeof v === 'number' && v === 0) {
        // fine: buildings never move
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        errors.push({
          code: 'BUILDING_CANNOT_MOVE',
          field: 'speed',
          value: v,
          allowed: { equals: 0 },
          message: `A ${t} never moves, so speed must be left out (or 0), but it is ${v}.`,
          fix: `Remove this.speed: a ${t} is a building and never moves. Want something that walks? Make a soldier.`,
        });
      } else {
        checkNumber(errors, 'speed', v, { min: 0, max: 0 }, { fix: `Remove this.speed: a ${t} never moves.` });
      }
    }
    for (const f of ['range', 'attackCooldown', 'size'] as const) {
      if (has(f)) warnings.push(ignored(f, t, raw[f]));
    }
    if (t === 'factory') {
      productionInterval = has('productionInterval')
        ? checkNumber(errors, 'productionInterval', raw.productionInterval, bounds.productionInterval, {
            integer: true,
            integerCode: 'INTERVAL_NOT_INTEGER',
            fix: `In the constructor set this.productionInterval to a whole number of ticks from ${bounds.productionInterval.min} to ${bounds.productionInterval.max}, e.g. this.productionInterval = 900 (one minion every 15 s).`,
          })
        : undefined;
      produces = has('produces') ? checkProduces(errors, raw.produces) : DEFAULT_MINION_KIND;
      // M8.8: the minions' element; a medic factory's is ignored (medics never attack).
      if (has('minionElement')) {
        if (produces === 'medic') {
          warnings.push(ignoredWith('minionElement', t, raw.minionElement, "medics never attack, so their element does nothing and isn't priced"));
          minionElement = 'normal';
        } else {
          minionElement = checkElement(errors, 'minionElement', raw.minionElement);
        }
      } else {
        minionElement = 'normal';
      }
      burst = has('burst')
        ? checkNumber(errors, 'burst', raw.burst, bounds.burst, {
            integer: true,
            integerCode: 'BURST_NOT_INTEGER',
            fix: `In the constructor set this.burst to a whole number from ${bounds.burst.min} to ${bounds.burst.max}, e.g. this.burst = 3 (1 = send each minion out as soon as it is made), or leave it out.`,
          })
        : DEFAULT_BURST;
    } else {
      for (const f of ['productionInterval', 'produces', 'burst'] as const) {
        if (has(f)) warnings.push(ignored(f, t, raw[f]));
      }
      if (has('minionElement')) warnings.push(ignoredWith('minionElement', t, raw.minionElement, 'only factories build minions'));
    }
    // M8.8: walls and factories don't attack or support.
    if (has('element')) {
      warnings.push(
        ignoredWith('element', t, raw.element, t === 'factory' ? "a factory can't attack: use this.minionElement to give its minions an element" : "a wall can't attack"),
      );
    }
    if (has('splashRadius')) warnings.push(ignoredWith('splashRadius', t, raw.splashRadius, `a ${t} can't attack`));
    for (const f of SUPPORT_FIELDS) {
      if (has(f)) {
        warnings.push(ignoredWith(f, t, raw[f], t === 'factory' ? "a factory can't support: set this.produces = 'medic' to build healing minions" : "a wall can't support anyone"));
      }
    }
    damage = 0;
    range = 0;
    speed = 0;
    attackCooldown = 0;
  } else {
    damage = has('damage') ? checkNumber(errors, 'damage', raw.damage, bounds.damage) : undefined;
    // Redesign: towers out-range soldiers (soldiers within soldierRange, towers within range).
    const rangeBounds = type === 'soldier' ? bounds.soldierRange : bounds.range;
    range = has('range')
      ? checkNumber(errors, 'range', raw.range, rangeBounds, type === 'soldier' && bounds.soldierRange.max < bounds.range.max && typeof raw.range === 'number' && raw.range > rangeBounds.max
          ? { fix: `In the constructor set this.range to a number from ${rangeBounds.min} to ${rangeBounds.max} (px, edge to edge): soldiers reach at most ${rangeBounds.max} px. Want to shoot further (up to ${bounds.range.max} px)? Make it a tower.` }
          : {})
      : undefined;
    attackCooldown = has('attackCooldown')
      ? checkNumber(errors, 'attackCooldown', raw.attackCooldown, bounds.attackCooldown, { integer: true })
      : undefined;

    // speed: towers exactly 0, soldiers within soldierSpeed.
    if (has('speed')) {
      const v = raw.speed;
      if (type === 'tower' && typeof v === 'number' && Number.isFinite(v) && v !== 0) {
        errors.push({
          code: 'TOWER_CANNOT_MOVE',
          field: 'speed',
          value: v,
          allowed: { equals: 0 },
          message: `This unit is a tower, so speed must be 0, but it is ${v}.`,
          fix: `In the constructor set this.speed = 0 for a tower, or change this.type to "soldier" if it should move.`,
        });
      } else if (type === 'tower') {
        speed = checkNumber(errors, 'speed', v, { min: 0, max: 0 }, { fix: 'Towers never move: set this.speed = 0.' });
      } else {
        // Unknown or soldier type: check against soldier bounds.
        speed = checkNumber(errors, 'speed', v, bounds.soldierSpeed);
      }
    }
    if (type !== undefined) {
      for (const f of ['productionInterval', 'produces', 'burst'] as const) {
        if (has(f)) warnings.push(ignored(f, type, raw[f]));
      }
      if (has('minionElement')) warnings.push(ignoredWith('minionElement', type, raw.minionElement, 'only factories build minions; use this.element for this unit'));
    }
    // M8.8: element, splash and support.
    element = has('element') ? checkElement(errors, 'element', raw.element) : 'normal';
    splashRadius = has('splashRadius')
      ? checkNumber(errors, 'splashRadius', raw.splashRadius, bounds.splashRadius, {
          fix: `In the constructor set this.splashRadius to a number from ${bounds.splashRadius.min} to ${bounds.splashRadius.max} (px around the target), e.g. this.splashRadius = 40, or leave it out to hit one target.`,
        })
      : 0;
    support = null;
    if (has('support')) {
      const kind = checkSupportKind(errors, raw.support);
      if (kind) {
        const b = bounds.support[kind];
        const eg = SUPPORT_EXAMPLE[kind];
        const unit = kind === 'heal' ? 'HP per heal' : '%';
        let power: number | undefined;
        let range: number | undefined;
        for (const f of ['supportPower', 'supportRange'] as const) {
          if (has(f)) continue;
          errors.push({
            code: 'STAT_MISSING',
            field: f,
            message: `This unit has support '${kind}' but does not set ${f}.`,
            fix: `this.supportPower = ${eg.power}; this.supportRange = ${eg.range}; // ${eg.says}`,
          });
        }
        if (has('supportPower')) {
          power = checkNumber(errors, 'supportPower', raw.supportPower, b.power, {
            fix: `In the constructor set this.supportPower to a number from ${b.power.min} to ${b.power.max} (${unit}) for support '${kind}', e.g. this.supportPower = ${eg.power}.`,
          });
        }
        if (has('supportRange')) {
          range = checkNumber(errors, 'supportRange', raw.supportRange, b.range, {
            fix: `In the constructor set this.supportRange to a number from ${b.range.min} to ${b.range.max} (px, edge to edge) for support '${kind}', e.g. this.supportRange = ${eg.range}.`,
          });
        }
        if (power !== undefined && range !== undefined) support = { kind, power, range };
        else support = undefined;
      } else {
        support = undefined;
      }
    } else {
      for (const f of ['supportPower', 'supportRange'] as const) {
        if (has(f)) warnings.push(ignoredWith(f, type ?? 'soldier', raw[f], `it only counts with this.support = ${SUPPORT_LIST.replace(/, ([^,]*)$/, ' or $1')}`));
      }
    }
  }

  // color: "#RRGGBB".
  let color: string | undefined;
  if (has('color')) {
    const v = raw.color;
    if (typeof v !== 'string') {
      errors.push(wrongType('color', v, 'string', `In the constructor set this.color to a hex colour string, e.g. this.color = "#33CC66".`));
    } else if (!COLOR_RE.test(v)) {
      errors.push({
        code: 'BAD_COLOR',
        field: 'color',
        value: v,
        allowed: { pattern: '#RRGGBB' },
        message: `color is "${v}" but must look like "#RRGGBB" (a # and 6 hex digits).`,
        fix: `In the constructor set this.color to a hex colour like this.color = "#33CC66" (no colour names, no 3-digit codes).`,
      });
    } else {
      color = v;
    }
  }

  // size: optional body radius; the type default applies when it is omitted (buildings: fixed).
  const size = !building && has('size') ? checkNumber(errors, 'size', raw.size, bounds.size) : undefined;

  // shape: optional.
  let shape: Shape | undefined;
  if (has('shape')) {
    const v = raw.shape;
    if (typeof v !== 'string') {
      errors.push(wrongType('shape', v, 'string', `Remove this.shape or set it to one of: ${SHAPES.join(', ')}.`));
    } else if (!(SHAPES as readonly string[]).includes(v)) {
      errors.push({
        code: 'STAT_OUT_OF_RANGE',
        field: 'shape',
        value: v,
        allowed: { oneOf: [...SHAPES] },
        message: `shape is "${v}" but must be one of ${SHAPES.join(', ')}.`,
        fix: `Set this.shape to one of: ${SHAPES.map((s) => `"${s}"`).join(', ')} (or remove it).`,
      });
    } else {
      shape = v as Shape;
    }
  }

  if (
    errors.length > 0 ||
    name === undefined ||
    type === undefined ||
    maxHealth === undefined ||
    damage === undefined ||
    range === undefined ||
    speed === undefined ||
    attackCooldown === undefined ||
    color === undefined ||
    element === undefined ||
    splashRadius === undefined ||
    support === undefined ||
    (type === 'factory' && (productionInterval === undefined || produces === undefined || burst === undefined || minionElement === undefined))
  ) {
    return { ok: false, errors, warnings };
  }

  const stats: StatsSnapshot = Object.freeze({
    name,
    type,
    maxHealth,
    damage,
    range,
    speed,
    attackCooldown,
    ...(type === 'factory' ? { productionInterval: productionInterval!, produces: produces!, minionElement: minionElement!, burst: burst! } : {}),
    element,
    splashRadius,
    support,
    color,
    size: building ? DEFAULT_SIZE[type] : (size ?? DEFAULT_SIZE[type]),
    shape: shape ?? DEFAULT_SHAPE[type],
  });
  return { ok: true, stats, warnings };
}
