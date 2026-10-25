// Game configuration: zod schema + defaults (plan §5 bounds, §6 economy,
// §3 timers, §8 sandbox limits, §9 sudden death and scoring, §9.2 match size,
// §4 rate limits).
//
// `DEFAULT_CONFIG` is the single source of truth in code. `config/default.json`
// at the repo root mirrors it for humans/ops and a test keeps them in sync.
// The server loads that file (if present), deep-merges it over the defaults
// and validates the result with `parseConfig`.

import { z } from 'zod';

const finite = () => z.number().refine(Number.isFinite, 'must be a finite number');
const nonNeg = () => finite().refine((n) => n >= 0, 'must be >= 0');
const posInt = () => z.number().int().positive();
const atLeastOne = () => finite().refine((n) => n >= 1, 'must be >= 1');

/** An inclusive numeric range. */
const RangeSchema = z
  .object({ min: finite(), max: finite() })
  .refine((r) => r.min <= r.max, 'min must be <= max');
export type NumRange = z.infer<typeof RangeSchema>;

/**
 * Cost coefficients (§6, M8.8). Each stat term is convex:
 * term = c * x * (1 + curveK * (x / max)²), so a maxed stat costs (1 + curveK)× its linear price;
 * raw = (base + Σ term + heal) * max(1, refCD / CD) * power * splash * element + aura.
 */
export const CostCoefficientsSchema = z.object({
  base: nonNeg(),
  hp: nonNeg(),
  damage: nonNeg(),
  range: nonNeg(),
  speed: nonNeg(),
  /** Per px of size above the minimum size (6). */
  size: nonNeg(),
  /** Cooldown (ticks) at which the factor is 1. Faster cooldowns multiply the cost. */
  referenceCooldown: z.number().positive(),
  /**
   * Curve strength k: a stat at its max costs (1 + k)× its linear price. Must be
   * >= 0 (a negative k would make cost fall as a stat rises) and <= 5.
   */
  curveK: nonNeg().refine((n) => n <= 5, 'must be <= 5'),
  /** Power factor q: × (1 + q · HP/maxHP · damage/maxDamage) (tough AND strong costs more). 0-4. */
  powerFactor: nonNeg().refine((n) => n <= 4, 'must be <= 4'),
  /** M8.8 splash factor s: × (1 + s · ρ(2 − ρ)), ρ = splashRadius / 80. 0-2. */
  splash: nonNeg().refine((n) => n <= 2, 'must be <= 2'),
  /** M8.8 element factors (whole-unit multipliers; normal is always 1). Each >= 1. */
  element: z.object({ fire: atLeastOne(), ice: atLeastOne(), lightning: atLeastOne() }),
  /** M8.8 heal price per HP per heal (inside the cooldown factor). */
  heal: nonNeg(),
  /** M8.8 aura prices per % (added after the factors: always on). */
  aura: z.object({ haste: nonNeg(), might: nonNeg(), shield: nonNeg() }),
  /**
   * Walls (§6 Walls and factories): raw = base + hp·HP·(1 + curveK·(HP/1500)²).
   * No cooldown factor (walls can't attack).
   */
  wall: z.object({ base: nonNeg(), hp: nonNeg() }),
  /**
   * Factories: ceil(base + hp·HP·(1 + curveK·(HP/1000)²)) + minionValue × E,
   * minionValue = ceil(minionCost × minionDiscount) where minionCost is the
   * unit formula on the `factory.minion` stats (§6).
   */
  factory: z.object({
    base: nonNeg(),
    hp: nonNeg(),
    /** Share of a minion's soldier price a factory pays per expected minion (they arrive during the battle). */
    minionDiscount: finite().refine((n) => n > 0 && n <= 1, 'must be > 0 and <= 1'),
  }),
});
export type CostCoefficients = z.infer<typeof CostCoefficientsSchema>;

/** Stat bounds (§5 table). */
export const StatBoundsSchema = z.object({
  nameLength: z
    .object({ min: posInt(), max: posInt() })
    .refine((r) => r.min <= r.max, 'min must be <= max'),
  maxHealth: RangeSchema,
  damage: RangeSchema,
  range: RangeSchema,
  /** Soldier speed range. Towers must have speed exactly 0. */
  soldierSpeed: RangeSchema,
  /** Redesign: soldier range (towers use `range`, which reaches further: towers out-range soldiers). */
  soldierRange: RangeSchema,
  /** Integer ticks between attacks. */
  attackCooldown: RangeSchema,
  /** Optional body radius in px (hitbox and drawn size). */
  size: RangeSchema,
  /** Wall maxHealth (§5.2). */
  wallHealth: RangeSchema,
  /** Factory maxHealth (§5.2). */
  factoryHealth: RangeSchema,
  /** Factory: integer ticks between two minions (§5.2). */
  productionInterval: RangeSchema,
  /** Factory (M8.6): minions saved up inside before they leave together (§5.3). Whole numbers; max ≤ factory.maxAlivePerFactory. */
  burst: RangeSchema,
  /** M8.8 (§5.4): splash radius in px (0 = one target). */
  splashRadius: RangeSchema,
  /** M8.8 (§5.5): supportPower and supportRange per support kind. */
  support: z.object({
    heal: z.object({ power: RangeSchema, range: RangeSchema }),
    haste: z.object({ power: RangeSchema, range: RangeSchema }),
    might: z.object({ power: RangeSchema, range: RangeSchema }),
    shield: z.object({ power: RangeSchema, range: RangeSchema }),
  }),
});
export type StatBounds = z.infer<typeof StatBoundsSchema>;

/**
 * One built-in minion kind (§5.2, §5.3): the same for everyone. Priced as a
 * soldier, so it is kept inside the soldier bounds (refined below).
 */
export const MinionStatsSchema = z.object({
  maxHealth: z.number().positive(),
  damage: nonNeg(),
  range: nonNeg(),
  speed: z.number().positive(),
  attackCooldown: posInt(),
  size: z.number().positive(),
  /** A minion chases enemies within this edge-to-edge distance of itself. */
  aggroRange: nonNeg(),
  /** Ticks blocked by an enemy wall before a minion attacks it. */
  impatientTicks: posInt(),
  /** Hits on walls deal damage × this (M8.6: brutes 3, the rest 1). Not priced (§5.3). */
  wallDamageMultiplier: finite().refine((n) => n >= 1 && n <= 5, 'must be 1-5'),
  /** M8.8 medic (§5.5): HP per heal (its heal support power); priced in its soldier formula. */
  heal: nonNeg().optional(),
  /** M8.8 medic: heal reach, edge to edge (its heal support range). */
  reach: nonNeg().optional(),
});
export type MinionStats = z.infer<typeof MinionStatsSchema>;

/** The preset minion kinds (§5.3; medic §5.5), keyed like `MinionKind`. */
export const MinionKindsSchema = z.object({
  grunt: MinionStatsSchema,
  archer: MinionStatsSchema,
  runner: MinionStatsSchema,
  brute: MinionStatsSchema,
  medic: MinionStatsSchema,
});
export type MinionKindsConfig = z.infer<typeof MinionKindsSchema>;

export const FactorySchema = z.object({
  /** Most minions one factory makes in a battle (E's cap, §6). */
  maxMinionsPerFactory: posInt(),
  /**
   * Factories build no minion that would appear at or after suddenDeath.startTick
   * (§9.3, 2026-10-25 "Factories stop at sudden death"); E is priced over that
   * window. false: they build until the end of the battle (the pre-2026-10-25 rule).
   */
  stopAtSuddenDeath: z.boolean(),
  /**
   * Every factory still standing is destroyed on the first tick of sudden death
   * (suddenDeath.startTick), credited to nobody; stored minions are lost with it
   * as with any destroyed factory (§9.3, 2026-10-25 "factories die at sudden
   * death", on by default). false: factories live on into sudden death.
   */
  dieAtSuddenDeath: z.boolean(),
  /**
   * When a factory is destroyed, its living minions crumble with it in the same
   * tick (§9.3, 2026-10-25 "Minions die with their factory"), credited to the
   * factory's killer. false: they keep fighting (the pre-2026-10-25 rule).
   */
  minionsDieWithFactory: z.boolean(),
  /**
   * With minionsDieWithFactory: only the minions whose centre is within this many
   * px of the factory's centre (distance <= radius) at its death tick crumble; the
   * rest keep fighting (2026-10-25 "Only minions near the factory crumble").
   * 0 = every minion of the factory crumbles, wherever it is.
   */
  crumbleRadius: nonNeg(),
  maxAlivePerFactory: posInt(),
  /** Alive minions per player: min(this, floor(maxAlivePerBattle / players)). */
  maxAlivePerPlayer: posInt(),
  maxAlivePerBattle: posInt(),
  /** Minions also chase enemies within this distance of their rally point. */
  rallyGuardRadius: nonNeg(),
  /** A minion closer than this to its rally point idles there. */
  rallyArriveRadius: nonNeg(),
  /** Order `defend` (M8.6): minions fight enemies within this distance of the factory's centre. */
  defendRadius: nonNeg(),
  /** Order `defend`: a minion this close to the factory's centre waits there. */
  defendArriveRadius: nonNeg(),
  /** Order `guard`: minions fight enemies within this distance of the guarded ally. */
  guardRadius: nonNeg(),
  /** Order `guard`: a minion within ally radius + own radius + this waits there. */
  guardArriveGap: nonNeg(),
  /** The minion kinds a factory can build (`produces`, M8.6); `grunt` is the M8.5 minion. */
  minions: MinionKindsSchema,
});
export type FactoryConfig = z.infer<typeof FactorySchema>;

/** M8.8 element constants (§5.4, §9.4). */
export const ElementsSchema = z.object({
  /** A fire hit adds burnPct% of its damage as a burn, over `pulses` pulses `pulseTicks` apart. */
  fire: z.object({ burnPct: nonNeg(), pulses: posInt(), pulseTicks: posInt() }),
  /** An ice hit freezes for `ticks`: moves, reloads and builds slowPct% slower. */
  ice: z.object({ slowPct: finite().refine((n) => n >= 0 && n < 100, 'must be 0-99'), ticks: posInt() }),
  /** chancePct% of lightning main hits zap the nearest other enemy within hopRange px (edge to edge); a burning target adds hops. */
  lightning: z.object({
    chancePct: finite().refine((n) => n >= 0 && n <= 100, 'must be 0-100'),
    hopRange: nonNeg(),
    burningExtraHops: z.number().int().nonnegative(),
  }),
  /** Shatter: a fire hit on a frozen target does +shatterPct% and thaws it. */
  shatterPct: nonNeg(),
  /** Redesign synergy "kindle": a burning body takes +kindlePct% from every hit that isn't fire (burn pulses excluded). */
  kindlePct: nonNeg(),
  /** Redesign synergy "brittle": a frozen body takes +brittlePct% from every hit that isn't ice or fire (fire shatters instead). */
  brittlePct: nonNeg(),
  /** Splash hits deal splashPct% of the hit. */
  splashPct: nonNeg(),
});
export type ElementsConfig = z.infer<typeof ElementsSchema>;

/** Redesign (2026-10-24): ranged accuracy against the target's speed (§9.4 Accuracy). */
export const AccuracySchema = z.object({
  /** The miss chance of a ranged shot at a target moving at `speedRef` px/tick or faster, in %. */
  missMaxPct: finite().refine((n) => n >= 0 && n <= 100, 'must be 0-100'),
  /** Speed (px per tick moved this tick) at which the miss chance reaches missMaxPct. */
  speedRef: z.number().positive(),
});
export type AccuracyConfig = z.infer<typeof AccuracySchema>;

/** M8.8 support constants (§5.5). */
export const SupportSchema = z.object({
  /** A body can be healed this % of its max HP per 60-tick window (shared by every healer). */
  healRoomPctPerSecond: nonNeg(),
});

export const ConfigSchema = z.object({
  /** Economy version: 3 = the $10,000 redesign (stored config patches without it are migrated, §6). */
  economyVersion: z.literal(3),
  cost: CostCoefficientsSchema,
  stats: z.object({ bounds: StatBoundsSchema }),
  caps: z.object({
    /** Max rounded cost of a single unit (§6). */
    unitCost: posInt(),
    /** Credits per player per round; resets every round. */
    budget: posInt(),
    /** Max active designs per player (templates don't count). */
    maxDesigns: posInt(),
    /** Max unit types (soldiers) fielded per round (§5.2). */
    maxUnitTypes: posInt(),
    /** Max building types (towers, walls, factories) fielded per round (§5.2). */
    maxBuildingTypes: posInt(),
    /** Max fighter copies placed per player: soldiers + towers + factories (everything that runs code). */
    maxCopies: posInt(),
    /** Of those, max factories (§5.2). */
    maxFactoryCopies: z.number().int().nonnegative(),
    /** Max walls placed per player, on top of maxCopies (walls run no code). */
    maxWallCopies: z.number().int().nonnegative(),
    /** Max unit source size in bytes (§7 step 1). */
    maxSourceBytes: posInt(),
    /**
     * Redesign "copy ramp" (§6): copies of one design beyond `freeCopies` cost
     * `pctPerCopy`% more each, cumulatively (walls never). 0 = off.
     */
    copyRamp: z.object({ freeCopies: z.number().int().nonnegative(), pctPerCopy: nonNeg() }),
  }),
  timers: z.object({
    defaultRounds: posInt().max(10),
    planFirstRoundSec: posInt(),
    planLaterRoundsSec: posInt(),
    placementSec: posInt(),
    /** Battle length in sim ticks (90 s at 60 ticks/s). */
    battleTicks: posInt(),
    ticksPerSecond: posInt(),
    /** PLAN → PLACEMENT ~3 s after every active player is Ready (§3). Never starts the battle. */
    autoAdvanceWhenAllReady: z.boolean(),
  }),
  /** Match size (§9.2). Arena sizes, zone tables and team colours are code (shared/maps.ts, teams.ts). */
  match: z.object({
    /** Seats 0..maxPlayers−1; joining beyond it is GAME_FULL. 2-8. */
    maxPlayers: z.number().int().min(2).max(8),
  }),
  /**
   * Round points (§9 Points): place points + damage bonus + value bonus.
   * Place points are a formula, not config: with P ranked players and T sides,
   * place k gets round((P − 1) × (T − k) / (T − 1)) (free-for-all: P − k).
   * Bonus = round-half-up(max × P/4 × mine / top), 0 when the top value is 0.
   */
  scoring: z.object({
    /** Max damage bonus AT 4 PLAYERS (for the top effective damage dealer); scaled × P/4. */
    damageBonusMax: z.number().int().nonnegative(),
    /** Max value-destroyed bonus AT 4 PLAYERS (for the top value destroyer); scaled × P/4. */
    valueBonusMax: z.number().int().nonnegative(),
    /** How many places the round's "top damage" units list shows (ties included). */
    topUnitsShown: z.number().int().min(1).max(10),
  }),
  suddenDeath: z
    .object({
      startTick: z.number().int().nonnegative(),
      endTick: posInt(),
      startRadius: z.number().positive(),
      endRadius: nonNeg(),
      /** Percent of maxHP lost per second while outside the safe circle. */
      damagePctPerSecond: nonNeg(),
    })
    .refine((s) => s.startTick < s.endTick, 'startTick must be < endTick'),
  sim: z.object({
    /** Range <= this counts as melee: instant hit. */
    meleeMaxRange: nonNeg(),
    /** Homing projectile speed in px/tick. */
    projectileSpeed: z.number().positive(),
    /** Float tolerance added to range when checking attacks. */
    rangeTolerance: nonNeg(),
    separationPasses: z.number().int().nonnegative(),
    /** Record a frame every N ticks. */
    frameEveryTicks: posInt(),
    /** Wall steering: ticks without a wall hit after which the slide side is forgotten (§9.3). */
    slideMemoryTicks: posInt(),
    /** Routing round walls: a body re-plans its route at most every N ticks (plus on reaching its waypoint, §9.3). */
    replanTicks: posInt(),
    /** Redesign: towers and factories are solid for routing (bodies walk round them; false = the M8.7 walls-only router). */
    routeRoundBuildings: z.boolean(),
  }),
  /** Factories and their built-in minions (§5.2, §9.3). */
  factory: FactorySchema,
  /** M8.8 elements and splash (§5.4, §9.4). */
  elements: ElementsSchema,
  /** M8.8 support (§5.5). */
  support: SupportSchema,
  /** Redesign: ranged accuracy vs the target's speed (§9.4). */
  accuracy: AccuracySchema,
  sandbox: z.object({
    mode: z.enum(['ivm', 'process', 'inproc-unsafe']),
    memoryLimitMb: posInt(),
    validation: z.object({
      /**
       * Total wall budget for EVALUATING the module (§7 step 4), microtasks
       * included. The later steps have their own per-call limits
       * (constructTimeoutMs per construction/stat read, dryRunCallTimeoutMs per
       * dry-run call), so one validation is bounded by about
       * evalBudgetMs + 7 × constructTimeoutMs + 15 × dryRunCallTimeoutMs.
       */
      evalBudgetMs: posInt(),
      /** Per constructor call (§7 step 5). */
      constructTimeoutMs: posInt(),
      /** Per dry-run update() call (§7 step 9). */
      dryRunCallTimeoutMs: posInt(),
      /** update() slower than this gives W_SLOW. */
      slowUpdateWarnMs: z.number().positive(),
    }),
    battle: z.object({
      /** Hard per-player __tick timeout. */
      hardTimeoutMs: posInt(),
      /** Soft limit: above this the player gets a slow strike. */
      softTimeoutMs: posInt(),
      /** Extra wall time over the hard timeout before the isolate is disposed. */
      disposeGraceMs: posInt(),
      /** Timeout for reading `__current` after a hard timeout. */
      culpritProbeTimeoutMs: posInt(),
      /** Throws before a unit is disabled. */
      unitStrikeLimit: posInt(),
      /**
       * Hard timeouts blamed on one unit before that unit is disabled. Below
       * this the unit's ticks just idle (one stall can be GC, not the player).
       */
      timeoutsToDisable: posInt(),
      /** Timeouts in a row (after a culprit was disabled) that disable the player. */
      timeoutsInARowLimit: posInt(),
      /** Total timeouts that disable the player. */
      timeoutsTotalLimit: posInt(),
      /** Slow strikes before the slowest unit (then the player) is disabled. */
      slowStrikeLimit: posInt(),
    }),
  }),
  rateLimits: z.object({
    loginPerMinute: posInt(),
    validatePerSecond: posInt(),
    submitMinIntervalMs: posInt(),
  }),
}).superRefine((c, ctx) => {
  // Every minion kind is priced as a soldier (§6), so it must be a legal soldier.
  const b = c.stats.bounds;
  const within: Array<['maxHealth' | 'damage' | 'range' | 'speed' | 'attackCooldown' | 'size', { min: number; max: number }]> = [
    ['maxHealth', b.maxHealth],
    ['damage', b.damage],
    ['range', b.soldierRange],
    ['speed', b.soldierSpeed],
    ['attackCooldown', b.attackCooldown],
    ['size', b.size],
  ];
  for (const [kind, m] of Object.entries(c.factory.minions) as Array<[string, MinionStats]>) {
    for (const [k, r] of within) {
      if (m[k] < r.min || m[k] > r.max) {
        ctx.addIssue({ code: 'custom', path: ['factory', 'minions', kind, k], message: `must be within the soldier bounds ${r.min}-${r.max}` });
      }
    }
  }
  // The medic (M8.8, §5.5): a pure healer (damage 0) whose heal and reach fit the heal support bounds.
  const medic = c.factory.minions.medic;
  const hb = b.support.heal;
  if (medic.damage !== 0) ctx.addIssue({ code: 'custom', path: ['factory', 'minions', 'medic', 'damage'], message: 'medics never attack: must be 0' });
  if (medic.heal === undefined || medic.heal < hb.power.min || medic.heal > hb.power.max) {
    ctx.addIssue({ code: 'custom', path: ['factory', 'minions', 'medic', 'heal'], message: `must be within the heal support bounds ${hb.power.min}-${hb.power.max}` });
  }
  if (medic.reach === undefined || medic.reach < hb.range.min || medic.reach > hb.range.max) {
    ctx.addIssue({ code: 'custom', path: ['factory', 'minions', 'medic', 'reach'], message: `must be within the heal support bounds ${hb.range.min}-${hb.range.max}` });
  }
  // Burst (§5.3): whole minions, at least 1, and stored minions count toward the per-factory cap.
  const burst = b.burst;
  if (!Number.isInteger(burst.min) || !Number.isInteger(burst.max) || burst.min < 1) {
    ctx.addIssue({ code: 'custom', path: ['stats', 'bounds', 'burst'], message: 'must be whole numbers >= 1' });
  }
  if (burst.max > c.factory.maxAlivePerFactory) {
    ctx.addIssue({ code: 'custom', path: ['stats', 'bounds', 'burst', 'max'], message: `must be <= factory.maxAlivePerFactory (${c.factory.maxAlivePerFactory})` });
  }
});

export type GameConfig = z.infer<typeof ConfigSchema>;
export type SandboxMode = GameConfig['sandbox']['mode'];

export const DEFAULT_CONFIG: GameConfig = {
  // The $10,000 redesign (§6). Stored config patches from older economies are migrated (`migrateEconomyPatch`).
  economyVersion: 3,
  cost: {
    base: 50,
    hp: 0.1875,
    damage: 1.875,
    range: 1.38,
    speed: 90,
    size: 8,
    referenceCooldown: 60,
    curveK: 1,
    powerFactor: 2,
    splash: 0.8,
    element: { fire: 1.3, ice: 1.75, lightning: 1.3 },
    heal: 3.5,
    aura: { haste: 9, might: 8, shield: 7 },
    // §6 Walls and factories (×5 in M8.8).
    wall: { base: 20, hp: 0.0375 },
    factory: { base: 50, hp: 0.5, minionDiscount: 0.5 },
  },
  stats: {
    bounds: {
      nameLength: { min: 1, max: 24 },
      maxHealth: { min: 80, max: 4000 },
      damage: { min: 0, max: 240 },
      range: { min: 20, max: 300 },
      soldierSpeed: { min: 0.5, max: 5 },
      soldierRange: { min: 20, max: 160 },
      attackCooldown: { min: 10, max: 600 },
      size: { min: 6, max: 20 },
      wallHealth: { min: 400, max: 12000 },
      factoryHealth: { min: 120, max: 1200 },
      productionInterval: { min: 300, max: 1200 },
      burst: { min: 1, max: 4 },
      splashRadius: { min: 0, max: 80 },
      support: {
        heal: { power: { min: 15, max: 400 }, range: { min: 20, max: 200 } },
        haste: { power: { min: 5, max: 50 }, range: { min: 40, max: 150 } },
        might: { power: { min: 5, max: 50 }, range: { min: 40, max: 150 } },
        shield: { power: { min: 5, max: 40 }, range: { min: 40, max: 150 } },
      },
    },
  },
  caps: {
    unitCost: 3000,
    budget: 10000,
    maxDesigns: 8,
    maxUnitTypes: 4,
    maxBuildingTypes: 4,
    maxCopies: 12,
    maxFactoryCopies: 5,
    maxWallCopies: 16,
    maxSourceBytes: 64 * 1024, // §7 step 1: sprites take room
    copyRamp: { freeCopies: 3, pctPerCopy: 15 },
  },
  timers: {
    defaultRounds: 3,
    planFirstRoundSec: 15 * 60,
    planLaterRoundsSec: 8 * 60,
    placementSec: 3 * 60,
    battleTicks: 7200,
    ticksPerSecond: 60,
    autoAdvanceWhenAllReady: false,
  },
  match: {
    maxPlayers: 8,
  },
  scoring: {
    damageBonusMax: 2,
    valueBonusMax: 1,
    topUnitsShown: 3,
  },
  suddenDeath: {
    // Tuned in M6 against tests/balance.test.ts (docs/balance.md): from 50 s,
    // 7% of max HP per second, so all-tower armies lose towers before 90 s.
    startTick: 4500,
    endTick: 7200,
    startRadius: 570,
    endRadius: 60,
    damagePctPerSecond: 10,
  },
  sim: {
    meleeMaxRange: 50,
    projectileSpeed: 10,
    rangeTolerance: 0.5,
    separationPasses: 2,
    frameEveryTicks: 2,
    slideMemoryTicks: 45,
    replanTicks: 10,
    routeRoundBuildings: true,
  },
  factory: {
    maxMinionsPerFactory: 12,
    // Off by default: on, it nerfed attacking factory armies and broke the 70% cap
    // without moving the factory camp (§14 "Factories stop at sudden death").
    stopAtSuddenDeath: false,
    // Off by default (user, 2026-10-25, after the measurements: "turn it off by
    // default"): on, the factory camp got stronger (62.9% -> 66.7%), attacking
    // factory armies collapsed and 4 rules failed (§14 "Factories die at sudden death").
    dieAtSuddenDeath: false,
    // Off by default: on, the camp fell (62.9% -> 42.1%) but attacking factory armies
    // collapsed and 12 rules failed (§14 "Minions die with their factory").
    minionsDieWithFactory: false,
    // With the option on, only minions within 120 px crumble: the one radius that kept
    // every rule (camp 62.9% -> 60.4%; §14 "Only minions near the factory crumble").
    crumbleRadius: 120,
    maxAlivePerFactory: 4,
    maxAlivePerPlayer: 12,
    maxAlivePerBattle: 40,
    rallyGuardRadius: 200,
    rallyArriveRadius: 24,
    defendRadius: 160,
    defendArriveRadius: 48,
    guardRadius: 120,
    guardArriveGap: 16,
    // §5.3 minion kinds (M8.6, ×5 in M8.8). grunt = the M8.5 minion; each must be a legal soldier.
    minions: {
      grunt: { maxHealth: 360, damage: 20, range: 20, speed: 1.5, attackCooldown: 60, size: 8, aggroRange: 120, impatientTicks: 120, wallDamageMultiplier: 1 },
      archer: { maxHealth: 240, damage: 20, range: 110, speed: 1.2, attackCooldown: 60, size: 7, aggroRange: 150, impatientTicks: 120, wallDamageMultiplier: 1 },
      runner: { maxHealth: 480, damage: 24, range: 20, speed: 2.6, attackCooldown: 60, size: 6, aggroRange: 120, impatientTicks: 120, wallDamageMultiplier: 1 },
      brute: { maxHealth: 1100, damage: 32, range: 20, speed: 0.9, attackCooldown: 60, size: 11, aggroRange: 120, impatientTicks: 30, wallDamageMultiplier: 3 },
      // M8.8 (§5.5): never attacks; heals 60 HP within 60 px, cleanses burning and frozen allies first.
      medic: { maxHealth: 300, damage: 0, range: 20, speed: 1.4, attackCooldown: 60, size: 7, aggroRange: 150, impatientTicks: 120, wallDamageMultiplier: 1, heal: 60, reach: 60 },
    },
  },
  elements: {
    fire: { burnPct: 50, pulses: 6, pulseTicks: 30 },
    ice: { slowPct: 35, ticks: 120 },
    lightning: { chancePct: 35, hopRange: 100, burningExtraHops: 2 },
    shatterPct: 40,
    kindlePct: 25,
    brittlePct: 25,
    splashPct: 50,
  },
  support: {
    // Heals stop at suddenDeath.startTick (§5.5).
    healRoomPctPerSecond: 4,
  },
  accuracy: {
    // Gentle (the user: "tune against scouts"): at most 20% at speed 5 or more.
    missMaxPct: 20,
    speedRef: 5,
  },
  sandbox: {
    mode: 'ivm',
    memoryLimitMb: 32,
    validation: {
      evalBudgetMs: 1000,
      constructTimeoutMs: 50,
      dryRunCallTimeoutMs: 20,
      slowUpdateWarnMs: 2,
    },
    battle: {
      hardTimeoutMs: 12,
      softTimeoutMs: 6,
      disposeGraceMs: 10,
      culpritProbeTimeoutMs: 5,
      unitStrikeLimit: 30,
      timeoutsToDisable: 2,
      timeoutsInARowLimit: 3,
      timeoutsTotalLimit: 5,
      slowStrikeLimit: 30,
    },
  },
  rateLimits: {
    loginPerMinute: 5,
    validatePerSecond: 1,
    submitMinIntervalMs: 3000,
  },
};

/** A recursive partial, used for config overrides and `PUT /admin/config`. */
export type DeepPartial<T> = T extends readonly (infer _U)[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` over `base`. Arrays and scalars in the patch replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out as T;
}

/**
 * Rewrite keys of older config files/patches to the current shape. Today:
 * `factory.minion` becomes `factory.minions.grunt` (M8.6), `caps.maxTypes` is dropped (M8.5 replaced it with maxUnitTypes and
 * maxBuildingTypes, which keep their defaults), and the fixed place-points table (the top-level `points` array, later
 * `scoring.placePoints`) is gone: place points are the §9 formula, so both
 * keys are dropped. Returns a new object; anything that isn't a plain object
 * is returned unchanged.
 */
export function migrateConfigPatch<T>(patch: T): T {
  if (!isPlainObject(patch)) return patch;
  let out: Record<string, unknown> = patch;
  // M8.5: caps.maxTypes (≤ 3 types in total) became maxUnitTypes + maxBuildingTypes.
  if (isPlainObject(out.caps) && 'maxTypes' in out.caps) {
    const { maxTypes: _maxTypes, ...caps } = out.caps;
    out = { ...out, caps };
  }
  // M8.6: the one built-in minion (factory.minion) became the grunt of factory.minions.
  if (isPlainObject(out.factory) && 'minion' in out.factory) {
    const { minion, ...factory } = out.factory;
    const minions = isPlainObject(factory.minions) ? factory.minions : {};
    const grunt = isPlainObject(minions.grunt) ? minions.grunt : {};
    out = { ...out, factory: { ...factory, minions: { ...minions, grunt: { ...(isPlainObject(minion) ? minion : {}), ...grunt } } } };
  }
  const hasLegacyScoring = isPlainObject(out.scoring) && 'placePoints' in out.scoring;
  if (!('points' in out) && !hasLegacyScoring) return out as T;
  const { points: _points, ...rest } = out;
  if (!isPlainObject(rest.scoring)) return rest as T;
  const { placePoints: _placePoints, ...scoring } = rest.scoring;
  return { ...rest, scoring } as T;
}

/** The economy the defaults are for: 3 = the $10,000 redesign (2 was the ×5 $5,000 game, absent the $1,000 game). */
export const ECONOMY_VERSION = 3;

/**
 * The keys an older-economy config patch may not keep (§6 migration): every
 * money, HP and damage number changed scale (M8.8: ×5; the redesign: HP ×1.6,
 * damage ×0.8, a $10,000 budget, 120 s battles and new factory numbers), and an
 * old `curveK`, `cost.hp` or battle length would silently undo the retune.
 */
export const ECONOMY_DROPPED = [
  'cost',
  'caps.budget',
  'caps.unitCost',
  'caps.maxFactoryCopies',
  'caps.maxWallCopies',
  'stats.bounds.maxHealth',
  'stats.bounds.damage',
  'stats.bounds.wallHealth',
  'stats.bounds.factoryHealth',
  'stats.bounds.productionInterval',
  'stats.bounds.support.heal.power',
  'timers.battleTicks',
  'suddenDeath.startTick',
  'suddenDeath.endTick',
  'factory.maxMinionsPerFactory',
  'factory.maxAlivePerPlayer',
  'factory.minions.*.maxHealth',
  'factory.minions.*.damage',
  'factory.minions.*.heal',
] as const;
/** @deprecated the M8.8 name of `ECONOMY_DROPPED`. */
export const ECONOMY_V2_DROPPED = ECONOMY_DROPPED;

/** Delete the dotted path `path` (a `*` segment matches every key) from `obj`, collecting the dropped leaf paths. */
function dropPath(obj: Record<string, unknown>, path: string[], at: string, dropped: string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  const keys = head === '*' ? Object.keys(obj) : [head];
  for (const k of keys) {
    if (!(k in obj)) continue;
    const here = at ? `${at}.${k}` : k;
    if (rest.length === 0) {
      dropped.push(...leafPaths(obj[k], here));
      delete obj[k];
    } else if (isPlainObject(obj[k])) {
      const child = { ...obj[k] };
      obj[k] = child;
      dropPath(child, rest, here, dropped);
    }
  }
}

/**
 * The economy step (§6 migration) for a STORED config patch (the server's
 * `configPatch` in state.json): a patch without `economyVersion: 3` was made
 * for an older economy, so its scale-sensitive keys (`ECONOMY_DROPPED`) are
 * dropped and the rest (plan timers, map, scoring, …) is kept. Returns the
 * migrated patch (stamped with the current economyVersion when it has any
 * content) and the dropped key paths, for the log and the admin banner. A
 * mechanical conversion is deliberately not done.
 *
 * Not part of `parseConfig`: a fresh override such as `{ cost: { base: 55 } }`
 * is already at the new scale.
 */
export function migrateEconomyPatch<T>(patch: T): { patch: T; dropped: string[] } {
  if (!isPlainObject(patch)) return { patch, dropped: [] };
  const src = migrateConfigPatch(patch) as Record<string, unknown>;
  if (src.economyVersion === ECONOMY_VERSION) return { patch: src as T, dropped: [] };
  const dropped: string[] = [];
  const out: Record<string, unknown> = { ...src };
  delete out.economyVersion;
  for (const path of ECONOMY_DROPPED) dropPath(out, path.split('.'), '', dropped);
  const pruned = prune(out) as Record<string, unknown>;
  return { patch: (Object.keys(pruned).length > 0 ? { ...pruned, economyVersion: ECONOMY_VERSION } : pruned) as T, dropped };
}

function leafPaths(v: unknown, at: string): string[] {
  if (!isPlainObject(v)) return [at];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) out.push(...leafPaths(x, `${at}.${k}`));
  return out.length > 0 ? out : [at];
}

/** Drop empty objects left behind by a migration. */
function prune(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const p = prune(x);
    if (isPlainObject(p) && Object.keys(p).length === 0) continue;
    out[k] = p;
  }
  return out;
}

/**
 * Merge a partial config over `base` (default: DEFAULT_CONFIG) and validate.
 * Legacy keys are migrated first (`migrateConfigPatch`).
 * Throws a ZodError on invalid input; use `safeParseConfig` to get errors.
 */
export function parseConfig(patch: unknown = {}, base: GameConfig = DEFAULT_CONFIG): GameConfig {
  return ConfigSchema.parse(deepMerge(base, migrateConfigPatch(patch)));
}

export function safeParseConfig(patch: unknown = {}, base: GameConfig = DEFAULT_CONFIG) {
  return ConfigSchema.safeParse(deepMerge(base, migrateConfigPatch(patch)));
}
