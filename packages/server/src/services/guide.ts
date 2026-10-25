// GET /guide (§10.3): the unit guide, the full rulebook for units shown by
// /play's "📖 Unit guide" overlay and the standalone /guide page (§12.1).
//
// Everything is built from the LIVE config (bounds, coefficients, elements,
// support, factory, caps, timers, scoring) and the §5 contract, so an admin
// retune changes the guide's numbers at once. Example prices come from
// `computeCost` under that config. The field / action / view tables are
// `Record`s over the contract's own types, so a new contract field fails the
// typecheck until it is explained here (and tests/guide.test.ts parses the
// contract text for the same reason).
//
// Written for players aged 9-13 (and their Claude): short sentences, the exact
// field names in `code`, and "For Claude / code" boxes with snippets.

import { createHash } from 'node:crypto';
import {
  BADGES,
  DEFAULT_SIZE,
  ELEMENTS,
  FACTORY_RADIUS,
  MINION_KINDS,
  MINION_KIND_NAMES,
  MINION_ORDERS,
  SUPPORT_KINDS,
  UNIT_TYPES,
  WALL_HALF,
  computeCost,
  cooldownFactor,
  expectedMinions,
  fmt,
  minionPrice,
  money,
  placePointsTable,
  powerFactor,
  pricingOf,
  productionEndTick,
  scaledBonusMax,
  splashFactor,
  type Action,
  type CostStats,
  type Element,
  type FactoryView,
  type GameConfig,
  type GuideBlockDTO,
  type GuideCardDTO,
  type GuideDTO,
  type GuideExampleDTO,
  type GuideSectionDTO,
  type MinionKind,
  type MinionOrder,
  type NumRange,
  type OtherView,
  type SelfView,
  type StatField,
  type StatusView,
  type SupportKind,
  type SupportView,
  type UnitType,
  type WorldView,
} from '@pixel-clash/shared';
import { PRICE_PARAGRAPH, buildRules, contractTypescript } from './rules.js';

/** A starter template as the guide prices it: its name and frozen stats. */
export interface GuideTemplate {
  key: string;
  name: string;
  stats: CostStats;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

/** 2500 → "2,500"; 1.5 → "1.5". */
function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  const [whole, cents] = String(Math.abs(r)).split('.');
  return `${r < 0 ? '-' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? `.${cents}` : ''}`;
}
function span(r: NumRange, unit = ''): string {
  return `${num(r.min)}-${num(r.max)}${unit}`;
}
function x(n: number): string {
  return `×${fmt(n)}`;
}
function secs(ticks: number, config: GameConfig): string {
  return `${fmt(ticks / config.timers.ticksPerSecond)} s`;
}
function quoted(list: readonly string[]): string {
  return list.map((v) => `\`'${v}'\``).join(', ');
}
function clampTo(v: number, r: NumRange): number {
  return Math.min(r.max, Math.max(r.min, v));
}

// ---------------------------------------------------------------------------
// Stats (§5 bounds table, §5.2, §5.6): one entry per contract field
// ---------------------------------------------------------------------------

interface FieldDoc {
  /** What it does, in player words. */
  what: string;
  /** The allowed values for a type, or null when that type leaves it out. */
  allowed: (config: GameConfig, type: UnitType) => string | null;
  /** How it changes the price for a type. */
  cost: (config: GameConfig, type: UnitType) => string;
}

const fighter = (type: UnitType) => type === 'soldier' || type === 'tower';

const FIELDS: Record<StatField, FieldDoc> = {
  name: {
    what: 'The name shown on screen.',
    allowed: (c) => `${span(c.stats.bounds.nameLength)} characters`,
    cost: () => 'free',
  },
  type: {
    what: 'What kind of unit it is. Soldiers move; towers, walls and factories are buildings and never move.',
    allowed: (_c, t) => `\`'${t}'\``,
    cost: () => 'picks the price formula',
  },
  maxHealth: {
    what: 'Hit points (HP). At 0 the unit is destroyed.',
    allowed: (c, t) => {
      const b = c.stats.bounds;
      return span(t === 'wall' ? b.wallHealth : t === 'factory' ? b.factoryHealth : b.maxHealth);
    },
    cost: (c, t) => {
      const per = t === 'wall' ? c.cost.wall.hp : t === 'factory' ? c.cost.factory.hp : c.cost.hp;
      return `${money(per)} per HP, up to ${x(1 + c.cost.curveK)} near the max${fighter(t) && c.cost.powerFactor > 0 ? '; lots of HP AND damage costs extra (power)' : ''}`;
    },
  },
  damage: {
    what: 'Damage of one hit. 0 is allowed for a pure helper (it can still heal or freeze).',
    allowed: (c, t) => (fighter(t) ? `${span(c.stats.bounds.damage)} (required)` : null),
    cost: (c) => `${money(c.cost.damage)} per point, up to ${x(1 + c.cost.curveK)} near the max`,
  },
  range: {
    what: 'How far it can hit, EDGE to edge: the gap between the two bodies. Above 50 px it fires homing shots that fly over walls.',
    allowed: (c, t) => (t === 'soldier' ? `${span(c.stats.bounds.soldierRange, ' px')} (required; towers reach further)` : fighter(t) ? `${span(c.stats.bounds.range, ' px')} (required)` : null),
    cost: (c) => `${money(c.cost.range)} per px, up to ${x(1 + c.cost.curveK)} near the max`,
  },
  speed: {
    what: 'Pixels it can walk per tick (60 ticks = 1 second).',
    allowed: (c, t) => (t === 'soldier' ? `${span(c.stats.bounds.soldierSpeed, ' px/tick')} (required)` : t === 'tower' ? '0 (or leave it out)' : null),
    cost: (c, t) => (t === 'soldier' ? `${money(c.cost.speed)} per 1 px/tick, up to ${x(1 + c.cost.curveK)} near the max` : 'free (0)'),
  },
  attackCooldown: {
    what: 'Whole ticks between two attacks (and heals). 60 = once a second.',
    allowed: (c, t) => (fighter(t) ? `whole number ${span(c.stats.bounds.attackCooldown)} ticks (required)` : null),
    cost: (c) =>
      `free at ${c.cost.referenceCooldown}; faster multiplies the WHOLE price (${Math.round(c.cost.referenceCooldown / 2)} = ${x(cooldownFactor(Math.round(c.cost.referenceCooldown / 2), c.cost))}); slower gives no discount`,
  },
  productionInterval: {
    what: 'Whole ticks between two minions. Faster means more minions in one battle.',
    allowed: (c, t) => (t === 'factory' ? `whole number ${span(c.stats.bounds.productionInterval)} ticks (${secs(c.stats.bounds.productionInterval.min, c)} to ${secs(c.stats.bounds.productionInterval.max, c)}) (required)` : null),
    cost: () => 'the factory pays up front for every minion it can make in one battle: faster = pricier',
  },
  produces: {
    what: 'Which minion the factory builds (see Factories).',
    allowed: (_c, t) => (t === 'factory' ? `${quoted(MINION_KINDS)} (default \`'grunt'\`)` : null),
    cost: () => 'each minion kind has its own price',
  },
  minionElement: {
    what: 'The element of every minion it builds. Medics ignore it (they never attack).',
    allowed: (_c, t) => (t === 'factory' ? `${quoted(ELEMENTS)} (default \`'normal'\`)` : null),
    cost: (c) => `${x(c.cost.element.fire)} on each minion's price (not medics)`,
  },
  burst: {
    what: 'Minions wait INSIDE the factory until this many are ready, then leave together.',
    allowed: (c, t) => (t === 'factory' ? `whole number ${span(c.stats.bounds.burst)} (default 1)` : null),
    cost: () => 'free',
  },
  element: {
    what: 'Fire burns, ice freezes, lightning zaps (see Elements).',
    allowed: (_c, t) => (fighter(t) ? `${quoted(ELEMENTS)} (default \`'normal'\`)` : null),
    cost: (c) => (c.cost.element.fire === c.cost.element.ice && c.cost.element.ice === c.cost.element.lightning ? `${x(c.cost.element.fire)} on the whole price (normal ×1)` : `fire ${x(c.cost.element.fire)}, ice ${x(c.cost.element.ice)}, lightning ${x(c.cost.element.lightning)} on the whole price`),
  },
  splashRadius: {
    what: 'Other enemies this close to the target take part of the hit too (see Elements).',
    allowed: (c, t) => (fighter(t) ? `${span(c.stats.bounds.splashRadius, ' px')} (default 0 = one target)` : null),
    cost: (c) => {
      const max = c.stats.bounds.splashRadius.max;
      const mid = Math.round(max / 2);
      return `${x(splashFactor(mid, c.cost))} on the whole price at ${mid} px, ${x(splashFactor(max, c.cost))} at ${max} px`;
    },
  },
  support: {
    what: "One helper power: `'heal'` is an action you return; `'haste'`, `'might'` and `'shield'` are auras that work by themselves.",
    allowed: (_c, t) => (fighter(t) ? `${quoted(SUPPORT_KINDS)} (optional)` : null),
    cost: () => 'heal: priced inside the cooldown factor; auras: added at the very end',
  },
  supportPower: {
    what: 'How strong the support is: HP per heal, or the aura\'s %.',
    allowed: (c, t) => {
      if (!fighter(t)) return null;
      const s = c.stats.bounds.support;
      return `with support: heal ${span(s.heal.power, ' HP')}, haste ${span(s.haste.power, '%')}, might ${span(s.might.power, '%')}, shield ${span(s.shield.power, '%')}`;
    },
    cost: (c) => `heal ${money(c.cost.heal)} per HP, haste ${money(c.cost.aura.haste)}, might ${money(c.cost.aura.might)}, shield ${money(c.cost.aura.shield)} per %; more near the max`,
  },
  supportRange: {
    what: 'How far the heal reaches, or how big the aura is, EDGE to edge.',
    allowed: (c, t) => {
      if (!fighter(t)) return null;
      const s = c.stats.bounds.support;
      return `with support: heal ${span(s.heal.range, ' px')}, auras ${span(s.haste.range, ' px')}`;
    },
    cost: () => 'the support price ×0.5 at the shortest reach up to ×1.5 at the longest',
  },
  color: {
    what: "Colour of shots and particles (and a wall's block, a factory's minions).",
    allowed: () => '`"#RRGGBB"`',
    cost: () => 'free',
  },
  size: {
    what: 'Body radius in px: the hitbox AND the drawn size. Range is edge to edge, so a bigger body also reaches further.',
    allowed: (c, t) =>
      fighter(t) ? `${span(c.stats.bounds.size, ' px')} (default ${DEFAULT_SIZE[t]})` : null,
    cost: (c) => `${money(c.cost.size)} per px above 6`,
  },
  shape: {
    what: 'Only for the plain look you get when there is no `sprite()`.',
    allowed: () => "`'circle'`, `'square'`, `'triangle'` or `'diamond'` (optional)",
    cost: () => 'free',
  },
};

const TYPE_INFO: Record<UnitType, { icon: string; title: string; text: string; snippet: (c: GameConfig) => string }> = {
  soldier: {
    icon: '🗡️',
    title: 'Soldier',
    text: 'Walks and fights. Your `update()` picks where to go and whom to hit every tick.',
    snippet: () =>
      [
        "this.name = 'Knight';",
        "this.type = 'soldier';",
        'this.maxHealth = 600;',
        'this.damage = 50;',
        'this.range = 40;',
        'this.speed = 1.5;',
        'this.attackCooldown = 60;',
        "this.color = '#3399FF';",
      ].join('\n'),
  },
  tower: {
    icon: '🏹',
    title: 'Tower',
    text: 'A building that stays put and shoots. Its `update()` picks a target.',
    snippet: () =>
      ["this.name = 'Archer Tower';", "this.type = 'tower';", 'this.maxHealth = 625;', 'this.damage = 75;', 'this.range = 140;', 'this.speed = 0;', 'this.attackCooldown = 45;', "this.color = '#FF9933';"].join(
        '\n',
      ),
  },
  wall: {
    icon: '🧱',
    title: 'Wall',
    text: `A solid ${WALL_HALF * 2}×${WALL_HALF * 2} px block that stops EVERYONE (your units too). No \`update()\`, never attacks. Enemies can break it.`,
    snippet: () => ["this.name = 'Stone Wall';", "this.type = 'wall';", 'this.maxHealth = 2000;', "this.color = '#8A8F98';"].join('\n'),
  },
  factory: {
    icon: '🏭',
    title: 'Factory',
    text: `A building (radius ${FACTORY_RADIUS} px) that builds minions. Its \`update()\` gives them orders.`,
    snippet: () =>
      [
        "this.name = 'Brute Barracks';",
        "this.type = 'factory';",
        'this.maxHealth = 1500;',
        'this.productionInterval = 900;',
        "this.produces = 'brute';",
        "this.minionElement = 'fire';",
        'this.burst = 2;',
        "this.color = '#C0A060';",
      ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// What update() sees (§5 SelfView / OtherView / WorldView / StatusView / FactoryView)
// ---------------------------------------------------------------------------

const SELF_FIELDS: Record<keyof SelfView, string> = {
  id: 'this copy\'s id, e.g. "2-0-3"',
  unitId: 'the design this copy was made from',
  ownerId: 'the player who owns it',
  teamId: 'its team: same teamId = friend',
  type: "`'soldier'`, `'tower'` or `'factory'` (walls have no update)",
  name: 'its name',
  x: 'position (px)',
  y: 'position (px)',
  radius: 'body radius (px)',
  hp: 'hit points now',
  maxHp: 'hit points when full',
  damage: 'BASE damage (might changes it in battle, see `status`)',
  range: 'range, edge to edge',
  speed: 'BASE speed (haste and freeze change it in battle)',
  attackCooldown: 'ticks between attacks',
  cooldownRemaining: '0 = can attack (or heal) this tick',
  element: 'its element',
  splashRadius: 'its splash radius (0 = none)',
  support: 'its support `{ kind, power, range }` or null',
  status: 'burns, freezes and buffs on it now (see Status)',
  blockedBy: 'id of the wall that stopped its last move, else null',
  blockedTicks: 'ticks in a row a wall has stopped it',
  pathing: "`'direct'` (straight there), `'detour'` (going round walls) or `'no-route'` (walled off: it walks to the best wall to break and waits there)",
  factory: 'factories only: the factory details (see Factory view), else null',
};

const OTHER_FIELDS: Record<keyof OtherView, string> = {
  id: 'use it as `targetId`',
  ownerId: 'the player who owns it',
  teamId: 'same as yours = ally, different = enemy',
  type: "`'soldier'`, `'tower'`, `'wall'`, `'factory'` or `'minion'`",
  name: "its name (a minion's name is its kind: 'Grunt', 'Archer', …)",
  x: 'position (px)',
  y: 'position (px)',
  radius: 'body radius (a wall counts as 20)',
  hp: 'hit points now',
  maxHp: 'hit points when full',
  range: 'its range (walls and factories 0)',
  element: 'its element (walls and factories `normal`)',
  splashRadius: 'its splash radius (0 = none)',
  support: 'its support `{ kind, power, range }` or null',
  status: 'its burns, freezes and buffs',
  moving: 'it moved last tick: ranged shots at a moving body can miss',
  currentSpeed: 'px it moved last tick (0 = standing still); the faster, the more ranged shots miss',
  ownerName: "its player's name (a minion: its factory's player), only when the match setting 'Show enemy names to units' is on",
  teamName: "team mode: its team's name, e.g. 'Team 2', only when the match setting 'Show enemy names to units' is on",
};

const STATUS_FIELDS: Record<keyof StatusView, (c: GameConfig) => string> = {
  burning: (c) => `ticks until its burn ends (max ${c.elements.fire.pulses * c.elements.fire.pulseTicks})`,
  burnLeft: () => 'HP the burn will still take',
  frozen: (c) => `ticks until the freeze ends (max ${c.elements.ice.ticks}): moves, reloads and builds ${c.elements.ice.slowPct}% slower`,
  haste: () => '% from the strongest haste aura on it',
  might: () => '% from the strongest might aura on it',
  shield: () => '% from the strongest shield aura on it',
  healRoom: () => 'HP it can still be healed this second (0 = full, a wall or factory, the heal cap is used up, or sudden death)',
};

const SUPPORT_VIEW_FIELDS: Record<keyof SupportView, string> = {
  kind: "`'heal'`, `'haste'`, `'might'` or `'shield'`",
  power: 'HP per heal, or the aura %',
  range: 'reach or aura size, edge to edge',
};

const FACTORY_FIELDS: Record<keyof FactoryView, string> = {
  productionInterval: 'ticks between two minions',
  nextMinionIn: 'ticks until the next minion (it waits while you hold, or while the factory is full)',
  producing: "true, unless the host turned on 'Factories stop at sudden death': then false once no new minion can appear before sudden death (stored ones still leave)",
  minionsLeft: 'minions it can still make this battle (0 once producing is false)',
  minionsAlive: 'its minions out on the field',
  maxAlive: 'cap on minionsAlive + stored',
  stored: 'minions waiting inside (safe, but LOST if the factory is destroyed)',
  burst: 'stored minions leave together when stored reaches burst',
  produces: 'the minion kind it builds',
  minionElement: "its minions' element",
  order: "the squad order now: `'attack'`, `'defend'`, `'swarm'` or `'guard'`",
  orderTargetId: 'swarm: the enemy, guard: the ally, else null',
  rally: "where `'attack'` minions go (starts at `world.center`)",
};

const WORLD_FIELDS: Record<keyof WorldView, (c: GameConfig) => string> = {
  width: () => 'arena width: 800 (2-4 players), 1040 (5-6) or 1200 (7-8). Never assume 800!',
  height: () => 'arena height',
  tick: (c) => `the tick now (${c.timers.ticksPerSecond} ticks = 1 s)`,
  ticksLeft: () => 'ticks until the battle ends',
  mapStyle: () => "`'duel'`, `'triangle'`, `'corners'`, `'ring'`, `'lanes'` or `'islands'`",
  myCorner: () => 'centre of your start zone this round',
  center: () => 'centre of the arena',
  safeZone: (c) => `the safe circle \`{ x, y, radius }\`: it shrinks from ${secs(c.suddenDeath.startTick, c)} (sudden death)`,
  players: () => "every player in this battle, you too: `{ id, name, teamId, teamName }` (`id` = a body's `ownerId`; `teamName` in team mode), only when the match setting 'Show enemy names to units' is on",
};

// ---------------------------------------------------------------------------
// Actions (§5 Action union)
// ---------------------------------------------------------------------------

type ActionName = Action['action'];

const ACTIONS: Record<ActionName, { who: string; what: string; example: string }> = {
  idle: { who: 'everyone', what: 'Do nothing this tick.', example: "{ action: 'idle' }" },
  move: { who: 'soldiers', what: 'Walk toward a point (at most `speed` px per tick). It walks round walls by itself.', example: "{ action: 'move', destination: { x: 400, y: 400 } }" },
  attack: {
    who: 'soldiers, towers',
    what: 'Hit a living enemy that is in range, when `cooldownRemaining` is 0.',
    example: "{ action: 'attack', targetId: enemy.id }",
  },
  heal: {
    who: "support `'heal'` only",
    what: 'Heal a hurt, burning or frozen ally in `supportRange`. Uses the attack cooldown.',
    example: "{ action: 'heal', targetId: ally.id }",
  },
  rally: { who: 'factories', what: "Order `'attack'` and send the minions to this point.", example: "{ action: 'rally', destination: enemy }" },
  command: {
    who: 'factories',
    what: "Give all its minions one order: `'attack'`, `'defend'`, `'swarm'` (needs an enemy `targetId`) or `'guard'` (needs an ally `targetId`).",
    example: "{ action: 'command', order: 'swarm', targetId: enemy.id }",
  },
  release: { who: 'factories', what: 'Send the stored minions out now.', example: "{ action: 'release' }" },
  hold: { who: 'factories', what: "Don't build this tick (stored minions stay inside).", example: "{ action: 'hold' }" },
};

// ---------------------------------------------------------------------------
// Elements, support, minions
// ---------------------------------------------------------------------------

function elementRows(c: GameConfig): string[][] {
  const e = c.elements;
  const f = c.cost.element;
  const burnS = fmt((e.fire.pulses * e.fire.pulseTicks) / c.timers.ticksPerSecond);
  const rows: Record<Element, [string, string, string]> = {
    normal: ['⚪', 'Just the hit.', '×1'],
    fire: ['🔥', `Adds ${e.fire.burnPct}% of the hit again as a burn over ${burnS} s.`, x(f.fire)],
    ice: ['❄️', `Freezes the target for ${secs(e.ice.ticks, c)}: it moves, reloads and builds ${e.ice.slowPct}% slower. Works even at damage 0.`, x(f.ice)],
    lightning: [
      '⚡',
      `${e.lightning.chancePct}% of hits also zap the nearest other enemy within ${e.lightning.hopRange} px for the same damage.`,
      x(f.lightning),
    ],
  };
  return ELEMENTS.map((el) => [`${rows[el][0]} \`'${el}'\``, rows[el][1], rows[el][2]]);
}

function supportRows(c: GameConfig): string[][] {
  const b = c.stats.bounds.support;
  const text: Record<SupportKind, string> = {
    heal: "An action: return `{ action: 'heal', targetId }` to heal one ally. Burning or frozen allies get cleansed instead.",
    haste: 'Aura: allies nearby move AND reload faster by power %.',
    might: 'Aura: allies nearby hit harder by power %.',
    shield: 'Aura: allies nearby take power % less damage (not from sudden death).',
  };
  const price: Record<SupportKind, string> = {
    heal: `${money(c.cost.heal)} per HP per heal, inside the cooldown factor`,
    haste: `${money(c.cost.aura.haste)} per %, added at the end`,
    might: `${money(c.cost.aura.might)} per %, added at the end`,
    shield: `${money(c.cost.aura.shield)} per %, added at the end`,
  };
  const icon: Record<SupportKind, string> = { heal: '💚', haste: '💨', might: '💪', shield: '🛡️' };
  return SUPPORT_KINDS.map((k) => [
    `${icon[k]} \`'${k}'\``,
    text[k],
    `${span(b[k].power, k === 'heal' ? ' HP' : '%')}`,
    `${span(b[k].range, ' px')}`,
    price[k],
  ]);
}

const MINION_ROLE: Record<MinionKind, string> = {
  grunt: 'the default and cheapest kind, melee',
  archer: 'shoots from far (over walls), fragile',
  runner: 'very fast and small',
  brute: 'slow and tough; hits walls extra hard',
  medic: 'never attacks: heals its side, cleanses burns and freezes first',
};

const ORDER_TEXT: Record<MinionOrder, (c: GameConfig) => string> = {
  attack: (c) => `(the default) hunt the nearest enemy near them or within ${c.factory.rallyGuardRadius} px of the rally point, else wait at the rally point`,
  defend: (c) => `stay home: fight enemies within ${c.factory.defendRadius} px of the factory`,
  swarm: () => "every minion goes for ONE enemy (`targetId`), walls too. When it dies the order becomes `'attack'`",
  guard: (c) => `stay next to one ally (\`targetId\`, or the factory's own id) and fight enemies within ${c.factory.guardRadius} px of it. When it dies the order becomes \`'defend'\``,
};

// ---------------------------------------------------------------------------
// Examples (live prices)
// ---------------------------------------------------------------------------

interface ArchetypeSpec {
  id: string;
  name: string;
  note: string;
  stats: (c: GameConfig) => CostStats;
}

/** A soldier/tower with every stat clamped into the live bounds. */
function unitStats(c: GameConfig, s: CostStats): CostStats {
  const b = c.stats.bounds;
  const out: CostStats = {
    ...s,
    maxHealth: clampTo(s.maxHealth, b.maxHealth),
    damage: clampTo(s.damage, b.damage),
    range: clampTo(s.range, s.type === 'soldier' ? b.soldierRange : b.range),
    speed: s.type === 'tower' ? 0 : clampTo(s.speed, b.soldierSpeed),
    attackCooldown: clampTo(s.attackCooldown, b.attackCooldown),
    size: clampTo(s.size ?? DEFAULT_SIZE[s.type], b.size),
  };
  if (s.splashRadius !== undefined) out.splashRadius = clampTo(s.splashRadius, b.splashRadius);
  if (s.support) {
    const sb = b.support[s.support.kind];
    out.support = { kind: s.support.kind, power: clampTo(s.support.power, sb.power), range: clampTo(s.support.range, sb.range) };
  }
  return out;
}

function buildingStats(c: GameConfig, s: CostStats): CostStats {
  const b = c.stats.bounds;
  if (s.type === 'wall') return { ...s, maxHealth: clampTo(s.maxHealth, b.wallHealth) };
  return {
    ...s,
    maxHealth: clampTo(s.maxHealth, b.factoryHealth),
    productionInterval: clampTo(s.productionInterval ?? b.productionInterval.min, b.productionInterval),
  };
}

const ARCHETYPES: ArchetypeSpec[] = [
  {
    id: 'tank',
    name: 'Tank',
    note: 'lots of HP, little damage',
    stats: (c) => unitStats(c, { type: 'soldier', maxHealth: 2900, damage: 24, range: 20, speed: 1, attackCooldown: 60, size: 14 }),
  },
  {
    id: 'sniper',
    name: 'Sniper Tower',
    note: 'huge range and big hits, slow reload',
    stats: (c) => unitStats(c, { type: 'tower', maxHealth: 640, damage: 120, range: 280, speed: 0, attackCooldown: 90, size: 12 }),
  },
  {
    id: 'fire-splash',
    name: 'Fire Splash Tower',
    note: 'fire + splash',
    stats: (c) => unitStats(c, { type: 'tower', maxHealth: 1120, damage: 48, range: 150, speed: 0, attackCooldown: 60, size: 14, element: 'fire', splashRadius: 40 }),
  },
  {
    id: 'cleric',
    name: 'Battle Cleric',
    note: 'a soldier that heals (or hits) on each cooldown',
    stats: (c) =>
      unitStats(c, { type: 'soldier', maxHealth: 800, damage: 16, range: 30, speed: 1.5, attackCooldown: 60, size: 10, support: { kind: 'heal', power: 96, range: 120 } }),
  },
  {
    id: 'drummer',
    name: 'War Drummer',
    note: 'might aura: everyone near it hits harder',
    stats: (c) =>
      unitStats(c, { type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10, support: { kind: 'might', power: 30, range: 100 } }),
  },
  {
    id: 'brute-factory',
    name: 'Brute Barracks',
    note: 'a factory of fire brutes',
    stats: (c) =>
      buildingStats(c, { type: 'factory', maxHealth: 360, damage: 0, range: 0, speed: 0, attackCooldown: 0, productionInterval: 900, produces: 'brute', minionElement: 'fire' }),
  },
  {
    id: 'big-wall',
    name: 'Fortress Wall',
    note: 'a very tough wall',
    stats: (c) => buildingStats(c, { type: 'wall', maxHealth: 8000, damage: 0, range: 0, speed: 0, attackCooldown: 0 }),
  },
  {
    id: 'maxed',
    name: 'Maxed Monster',
    note: 'every stat at its max: way over the price cap!',
    stats: (c) => {
      const b = c.stats.bounds;
      return { type: 'soldier', maxHealth: b.maxHealth.max, damage: b.damage.max, range: b.soldierRange.max, speed: b.soldierSpeed.max, attackCooldown: clampTo(60, b.attackCooldown), size: b.size.max };
    },
  },
];

function priceOf(stats: CostStats, c: GameConfig): number {
  return computeCost(stats, c.cost, pricingOf(c)).cost;
}

function example(c: GameConfig, id: string, name: string, group: GuideExampleDTO['group'], note: string, stats: CostStats): GuideExampleDTO {
  const cost = priceOf(stats, c);
  return { id, name, group, note, stats, cost, overCap: cost > c.caps.unitCost };
}

/** "HP 600 · dmg 50 · range 40 · speed 1.5 · CD 60" plus the extras. */
function keyStats(s: CostStats): string {
  if (s.type === 'wall') return `HP ${num(s.maxHealth)}`;
  if (s.type === 'factory') {
    const parts = [`HP ${num(s.maxHealth)}`, `every ${num(s.productionInterval ?? 0)} ticks`, s.produces ?? 'grunt'];
    if (s.minionElement && s.minionElement !== 'normal') parts.push(s.minionElement);
    return parts.join(' · ');
  }
  const parts = [`HP ${num(s.maxHealth)}`, `dmg ${num(s.damage)}`, `range ${num(s.range)}`];
  if (s.type === 'soldier') parts.push(`speed ${num(s.speed)}`);
  parts.push(`CD ${num(s.attackCooldown)}`);
  if (s.element && s.element !== 'normal') parts.push(s.element);
  if (s.splashRadius) parts.push(`splash ${num(s.splashRadius)}`);
  if (s.support) parts.push(`${s.support.kind} ${num(s.support.power)}${s.support.kind === 'heal' ? '' : '%'}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function typesSection(c: GameConfig): GuideSectionDTO {
  const cards: GuideCardDTO[] = UNIT_TYPES.map((t) => ({
    icon: TYPE_INFO[t].icon,
    title: TYPE_INFO[t].title,
    text: TYPE_INFO[t].text,
    facts: [`\`type: '${t}'\``, t === 'soldier' ? 'a "unit"' : 'a "building"', t === 'wall' ? 'no update()' : 'update() required'],
  }));
  cards.push({
    icon: '👾',
    title: 'Minion',
    text: `Made by factories: ${MINION_KINDS.map((k) => MINION_KIND_NAMES[k]).join(', ')}. The game writes their code; you only give orders. They show up as \`type: 'minion'\`.`,
    facts: ['you never submit one'],
  });
  return {
    id: 'types',
    icon: '🧩',
    title: 'Unit types',
    summary: 'Four types you can build, plus the minions factories make.',
    blocks: [
      { kind: 'cards', cards },
      {
        kind: 'text',
        text: `Each round you can field up to **${c.caps.maxUnitTypes} unit types** (soldiers) and **${c.caps.maxBuildingTypes} building types** (towers, walls, factories).`,
      },
      {
        kind: 'code',
        title: 'For your AI helper / code: the shape of a unit',
        text: 'A unit is a JavaScript class. The constructor sets the stats on `this`; `update()` runs every tick and returns an action.',
        code: [
          'export default class MyUnit {',
          '  constructor() {',
          "    this.name = 'Knight';",
          "    this.type = 'soldier'; // 'soldier' | 'tower' | 'wall' | 'factory'",
          '    // … stats (see Stats)',
          '  }',
          '  update(self, enemies, allies, world) {',
          "    return { action: 'idle' };",
          '  }',
          '  sprite() { /* optional pixel art */ }',
          '}',
        ].join('\n'),
      },
    ],
  };
}

function statsSection(c: GameConfig): GuideSectionDTO {
  const blocks: GuideBlockDTO[] = [
    {
      kind: 'text',
      text: 'Set these on `this` in the constructor. Anything not listed for a type must be left out (or it is ignored with a warning). Stats are frozen when the unit is checked: changing them in `update()` does nothing.',
    },
  ];
  for (const t of UNIT_TYPES) {
    const rows: string[][] = [];
    for (const field of Object.keys(FIELDS) as StatField[]) {
      const doc = FIELDS[field];
      const allowed = doc.allowed(c, t);
      if (allowed === null) continue;
      rows.push([`\`${field}\``, allowed, doc.what, doc.cost(c, t)]);
    }
    blocks.push({ kind: 'table', caption: `${TYPE_INFO[t].icon} ${TYPE_INFO[t].title}`, head: ['Field', 'Allowed', 'What it does', 'Price'], rows });
    blocks.push({ kind: 'code', title: `For your AI helper / code: a ${t}`, code: TYPE_INFO[t].snippet(c) });
  }
  blocks.push({
    kind: 'list',
    items: [
      `Walls are always ${WALL_HALF * 2}×${WALL_HALF * 2} px and factories always radius ${FACTORY_RADIUS}: \`size\` is ignored for them.`,
      'Towers must have `speed` 0. Walls and factories leave out `damage`, `range`, `speed` and `attackCooldown`.',
      '`attackCooldown`, `productionInterval` and `burst` must be whole numbers.',
    ],
  });
  return { id: 'stats', icon: '📊', title: 'Stats', summary: 'Every field per type: what is allowed, what it does and what it costs.', blocks };
}

function elementsSection(c: GameConfig): GuideSectionDTO {
  const e = c.elements;
  const sb = c.stats.bounds.splashRadius;
  return {
    id: 'elements',
    icon: '🔥',
    title: 'Elements, splash & combos',
    summary: 'One element per unit, optional splash, and combos between elements.',
    blocks: [
      { kind: 'table', head: ['Element', 'What it does', 'Price'], rows: elementRows(c) },
      {
        kind: 'cards',
        cards: [
          { icon: '🔥', title: 'Kindle', text: `A BURNING enemy takes +${e.kindlePct}% from every hit that isn't fire.` },
          { icon: '🧊', title: 'Brittle', text: `A FROZEN enemy takes +${e.brittlePct}% from every hit that isn't ice or fire.` },
          { icon: '💥', title: 'Shatter', text: `Fire hits a FROZEN enemy: ${100 + e.shatterPct}% damage, and it thaws.` },
          { icon: '🌩️', title: 'Overload', text: `Lightning hits a BURNING enemy: the zap hops ${e.lightning.burningExtraHops} more time${e.lightning.burningExtraHops === 1 ? '' : 's'}.` },
          {
            icon: '🎯',
            title: 'Moving targets',
            text: `A ranged shot at a MOVING enemy misses up to ${c.accuracy.missMaxPct}% of the time (at full speed; never when it stands still, never in melee). A miss still splashes where it lands.`,
          },
          {
            icon: '🌊',
            title: 'Splash',
            text: `\`splashRadius\` ${span(sb, ' px')}: every other enemy that close to the target takes ${e.splashPct}% of the hit, with your fire or ice. Price ${x(splashFactor(Math.round(sb.max / 2), c.cost))} at ${Math.round(sb.max / 2)} px, ${x(splashFactor(sb.max, c.cost))} at ${sb.max} px.`,
          },
        ],
      },
      {
        kind: 'list',
        items: [
          'Walls never burn, freeze, get zapped or take splash: a hit on a wall is plain damage.',
          'Factories burn, get zapped, take splash, and build slower when frozen.',
          "A factory's `minionElement` gives every minion it builds that element (minions never splash; medics ignore it).",
          'Every body shows its `element`, `splashRadius` and `status` (`burning`, `frozen`, …) in `update()`.',
        ],
      },
      {
        kind: 'code',
        title: 'For your AI helper / code: elements and combos',
        code: [
          "this.element = 'fire';     // 'normal' | 'fire' | 'ice' | 'lightning'",
          `this.splashRadius = 40;    // ${span(sb)} px`,
          '',
          '// in update(): read a status, e.g. find an enemy in range that is frozen',
          'const frozen = enemies.find((e) => e.status.frozen > 0 && inRange(self, e));',
          "if (frozen && self.cooldownRemaining === 0) return { action: 'attack', targetId: frozen.id };",
        ].join('\n'),
      },
    ],
  };
}

function supportSection(c: GameConfig): GuideSectionDTO {
  const sdS = secs(c.suddenDeath.startTick, c);
  return {
    id: 'support',
    icon: '💚',
    title: 'Support: heal & auras',
    summary: 'One support per soldier or tower: a heal you control, or an aura that works by itself.',
    blocks: [
      { kind: 'table', head: ['Support', 'What it does', 'supportPower', 'supportRange', 'Price'], rows: supportRows(c) },
      {
        kind: 'list',
        items: [
          `Heal limit: an ally can get at most **${c.support.healRoomPctPerSecond}% of its max HP per second**, shared by all healers (\`status.healRoom\` shows what is left).`,
          'A heal on a burning or frozen ally only cleanses it (puts out the fire, thaws the ice).',
          `No heals after ${sdS} (sudden death). Auras keep working.`,
          'Never healed: walls, factories, the healer itself.',
          'Auras reach allies within `supportRange`, edge to edge. Only the strongest aura of each kind counts; different kinds add up.',
          'A unit with damage 0 is a pure helper: it cannot win alone. A side with only helpers (and walls) left is out.',
        ],
      },
      {
        kind: 'code',
        title: 'For your AI helper / code: a healer',
        code: [
          "this.support = 'heal';     // 'heal' | 'haste' | 'might' | 'shield'",
          'this.supportPower = 96;    // HP per heal (auras: %)',
          'this.supportRange = 120;   // px, edge to edge',
          '',
          '// in update(): heal the hurt ally with the most heal room',
          'const hurt = allies',
          '  .filter((a) => a.status.healRoom > 0 || a.status.burning > 0 || a.status.frozen > 0)',
          '  .sort((a, b) => b.status.healRoom - a.status.healRoom)[0];',
          "if (hurt && self.cooldownRemaining === 0) return { action: 'heal', targetId: hurt.id };",
        ].join('\n'),
      },
    ],
  };
}

function viewSection(c: GameConfig): GuideSectionDTO {
  const rows = (rec: Record<string, string>) => Object.entries(rec).map(([k, v]) => [`\`${k}\``, v]);
  const status = Object.fromEntries(Object.entries(STATUS_FIELDS).map(([k, f]) => [k, f(c)]));
  const world = Object.fromEntries(Object.entries(WORLD_FIELDS).map(([k, f]) => [k, f(c)]));
  return {
    id: 'view',
    icon: '👀',
    title: 'What update() can see',
    summary: '`update(self, enemies, allies, world)` gets fresh copies every tick.',
    blocks: [
      {
        kind: 'text',
        text: `\`update()\` runs once per tick (${c.timers.ticksPerSecond} ticks = 1 second). \`self\` is this unit, \`enemies\` and \`allies\` are lists of everything else alive, \`world\` is the arena. Changing them does nothing; extra fields you put on \`this\` are remembered between ticks.`,
      },
      { kind: 'table', caption: 'self (SelfView)', head: ['Field', 'Meaning'], rows: rows(SELF_FIELDS) },
      { kind: 'table', caption: 'each enemy / ally (OtherView)', head: ['Field', 'Meaning'], rows: rows(OTHER_FIELDS) },
      { kind: 'table', caption: 'status (StatusView): on self and every enemy / ally', head: ['Field', 'Meaning'], rows: rows(status) },
      { kind: 'table', caption: 'support (SupportView)', head: ['Field', 'Meaning'], rows: rows(SUPPORT_VIEW_FIELDS) },
      { kind: 'table', caption: 'self.factory (FactoryView): factories only', head: ['Field', 'Meaning'], rows: rows(FACTORY_FIELDS) },
      { kind: 'table', caption: 'world (WorldView)', head: ['Field', 'Meaning'], rows: rows(world) },
      {
        kind: 'list',
        items: [
          '`enemies` holds every living enemy body on the map (soldiers, towers, walls, factories and minions), not just the closest; `allies` holds every other living friendly body.',
          'Range is EDGE to edge: `inRange(self, other)` is `Math.hypot(other.x - self.x, other.y - self.y) - self.radius - other.radius <= self.range`.',
          "Free-for-all: every player is their own team. Team mode: teammates' units are in `allies`.",
          'Stored minions (inside a factory) are invisible.',
          "Show enemy names to units (a match setting the host picks at Start match; off by default): when it is on, every body also has `ownerName` (and `teamName` in team mode) and `world.players` lists the players. When it is off these fields are missing.",
        ],
      },
      { kind: 'code', title: 'For your AI helper / code: the exact contract (TypeScript)', code: contractTypescript() },
    ],
  };
}

function actionsSection(): GuideSectionDTO {
  const rows = (Object.keys(ACTIONS) as ActionName[]).map((a) => [`\`'${a}'\``, ACTIONS[a].who, ACTIONS[a].what, `\`${ACTIONS[a].example}\``]);
  return {
    id: 'actions',
    icon: '🎮',
    title: 'Actions update() can return',
    summary: 'Return one action per tick. Anything else (or an error) means idle.',
    blocks: [
      { kind: 'table', head: ['action', 'Who', 'What it does', 'Example'], rows },
      {
        kind: 'list',
        items: [
          'An action is a request: an attack on an enemy out of range, or while reloading, just idles.',
          "An action the type can't do (a tower that moves) is an idle.",
          'If `update()` throws an error the unit idles; 30 errors disable it for the battle.',
          'No `import`, `require`, timers or network: they do not exist in the game.',
        ],
      },
      {
        kind: 'code',
        title: 'For your AI helper / code: a simple soldier update()',
        code: [
          'update(self, enemies, allies, world) {',
          "  const targets = enemies.filter((e) => e.type !== 'wall');",
          '  if (targets.length === 0) return { action: \'idle\' };',
          '  const near = targets.reduce((a, b) =>',
          '    Math.hypot(a.x - self.x, a.y - self.y) < Math.hypot(b.x - self.x, b.y - self.y) ? a : b);',
          '  if (inRange(self, near)) return { action: \'attack\', targetId: near.id };',
          "  return { action: 'move', destination: { x: near.x, y: near.y } };",
          '}',
        ].join('\n'),
      },
    ],
  };
}

function factoriesSection(c: GameConfig): GuideSectionDTO {
  const pricing = pricingOf(c);
  const f = c.factory;
  const kindRows = MINION_KINDS.map((k) => {
    const m = f.minions[k];
    const p = minionPrice(c.cost, pricing, k);
    const dmg = k === 'medic' ? `0 (heals ${num(m.heal ?? 0)}, reach ${num(m.reach ?? 0)})` : num(m.damage);
    return [`\`'${k}'\``, MINION_ROLE[k], num(m.maxHealth), dmg, num(m.range), num(m.speed), money(p.minionCost), money(p.minionValue)];
  });
  const iv = c.stats.bounds.productionInterval;
  const intervals = [iv.min, 900, 1200, iv.max].filter((v, i, a) => v >= iv.min && v <= iv.max && a.indexOf(v) === i);
  const orderRows = MINION_ORDERS.map((o) => [`\`'${o}'\``, ORDER_TEXT[o](c)]);
  return {
    id: 'factories',
    icon: '🏭',
    title: 'Factories & minions',
    summary: 'Pick the minion kind, give squad orders, and save minions up for a burst.',
    blocks: [
      {
        kind: 'table',
        caption: 'Minion kinds (`this.produces`)',
        head: ['Kind', 'Role', 'HP', 'Damage', 'Range', 'Speed', 'Minion price', 'Factory pays per minion'],
        rows: kindRows,
      },
      {
        kind: 'table',
        caption: f.stopAtSuddenDeath
          ? `Minions per battle (\`productionInterval\`): the minions it can make before sudden death (${secs(productionEndTick(c), c)})`
          : 'Minions per battle (`productionInterval`)',
        head: ['productionInterval', 'One minion every', 'Minions per battle'],
        rows: intervals.map((v) => [`${num(v)} ticks`, secs(v, c), String(expectedMinions(v, pricing))]),
      },
      { kind: 'table', caption: "Squad orders (`{ action: 'command', order }`)", head: ['Order', 'What the minions do'], rows: orderRows },
      {
        kind: 'list',
        items: [
          `**Burst** (\`this.burst\`, ${span(c.stats.bounds.burst)}): the first minions wait INSIDE (safe from attacks) and leave together with the last one. If the factory is destroyed, the stored minions are LOST. \`{ action: 'release' }\` sends them out early. Burst is free.`,
          `At most **${f.maxAlivePerFactory}** minions alive (plus stored) per factory, **${f.maxAlivePerPlayer}** per player (fewer with 7-8 players), and **${f.maxMinionsPerFactory}** per factory per battle.`,
          `Brutes hit walls ×${f.minions.brute.wallDamageMultiplier} as hard.`,
          ...(f.stopAtSuddenDeath
            ? [`Factories stop building at sudden death (${secs(c.suddenDeath.startTick, c)}): no new minion appears from then on and \`self.factory.producing\` is false. Minions already out keep fighting, and stored minions still leave.`]
            : []),
          'Destroying a factory stops it; its minions keep going.',
        ],
      },
      {
        kind: 'code',
        title: 'For your AI helper / code: a factory update()',
        code: [
          'update(self, enemies, allies, world) {',
          "  const target = enemies.find((e) => e.type !== 'wall');",
          "  if (target) return { action: 'command', order: 'swarm', targetId: target.id };",
          "  return { action: 'rally', destination: world.center };",
          '}',
        ].join('\n'),
      },
    ],
  };
}

function costSection(c: GameConfig, examples: GuideExampleDTO[]): GuideSectionDTO {
  const cc = c.cost;
  const k = cc.curveK;
  const b = c.stats.bounds;
  const pricing = pricingOf(c);
  // Why maxing is pricier: the same soldier with more and more HP.
  const base: CostStats = unitStats(c, { type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 });
  const hpSteps = [0.25, 0.5, 0.75, 1].map((r) => clampTo(Math.round(b.maxHealth.max * r), b.maxHealth));
  const hpRows = hpSteps.map((hp) => {
    const res = computeCost({ ...base, maxHealth: hp }, cc, pricing);
    const part = res.breakdown.parts.maxHealth;
    return [num(hp), money(Math.round(part.total)), money(Math.round((part.total / hp) * 100)), money(res.cost)];
  });
  // One big unit vs two medium ones.
  const bigHp = clampTo(2000, b.maxHealth);
  const bigDmg = clampTo(200, b.damage);
  const big = computeCost({ ...base, maxHealth: bigHp, damage: bigDmg }, cc, pricing).cost;
  const medium = computeCost({ ...base, maxHealth: Math.round(bigHp / 2), damage: Math.round(bigDmg / 2) }, cc, pricing).cost;
  const exampleRows = examples.map((e) => [
    `${e.name}${e.group === 'template' ? ' (template)' : ''}`,
    e.stats.type,
    keyStats(e.stats),
    e.overCap ? `**${money(e.cost)}** (too much!)` : `**${money(e.cost)}**`,
    e.note,
  ]);
  const half = Math.round(cc.referenceCooldown / 2);
  return {
    id: 'cost',
    icon: '💰',
    title: 'How cost works',
    summary: 'Every unit has a price. Better stats cost more, and maxed stats cost a LOT more.',
    blocks: [
      { kind: 'text', text: PRICE_PARAGRAPH },
      {
        kind: 'list',
        items: [
          `**1. Start price** ${money(cc.base)}, then every stat adds its price: HP ${money(cc.hp)} each, damage ${money(cc.damage)}, range ${money(cc.range)} per px, speed ${money(cc.speed)} per 1 px/tick, size ${money(cc.size)} per px above 6.`,
          k > 0
            ? `**2. Near the max costs more:** a stat at its max costs ${x(1 + k)} its normal price, at half its max ${x(1 + k / 4)}.`
            : '**2. No curve right now:** a stat at its max costs its normal price.',
          `**3. Healing** (support \`'heal'\`) adds ${money(cc.heal)} per HP per heal.`,
          `**4. Multiply:** fast attacks (cooldown ${half} = ${x(cooldownFactor(half, cc))}), tough AND strong (up to ${x(powerFactor({ maxHealth: b.maxHealth.max, damage: b.damage.max }, cc))}), splash (up to ${x(splashFactor(b.splashRadius.max, cc))}), an element (${x(cc.element.fire)}).`,
          `**5. Auras** (haste ${money(cc.aura.haste)}, might ${money(cc.aura.might)}, shield ${money(cc.aura.shield)} per %) are added at the end.`,
          `**6. Round up** to whole dollars. One unit may cost at most **${money(c.caps.unitCost)}**.`,
          `**Walls** cost ${money(cc.wall.base)} + ${money(cc.wall.hp)} per HP. **Factories** cost ${money(cc.factory.base)} + ${money(cc.factory.hp)} per HP, plus their minions: each minion they can make ${c.factory.stopAtSuddenDeath ? 'before sudden death' : 'in a battle'} costs ${fmt(cc.factory.minionDiscount * 100)}% of its price${c.factory.stopAtSuddenDeath ? '' : ' (they arrive during the battle)'}.`,
        ],
      },
      { kind: 'table', caption: 'Live example prices', head: ['Example', 'Type', 'Stats', 'Price', 'What it is'], rows: exampleRows },
      {
        kind: 'table',
        caption: 'Why maxing is pricier: a Basic Soldier with more and more HP',
        head: ['maxHealth', 'HP part', 'per 100 HP', 'Whole unit'],
        rows: hpRows,
      },
      {
        kind: 'text',
        text: `One soldier with ${num(bigHp)} HP and ${num(bigDmg)} damage costs **${money(big)}**. One with half of each costs **${money(medium)}**.`,
      },
      {
        kind: 'code',
        title: 'For your AI helper / code: the exact formula',
        text: 'Coefficients are the live config (`GET /api/rules` → `coefficients`).',
        code: String(buildRules(c).costFormula),
      },
    ],
  };
}

function budgetSection(c: GameConfig): GuideSectionDTO {
  const cap = c.caps;
  return {
    id: 'budget',
    icon: '🧮',
    title: 'Budget & limits',
    summary: 'How much you can spend and how many units you can bring.',
    blocks: [
      {
        kind: 'table',
        head: ['Limit', 'Now'],
        rows: [
          ['Money per round (resets every round)', `**${money(cap.budget)}**`],
          ['Max price of one unit', money(cap.unitCost)],
          ['Unit types per round (soldiers)', String(cap.maxUnitTypes)],
          ['Building types per round (towers, walls, factories)', String(cap.maxBuildingTypes)],
          ['Fighters placed (soldiers, towers, factories)', String(cap.maxCopies)],
          ['… of which factories', String(cap.maxFactoryCopies)],
          ['Walls placed (on top of fighters)', String(cap.maxWallCopies)],
          ['Saved designs (templates not counted)', String(cap.maxDesigns)],
          ['Code size of one unit', `${num(cap.maxSourceBytes / 1024)} KB`],
        ],
      },
      {
        kind: 'list',
        items: [
          'You place copies of your picked units; every copy costs its price from the round budget.',
          ...(cap.copyRamp.pctPerCopy > 0
            ? [`**Copies:** your first ${cap.copyRamp.freeCopies} copies of a design cost its price; copy ${cap.copyRamp.freeCopies + 1} costs +${cap.copyRamp.pctPerCopy}%, the next +${2 * cap.copyRamp.pctPerCopy}%, and so on (walls never).`]
            : []),
          'Ready needs at least one fighter: a soldier or tower with damage above 0, or a factory that builds attacking minions.',
        ],
      },
    ],
  };
}

function battlesSection(c: GameConfig): GuideSectionDTO {
  const t = c.timers;
  const sd = c.suddenDeath;
  const sc = c.scoring;
  return {
    id: 'battles',
    icon: '⚔️',
    title: 'Battles & scoring',
    summary: 'Plan, place, clash, score. Then do it again.',
    blocks: [
      {
        kind: 'list',
        items: [
          `**Plan** (${fmt(t.planFirstRoundSec / 60)} min first round, ${fmt(t.planLaterRoundsSec / 60)} min later): ask your AI helper for units and pick your army.`,
          `**Placement** (${fmt(t.placementSec / 60)} min): put your units on your zone.`,
          `**Battle** (${secs(t.battleTicks, c)}): the units fight on their own, running your code.`,
          `**Sudden death:** from ${secs(sd.startTick, c)} a safe circle shrinks to the centre; outside it units lose ${sd.damagePctPerSecond}% of max HP per second.`,
          'The last side with fighters wins. At the time limit, survivors are ranked by the value of their living units (walls count $0).',
          `**Points:** your place (1st gets players - 1, e.g. ${placePointsTable(4).join('/')} with 4 players) + up to ${scaledBonusMax(sc.damageBonusMax, 4)} for damage + up to ${scaledBonusMax(sc.valueBonusMax, 4)} for enemy value destroyed (with 4 players; more with more players).`,
          `**Badges** (no points): ${Object.values(BADGES)
            .map((bd) => `${bd.emoji} ${bd.title}`)
            .join(', ')}.`,
          `The match has ${t.defaultRounds} rounds (the host can change it).`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

function stampOf(config: GameConfig, templates: readonly GuideTemplate[]): string {
  const used = [config.cost, config.stats, config.caps, config.timers, config.factory, config.elements, config.support, config.accuracy, config.suddenDeath, config.scoring, templates];
  return createHash('sha256').update(JSON.stringify(used)).digest('hex').slice(0, 16);
}

const NO_TEMPLATES: readonly GuideTemplate[] = [];

let cache: { config: GameConfig; templates: readonly GuideTemplate[]; guide: GuideDTO } | null = null;

/** The examples: the templates, then the archetypes (clamped into the live bounds). */
export function guideExamples(config: GameConfig, templates: readonly GuideTemplate[] = []): GuideExampleDTO[] {
  return [
    ...templates.map((t) => example(config, t.key, t.name, 'template', 'what every player starts with', t.stats)),
    ...ARCHETYPES.map((a) => example(config, a.id, a.name, 'archetype', a.note, a.stats(config))),
  ];
}

/** Build the guide from the live config (memoized on the config object and template list). */
export function buildGuide(config: GameConfig, templates: readonly GuideTemplate[] = NO_TEMPLATES): GuideDTO {
  if (cache && cache.config === config && cache.templates === templates) return cache.guide;
  const examples = guideExamples(config, templates);
  const guide: GuideDTO = {
    stamp: stampOf(config, templates),
    title: 'Unit guide',
    intro: 'Everything your units can do, with the numbers from this game. Ask your AI helper to build any of it!',
    sections: [
      typesSection(config),
      statsSection(config),
      elementsSection(config),
      supportSection(config),
      viewSection(config),
      actionsSection(),
      factoriesSection(config),
      costSection(config, examples),
      budgetSection(config),
      battlesSection(config),
    ],
    examples,
  };
  cache = { config, templates, guide };
  return guide;
}
