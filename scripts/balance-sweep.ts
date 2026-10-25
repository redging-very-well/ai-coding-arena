// `npm run balance:sweep`: try one config knob at several values (plan §14,
// docs/balance.md "Fast balance runs"). For each value it runs
// `npm run balance -- --fast` on the whole archetype pool with the patch
// (`--with` plus the value), so every rule and rate is checked, and the
// result cache re-uses every battle the knob can't reach (a factory knob
// re-plays only the battles with factories). Then it prints one table: each
// archetype's win rate per value (the archetypes the knob touches first),
// the rules that pass, fail or stay open, and the battles played vs cached.
// `--confirm` then runs one `--full` on the best value: every rule passes and
// it is closest to the `--target` (else the fewest failures).
//
//   npm run balance:sweep -- --param factory.crumbleRadius=120,160,200,260 \
//     --with '{"factory":{"minionsDieWithFactory":true}}' --seeds 11,4242
//   npm run balance:sweep -- --param support.healRoomPctPerSecond=3,4,5 --confirm
//   npm run balance:sweep -- --param factory.crumbleRadius=120,200 --extra camp,camptowers,campfive --target camp<=55%
//
// Options:
//   --param <path>=v1,v2,...   the knob (dotted config path) and its values (JSON: numbers, true/false, "strings")
//   --with '<json>' | file     a patch applied under every value (e.g. turn an option on)
//   --seeds 11,4242            seeds (default: the test's seed 11)
//   --target <key><=<rate>     the archetype rate to aim for (also >=; rate 0.55 or 55%): picks the best value
//   --extra a,b                archetypes outside the pool (the camps) played against it, every battle, per value
//   --focus a,b                archetypes shown first (default: those whose armies the knob reaches, by spread)
//   --all                      every archetype in the table (default: the focus rows and the 10 biggest movers)
//   --confirm                  one `npm run balance -- --full` on the best value afterwards
//   --alpha, --workers, --no-cache, --json out.json   passed on / the sweep's results as JSON
//
// Exit code: 0 when the best value passes every rule (and its --confirm run does), 1 otherwise.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge } from '@pixel-clash/shared';
import { ALL_ARCHETYPES, battleFeatures, type Archetype } from '../tests/helpers/balance.js';
import { leafClass, type BattleFeature } from '../tests/helpers/balanceCache.js';

interface Args {
  path: string;
  values: unknown[];
  with: unknown;
  seeds?: string;
  target?: { key: string; op: '<=' | '>='; rate: number };
  extra: string[];
  focus?: string[];
  all: boolean;
  confirm: boolean;
  pass: string[];
  json?: string;
}

function parseValue(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function parseArgs(argv: string[]): Args {
  const a: Args = { path: '', values: [], with: {}, extra: [], all: false, confirm: false, pass: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--param': {
        const v = val();
        const eq = v.indexOf('=');
        if (eq <= 0) throw new Error('--param <path>=v1,v2,...');
        a.path = v.slice(0, eq);
        a.values = v.slice(eq + 1).split(',').map((x) => parseValue(x.trim()));
        break;
      }
      case '--with': {
        const v = val();
        a.with = JSON.parse(v.trimStart().startsWith('{') ? v : readFileSync(v, 'utf8'));
        break;
      }
      case '--seeds':
        a.seeds = val();
        break;
      case '--target': {
        const m = /^([A-Za-z0-9]+)\s*(<=|>=)\s*([\d.]+)(%?)$/.exec(val());
        if (!m) throw new Error('--target <archetype><=<rate> (or >=; rate 0.55 or 55%)');
        a.target = { key: m[1]!, op: m[2] as '<=' | '>=', rate: Number(m[3]) / (m[4] || Number(m[3]) > 1 ? 100 : 1) };
        break;
      }
      case '--extra':
        a.extra = val().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--focus':
        a.focus = val().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--all':
        a.all = true;
        break;
      case '--confirm':
        a.confirm = true;
        break;
      case '--alpha':
      case '--workers':
      case '--prior':
        a.pass.push(arg, val());
        break;
      case '--no-cache':
        a.pass.push(arg);
        break;
      case '--json':
        a.json = val();
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
  if (!a.path || a.values.length === 0) throw new Error('--param <path>=v1,v2,... is required (--help)');
  return a;
}

const args = parseArgs(process.argv.slice(2));
const BALANCE = fileURLToPath(new URL('./balance.ts', import.meta.url));

/** The patch for one value: `--with` with the knob set on top. */
function patchFor(value: unknown): unknown {
  const knob = args.path.split('.').reduceRight<unknown>((inner, k) => ({ [k]: inner }), value);
  return deepMerge(args.with, knob);
}

interface RunJson {
  rows: Array<{ row: string; est: number; lo: number; hi: number; played: number; n: number; cap: number }>;
  rules: Array<{ label: string; kind: string; verdict: boolean | null }>;
  extra: Array<{ key: string; rate: number; w: number; d: number; l: number; n: number }>;
  battles: { needed: number; total: number; played: number; cached: number };
  seconds: number;
}

/** One `npm run balance` child with the patch (BALANCE_FIT set, so the archetypes are refit to it in that process). */
function runBalance(patch: unknown, mode: '--fast' | '--full', out: string | undefined, quiet: boolean): number {
  const argv = [mode, '--config', JSON.stringify(patch), ...(args.seeds ? ['--seeds', args.seeds] : []), ...(args.extra.length ? ['--extra', args.extra.join(',')] : []), ...args.pass];
  if (out) argv.push('--json', out, '--quiet');
  const r = spawnSync(process.execPath, [...process.execArgv, BALANCE, ...argv], {
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    env: { ...process.env, BALANCE_FIT: JSON.stringify(patch) },
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

const tmp = mkdtempSync(join(tmpdir(), 'pc-sweep-'));
interface Point {
  value: unknown;
  patch: unknown;
  res: RunJson;
  wall: number;
  fail: string[];
  open: string[];
  pass: number;
}
const points: Point[] = [];
const valueText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const cls = leafClass(args.path);
console.error(`sweep: ${args.path} (${cls === 'global' ? 'read by every battle' : cls === 'unread' ? 'never read by a battle: prices/caps reach battles through the refit armies' : `only battles with ${cls}`}) = ${args.values.map(valueText).join(', ')}${args.with && Object.keys(args.with as object).length ? ` with ${JSON.stringify(args.with)}` : ''}`);
try {
  for (const [i, value] of args.values.entries()) {
    const patch = patchFor(value);
    const out = join(tmp, `p${i}.json`);
    const t0 = performance.now();
    runBalance(patch, '--fast', out, true);
    const wall = (performance.now() - t0) / 1000;
    let res: RunJson;
    try {
      res = JSON.parse(readFileSync(out, 'utf8')) as RunJson;
    } catch {
      throw new Error(`the balance run for ${args.path}=${valueText(value)} wrote no results (bad patch?)`);
    }
    const fail = res.rules.filter((r) => r.verdict === false).map((r) => r.label);
    const open = res.rules.filter((r) => r.verdict === null).map((r) => r.label);
    const p: Point = { value, patch, res, wall, fail, open, pass: res.rules.length - fail.length - open.length };
    points.push(p);
    console.error(`  ${args.path}=${valueText(value)}: ${fail.length === 0 && open.length === 0 ? 'PASS' : `FAIL ${fail.length}${open.length ? ` (+${open.length} open)` : ''}`}; battles ${res.battles.played} played, ${res.battles.cached} cached; ${wall.toFixed(1)} s`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const pct = (x: number | undefined) => (x === undefined ? '-' : `${(100 * x).toFixed(1)}%`);
const rate = (p: Point, key: string): number | undefined => p.res.rows.find((r) => r.row === key)?.est ?? p.res.extra.find((r) => r.key === key)?.rate;
const poolKeys = points[0]!.res.rows.map((r) => r.row);
const spread = (key: string) => {
  const xs = points.map((p) => rate(p, key)).filter((x): x is number => x !== undefined);
  return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
};
// The archetypes the knob reaches: their armies have the feature its class names (all of them for a global or price knob).
const reached = (a: Archetype) => cls === 'global' || cls === 'unread' || battleFeatures([a]).includes(cls as BattleFeature);
const focus = args.focus ?? [...args.extra, ...ALL_ARCHETYPES.filter((a) => poolKeys.includes(a.key) && reached(a)).map((a) => a.key).sort((x, y) => spread(y) - spread(x))];
if (args.target && !focus.includes(args.target.key)) focus.unshift(args.target.key);
const rest = poolKeys.filter((k) => !focus.includes(k)).sort((x, y) => spread(y) - spread(x));
const shown = args.all ? [...focus, ...rest] : [...focus.slice(0, Math.max(12, args.focus?.length ?? 0, args.extra.length)), ...rest.slice(0, 10)];
const cols = points.map((p) => valueText(p.value));
// Wide enough for the value labels and the longest row cell ("249/249").
const w = Math.max(9, ...cols.map((c) => c.length + 2), ...points.map((p) => `${p.pass}/${p.res.rules.length}`.length + 2));
const line = (label: string, cells: string[]) => console.log(`${label.padEnd(16)}${cells.map((c) => c.padStart(w)).join('')}`);
console.log(`\n${args.path}${args.with && Object.keys(args.with as object).length ? ` (with ${JSON.stringify(args.with)})` : ''}: --fast win rates (estimates over the battles played; extras: every battle, draws half)`);
line('', cols);
const focusShown = shown.filter((k) => focus.includes(k));
for (const k of focusShown) line(`${k}${args.extra.includes(k) ? '*' : ''}`, points.map((p) => pct(rate(p, k))));
if (shown.length > focusShown.length) {
  console.log(`  ${'-'.repeat(14)} biggest movers among the others`);
  for (const k of shown.filter((x) => !focus.includes(x))) line(k, points.map((p) => pct(rate(p, k))));
}
if (!args.all && poolKeys.length + args.extra.length > shown.length) console.log(`  … ${poolKeys.length + args.extra.length - shown.length} more (--all)`);
line('rules pass', points.map((p) => `${p.pass}/${p.res.rules.length}`));
line('rules fail', points.map((p) => String(p.fail.length)));
line('rules open', points.map((p) => String(p.open.length)));
line('played', points.map((p) => String(p.res.battles.played)));
line('cached', points.map((p) => String(p.res.battles.cached)));
line('seconds', points.map((p) => p.wall.toFixed(0)));
for (const p of points) if (p.fail.length || p.open.length) console.log(`  ${valueText(p.value)}: ${[...p.fail.map((l) => `FAIL ${l}`), ...p.open.map((l) => `OPEN ${l}`)].join('; ')}`);

// ---------------------------------------------------------------------------
// The best value
// ---------------------------------------------------------------------------

/** How far a point misses the target (0 = met), then how far it is from it. */
const targetScore = (p: Point): [number, number] => {
  if (!args.target) return [0, 0];
  const r = rate(p, args.target.key);
  if (r === undefined) return [Infinity, Infinity];
  const miss = args.target.op === '<=' ? Math.max(0, r - args.target.rate) : Math.max(0, args.target.rate - r);
  return [miss, Math.abs(r - args.target.rate)];
};
if (args.target && points.every((p) => rate(p, args.target!.key) === undefined)) console.log(`\n--target ${args.target.key}: not in the run (an archetype outside the pool needs --extra ${args.target.key})`);
const passing = points.filter((p) => p.fail.length === 0 && p.open.length === 0);
const ranked = [...(passing.length ? passing : points)].sort((x, y) => {
  if (!passing.length && x.fail.length + x.open.length !== y.fail.length + y.open.length) return x.fail.length + x.open.length - (y.fail.length + y.open.length);
  const [mx, dx] = targetScore(x);
  const [my, dy] = targetScore(y);
  return mx - my || dx - dy;
});
const best = ranked[0]!;
const why = passing.length
  ? `every rule passes${args.target ? `, ${args.target.key} ${pct(rate(best, args.target.key))} (target ${args.target.op} ${pct(args.target.rate)}${targetScore(best)[0] > 0 ? ', not met' : ''})` : ''}`
  : `no value passes every rule; fewest failures (${best.fail.length + best.open.length})`;
console.log(`\nBest: ${args.path}=${valueText(best.value)} (${why}). Sweep: ${points.reduce((s, p) => s + p.wall, 0).toFixed(0)} s, ${points.reduce((s, p) => s + p.res.battles.played, 0)} battles played, ${points.reduce((s, p) => s + p.res.battles.cached, 0)} cached.`);
console.log(`Confirm: npm run balance -- --full --config '${JSON.stringify(best.patch)}'${args.seeds ? ` --seeds ${args.seeds}` : ''}${args.extra.length ? ` --extra ${args.extra.join(',')}` : ''}`);

let confirmCode = 0;
if (args.confirm) {
  console.log(`\n--confirm: the full matrix on ${args.path}=${valueText(best.value)}`);
  const t0 = performance.now();
  confirmCode = runBalance(best.patch, '--full', undefined, false);
  console.log(`--confirm: ${confirmCode === 0 ? 'PASS' : 'FAIL'} in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

if (args.json) {
  writeFileSync(
    args.json,
    JSON.stringify(
      {
        param: args.path,
        with: args.with,
        target: args.target ?? null,
        best: best.value,
        points: points.map((p) => ({ value: p.value, patch: p.patch, seconds: p.wall, fail: p.fail, open: p.open, pass: p.pass, battles: p.res.battles, rates: Object.fromEntries([...poolKeys, ...args.extra].map((k) => [k, rate(p, k) ?? null])) })),
        confirm: args.confirm ? confirmCode === 0 : null,
      },
      null,
      1,
    ),
  );
}
process.exit(best.fail.length === 0 && best.open.length === 0 && confirmCode === 0 ? 0 : 1);
