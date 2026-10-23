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

/** An inclusive numeric range. */
const RangeSchema = z
  .object({ min: finite(), max: finite() })
  .refine((r) => r.min <= r.max, 'min must be <= max');
export type NumRange = z.infer<typeof RangeSchema>;

/**
 * Cost coefficients (§6). Each stat term is convex:
 * term = c * x * (1 + curveK * (x / max)²), so a maxed stat costs (1 + curveK)× its linear price;
 * raw = (base + Σ term) * max(1, refCD / CD).
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
});
export type MinionStats = z.infer<typeof MinionStatsSchema>;

/** The four preset minion kinds (§5.3), keyed like `MinionKind`. */
export const MinionKindsSchema = z.object({
  grunt: MinionStatsSchema,
  archer: MinionStatsSchema,
  runner: MinionStatsSchema,
  brute: MinionStatsSchema,
});
export type MinionKindsConfig = z.infer<typeof MinionKindsSchema>;

export const FactorySchema = z.object({
  /** Most minions one factory makes in a battle (E's cap, §6). */
  maxMinionsPerFactory: posInt(),
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

export const ConfigSchema = z.object({
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
  }),
  /** Factories and their built-in minions (§5.2, §9.3). */
  factory: FactorySchema,
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
  const within: Array<[keyof MinionStats, { min: number; max: number }]> = [
    ['maxHealth', b.maxHealth],
    ['damage', b.damage],
    ['range', b.range],
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
  cost: {
    base: 10,
    hp: 0.25,
    damage: 1.5,
    range: 0.2,
    speed: 12,
    size: 0.5,
    referenceCooldown: 60,
    curveK: 2,
    // §6 Walls and factories (first guesses, checked by tests/balance.test.ts).
    wall: { base: 4, hp: 0.06 },
    factory: { base: 10, hp: 0.12, minionDiscount: 0.5 },
  },
  stats: {
    bounds: {
      nameLength: { min: 1, max: 24 },
      maxHealth: { min: 10, max: 500 },
      damage: { min: 0, max: 60 },
      range: { min: 20, max: 300 },
      soldierSpeed: { min: 0.5, max: 5 },
      attackCooldown: { min: 10, max: 600 },
      size: { min: 6, max: 20 },
      wallHealth: { min: 50, max: 1500 },
      factoryHealth: { min: 100, max: 1000 },
      productionInterval: { min: 600, max: 1800 },
      burst: { min: 1, max: 4 },
    },
  },
  caps: {
    unitCost: 500,
    budget: 1000,
    maxDesigns: 8,
    maxUnitTypes: 4,
    maxBuildingTypes: 4,
    maxCopies: 12,
    maxFactoryCopies: 2,
    maxWallCopies: 12,
    maxSourceBytes: 64 * 1024, // §7 step 1: sprites take room
  },
  timers: {
    defaultRounds: 3,
    planFirstRoundSec: 15 * 60,
    planLaterRoundsSec: 8 * 60,
    placementSec: 3 * 60,
    battleTicks: 5400,
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
    startTick: 3000,
    endTick: 5400,
    startRadius: 570,
    endRadius: 60,
    damagePctPerSecond: 7,
  },
  sim: {
    meleeMaxRange: 50,
    projectileSpeed: 10,
    rangeTolerance: 0.5,
    separationPasses: 2,
    frameEveryTicks: 2,
    slideMemoryTicks: 45,
  },
  factory: {
    maxMinionsPerFactory: 8,
    maxAlivePerFactory: 4,
    maxAlivePerPlayer: 6,
    maxAlivePerBattle: 40,
    rallyGuardRadius: 200,
    rallyArriveRadius: 24,
    defendRadius: 160,
    defendArriveRadius: 48,
    guardRadius: 120,
    guardArriveGap: 16,
    // §5.3 minion kinds (M8.6). grunt = the M8.5 minion; each must be a legal soldier.
    minions: {
      grunt: { maxHealth: 40, damage: 5, range: 20, speed: 1.5, attackCooldown: 60, size: 8, aggroRange: 120, impatientTicks: 120, wallDamageMultiplier: 1 },
      archer: { maxHealth: 24, damage: 5, range: 110, speed: 1.2, attackCooldown: 60, size: 7, aggroRange: 150, impatientTicks: 120, wallDamageMultiplier: 1 },
      runner: { maxHealth: 28, damage: 4, range: 20, speed: 2.6, attackCooldown: 60, size: 6, aggroRange: 120, impatientTicks: 120, wallDamageMultiplier: 1 },
      brute: { maxHealth: 100, damage: 8, range: 20, speed: 0.9, attackCooldown: 60, size: 11, aggroRange: 120, impatientTicks: 30, wallDamageMultiplier: 3 },
    },
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
