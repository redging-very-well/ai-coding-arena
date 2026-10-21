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
});
export type StatBounds = z.infer<typeof StatBoundsSchema>;

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
    /** Max unit types fielded per round. */
    maxTypes: posInt(),
    /** Max copies placed per player. */
    maxCopies: posInt(),
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
  }),
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
       * this the unit's ticks just idle (one stall can be GC, not the kid).
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
});

export type GameConfig = z.infer<typeof ConfigSchema>;
export type SandboxMode = GameConfig['sandbox']['mode'];

export const DEFAULT_CONFIG: GameConfig = {
  cost: { base: 10, hp: 0.25, damage: 1.5, range: 0.2, speed: 12, size: 0.5, referenceCooldown: 60, curveK: 2 },
  stats: {
    bounds: {
      nameLength: { min: 1, max: 24 },
      maxHealth: { min: 10, max: 500 },
      damage: { min: 0, max: 60 },
      range: { min: 20, max: 300 },
      soldierSpeed: { min: 0.5, max: 5 },
      attackCooldown: { min: 10, max: 600 },
      size: { min: 6, max: 20 },
    },
  },
  caps: {
    unitCost: 500,
    budget: 1000,
    maxDesigns: 8,
    maxTypes: 3,
    maxCopies: 12,
    maxSourceBytes: 64 * 1024, // §7 step 1: sprites take room
  },
  timers: {
    defaultRounds: 3,
    planFirstRoundSec: 15 * 60,
    planLaterRoundsSec: 8 * 60,
    placementSec: 3 * 60,
    battleTicks: 5400,
    ticksPerSecond: 60,
  },
  match: {
    maxPlayers: 8,
  },
  scoring: {
    damageBonusMax: 2,
    valueBonusMax: 1,
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
 * the fixed place-points table (the top-level `points` array, later
 * `scoring.placePoints`) is gone: place points are the §9 formula, so both
 * keys are dropped. Returns a new object; anything that isn't a plain object
 * is returned unchanged.
 */
export function migrateConfigPatch<T>(patch: T): T {
  if (!isPlainObject(patch)) return patch;
  const hasLegacyScoring = isPlainObject(patch.scoring) && 'placePoints' in patch.scoring;
  if (!('points' in patch) && !hasLegacyScoring) return patch;
  const { points: _points, ...rest } = patch;
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
