// The fast balance tooling's logic:
// early stopping (helpers/balanceFast.ts) must give the full matrix's
// verdicts in 'exact' mode whatever the outcomes, and the result cache's keys
// (helpers/balanceCache.ts, helpers/balance.ts jobKey) must change exactly
// when something a battle reads changes. No battles are played here.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@pixel-clash/shared';
import { mulberry32 } from '../packages/server/src/sim/prng.js';
import { ALL_ARCHETYPES, allPairs, archetypeByKey, balanceConfig, battleFeatures, jobKey, pairJobs, type BattleJob } from './helpers/balance.js';
import { BATTLE_FEATURES, CONFIG_LEAF_RULES, configKey, configLeaves, engineHash, featuresOf, leafRule, shardKey, type BattleFeature } from './helpers/balanceCache.js';
import { cellProbability, exactCell, sequential, spreadOrder, type Cell, type Outcome } from './helpers/balanceFast.js';
import { FULL_DOMINANCE_EXCEPTIONS, STATED, WATCH_ITEMS, testRules, type MatrixDef, type Rule } from './helpers/balanceRules.js';

describe('early stopping (helpers/balanceFast.ts)', () => {
  it('exact cell bounds: decided only when no unplayed outcome can change it', () => {
    expect(exactCell('beats', { w: 5, d: 0, l: 0, r: 3, n: 8 })).toBe(true);
    expect(exactCell('beats', { w: 4, d: 0, l: 0, r: 4, n: 8 })).toBeUndefined();
    expect(exactCell('beats', { w: 0, d: 0, l: 4, r: 4, n: 8 })).toBe(false);
    expect(exactCell('notBeats', { w: 0, d: 0, l: 4, r: 4, n: 8 })).toBe(true);
    expect(exactCell('winsMost', { w: 5, d: 0, l: 0, r: 3, n: 8 })).toBe(true);
    expect(exactCell('winsMost', { w: 4, d: 0, l: 0, r: 4, n: 8 })).toBeUndefined();
    expect(exactCell('winsMost', { w: 0, d: 0, l: 4, r: 4, n: 8 })).toBe(false);
    expect(exactCell('losesMore', { w: 0, d: 1, l: 5, r: 2, n: 8 })).toBe(true);
    expect(exactCell({ winFrac: 0.75 }, { w: 6, d: 0, l: 0, r: 2, n: 8 })).toBe(true);
    expect(exactCell({ winFrac: 0.75 }, { w: 3, d: 0, l: 2, r: 3, n: 8 })).toBeUndefined();
    expect(exactCell({ winFrac: 0.75 }, { w: 2, d: 0, l: 3, r: 3, n: 8 })).toBe(false);
  });

  it('cell odds: a predicate and its negation add up to 1; lopsided cells are near certain', () => {
    for (const x of [
      { w: 2, d: 0, l: 0, r: 6, n: 8 },
      { w: 1, d: 1, l: 2, r: 4, n: 8 },
      { w: 0, d: 0, l: 0, r: 16, n: 16 },
    ]) {
      expect(cellProbability('beats', x) + cellProbability('notBeats', x)).toBeCloseTo(1, 9);
    }
    expect(cellProbability('beats', { w: 4, d: 0, l: 0, r: 4, n: 8 })).toBeGreaterThan(0.99);
    expect(cellProbability('beats', { w: 0, d: 0, l: 0, r: 8, n: 8 })).toBeCloseTo(cellProbability('losesMore', { w: 0, d: 0, l: 0, r: 8, n: 8 }), 9);
  });

  it('the spread order is a permutation that plays both maps, both zone pairs and both orders first', () => {
    const order = spreadOrder(8);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // pairJobs nests site (4s) > zone pair (2s) > order (1s): the first four cover both sites and zone pairs.
    const first = order.slice(0, 4);
    expect(new Set(first.map((i) => i >> 2)).size).toBe(2);
    expect(new Set(first.map((i) => (i >> 1) & 1)).size).toBe(2);
    expect(spreadOrder(6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("'exact' mode gives the full matrix's verdict on every rule, over random matrices", async () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 40; trial++) {
      const keys = Array.from({ length: 6 + (trial % 4) }, (_, i) => `k${i}`);
      const strength = keys.map(() => rng());
      const n = trial % 3 === 0 ? 16 : 8;
      const truth = new Map<string, Outcome[]>();
      for (const [a, b] of allPairs(keys)) {
        const pa = strength[keys.indexOf(a)]!;
        const pb = strength[keys.indexOf(b)]!;
        truth.set(`${a}|${b}`, Array.from({ length: n }, () => {
          const x = rng() * (pa + pb + 0.1);
          return x < pa ? 1 : x < pa + pb ? -1 : 0;
        }) as Outcome[]);
      }
      const matrices: MatrixDef[] = [{ name: 'all', keys, caps: { k0: 0.8 }, losingMatchup: true }];
      const rules: Rule[] = keys.flatMap((row) => [
        { kind: 'cap' as const, matrix: 'all', row, cap: row === 'k0' ? 0.8 : 0.6, label: `${row} cap` },
        { kind: 'struct' as const, matrix: 'all', row, what: 'beatsSomeone' as const, label: `${row} beats someone` },
        { kind: 'struct' as const, matrix: 'all', row, what: 'notBeatsAll' as const, label: `${row} not all` },
        { kind: 'struct' as const, matrix: 'all', row, what: 'losesToSomeone' as const, label: `${row} loses` },
      ]);
      rules.push({ kind: 'cells', checks: [{ a: 'k1', b: 'k0', pred: 'winsMost' }], all: true, label: 'stated' });
      rules.push({ kind: 'cells', checks: [{ a: 'k2', b: 'k3', pred: { winFrac: 0.75 } }, { a: 'k2', b: 'k4', pred: 'losesMore' }], all: false, label: 'either' });
      const run = async (mode: 'exact' | 'full') => {
        const cells: Cell[] = allPairs(keys).map(([a, b]) => ({ a, b, outcomes: Array(n).fill(undefined) }));
        const res = await sequential(cells, matrices, rules, async (wanted) => {
          for (const w of wanted) for (const j of w.jobs) w.cell.outcomes[j] = truth.get(`${w.cell.a}|${w.cell.b}`)![j];
        }, { mode, alpha: 0.001, first: 2, step: 2 });
        return res;
      };
      const exact = await run('exact');
      const full = await run('full');
      expect(exact.states.map((s) => s.verdict), `trial ${trial}`).toEqual(full.states.map((s) => s.verdict));
      expect(exact.states.every((s) => s.verdict !== undefined)).toBe(true);
      expect(exact.played).toBeLessThanOrEqual(full.played);
    }
  });

  it("the CLI's rules are the balance test's: every matrix, cap, stated outcome and shape check", () => {
    // A custom selection is its own matrix (the redesign dropped the old 6, 13 and 17 sub-matrices).
    const keys = ['bricks', 'templates', 'tanks', 'turtle', 'scouts', 'snipers'];
    const { matrices, rules } = testRules(keys);
    expect(matrices.map((m) => m.name)).toEqual(['selected']);
    expect(rules.filter((r) => r.kind === 'cap')).toHaveLength(6);
    expect(rules.filter((r) => r.kind === 'struct')).toHaveLength(18); // beats someone, not everyone, loses to someone
    expect(rules.filter((r) => r.kind === 'cells').map((r) => r.label)).toEqual([
      'shape: bricks beat tanks',
      'shape: turtle beats templates',
      "shape: tanks don't beat the turtle",
    ]);
    // The whole pool: the full matrix with its recorded exception and watch item, and every stated outcome.
    const all = testRules(ALL_ARCHETYPES.map((a) => a.key));
    expect(all.matrices.map((m) => m.name)).toEqual(['full']);
    expect(all.matrices[0]!.caps).toEqual({ bricks: FULL_DOMINANCE_EXCEPTIONS.bricks!.roundRobinWinCap, soldiersFilled: WATCH_ITEMS.soldiersFilled!.roundRobinWinCap });
    expect(all.rules.filter((r) => r.kind === 'cap')).toHaveLength(ALL_ARCHETYPES.length);
    expect(all.rules.filter((r) => r.kind === 'struct')).toHaveLength(3 * ALL_ARCHETYPES.length);
    expect(all.rules.filter((r) => r.kind === 'cells' && r.stated)).toHaveLength(STATED.length);
  });
});

describe('result cache keys (helpers/balanceCache.ts)', () => {
  const job = pairJobs(archetypeByKey('templates'), archetypeByKey('turtle'), [11])[0]!;

  it('the same battle has the same key; the engine hash is stable', () => {
    expect(jobKey(job, DEFAULT_CONFIG)).toBe(jobKey({ ...job }, balanceConfig({})));
    expect(engineHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(engineHash()).toBe(engineHash());
  });

  it('fields a battle never reads leave the key alone; everything else changes it', () => {
    const base = jobKey(job, DEFAULT_CONFIG);
    // Lobby and economy limits: not read by a battle.
    expect(jobKey(job, balanceConfig({ caps: { budget: 7000, maxCopies: 20 } }))).toBe(base);
    expect(jobKey(job, balanceConfig({ timers: { planLaterRoundsSec: 99 } }))).toBe(base);
    expect(configKey(balanceConfig({ rateLimits: { loginPerMinute: 99 } }))).toBe(configKey(DEFAULT_CONFIG));
    // Rules of the fight.
    expect(jobKey(job, balanceConfig({ accuracy: { missMaxPct: 10 } }))).not.toBe(base);
    // Conditional fields: this duel has no splash, factories or support, so their knobs leave it alone.
    expect(jobKey(job, balanceConfig({ elements: { splashPct: 60 } }))).toBe(base);
    expect(jobKey(job, balanceConfig({ suddenDeath: { damagePctPerSecond: 5 } }))).not.toBe(base);
    expect(jobKey(job, balanceConfig({ timers: { battleTicks: 6000 } }))).not.toBe(base);
    // Prices reach a battle through the armies' costs: a price both armies pay changes the key.
    expect(jobKey(job, balanceConfig({ cost: { hp: DEFAULT_CONFIG.cost.hp * 1.1 } }))).not.toBe(base);
    // Another seed, zone pair, order or army.
    expect(jobKey({ ...job, seed: 12 }, DEFAULT_CONFIG)).not.toBe(base);
    expect(jobKey({ ...job, zones: [job.zones[1], job.zones[0]] }, DEFAULT_CONFIG)).not.toBe(base);
    expect(jobKey({ ...job, b: archetypeByKey('snipers') }, DEFAULT_CONFIG)).not.toBe(base);
    expect(jobKey({ ...job, b: { ...job.b, soldierBrain: 'hold' } }, DEFAULT_CONFIG)).not.toBe(base);
    expect(jobKey(job, DEFAULT_CONFIG, 'ivm')).not.toBe(base);
  });

  it('a price only the factories pay changes only battles with factories', () => {
    const patch = { cost: { factory: { ...DEFAULT_CONFIG.cost.factory, base: DEFAULT_CONFIG.cost.factory.base + 50 } } };
    const plain = pairJobs(archetypeByKey('tanks'), archetypeByKey('turtle'), [11])[0]!;
    const withFactories = pairJobs(archetypeByKey('swarm'), archetypeByKey('turtle'), [11])[0]!;
    expect(jobKey(plain, balanceConfig(patch))).toBe(jobKey(plain, DEFAULT_CONFIG));
    expect(jobKey(withFactories, balanceConfig(patch))).not.toBe(jobKey(withFactories, DEFAULT_CONFIG));
  });

  it('a price only the factories pay changes only battles with factories (and never the shard)', () => {
    const patch = { cost: { factory: { ...DEFAULT_CONFIG.cost.factory, base: DEFAULT_CONFIG.cost.factory.base + 50 } } };
    expect(shardKey(balanceConfig(patch))).toBe(shardKey(DEFAULT_CONFIG));
  });
});

describe('relevance-aware cache keys (helpers/balanceCache.ts CONFIG_LEAF_RULES)', () => {
  it('every config leaf is classified (global, unread or conditional), and every rule still matches a leaf', () => {
    const leaves = configLeaves(DEFAULT_CONFIG).map(([path]) => path);
    expect(leaves.length).toBeGreaterThan(100);
    // A new config field must get a rule in CONFIG_LEAF_RULES (when unsure: 'global').
    expect(leaves.filter((p) => leafRule(p) === undefined)).toEqual([]);
    expect(CONFIG_LEAF_RULES.filter(([prefix]) => !leaves.some((p) => p === prefix || p.startsWith(`${prefix}.`))).map(([p]) => p)).toEqual([]);
    // Conditional classes are only the known battle features.
    for (const [, cls] of CONFIG_LEAF_RULES) expect(['global', 'unread', ...BATTLE_FEATURES]).toContain(cls);
  });

  it('the features of a design: factories bring their minions (element, medics = support)', () => {
    const f = (s: Parameters<typeof featuresOf>[0]) => [...featuresOf(s)].sort();
    expect(f({ type: 'soldier', element: 'normal', splashRadius: 0, support: null })).toEqual([]);
    expect(f({ type: 'tower', element: 'ice', splashRadius: 40, support: null })).toEqual(['element', 'ice', 'splash']);
    expect(f({ type: 'soldier', element: 'normal', support: { kind: 'haste', power: 10, range: 60 } })).toEqual(['support']);
    expect(f({ type: 'wall', element: 'normal' })).toEqual([]);
    expect(f({ type: 'factory', element: 'normal', minionElement: 'fire' })).toEqual(['element', 'factory', 'fire']);
    expect(f({ type: 'factory', element: 'normal', produces: 'medic', minionElement: 'fire' })).toEqual(['factory', 'support']);
    // An element the table doesn't know: every conditional field counts.
    expect(f({ type: 'soldier', element: 'poison' })).toEqual([...BATTLE_FEATURES].sort());
  });

  // Every duel of the whole pool (seed 11): a patch to one feature's fields re-uses exactly the battles without it.
  const pool = ALL_ARCHETYPES.map((a) => a.key);
  const jobs: BattleJob[] = allPairs(pool).flatMap(([a, b]) => pairJobs(archetypeByKey(a), archetypeByKey(b), [11]));
  const base = jobs.map((j) => jobKey(j, DEFAULT_CONFIG));
  const reuse = (patch: unknown, feature: BattleFeature) => {
    const cfg = balanceConfig(patch);
    let kept = 0;
    let replayed = 0;
    jobs.forEach((j, i) => {
      const has = battleFeatures([j.a, j.b]).includes(feature);
      const same = jobKey(j, cfg) === base[i];
      expect(same, `${j.a.key} vs ${j.b.key}: ${feature} ${has ? 'present, key must change' : 'absent, key must stay'}`).toBe(!has);
      if (same) kept++;
      else replayed++;
    });
    expect(shardKey(cfg)).toBe(shardKey(DEFAULT_CONFIG));
    return { kept, replayed };
  };

  it('a factory-only change re-uses every battle without a factory and re-plays every battle with one', () => {
    const r = reuse({ factory: { minionsDieWithFactory: true, crumbleRadius: 200 } }, 'factory');
    expect(r.kept).toBeGreaterThan(0);
    expect(r.replayed).toBeGreaterThan(0);
    expect(r.kept + r.replayed).toBe(jobs.length);
  });

  it('a support-only change re-uses every battle without support and re-plays every battle with it', () => {
    const r = reuse({ support: { healRoomPctPerSecond: 10 } }, 'support');
    expect(r.kept).toBeGreaterThan(0);
    expect(r.replayed).toBeGreaterThan(0);
  });

  it('an element-only change re-uses every battle without that element', () => {
    expect(reuse({ elements: { fire: { burnPct: 60 } } }, 'fire').replayed).toBeGreaterThan(0);
    expect(reuse({ elements: { splashPct: 60 } }, 'splash').replayed).toBeGreaterThan(0);
  });

  it('a global change re-plays every battle', () => {
    const cfg = balanceConfig({ sim: { projectileSpeed: 12 } });
    expect(jobs.every((j, i) => jobKey(j, cfg) !== base[i])).toBe(true);
    expect(shardKey(cfg)).not.toBe(shardKey(DEFAULT_CONFIG));
    // The all-features key (the default) still covers every field a battle could read.
    expect(configKey(balanceConfig({ factory: { crumbleRadius: 200 } }))).not.toBe(configKey(DEFAULT_CONFIG));
  });
});
