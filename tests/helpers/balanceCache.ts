// The on-disk result cache of the balance tooling (plan §14, docs/balance.md
// "Fast balance runs"). Battles are deterministic, so a battle's record is a
// pure function of:
//   * the ENGINE: every source file a battle runs through (the sim, the
//     sandbox, the shared rules and costs, the transpile step, the balance
//     harness and the brains), plus the V8 version and CPU architecture
//     (Math.* may round differently elsewhere) and CACHE_FORMAT;
//   * the CONFIG fields that battle can read (`battleConfigDigest`, keyed by
//     `configKey(config, features)`): every config leaf is classified in
//     CONFIG_LEAF_RULES as global (read by every battle: length, sudden
//     death, movement, projectiles, pathing, accuracy, scoring, sandbox,
//     bounds), unread (lobby and economy: caps, plan timers, match size,
//     rate limits, and the cost section, whose prices reach a battle only
//     through each army's priced designs and the minion values, hashed
//     instead) or conditional on a feature of the battle's armies
//     (`featuresOf`: factory.* and the minion values only with a factory,
//     support.* only with healers, auras or medic minions, elements.<e>
//     only with that element, the synergies with any element, splashPct
//     with splash). So a factory-only knob re-plays only the battles with
//     factories, and a heal knob only those with support. A leaf with no
//     rule counts as global, and tests/balance-fast.test.ts fails on it;
//   * both armies as deployed (designs, prices, placements, brains), the map
//     style and size, the zone pair and the seed (`jobKey` in helpers/balance.ts).
// Any engine edit gives a new engine hash, i.e. a fresh cache. Records live in
// `.balance-cache/<engine>/<shard>.duels.jsonl` (round-robin duels; the shard is
// the hash of the config's global fields, `shardKey`) and
// `.battles.jsonl` (whole balanceBattle results: the free-for-alls, Lanes and
// other checks), gitignored, one JSON line per battle, appended as battles
// finish. BALANCE_CACHE=0 turns the cache off; BALANCE_CACHE_DIR moves it.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELEMENTS, MINION_KINDS, type GameConfig } from '@pixel-clash/shared';
import { minionValueOf } from '../../packages/server/src/sim/minion.js';

/** Bump when the record format or the key recipe changes. */
export const CACHE_FORMAT = 2;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Sources a battle depends on (directories are walked for .ts files). */
const ENGINE_SOURCES = [
  'packages/server/src/sim',
  'packages/server/src/sandbox',
  'packages/server/src/validator/transpile.ts',
  'packages/shared/src',
  'tests/helpers/balance.ts',
  'tests/helpers/brains.ts',
  'tests/helpers/brainUnits.ts',
  'tests/helpers/balanceCache.ts',
];

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function sourceFiles(path: string): string[] {
  const abs = join(ROOT, path);
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(abs, f));
}

let engine: string | undefined;

/** The engine hash: every engine source's path and text, the V8 version, the CPU architecture and CACHE_FORMAT. */
export function engineHash(): string {
  if (engine) return engine;
  const h = createHash('sha256');
  h.update(`format ${CACHE_FORMAT} v8 ${process.versions.v8} ${process.arch}\n`);
  for (const file of ENGINE_SOURCES.flatMap(sourceFiles)) {
    h.update(`${relative(ROOT, file)}\n`);
    h.update(readFileSync(file));
  }
  engine = h.digest('hex');
  return engine;
}

// ---------------------------------------------------------------------------
// Relevance: which config fields a battle can read (CACHE_FORMAT 2)
// ---------------------------------------------------------------------------

/**
 * What a battle's armies field that makes a conditional config field
 * readable: factories (minions), support (heal or aura units, medic
 * minions), each element (fire, ice, lightning: units or minions), any
 * element at all (the synergies), splash.
 */
export type BattleFeature = 'factory' | 'support' | 'fire' | 'ice' | 'lightning' | 'element' | 'splash';
export const BATTLE_FEATURES: readonly BattleFeature[] = ['factory', 'support', 'fire', 'ice', 'lightning', 'element', 'splash'];

/** How a config leaf reaches a battle: always, never, or only when the battle has that feature. */
export type LeafClass = 'global' | 'unread' | BattleFeature;

/**
 * Every config leaf, classified by its longest matching dotted prefix. A
 * leaf with no rule counts as global (read by every battle: the safe side),
 * and tests/balance-fast.test.ts fails on it, so a new config field must be
 * classified here before it lands. Conservative: when in doubt, 'global'.
 */
export const CONFIG_LEAF_RULES: ReadonlyArray<readonly [prefix: string, cls: LeafClass]> = [
  // Lobby and economy: never read by a battle. Prices reach it only through
  // each army's priced designs and the minion values (both hashed instead).
  ['economyVersion', 'unread'],
  ['cost', 'unread'],
  ['caps', 'unread'],
  ['match', 'unread'],
  ['rateLimits', 'unread'],
  ['timers.defaultRounds', 'unread'],
  ['timers.planFirstRoundSec', 'unread'],
  ['timers.planLaterRoundsSec', 'unread'],
  ['timers.placementSec', 'unread'],
  ['timers.autoAdvanceWhenAllReady', 'unread'],
  // Every battle: length and clock, sudden death, movement, separation,
  // projectiles, pathing, accuracy, scoring (the ranking), the sandbox
  // limits and the stat bounds (a factory's default interval; kept global).
  ['timers.battleTicks', 'global'],
  ['timers.ticksPerSecond', 'global'],
  ['suddenDeath', 'global'],
  ['sim', 'global'],
  ['accuracy', 'global'],
  ['scoring', 'global'],
  ['sandbox', 'global'],
  ['stats', 'global'],
  // Only with a factory on the field (production, minion caps, orders, kinds, crumbling).
  ['factory', 'factory'],
  // Only with healers (units or medic minions) or aura units.
  ['support', 'support'],
  // Only with that element on the field; the synergies with any element; splash with splash.
  ['elements.fire', 'fire'],
  ['elements.ice', 'ice'],
  ['elements.lightning', 'lightning'],
  ['elements.shatterPct', 'element'],
  ['elements.kindlePct', 'element'],
  ['elements.brittlePct', 'element'],
  ['elements.splashPct', 'splash'],
];

/** The rule of a leaf path (longest prefix), or undefined when none matches. */
export function leafRule(path: string): (readonly [string, LeafClass]) | undefined {
  let best: (readonly [string, LeafClass]) | undefined;
  for (const r of CONFIG_LEAF_RULES) if ((path === r[0] || path.startsWith(`${r[0]}.`)) && (!best || r[0].length > best[0].length)) best = r;
  return best;
}

/** A leaf's class ('global' when no rule matches: the safe side). */
export const leafClass = (path: string): LeafClass => leafRule(path)?.[1] ?? 'global';

/** Every leaf of a config as [dotted path, value] (arrays are leaves). */
export function configLeaves(v: unknown, at = ''): Array<[string, unknown]> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return [[at, v]];
  const out: Array<[string, unknown]> = [];
  for (const k of Object.keys(v).sort()) out.push(...configLeaves((v as Record<string, unknown>)[k], at ? `${at}.${k}` : k));
  return out;
}

/** The design fields that decide a battle's features (a soldier, tower, wall or factory as deployed). */
export interface FeatureStats {
  type: string;
  element?: string | undefined;
  splashRadius?: number | undefined;
  support?: unknown;
  produces?: string | undefined;
  minionElement?: string | undefined;
}

/** The features one design brings to a battle (conservative: a factory brings its minions' element and, for medics, support). */
export function featuresOf(s: FeatureStats, into: Set<BattleFeature> = new Set()): Set<BattleFeature> {
  const element = (e: string | undefined) => {
    if (e === 'fire' || e === 'ice' || e === 'lightning') into.add(e).add('element');
    else if (e !== undefined && e !== 'normal') for (const f of BATTLE_FEATURES) into.add(f); // an element this table doesn't know: everything
  };
  element(s.element);
  if ((s.splashRadius ?? 0) > 0) into.add('splash');
  if (s.support !== null && s.support !== undefined) into.add('support');
  if (s.type === 'factory') {
    into.add('factory');
    if ((s.produces ?? 'grunt') === 'medic') into.add('support');
    else element(s.minionElement);
  }
  return into;
}

/** The config as far as a battle with these features reads it (see the header). */
export function battleConfigDigest(config: GameConfig, features: Iterable<BattleFeature> = BATTLE_FEATURES): unknown {
  const has = new Set<LeafClass>(['global', ...features]);
  const fields = configLeaves(config).filter(([path]) => has.has(leafClass(path)));
  if (!has.has('factory')) return { fields };
  const minionValues: Record<string, number> = {};
  for (const kind of MINION_KINDS) for (const element of ELEMENTS) minionValues[`${kind}/${element}`] = minionValueOf(config, kind, element);
  return { fields, minionValues };
}

const featureKeys = new WeakMap<GameConfig, Map<string, string>>();

/**
 * The config key of a battle with these features: a hash of
 * `battleConfigDigest`. A change to a field no feature of the battle reads
 * (a factory knob in a battle without factories) leaves it alone.
 */
export function configKey(config: GameConfig, features: Iterable<BattleFeature> = BATTLE_FEATURES): string {
  const fs = [...new Set(features)].sort();
  const id = fs.join(',');
  let m = featureKeys.get(config);
  if (!m) featureKeys.set(config, (m = new Map()));
  let k = m.get(id);
  if (!k) {
    k = sha(JSON.stringify(battleConfigDigest(config, fs as BattleFeature[])));
    m.set(id, k);
  }
  return k;
}

/** The shard a config's records live in: its global fields only, so configs that differ in conditional fields share one file. */
export const shardKey = (config: GameConfig): string => configKey(config, []);

const fullKeys = new WeakMap<GameConfig, string>();

/** A hash of the whole config (in-memory memo keys only). */
export function fullConfigKey(config: GameConfig): string {
  let k = fullKeys.get(config);
  if (!k) fullKeys.set(config, (k = sha(JSON.stringify(config))));
  return k;
}

export function cacheEnabled(): boolean {
  const v = process.env.BALANCE_CACHE;
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function cacheDir(): string {
  return process.env.BALANCE_CACHE_DIR || join(ROOT, '.balance-cache');
}

/** Engine versions kept on disk (a new one prunes the least recently made beyond this). */
const KEEP_ENGINES = 6;

function pruneEngines(root: string): void {
  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ path: join(root, d.name), t: statSync(join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(KEEP_ENGINES)) rmSync(d.path, { recursive: true, force: true });
  } catch {
    // Pruning is housekeeping only.
  }
}

/** One shard of the cache: the records of one engine and the global fields of one config (`shardKey`). */
export class BattleCache<R> {
  private readonly file: string;
  private records: Map<string, R> | undefined;

  constructor(config: GameConfig, dir = cacheDir(), kind = 'duels') {
    this.file = join(dir, engineHash().slice(0, 24), `${shardKey(config).slice(0, 24)}.${kind}.jsonl`);
  }

  private load(): Map<string, R> {
    if (this.records) return this.records;
    this.records = new Map();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const { k, r } = JSON.parse(line) as { k: string; r: R };
          this.records.set(k, r);
        } catch {
          // A torn last line (a run killed mid-write): that battle is simply played again.
        }
      }
    }
    return this.records;
  }

  get(key: string): R | undefined {
    return this.load().get(key);
  }

  get size(): number {
    return this.load().size;
  }

  /** Store records (one append per call: whole lines, so concurrent runs don't interleave). */
  putAll(entries: Array<[string, R]>): void {
    if (entries.length === 0) return;
    const recs = this.load();
    for (const [k, r] of entries) recs.set(k, r);
    const dir = join(this.file, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      pruneEngines(join(dir, '..'));
    }
    appendFileSync(this.file, entries.map(([k, r]) => `${JSON.stringify({ k, r })}\n`).join(''));
  }
}
