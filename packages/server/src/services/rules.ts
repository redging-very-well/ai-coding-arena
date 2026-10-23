// GET /rules + MCP get_rules, GET /contract + MCP get_unit_contract (§10).

import { readFileSync } from 'node:fs';
import {
  ARENA,
  BADGES,
  CELL_SIZE,
  DEFAULT_CONFIG,
  DEFAULT_SIZE,
  GRID_SIZE,
  MAP_STYLES,
  MAP_STYLE_INFO,
  MAX_PLAYERS,
  MINION_KINDS,
  MINION_KIND_NAMES,
  MIN_PLAYERS,
  PHASES,
  TEAM_MODES,
  TEAM_STYLES,
  FACTORY_RADIUS,
  WALL_HALF,
  ZONE_SIZE,
  arenaSizeFor,
  defaultMapStyle,
  expectedMinions,
  isValidTeamMode,
  minionPrice,
  pricingOf,
  placePointsTable,
  scaledBonusMax,
  teamModeLabel,
  type ContractDTO,
  type GameConfig,
  type MatchInfoDTO,
  type RulesDTO,
} from '@pixel-clash/shared';
import { repoPath } from '../util/paths.js';
import { templateSource } from './units.js';

/** The Open Armory paragraph of the rules (§9.1). */
export function armoryRules(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    text: enabled
      ? 'Open Armory is ON this match: every unit type that fought in a battle becomes borrowable by all OTHER players from the next Plan phase, as a frozen copy named "Unit (Creator)". Pick borrowed units on the Pixel Clash page (they count toward your unit and building types). list_armory shows them.'
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

/** Map styles, arena sizes and zone rules (§9.2). */
export function mapRules(): Record<string, unknown> {
  const counts = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => i + MIN_PLAYERS);
  return {
    text: 'The map depends on the player count: 2 Duel (opposite corners), 3 Triangle, 4 Corners, 5-8 Ring; the host can pick another style that fits (Lanes for 4/6/8, Islands for 6/8, Corners for 3). The arena grows with the players: read world.width, world.height and world.center (and world.mapStyle), never assume 800 or 400.',
    arenaSizes: Object.fromEntries(counts.map((n) => [n, arenaSizeFor(n)])),
    defaults: Object.fromEntries(counts.map((n) => [n, defaultMapStyle(n)])),
    styles: MAP_STYLES.map((style) => ({ style, ...MAP_STYLE_INFO[style], arenaSizes: MAP_STYLE_INFO[style].players.map(arenaSizeFor) })),
    zones: `Every player has one ${ZONE_SIZE}x${ZONE_SIZE} zone (${GRID_SIZE}x${GRID_SIZE} cells of ${CELL_SIZE} px). Placement col/row are zone-local: row 0 is the FRONT row (facing the centre, or on Lanes the other row) and (0,0) is the front cell nearest the centre, so a layout means the same thing on every map.`,
    rotation: 'Zones are dealt at the start of every Placement and rotate each round. In team mode whole teams rotate as blocks of neighbouring zones, and teammates rotate inside their block.',
    rangesUnchanged: 'Ranges, speeds, sizes, budget and caps are the same on every map; only the arena and the zone positions change.',
  };
}

/** Team modes and team rules (§9.2). */
export function teamRules(): Record<string, unknown> {
  const counts = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => i + MIN_PLAYERS);
  return {
    modes: TEAM_MODES.map((mode) => ({
      mode,
      validFor: counts.filter((n) => isValidTeamMode(mode, n)).map((n) => ({ players: n, label: teamModeLabel(mode, n) })),
    })),
    colors: TEAM_STYLES.map((t) => ({ name: t.name, color: t.color, pattern: t.pattern })),
    rules: [
      'Free-for-all is the default: every player is their own team (teamId = your seat).',
      'Team mode (2v2, 3v3, 2v2v2, 4v4, 2v2v2v2) is chosen at Start match; teams are fixed for the whole match. Late joiners sit out until the next match.',
      "Same teamId = friend, different = enemy. allies are your own other units AND all your teammates' units; enemies are every other team's units.",
      "There is no friendly fire: attacking a teammate's unit just idles.",
      "A team is out when its last unit dies; the battle ends when one team (or nobody) is left. At the time limit teams are ranked by the total cost of all their members' living units.",
      "Every member gets the TEAM's place points; damage and value-destroyed bonuses stay your own. The team table ranks teams by the average of their members' match points.",
      "Teammates see each other's picked units (name, stats, cost, sprite), zones and placements live during Plan and Placement, so you can plan together. Code is never shared. Opponents see nothing until START.",
    ],
  };
}

/**
 * The four unit types (§5.2): groups, per-type stats and prices, the
 * factory's minions, and the fighter / living-value rules (§9.3).
 */
export function unitTypeRules(config: GameConfig): Record<string, unknown> {
  const b = config.stats.bounds;
  const c = config.cost;
  const f = config.factory;
  const pricing = pricingOf(config);
  const { minionCost, minionValue } = minionPrice(c, pricing);
  const iv = b.productionInterval;
  const examples = [iv.min, 900, 1200, iv.max].filter((v, i, a) => v >= iv.min && v <= iv.max && a.indexOf(v) === i);
  return {
    text:
      'Four types: soldier (moves and fights), tower (stays and shoots), wall (a solid block that stops everyone, never attacks, has no update), factory (stays and builds minions; its update only picks where they go). Soldiers are "units"; towers, walls and factories are "buildings".',
    types: {
      soldier: { group: 'unit', moves: true, attacks: true, update: 'required', needs: ['name', 'type', 'maxHealth', 'damage', 'range', 'speed', 'attackCooldown', 'color'], size: `${b.size.min}-${b.size.max}, default ${DEFAULT_SIZE.soldier}` },
      tower: { group: 'building', moves: false, attacks: true, update: 'required', needs: ['name', 'type', 'maxHealth', 'damage', 'range', 'speed (0)', 'attackCooldown', 'color'], size: `${b.size.min}-${b.size.max}, default ${DEFAULT_SIZE.tower}` },
      wall: {
        group: 'building',
        moves: false,
        attacks: false,
        update: 'none (an update() is ignored)',
        needs: ['name', 'type', 'maxHealth', 'color'],
        maxHealth: b.wallHealth,
        body: `a ${WALL_HALF * 2}x${WALL_HALF * 2} px square filling its cell; for range it counts as a circle of radius ${WALL_HALF}`,
        leaveOut: ['damage', 'range', 'speed', 'attackCooldown', 'size'],
      },
      factory: {
        group: 'building',
        moves: false,
        attacks: false,
        update:
          "required: return { action: 'rally', destination } (attack + where its minions go, default world.center), { action: 'command', order: 'attack' | 'defend' | 'swarm' | 'guard', targetId? } (a squad order; swarm needs an enemy id, guard an ally id), { action: 'release' } (send stored minions out now), { action: 'hold' } (pause building this tick) or { action: 'idle' }",
        needs: ['name', 'type', 'maxHealth', 'productionInterval', 'color'],
        optional: {
          produces: `one of ${MINION_KINDS.map((k) => `'${k}'`).join(', ')} (default 'grunt'): the minion it builds; the price follows`,
          burst: `whole number ${b.burst.min}-${b.burst.max} (default 1): minions saved up inside, then sent out together; free`,
        },
        maxHealth: b.factoryHealth,
        productionInterval: { ...iv, integer: true, unit: 'ticks between two minions' },
        body: `a circle of radius ${FACTORY_RADIUS}`,
        leaveOut: ['damage', 'range', 'speed', 'attackCooldown', 'size'],
      },
    },
    limits: {
      perRound: `Up to ${config.caps.maxUnitTypes} unit types (soldiers) AND up to ${config.caps.maxBuildingTypes} building types (towers, walls, factories).`,
      copies: `Up to ${config.caps.maxCopies} fighters placed (soldiers, towers and factories), of which at most ${config.caps.maxFactoryCopies} factories, plus up to ${config.caps.maxWallCopies} walls.`,
    },
    walls: [
      'Walls block EVERY body, your own and your teammates\' too: leave a gap of one empty cell (two for size 19-20 bodies).',
      'Enemies (soldiers, towers and minions) can attack and break walls. Shots fly over walls.',
      'Units walk round walls by themselves: a move goes the shortest open way (gaps one cell wide, two for size 19-20). self.pathing is \'direct\', \'detour\' (going round walls) or \'no-route\' (walled off: it walks to the best wall to break and waits there); self.blockedBy is the wall that stopped it and self.blockedTicks counts the ticks it has been stopped.',
      'Sudden death hurts walls too (they crumble in about 14 s outside the circle).',
    ],
    factories: {
      text: `A factory builds one minion every productionInterval ticks, at most ${f.maxAlivePerFactory} alive per factory and ${f.maxAlivePerPlayer} per player (fewer with 7-8 players), up to ${f.maxMinionsPerFactory} per battle. Destroying a factory stops it; its minions keep going.`,
      minionsPerBattle: Object.fromEntries(examples.map((v) => [v, expectedMinions(v, pricing)])),
      minion: { ...f.minions.grunt, type: 'minion', name: MINION_KIND_NAMES.grunt, note: 'the grunt (the default kind). Built-in AI: chases enemies near it or near the rally point, otherwise walks to the rally point; you never write minion code' },
      minionCost,
      minionValue,
      // M8.6 (§5.3): the four kinds a factory can build (this.produces).
      minionKinds: Object.fromEntries(
        MINION_KINDS.map((k) => {
          const price = minionPrice(c, pricing, k);
          return [k, { ...f.minions[k], name: MINION_KIND_NAMES[k], role: KIND_ROLES[k], minionCost: price.minionCost, minionValue: price.minionValue }];
        }),
      ),
      orders: {
        text: "A factory gives all its minions one order with { action: 'command', order, targetId? }. It is kept until changed and starts as 'attack'. { action: 'rally', destination } = attack with a new rally point.",
        attack: `default: hunt the nearest enemy (not a wall) within their aggro range or ${f.rallyGuardRadius} px of the rally point, else wait at the rally point`,
        defend: `stay home: fight enemies within ${f.defendRadius} px of the factory, else wait next to it`,
        swarm: "{ order: 'swarm', targetId: enemy.id }: every minion goes for that one enemy (walls too), wherever it is; when it dies the order becomes 'attack'",
        guard: `{ order: 'guard', targetId: ally.id }: stay next to that ally (or self.id = the factory) and fight enemies within ${f.guardRadius} px of it; when it dies the order becomes 'defend'`,
      },
      burst: {
        ...b.burst,
        default: 1,
        text: "this.burst = N: the first N-1 minions wait INSIDE the factory (self.factory.stored; they can't be hit) and leave together with the N-th. { action: 'release' } sends them out early, and they leave on their own when the factory can't store more. Stored minions are LOST if the factory is destroyed. They count toward the alive caps. Burst never changes the price.",
      },
    },
    fighters:
      'Fighters are soldiers, towers, minions and factories that can still build. Walls are NOT fighters: Ready needs at least one fighter (NO_FIGHTERS), and a side with no fighters left is out (its walls crumble).',
    livingValue: `At the time limit walls are worth $0, a factory is worth its body price only (minions it never built count nothing), and each living minion $${minionValue}. During the battle a factory counts $${minionValue} per minion it can still build in time, and one that holds or is walled in until it no longer has time to build one is not a fighter any more. Breaking an enemy wall still scores its full price as value destroyed.`,
  };
}

export function buildRules(config: GameConfig, armoryEnabled = false, match?: MatchInfoDTO): RulesDTO {
  const t = config.timers;
  const arena = match?.map ? { width: match.map.width, height: match.map.height } : { width: ARENA.width, height: ARENA.height };
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
    maxPlayers: config.match.maxPlayers,
    caps: { ...config.caps },
    costFormula:
      'each stat term = linear * (1 + c.curveK * (x / max)^2) with linear = maxHealth*c.hp (max 500), damage*c.damage (max 60), range*c.range (max 300), speed*c.speed (max 5), (size - 6)*c.size (max 14); ' +
      'raw = (c.base + sum of the terms) * max(1, c.referenceCooldown / attackCooldown); cost = ceil(raw), where c = coefficients and size defaults to bounds.defaultSize[type]. ' +
      curveSentence(config.cost.curveK) +
      ' Walls: cost = ceil(c.wall.base + maxHealth*c.wall.hp*(1 + c.curveK*(maxHealth/1500)^2)). ' +
      'Factories: cost = ceil(c.factory.base + maxHealth*c.factory.hp*(1 + c.curveK*(maxHealth/1000)^2)) + minionValue * E, where E = the minions it can build in one battle (unitTypes.factories.minionsPerBattle) and minionValue = half the price of its minion kind priced as a soldier (unitTypes.factories.minionKinds[produces].minionValue: grunt is the default). burst never changes the price.',
    coefficients: { ...config.cost },
    bounds: {
      ...config.stats.bounds,
      byType: {
        soldier: { maxHealth: config.stats.bounds.maxHealth, damage: config.stats.bounds.damage, range: config.stats.bounds.range, speed: config.stats.bounds.soldierSpeed, attackCooldown: config.stats.bounds.attackCooldown, size: config.stats.bounds.size },
        tower: { maxHealth: config.stats.bounds.maxHealth, damage: config.stats.bounds.damage, range: config.stats.bounds.range, speed: 0, attackCooldown: config.stats.bounds.attackCooldown, size: config.stats.bounds.size },
        wall: { maxHealth: config.stats.bounds.wallHealth },
        factory: { maxHealth: config.stats.bounds.factoryHealth, productionInterval: config.stats.bounds.productionInterval },
      },
      towerSpeed: 0,
      defaultSize: DEFAULT_SIZE,
      color: '#RRGGBB',
      shape: ['circle', 'square', 'triangle', 'diamond'],
    },
    scoring: scoringRules(config),
    unitTypes: unitTypeRules(config),
    factory: { ...config.factory },
    arena: {
      width: arena.width,
      height: arena.height,
      zoneSize: ZONE_SIZE,
      cellSize: CELL_SIZE,
      gridSize: GRID_SIZE,
      zones: 'The map depends on the player count: 2 Duel (opposite corners), 3 Triangle, 4 Corners, 5-8 Ring; the host can pick Lanes or Islands. The arena is 800 px for 2-4 players, 1040 for 5-6 and 1200 for 7-8: read world.width and world.center, never assume 800 or 400. Zones rotate every round.',
      rangeIs: 'edge to edge: distance - self.radius - other.radius <= range',
    },
    suddenDeath: {
      ...config.suddenDeath,
      text: `From ${config.suddenDeath.startTick / t.ticksPerSecond} s a safe circle around world.center shrinks (radii here are for the 800 arena and grow with it); units outside lose ${config.suddenDeath.damagePctPerSecond}% of max health per second.`,
    },
    submissions: 'submit_unit works only in the PLAN phase; validate_unit works any time.',
    armory: armoryRules(armoryEnabled),
    maps: mapRules(),
    teams: teamRules(),
    ...(match
      ? {
          thisMatch: {
            mapStyle: match.mapStyle,
            teamMode: match.teamMode,
            arena,
            teams: match.teams?.map((tm) => ({ teamId: tm.teamId, name: tm.name, members: tm.members.length })) ?? null,
          },
        }
      : {}),
    ranking:
      'Survivors rank above the eliminated (a side with only walls left is out). At the time limit, survivors are ranked by the total value of their living units: soldiers and towers their cost, walls $0, factories their body (unbuilt minions count nothing), minions their minionValue. In team mode whole teams are ranked the same way (team living cost).',
    pointsSummary: `Round points = place points (1st gets players - 1 down to 0 for last; 4 players: ${placePointsTable(4).join('/')}) + damage bonus (0-${config.scoring.damageBonusMax} at 4 players) + value-destroyed bonus (0-${config.scoring.valueBonusMax} at 4 players). Bonuses scale with players / 4. See scoring.`,
  };
}

/** §9 Points / Badges / Match standings, with the numbers from config. */
export function scoringRules(config: GameConfig): RulesDTO['scoring'] {
  const sc = config.scoring;
  const four = placePointsTable(4);
  const place = four.map((p, i) => `${ordinal(i + 1)} ${p}`).join(', ');
  const byPlayers: Record<string, number[]> = {};
  for (let n = 2; n <= config.match.maxPlayers; n++) byPlayers[n] = placePointsTable(n);
  return {
    placePoints: four,
    placePointsByPlayers: byPlayers,
    damageBonusMax: sc.damageBonusMax,
    valueBonusMax: sc.valueBonusMax,
    formula: 'round points = place points + damage bonus + value bonus',
    place: `Place points: 1st gets (players - 1), then one less per place, down to 0 for last (2 players 1/0, 4 players: ${place}, 8 players 7..0; tied players share the better place). In team mode every member gets the team's place points: round((players - 1) x (teams - place) / (teams - 1)).`,
    damageBonus: `Damage bonus: round(${sc.damageBonusMax} x players/4 x myDamage / topDamage), e.g. 0-${scaledBonusMax(sc.damageBonusMax, 4)} with 4 players. Damage is EFFECTIVE damage to enemy units: a hit counts at most the hp the target had left (no overkill). It is credited when the hit lands (projectiles on impact), even if the shooter died meanwhile.`,
    valueBonus: `Value bonus: round(${sc.valueBonusMax} x players/4 x myValueDestroyed / topValueDestroyed), e.g. 0-${scaledBonusMax(sc.valueBonusMax, 4)} with 4 players. Bonuses are always your own, also in team mode. When your hit finishes an enemy unit you get its FULL unit cost as value destroyed (and a KO). Hits in the same tick resolve in seat order, then instanceId order.`,
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
  "4. The returned action is a request: attack needs a living enemy within range (EDGE to edge, +0.5 px) and cooldownRemaining = 0, else the unit idles. move: soldiers only, at most `speed` px per tick, clamped to the arena; a wall in the way is slid along. rally {destination}, command {order, targetId?}, release and hold: factories only (rally = order 'attack' + where its minions go; command gives the squad order attack/defend/swarm/guard, kept until changed; release sends the stored minions out; hold pauses building for the tick). An action the type can't do is an idle. Anything else (or a throw) means idle; throws count strikes and 30 strikes disable the unit for the battle.",
  '5. No import, require, network, timers or async. They do not exist in the sandbox.',
  '6. Four types: soldier (moves, fights), tower (stays, shoots), wall (a 40x40 block with no update() that blocks everyone; enemies can break it), factory (stays and builds minions: grunts, archers, runners or brutes; its update() gives them orders). Minions are engine-made fighters (type "minion" in enemies/allies, named after their kind): you never write their code.',
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

/** The sudden-death tip, with the start time and damage rate from config. */
export function suddenDeathTip(config: GameConfig = DEFAULT_CONFIG): string {
  const sd = config.suddenDeath;
  const startS = Math.round((sd.startTick / config.timers.ticksPerSecond) * 10) / 10;
  return `After ${startS} s a safe circle shrinks toward the centre; units outside it lose ${sd.damagePctPerSecond}% of max health per second. Towers far from the centre will suffer.`;
}

/** Strategy tips; the cost-curve and sudden-death tips follow the config. */
export function strategyTips(config: GameConfig = DEFAULT_CONFIG): string[] {
  return STRATEGY_TIPS.map((t) =>
    t === CURVE_TIP_SLOT ? curveTip(config.cost.curveK) : t === SUDDEN_DEATH_TIP_SLOT ? suddenDeathTip(config) : t,
  );
}

const CURVE_TIP_SLOT = '(curve tip)';
const SUDDEN_DEATH_TIP_SLOT = '(sudden-death tip)';

export const STRATEGY_TIPS = [
  'attackCooldown 60 is free; a faster cooldown multiplies the WHOLE cost (cooldown 30 = ×2).',
  "attackCooldown above 60 gives NO discount: it's the same price for less damage. Use 60.",
  'Range is edge to edge: bigger bodies (size) reach further but are easier to hit.',
  CURVE_TIP_SLOT,
  'Points come from your place AND from damage (up to +2 with 4 players, more with more players) and enemy value destroyed (up to +1 with 4 players). Aggressive units score damage points even if they do not survive.',
  'The arena is 800, 1040 or 1200 px wide depending on the player count: use world.width, world.height and world.center, never 800 or 400.',
  "Tell friend from foe by teamId: allies include your teammates' units in team mode, and enemies are only the other teams' units.",
  SUDDEN_DEATH_TIP_SLOT,
  'Add a sprite() method with pixel art (drawn facing right); without it the unit gets a plain fallback look.',
  'Walls block everyone, your own units too: leave a gap of one empty cell so your soldiers and minions can get out (two cells for size 19-20).',
  "Walls can't attack and are worth $0 at the end, and a player with only walls left is out: walls protect fighters, they don't win.",
  "Skip enemies with type 'wall' when picking targets, unless one blocks you: if self.blockedBy is an enemy wall (still in enemies) and self.blockedTicks is high (120 = 2 s), smash it.",
  "Minions show up in enemies as type 'minion': weak (40 HP) but many. Shots fly over walls, so towers behind walls still shoot.",
  'A factory pays up front for its minions: productionInterval 600 makes 8 per battle, 900 makes 5, 1800 makes 2, and the price follows. Rally them at the nearest enemy to attack, or in front of your towers to defend.',
  "Pick this.produces for the job: 'archer' (shoots from 110 px, fragile) behind walls or towers, 'runner' (fast) to swarm far targets, 'brute' (tough, 3x damage to walls) to smash walls, 'grunt' (default, cheapest) for a steady stream.",
  "Squad orders: { action: 'command', order: 'swarm', targetId: enemy.id } sends every minion at one enemy; 'guard' with an ally's id keeps them next to it; 'defend' keeps them home; 'attack' (default) hunts. swarm and guard need a targetId: with no target return { action: 'command', order: 'attack' }. swarm is for ONE target (a sniper, a wall in the way); for an open fight attack is the all-rounder, and defend next to your towers is very strong.",
  'this.burst = 4 saves minions inside the factory and sends them out together (a surprise rush), but stored minions die with the factory: keep it safe, or release early with { action: \'release\' }.',
];

/** One line per minion kind (get_rules). */
const KIND_ROLES = {
  grunt: 'the default: cheap all-rounder, melee',
  archer: 'ranged (110 px, shots fly over walls), fragile: put it behind walls or soldiers',
  runner: 'very fast and small, weak: reaches far targets first (great with swarm)',
  brute: 'slow and tough, hits walls 3x as hard and smashes a blocking wall after 0.5 s',
} as const;

export function buildContract(config: GameConfig = DEFAULT_CONFIG): ContractDTO {
  return {
    typescript: contractTypescript(),
    templates: {
      basic_soldier: templateSource('basic_soldier'),
      basic_tower: templateSource('basic_tower'),
      basic_wall: templateSource('basic_wall'),
      basic_factory: templateSource('basic_factory'),
    },
    notes: [...ENGINE_RULES, ...strategyTips(config).map((t) => `Tip: ${t}`)],
  };
}
