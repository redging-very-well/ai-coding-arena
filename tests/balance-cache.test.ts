// The relevance-aware result cache, on real battles (helpers/balanceCache.ts,
// docs/balance.md "Fast balance runs"): a config patch that only touches
// factory (or support, or one element's) fields re-uses the cached records
// of every battle without that feature and re-plays the rest, and the
// records it re-uses are exactly what playing them again under the patched
// config gives (cached vs uncached parity). Plays a few dozen battles, so it
// runs in the balance pass (vitest.config.ts BALANCE_FILES). The key-only
// checks over the whole pool are in tests/balance-fast.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archetypeByKey, battleFeatures, pairJobs, runJobs, runStats, type BattleJob, type BattleRecord } from './helpers/balance.js';
import type { BattleFeature } from './helpers/balanceCache.js';

let dir = '';
const savedDir = process.env.BALANCE_CACHE_DIR;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-balance-cache-'));
  process.env.BALANCE_CACHE_DIR = dir;
});
afterAll(() => {
  if (savedDir === undefined) delete process.env.BALANCE_CACHE_DIR;
  else process.env.BALANCE_CACHE_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

// Four duels per pair (seed 11, the first site, both zone pairs, both orders): plain, factory, support, fire, medic factories.
const PAIRS: Array<[string, string]> = [
  ['tanks', 'turtle'],
  ['swarm', 'tanks'],
  ['healerball', 'templates'],
  ['firesquad', 'turtle'],
  ['medictent', 'bricks'],
];
const jobs: BattleJob[] = PAIRS.flatMap(([a, b]) => pairJobs(archetypeByKey(a), archetypeByKey(b), [11]).slice(0, 4));
const strip = (r: BattleRecord) => ({ ...r, ms: 0 });

async function run(patch: unknown, cache: boolean): Promise<{ recs: BattleRecord[]; played: number; cached: number }> {
  const before = { ...runStats };
  const recs = await runJobs(jobs, patch, { cache, workers: 1 });
  return { recs, played: runStats.played - before.played, cached: runStats.cached - before.cached };
}

describe('relevance-aware result cache (real battles)', () => {
  it('a feature-only patch re-plays exactly the battles with that feature, and the re-used records match an uncached run', async () => {
    const base = await run(undefined, true);
    expect(base.played + base.cached).toBe(jobs.length);
    expect((await run(undefined, true)).cached).toBe(jobs.length);

    const patches: Array<[BattleFeature, unknown]> = [
      ['factory', { factory: { minionsDieWithFactory: true, crumbleRadius: 200 } }],
      ['support', { support: { healRoomPctPerSecond: 10 } }],
      ['fire', { elements: { fire: { burnPct: 80 } } }],
    ];
    for (const [feature, patch] of patches) {
      const want = jobs.filter((j) => battleFeatures([j.a, j.b]).includes(feature)).length;
      expect(want, feature).toBeGreaterThan(0);
      expect(want, feature).toBeLessThan(jobs.length);
      const cached = await run(patch, true);
      expect(cached.played, `${feature}: battles re-played`).toBe(want);
      expect(cached.cached, `${feature}: battles re-used`).toBe(jobs.length - want);
      const fresh = await run(patch, false);
      expect(fresh.played).toBe(jobs.length);
      expect(cached.recs.map(strip), `${feature}: cached vs uncached`).toEqual(fresh.recs.map(strip));
    }
  }, 300_000);
});
