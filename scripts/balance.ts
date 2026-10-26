// `npm run balance`: the fast balance round robin (see docs/architecture.md,
// testing and balance tooling). Plays the archetype matrix of tests/balance.test.ts
// with early stopping (tests/helpers/balanceFast.ts) and the result cache
// (tests/helpers/balanceCache.ts), checks the same rules (the 70% cap and the
// recorded exceptions, beats someone / not everyone / loses to someone, the
// shape checks and the stated outcomes) and prints the summary.
//
//   npm run balance                                   exact early stopping (same verdicts as the full matrix)
//   npm run balance -- --fast                         statistical early stopping (much fewer battles; see the docs)
//   npm run balance -- --full                         every battle
//   npm run balance -- --config patch.json            a deep-partial config patch (file or inline JSON); the
//                                                     archetypes are refit to it (--no-refit: keep the default armies)
//   npm run balance -- --archetypes bricks,tanks,turtle,scouts
//   npm run balance -- --seeds 11,4242                both seeds (16 battles per pair; default: the test's seed 11)
//   npm run balance -- --no-cache --workers 10 --top 15 --all --json out.json
//   npm run balance -- --runner ivm                   confirmation pass on the real sandbox (isolated-vm)
//   npm run balance -- --fast --verify                also play the full matrix and compare the verdicts
//   npm run balance -- --fast --extra camp,camptowers each extra archetype against the pool, every battle (draws
//                                                     count half); reported only, no rules (e.g. the factory camps)
//   npm run balance:sweep -- --param factory.crumbleRadius=120,160   a --fast run per value, compared (scripts/balance-sweep.ts)
//
// Exit code 0 when every rule holds, 1 when one fails.

import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  ALL_ARCHETYPES,
  MATRIX_SEEDS,
  allPairs,
  archetypeByKey,
  balanceConfig,
  balanceWorkers,
  pairJobs,
  pairResult,
  runJobs,
  runStats,
  type BalanceRunnerKind,
  type BattleJob,
  type BattleRecord,
  type PairResult,
} from '../tests/helpers/balance.js';
import { BalancePool } from '../tests/helpers/balancePool.js';
import { DEFAULT_SEQUENTIAL, counts, sequential, type Cell, type RuleState, type StopMode } from '../tests/helpers/balanceFast.js';
import { testRules, type Rule } from '../tests/helpers/balanceRules.js';
import { refitForPatch } from '../tests/helpers/balanceRefit.js';

interface Args {
  mode: StopMode;
  alpha: number;
  prior?: number;
  archetypes: string[];
  extra: string[];
  configPatch: unknown;
  seeds: number[];
  cache: boolean;
  workers: number;
  runner: BalanceRunnerKind;
  top: number;
  all: boolean;
  json?: string;
  verify: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    mode: 'exact',
    alpha: DEFAULT_SEQUENTIAL.alpha,
    archetypes: ALL_ARCHETYPES.map((x) => x.key),
    extra: [],
    configPatch: undefined,
    seeds: MATRIX_SEEDS,
    cache: true,
    workers: Math.max(balanceWorkers(), availableParallelism() - 1),
    runner: 'lean',
    top: 10,
    all: false,
    verify: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--full':
        a.mode = 'full';
        break;
      case '--exact':
        a.mode = 'exact';
        break;
      case '--fast':
      case '--stat':
        a.mode = 'stat';
        break;
      case '--alpha':
        a.alpha = Number(val());
        break;
      case '--prior':
        a.prior = Number(val());
        break;
      case '--archetypes':
        a.archetypes = val().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--extra':
        a.extra = val().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--config': {
        const v = val();
        a.configPatch = JSON.parse(v.trimStart().startsWith('{') ? v : readFileSync(v, 'utf8'));
        break;
      }
      case '--seeds':
        a.seeds = val().split(',').map(Number);
        break;
      case '--no-cache':
        a.cache = false;
        break;
      case '--workers':
        a.workers = Math.max(1, Number(val()));
        break;
      case '--runner':
        a.runner = val() as BalanceRunnerKind;
        if (!['lean', 'vm', 'ivm'].includes(a.runner)) throw new Error(`--runner lean|vm|ivm, not ${a.runner}`);
        break;
      case '--top':
        a.top = Number(val());
        break;
      case '--all':
        a.all = true;
        break;
      case '--json':
        a.json = val();
        break;
      case '--verify':
        a.verify = true;
        break;
      case '--quiet':
        a.quiet = true;
        break;
      case '--no-refit':
        break;
      case '--help':
      case '-h':
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg} (--help)`);
    }
  }
  for (const k of [...a.archetypes, ...a.extra]) archetypeByKey(k);
  return a;
}

const args = parseArgs(process.argv.slice(2));
// A --config patch refits the archetypes (padded units, brick, fills) in a fresh process.
refitForPatch(args.configPatch, process.argv);
const log = (s: string) => {
  if (!args.quiet) process.stderr.write(`${s}\n`);
};
const started = performance.now();
const config = balanceConfig(args.configPatch);
const keys = args.archetypes;
const { matrices, rules } = testRules(keys);

/** One matchup of the run: its jobs and the records played so far. */
interface Matchup {
  cell: Cell;
  jobs: BattleJob[];
  records: Array<BattleRecord | undefined>;
}
const matchups: Matchup[] = allPairs(keys).map(([a, b]) => {
  const jobs = pairJobs(archetypeByKey(a), archetypeByKey(b), args.seeds);
  return { cell: { a, b, outcomes: jobs.map(() => undefined) }, jobs, records: jobs.map(() => undefined) };
});
const byCell = new Map(matchups.map((m) => [m.cell, m]));

let pool: BalancePool | undefined;
const getPool = () => (pool ??= new BalancePool(args.workers, args.configPatch, args.runner));

async function play(wanted: Array<{ cell: Cell; jobs: number[] }>): Promise<void> {
  const flat = wanted.flatMap((w) => w.jobs.map((j) => ({ m: byCell.get(w.cell)!, j })));
  const t0 = performance.now();
  const recs = await runJobs(
    flat.map(({ m, j }) => m.jobs[j]!),
    args.configPatch,
    {
      workers: args.workers,
      cache: args.cache,
      runner: args.runner,
      pool: getPool,
      onProgress: (done, total) => {
        if (!args.quiet && process.stderr.isTTY) process.stderr.write(`\r  ${done}/${total} battles`);
      },
    },
  );
  if (!args.quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  flat.forEach(({ m, j }, i) => {
    m.records[j] = recs[i]!;
    m.cell.outcomes[j] = recs[i]!.outcome;
  });
  log(`  ${flat.length} battles (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

const opts = { ...DEFAULT_SEQUENTIAL, mode: args.mode, alpha: args.alpha, ...(args.prior !== undefined ? { prior: args.prior } : {}) };
log(`balance: ${keys.length} archetypes, ${matchups.length} matchups × ${matchups[0]?.jobs.length ?? 0} battles, mode ${args.mode}${args.mode === 'stat' ? ` (alpha ${args.alpha})` : ''}, seeds ${args.seeds.join(',')}, runner ${args.runner}, cache ${args.cache ? 'on' : 'off'}${args.configPatch ? ', config patch' : ''}`);
const res = await sequential(
  matchups.map((m) => m.cell),
  matrices,
  rules,
  play,
  opts,
  (round, open, wanted) => log(`round ${round + 1}: ${open} rules open, ${wanted} more battles`),
);

/** Verdicts of a full matrix on the same cells (the --verify check). */
let verifyStates: RuleState[] | undefined;
if (args.verify && args.mode !== 'full') {
  log('verify: playing the full matrix');
  const full = await sequential(
    matchups.map((m) => m.cell),
    matrices,
    rules,
    play,
    { ...opts, mode: 'full' },
  );
  verifyStates = full.states;
}
/** --extra: each extra archetype against every archetype of the run, every battle (reported only). */
interface ExtraRow {
  key: string;
  w: number;
  d: number;
  l: number;
  n: number;
  rate: number;
}
const extraRows: ExtraRow[] = [];
if (args.extra.length > 0) {
  log(`extra: ${args.extra.join(', ')} against the ${keys.length} archetypes`);
  const groups = args.extra.map((e) => ({ e, jobs: keys.filter((k) => k !== e).flatMap((k) => pairJobs(archetypeByKey(e), archetypeByKey(k), args.seeds)) }));
  const recs = await runJobs(
    groups.flatMap((g) => g.jobs),
    args.configPatch,
    { workers: args.workers, cache: args.cache, runner: args.runner, pool: getPool },
  );
  let at = 0;
  for (const g of groups) {
    const mine = recs.slice(at, at + g.jobs.length);
    at += g.jobs.length;
    const w = mine.filter((r) => r.outcome === 1).length;
    const l = mine.filter((r) => r.outcome === -1).length;
    const n = mine.length;
    extraRows.push({ key: g.e, w, d: n - w - l, l, n, rate: (w + (n - w - l) / 2) / Math.max(1, n) });
  }
}
pool?.close();
const seconds = (performance.now() - started) / 1000;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const main = matrices.find((m) => m.name === 'full') ?? matrices.find((m) => m.name === 'selected') ?? matrices[matrices.length - 1]!;
const cellOf = (a: string, b: string) => {
  const m = matchups.find((x) => (x.cell.a === a && x.cell.b === b) || (x.cell.a === b && x.cell.b === a))!;
  const c = counts(m.cell);
  return m.cell.a === a ? c : { ...c, w: c.l, l: c.w };
};
const rows = main.keys.map((row) => {
  let w = 0;
  let r = 0;
  let n = 0;
  for (const b of main.keys) {
    if (b === row) continue;
    const c = cellOf(row, b);
    w += c.w;
    r += c.r;
    n += c.n;
  }
  const played = n - r;
  return { row, lo: w / n, hi: (w + r) / n, est: played > 0 ? w / played : 0, played, n, cap: main.caps[row] ?? 0.7 };
});
rows.sort((x, y) => y.est - x.est);
const shown = args.all ? rows : rows.slice(0, args.top);
console.log(`\n${main.name === 'full' ? 'Full matrix' : 'Selected archetypes'} (${main.keys.length}): overall win rate${args.mode === 'full' ? '' : ' (estimate = wins / battles played; [lowest, highest] possible)'}`);
for (const r of shown) {
  const exact = r.played === r.n;
  const range = exact ? '' : ` [${pct(r.lo)}, ${pct(r.hi)}] ${r.played}/${r.n} played`;
  console.log(`  ${r.row.padEnd(14)} ${pct(r.est).padStart(6)}${range}${r.cap !== 0.7 ? ` (cap ${pct(r.cap)})` : ''}`);
}
if (!args.all && rows.length > shown.length) console.log(`  … ${rows.length - shown.length} more (--all)`);

const label = (s: RuleState) => `${s.rule.label}${s.verdict === undefined ? '' : s.exact ? '' : ` (p ${s.p.toFixed(4)})`}`;
const cellText = (rule: Rule) =>
  rule.kind === 'cells'
    ? rule.checks
        .map((c) => {
          const x = cellOf(c.a, c.b);
          return `${c.a} vs ${c.b} ${x.w}-${x.d}-${x.l}${x.r ? ` (+${x.r} unplayed)` : ''}`;
        })
        .join(' / ')
    : '';
const stated = res.states.filter((s) => s.rule.kind === 'cells');
console.log(`\nStated outcomes and shape checks (${stated.filter((s) => s.verdict === true).length}/${stated.length} hold):`);
for (const s of stated) console.log(`  ${s.verdict === true ? 'ok  ' : s.verdict === false ? 'FAIL' : '??  '} ${label(s)}: ${cellText(s.rule)}`);
const failing = res.states.filter((s) => s.verdict === false);
const open = res.states.filter((s) => s.verdict === undefined);
const capFails = failing.filter((s) => s.rule.kind === 'cap' || s.rule.kind === 'struct');
console.log(`\nCaps and structure (${res.states.length - stated.length} rules over matrices ${matrices.map((m) => m.name).join(', ')}): ${capFails.length === 0 ? 'all hold' : `${capFails.length} fail`}`);
for (const s of capFails) console.log(`  FAIL ${label(s)}`);
for (const s of open) console.log(`  OPEN ${label(s)} (p ${s.p.toFixed(3)})`);

// Battle-level checks seen in the played battles (the test checks them over every battle).
const results: PairResult[] = matchups.map((m) => pairResult(m.cell.a, m.cell.b, m.records.filter((r): r is BattleRecord => r !== undefined)));
const wallOnly = results.filter((r) => r.wallOnlyWins > 0).map((r) => `${r.a} vs ${r.b}`);
const healPct = config.support.healRoomPctPerSecond / 100;
// Heal events carry amounts rounded to 0.01 HP, so a window summed from them can read a hair over the limit.
const HEAL_TOLERANCE = 1e-4;
const healBad = results.filter((r) => r.healBattles > 0 && (r.worstHealWindow > healPct + HEAL_TOLERANCE || r.lastHealTick > config.suddenDeath.startTick)).map((r) => `${r.a} vs ${r.b}`);
console.log(`\nIn the played battles: wall-only wins ${wallOnly.length ? wallOnly.join(', ') : 'none'}; heal-limit breaks ${healBad.length ? healBad.join(', ') : 'none'}.`);

if (extraRows.length > 0) {
  console.log(`\nExtra archetypes against the ${keys.length} (every battle, draws half; no rules):`);
  for (const r of extraRows) console.log(`  ${r.key.padEnd(14)} ${pct(r.rate).padStart(6)}  ${r.w}-${r.d}-${r.l} of ${r.n}`);
}

let verifyDiff = 0;
if (verifyStates) {
  const diffs = res.states.flatMap((s, i) => (s.verdict !== verifyStates![i]!.verdict ? [`${s.rule.label}: ${String(s.verdict)} (${args.mode}) vs ${String(verifyStates![i]!.verdict)} (full)`] : []));
  verifyDiff = diffs.length;
  console.log(`\nVerify against the full matrix: ${diffs.length === 0 ? `same verdict on all ${res.states.length} rules` : `${diffs.length} differ`}`);
  for (const d of diffs) console.log(`  DIFF ${d}`);
}

const played = res.played;
console.log(
  `\n${failing.length === 0 && open.length === 0 ? 'PASS' : 'FAIL'}: ${failing.length} failing, ${open.length} open of ${res.states.length} rules. ` +
    `Battles: ${played} of ${res.total} needed (${pct(played / Math.max(1, res.total))}) in ${res.rounds} rounds; ${runStats.played} played, ${runStats.cached} from the cache. ${seconds.toFixed(1)} s.`,
);

if (args.json) {
  writeFileSync(
    args.json,
    JSON.stringify(
      {
        mode: args.mode,
        seeds: args.seeds,
        configPatch: args.configPatch ?? null,
        rows,
        rules: res.states.map((s) => ({ label: s.rule.label, kind: s.rule.kind, verdict: s.verdict ?? null, exact: s.exact, p: s.p })),
        cells: matchups.map((m) => ({ a: m.cell.a, b: m.cell.b, ...counts(m.cell) })),
        extra: extraRows,
        battles: { needed: played, total: res.total, played: runStats.played, cached: runStats.cached },
        seconds,
      },
      null,
      1,
    ),
  );
}
process.exit(failing.length === 0 && open.length === 0 && verifyDiff === 0 ? 0 : 1);
