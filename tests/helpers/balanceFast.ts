// Early stopping for the balance round robin. A matchup cell is a FIXED set of n deterministic battles
// (every duel site, zone pair, both orders, every seed), so after k of them
// the other n − k can only move the counts so far. Each rule (helpers/
// balanceRules.ts: the win caps, beats someone / not everyone / loses to
// someone, the shape checks and stated outcomes) is decided as soon as it
// can't change any more, and battles are only played for cells some
// undecided rule still depends on.
//
// Two modes:
//   'exact': a rule is decided when NO outcome of the unplayed battles can
//            change it (worst-case bounds). Same verdicts as the full matrix,
//            by construction.
//   'stat':  also decided when it is very likely (probability ≥ 1 − alpha)
//            under a Dirichlet model of each cell's battles (Jeffreys prior
//            on win/draw/loss): exact Dirichlet-multinomial odds for one
//            cell, a normal approximation for a row's total wins. Much
//            faster; a heuristic (the battles of a cell are not random draws),
//            checked against the full matrix with --verify.
//   'full':  every battle (the old way; still uses the cache).
// Cells play their battles in a spread order (both maps and both zone pairs
// first), `first` battles per cell up front, then `step` more per round for
// the cells that are still needed.

import type { CellCheck, CellPred, MatrixDef, Rule } from './balanceRules.js';

export type StopMode = 'exact' | 'stat' | 'full';
export type Outcome = 1 | 0 | -1;

/** A matchup: battles of A (row) against B, in job order; `undefined` = not played yet. */
export interface Cell {
  a: string;
  b: string;
  outcomes: Array<Outcome | undefined>;
}

export interface CellCounts {
  w: number;
  d: number;
  l: number;
  /** Unplayed battles. */
  r: number;
  n: number;
}

export function counts(c: Cell): CellCounts {
  let w = 0;
  let d = 0;
  let l = 0;
  let r = 0;
  for (const o of c.outcomes) {
    if (o === undefined) r++;
    else if (o === 1) w++;
    else if (o === -1) l++;
    else d++;
  }
  return { w, d, l, r, n: c.outcomes.length };
}

/** Counts from the other side (B's row). */
const flip = (x: CellCounts): CellCounts => ({ w: x.l, d: x.d, l: x.w, r: x.r, n: x.n });

/** Verdict of a rule: decided true/false, or open. */
export type Verdict = true | false | undefined;

/** Worst-case verdict of a cell predicate given its counts. */
export function exactCell(p: CellPred, x: CellCounts): Verdict {
  const { w, l, r, n } = x;
  if (p === 'beats' || p === 'notBeats') {
    const v: Verdict = w > l + r ? true : w + r <= l ? false : undefined;
    return v === undefined || p === 'beats' ? v : !v;
  }
  if (p === 'winsMost') return 2 * w > n ? true : 2 * (w + r) <= n ? false : undefined;
  if (p === 'losesMore') return l > w + r ? true : l + r <= w ? false : undefined;
  return w >= p.winFrac * n ? true : w + r < p.winFrac * n ? false : undefined;
}

// ---------------------------------------------------------------------------
// The statistical model
// ---------------------------------------------------------------------------

/** Default pseudo-count per outcome of the cell model (see SequentialOptions.prior). */
export const DEFAULT_PRIOR = 0.5;

function lgamma(z: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const g = 7;
  const c = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) x += c[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** P(the predicate holds at the end) for one cell: the unplayed battles' (wins, draws, losses) are Dirichlet-multinomial. */
export function cellProbability(p: CellPred, x: CellCounts, prior = DEFAULT_PRIOR): number {
  const a = [x.w + prior, x.d + prior, x.l + prior];
  const A = a[0]! + a[1]! + a[2]!;
  const r = x.r;
  const base = lgamma(r + 1) + lgamma(A) - lgamma(r + A);
  let prob = 0;
  for (let i = 0; i <= r; i++)
    for (let j = 0; i + j <= r; j++) {
      const k = r - i - j;
      const lp = base + lgamma(i + a[0]!) - lgamma(i + 1) - lgamma(a[0]!) + lgamma(j + a[1]!) - lgamma(j + 1) - lgamma(a[1]!) + lgamma(k + a[2]!) - lgamma(k + 1) - lgamma(a[2]!);
      const end: CellCounts = { w: x.w + i, d: x.d + j, l: x.l + k, r: 0, n: x.n };
      if (exactCell(p, end) === true) prob += Math.exp(lp);
    }
  return Math.min(1, Math.max(0, prob));
}

/** Mean and variance of the wins still to come in a cell (beta-binomial marginal). */
function winMoments(x: CellCounts, prior: number): { mean: number; variance: number } {
  const alpha = x.w + prior;
  const beta = x.d + x.l + prior;
  const n = x.r;
  const s = alpha + beta;
  return { mean: (n * alpha) / s, variance: (n * alpha * beta * (s + n)) / (s * s * (s + 1)) };
}

/** Standard normal CDF. */
function phi(z: number): number {
  // Abramowitz-Stegun 7.1.26 on erf.
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// ---------------------------------------------------------------------------
// Rules over cells
// ---------------------------------------------------------------------------

export class CellTable {
  private readonly byPair = new Map<string, Cell>();

  constructor(readonly cells: Cell[]) {
    for (const c of cells) this.byPair.set(`${c.a}|${c.b}`, c);
  }

  /** The cell of A against B and whether it is stored the other way round. */
  find(a: string, b: string): { cell: Cell; flipped: boolean } {
    const c = this.byPair.get(`${a}|${b}`);
    if (c) return { cell: c, flipped: false };
    const d = this.byPair.get(`${b}|${a}`);
    if (!d) throw new Error(`no cell ${a} vs ${b}`);
    return { cell: d, flipped: true };
  }

  /** A's counts against B. */
  counts(a: string, b: string): CellCounts {
    const { cell, flipped } = this.find(a, b);
    const x = counts(cell);
    return flipped ? flip(x) : x;
  }
}

export interface RuleState {
  rule: Rule;
  /** The verdict so far (decided by the bounds or, in 'stat' mode, by the odds). */
  verdict: Verdict;
  /** Decided by the worst-case bounds (true) or by the odds (false). */
  exact: boolean;
  /** Probability it holds ('stat' mode; 1/0 when exact). */
  p: number;
  /** Cells whose unplayed battles could still change it. */
  needs: Cell[];
}

/** Evaluate one rule. */
export function evaluateRule(rule: Rule, t: CellTable, matrices: Map<string, MatrixDef>, mode: StopMode, alpha: number, prior = DEFAULT_PRIOR): RuleState {
  const decide = (exact: Verdict, p: number, needs: Cell[]): RuleState => {
    if (exact !== undefined) return { rule, verdict: exact, exact: true, p: exact ? 1 : 0, needs: [] };
    if (mode === 'stat' && (p >= 1 - alpha || p <= alpha)) return { rule, verdict: p >= 1 - alpha, exact: false, p, needs: [] };
    return { rule, verdict: undefined, exact: false, p, needs };
  };
  const cellOf = (a: string, b: string) => t.find(a, b).cell;
  if (rule.kind === 'cells') {
    const parts = rule.checks.map((c: CellCheck) => {
      const x = t.counts(c.a, c.b);
      const v = exactCell(c.pred, x);
      return { v, p: v === undefined ? (mode === 'stat' ? cellProbability(c.pred, x, prior) : 0.5) : v ? 1 : 0, cell: cellOf(c.a, c.b) };
    });
    const open = parts.filter((q) => q.v === undefined).map((q) => q.cell);
    if (rule.all) {
      const v: Verdict = parts.some((q) => q.v === false) ? false : parts.every((q) => q.v === true) ? true : undefined;
      return decide(v, parts.reduce((s, q) => s * q.p, 1), open);
    }
    const v: Verdict = parts.some((q) => q.v === true) ? true : parts.every((q) => q.v === false) ? false : undefined;
    return decide(v, 1 - parts.reduce((s, q) => s * (1 - q.p), 1), open);
  }
  const m = matrices.get(rule.matrix)!;
  const others = m.keys.filter((k) => k !== rule.row);
  const rows = others.map((b) => ({ b, x: t.counts(rule.row, b), cell: cellOf(rule.row, b) }));
  if (rule.kind === 'cap') {
    const n = rows.reduce((s, q) => s + q.x.n, 0);
    const known = rows.reduce((s, q) => s + q.x.w, 0);
    const open = rows.reduce((s, q) => s + q.x.r, 0);
    const v: Verdict = (known + open) <= rule.cap * n + 1e-9 ? true : known > rule.cap * n + 1e-9 ? false : undefined;
    let p = 0.5;
    if (v === undefined && mode === 'stat') {
      let mean = known;
      let variance = 0;
      for (const q of rows) {
        const mm = winMoments(q.x, prior);
        mean += mm.mean;
        variance += mm.variance;
      }
      // Wins are whole: P(W ≤ floor(cap·n)) with a continuity correction.
      const limit = Math.floor(rule.cap * n + 1e-9) + 0.5;
      p = variance > 0 ? phi((limit - mean) / Math.sqrt(variance)) : mean <= limit ? 1 : 0;
    }
    return decide(v, p, rows.filter((q) => q.x.r > 0).map((q) => q.cell));
  }
  // Structural: beats someone / doesn't beat everyone / loses to someone.
  const pred: CellPred = rule.what === 'losesToSomeone' ? 'losesMore' : 'beats';
  const parts = rows.map((q) => {
    const v = exactCell(pred, q.x);
    return { v, p: v === undefined ? (mode === 'stat' ? cellProbability(pred, q.x, prior) : 0.5) : v ? 1 : 0, cell: q.cell };
  });
  const open = parts.filter((q) => q.v === undefined).map((q) => q.cell);
  if (rule.what === 'notBeatsAll') {
    const v: Verdict = parts.some((q) => q.v === false) ? true : parts.every((q) => q.v === true) ? false : undefined;
    return decide(v, 1 - parts.reduce((s, q) => s * q.p, 1), open);
  }
  const v: Verdict = parts.some((q) => q.v === true) ? true : parts.every((q) => q.v === false) ? false : undefined;
  return decide(v, 1 - parts.reduce((s, q) => s * (1 - q.p), 1), open);
}

/**
 * The spread play order of a cell's n battles: bit reversal of the job index
 * when n is a power of two (pairJobs nests site > zone pair > order > seed, so
 * the first battles cover both maps, both zone pairs, both orders), else as is.
 */
export function spreadOrder(n: number): number[] {
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: n }, (_, i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    return r;
  });
}

export interface SequentialOptions {
  mode: StopMode;
  /** 'stat' mode: the risk a decided rule is wrong (per rule). */
  alpha: number;
  /** Battles per cell up front. */
  first: number;
  /** More battles per needed cell per round. */
  step: number;
  /** 'stat' mode: pseudo-count per outcome of a cell (smaller = trusts a lopsided start more). */
  prior?: number;
}

export const DEFAULT_SEQUENTIAL: SequentialOptions = { mode: 'exact', alpha: 0.001, first: 2, step: 2 };

export interface SequentialResult {
  states: RuleState[];
  rounds: number;
  played: number;
  total: number;
}

/**
 * Run the rules over the cells, asking `play` for more battles of the needed
 * cells (by job index) until every rule is decided or every battle is played.
 */
export async function sequential(
  cells: Cell[],
  matrices: MatrixDef[],
  rules: Rule[],
  play: (wanted: Array<{ cell: Cell; jobs: number[] }>) => Promise<void>,
  opts: SequentialOptions = DEFAULT_SEQUENTIAL,
  onRound?: (round: number, open: number, wanted: number) => void,
): Promise<SequentialResult> {
  const table = new CellTable(cells);
  const mdefs = new Map(matrices.map((m) => [m.name, m]));
  const orderOf = new Map<number, number[]>();
  const order = (n: number) => {
    let o = orderOf.get(n);
    if (!o) orderOf.set(n, (o = spreadOrder(n)));
    return o;
  };
  /** The next `k` unplayed battles of a cell, in spread order. */
  const next = (c: Cell, k: number) => order(c.outcomes.length).filter((i) => c.outcomes[i] === undefined).slice(0, k);
  let rounds = 0;
  let states: RuleState[] = [];
  for (;;) {
    let wanted: Array<{ cell: Cell; jobs: number[] }>;
    if (rounds === 0) {
      const k = opts.mode === 'full' ? Infinity : opts.first;
      wanted = cells.map((cell) => ({ cell, jobs: next(cell, k) }));
    } else {
      states = rules.map((r) => evaluateRule(r, table, mdefs, opts.mode, opts.alpha, opts.prior));
      const needed = new Set<Cell>();
      for (const s of states) for (const c of s.needs) needed.add(c);
      wanted = [...needed].map((cell) => ({ cell, jobs: next(cell, opts.step) }));
      onRound?.(rounds, states.filter((s) => s.verdict === undefined).length, wanted.reduce((n, w) => n + w.jobs.length, 0));
    }
    wanted = wanted.filter((w) => w.jobs.length > 0);
    if (wanted.length === 0) break;
    await play(wanted);
    rounds++;
  }
  const played = cells.reduce((n, c) => n + c.outcomes.filter((o) => o !== undefined).length, 0);
  const total = cells.reduce((n, c) => n + c.outcomes.length, 0);
  return { states, rounds, played, total };
}
