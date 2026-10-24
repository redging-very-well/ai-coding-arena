// The on-disk result cache of the balance tooling (plan §14, docs/balance.md
// "Fast balance runs"). Battles are deterministic, so a battle's record is a
// pure function of:
//   * the ENGINE: every source file a battle runs through (the sim, the
//     sandbox, the shared rules and costs, the transpile step, the balance
//     harness and the brains), plus the V8 version and CPU architecture
//     (Math.* may round differently elsewhere) and CACHE_FORMAT;
//   * the CONFIG fields a battle reads (`battleConfigDigest`): everything but
//     the lobby/economy fields the sim never reads (caps, plan timers, match
//     size, rate limits). The cost section is left out too: prices reach a battle only
//     through the unit costs and minion values, and those are hashed instead
//     (each army's priced designs; the minion value of every kind and
//     element), so a price tweak re-plays only the battles whose numbers changed;
//   * both armies as deployed (designs, prices, placements, brains), the map
//     style and size, the zone pair and the seed (`jobKey` in helpers/balance.ts).
// Any engine edit gives a new engine hash, i.e. a fresh cache. Records live in
// `.balance-cache/<engine>/<config>.duels.jsonl` (round-robin duels) and
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
export const CACHE_FORMAT = 1;

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

/** The config as far as a battle reads it (see the header). */
export function battleConfigDigest(config: GameConfig): unknown {
  const { cost: _cost, caps: _caps, economyVersion: _ev, match: _match, rateLimits: _rl, timers, ...rest } = config;
  const minionValues: Record<string, number> = {};
  for (const kind of MINION_KINDS) for (const element of ELEMENTS) minionValues[`${kind}/${element}`] = minionValueOf(config, kind, element);
  return { ...rest, timers: { battleTicks: timers.battleTicks, ticksPerSecond: timers.ticksPerSecond }, minionValues };
}

const configKeys = new WeakMap<GameConfig, string>();

/** The config key: a hash of `battleConfigDigest`. */
export function configKey(config: GameConfig): string {
  let k = configKeys.get(config);
  if (!k) {
    k = sha(JSON.stringify(battleConfigDigest(config)));
    configKeys.set(config, k);
  }
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

/** One shard of the cache: the records of one engine and config. */
export class BattleCache<R> {
  private readonly file: string;
  private records: Map<string, R> | undefined;

  constructor(config: GameConfig, dir = cacheDir(), kind = 'duels') {
    this.file = join(dir, engineHash().slice(0, 24), `${configKey(config).slice(0, 24)}.${kind}.jsonl`);
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
