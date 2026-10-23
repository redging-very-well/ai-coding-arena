// The in-browser unit editor (plan §12.1 "Edit code"), DOM-free parts so
// tests can run them: finding the read-only sprite() method and the stat
// assignments in the @lezer/javascript syntax tree, turning §7 validation
// issues into editor diagnostics, the cost panel, the live-validation
// scheduler (debounced, coalesced, ≤ 1 request in flight, ≤ 1 per second),
// per-unit drafts, and the phase-change guard.
//
// Only the lazily loaded editor chunk imports this file (the lezer parser
// stays out of /play's first load).

import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@lezer/javascript';
import {
  CURVE_MAX,
  NEAR_MAX_RATIO,
  PRICED_STATS,
  STAT_FIELDS,
  playerHintForIssue,
  type CostBreakdown,
  type Phase,
  type PricedStat,
  type ValidationIssue,
  type ValidationResult,
} from '@pixel-clash/shared';

export interface Span {
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// Source analysis (lezer tree)
// ---------------------------------------------------------------------------

const tsParser = parser.configure({ dialect: 'ts' });

/**
 * The syntax tree of a unit. Units may use TypeScript syntax (the validator
 * transpiles it): when the JavaScript parse has errors and the TypeScript one
 * doesn't, the TypeScript tree is used.
 */
export function parseUnit(source: string): Tree {
  const js = parser.parse(source);
  if (!hasError(js)) return js;
  const ts = tsParser.parse(source);
  return hasError(ts) ? js : ts;
}

/** Should the editor highlight this unit as TypeScript? */
export function isTypeScript(source: string): boolean {
  return hasError(parser.parse(source)) && !hasError(tsParser.parse(source));
}

function text(source: string, n: SyntaxNode | null | undefined): string {
  return n ? source.slice(n.from, n.to) : '';
}

function hasError(tree: Tree): boolean {
  let bad = false;
  tree.iterate({
    enter: (n) => {
      if (n.type.isError) bad = true;
      return !bad;
    },
  });
  return bad;
}

/** Every class (declaration or expression) in the file. */
function classesOf(tree: Tree): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name === 'ClassDeclaration' || n.name === 'ClassExpression') out.push(n.node);
    },
  });
  return out;
}

/**
 * The unit class: the `export default class …`, else the class named by
 * `export default Name`, else the only class in the file.
 */
export function unitClass(source: string, tree: Tree = parseUnit(source)): SyntaxNode | null {
  const classes = classesOf(tree);
  let named: string | null = null;
  for (const top of tree.topNode.getChildren('ExportDeclaration')) {
    if (!top.getChild('default')) continue;
    const cls = top.getChild('ClassDeclaration') ?? top.getChild('ClassExpression');
    if (cls) return cls;
    const v = top.getChild('VariableName');
    if (v) named = text(source, v);
  }
  if (named) {
    const hit = classes.find((c) => text(source, c.getChild('VariableDefinition')) === named);
    if (hit) return hit;
  }
  return classes.length === 1 ? classes[0]! : null;
}

/** Non-static members of the class body named `name` (methods and fields). */
function members(source: string, cls: SyntaxNode, name: string): SyntaxNode[] {
  const body = cls.getChild('ClassBody');
  if (!body) return [];
  const out: SyntaxNode[] = [];
  for (let m = body.firstChild; m; m = m.nextSibling) {
    if (m.name !== 'MethodDeclaration' && m.name !== 'PropertyDeclaration') continue;
    if (m.getChild('static')) continue;
    const key = m.getChild('PropertyDefinition');
    if (key && text(source, key) === name) out.push(m);
  }
  return out;
}

export type SpriteLocation =
  /** The whole sprite() member (read-only) and its body's inside (folded). */
  | { kind: 'found'; range: Span; fold: Span | null; name: Span }
  /** The unit has no sprite(): nothing to protect. */
  | { kind: 'none' }
  /** It seems to have one, but we can't tell where it is: whole file editable, with a warning. */
  | { kind: 'unknown' };

/** Where the unit's sprite() method is (plan §12.1: it is read-only in the editor). */
export function findSprite(source: string, tree: Tree = parseUnit(source)): SpriteLocation {
  const mentions = /\bsprite\b/.test(source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  const cls = unitClass(source, tree);
  if (!cls) return mentions ? { kind: 'unknown' } : { kind: 'none' };
  const found = members(source, cls, 'sprite');
  if (found.length > 1) return { kind: 'unknown' };
  if (found.length === 0) {
    // A parse error can hide the method from the tree: don't claim there is none.
    return mentions && hasError(tree) ? { kind: 'unknown' } : { kind: 'none' };
  }
  const m = found[0]!;
  const key = m.getChild('PropertyDefinition')!;
  const block = m.getChild('Block') ?? m.getChild('ArrowFunction')?.getChild('Block') ?? m.getChild('FunctionExpression')?.getChild('Block');
  const fold = block && block.to - block.from > 2 ? { from: block.from + 1, to: block.to - 1 } : null;
  return { kind: 'found', range: { from: m.from, to: m.to }, fold, name: { from: key.from, to: key.to } };
}

/**
 * The value assigned to `this.<field>` in the constructor (or a class field
 * `<field> = …`), for squiggles on stat errors and for renaming a copy.
 */
export function findStatValue(source: string, field: string, tree: Tree = parseUnit(source)): Span | null {
  const cls = unitClass(source, tree);
  if (!cls) return null;
  const ctor = members(source, cls, 'constructor')[0];
  let last: Span | null = null;
  if (ctor) {
    const c = ctor.cursor();
    const end = ctor.to;
    while (c.next() && c.from < end) {
      if (c.name !== 'AssignmentExpression') continue;
      const lhs = c.node.firstChild;
      if (!lhs || lhs.name !== 'MemberExpression') continue;
      if (lhs.firstChild?.name !== 'this' || text(source, lhs.getChild('PropertyName')) !== field) continue;
      const rhs = c.node.lastChild;
      if (rhs && rhs !== lhs) last = { from: rhs.from, to: rhs.to }; // the last assignment wins
    }
  }
  if (last) return last;
  const fieldDecl = members(source, cls, field).find((m) => m.name === 'PropertyDeclaration');
  const value = fieldDecl?.lastChild?.name === ';' ? fieldDecl.lastChild.prevSibling : fieldDecl?.lastChild;
  return value && value.name !== 'PropertyDefinition' ? { from: value.from, to: value.to } : null;
}

/** The unit's name from `this.name = '…'` (null when it isn't a plain string). */
export function unitNameOf(source: string): string | null {
  const v = findStatValue(source, 'name');
  if (!v) return null;
  const lit = source.slice(v.from, v.to);
  const m = /^(['"])(.*)\1$/s.exec(lit);
  return m ? m[2]!.replace(/\\(.)/g, '$1') : null;
}

/** The source with `this.name = '…'` replaced (for "Copy to a new unit"); null if it can't be found. */
export function withUnitName(source: string, name: string): { source: string; change: Span & { insert: string } } | null {
  const v = findStatValue(source, 'name');
  if (!v) return null;
  const insert = `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return { source: source.slice(0, v.from) + insert + source.slice(v.to), change: { from: v.from, to: v.to, insert } };
}

/** Copy names: 1-24 characters, not the template's own name. */
export function copyNameProblem(name: string, templateName: string): string | null {
  const n = name.trim();
  if (n.length === 0) return 'Give your new unit a name.';
  if (n.length > 24) return 'Names can be up to 24 letters long.';
  if (n.toLowerCase() === templateName.trim().toLowerCase()) return 'Pick a new name, not the starter’s name.';
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostics (§7 issues → squiggles or the banner)
// ---------------------------------------------------------------------------

export interface EditorDiagnostic extends Span {
  severity: 'error' | 'warning';
  code: string;
  /** Player-friendly text (playerHint). */
  message: string;
  /** The technical message (shown on hover). */
  detail: string;
}

export interface BannerItem {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  detail: string;
}

const STATS = new Set<string>(STAT_FIELDS);

/** Offset of the start of 1-based `line` (clamped to the document). */
function lineStart(source: string, line: number): number {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = source.indexOf('\n', pos);
    if (nl < 0) return source.length;
    pos = nl + 1;
  }
  return pos;
}

function lineEnd(source: string, from: number): number {
  const nl = source.indexOf('\n', from);
  return nl < 0 ? source.length : nl;
}

/** The squiggle for a 1-based line (and column): the word there, or the line's text. */
export function spanAt(source: string, line: number, column?: number): Span {
  const start = lineStart(source, line);
  const end = lineEnd(source, start);
  if (column !== undefined && column >= 1) {
    const from = Math.min(end, start + column - 1);
    const word = /^[\w$]+/.exec(source.slice(from, end));
    const to = word ? from + word[0].length : Math.min(end, from + 1);
    // At the end of a line (missing brace…): mark the last character instead.
    return to > from ? { from, to } : { from: Math.max(start, from - 1), to: from };
  }
  const indent = /^\s*/.exec(source.slice(start, end))![0].length;
  return { from: Math.min(end, start + indent), to: end };
}

/** Turn a §7 result into squiggles (with a place in the code) and banner items (without). */
export function toDiagnostics(result: ValidationResult, source: string): { diagnostics: EditorDiagnostic[]; banner: BannerItem[] } {
  const tree = parseUnit(source);
  const diagnostics: EditorDiagnostic[] = [];
  const banner: BannerItem[] = [];
  const issues: Array<[ValidationIssue, 'error' | 'warning']> = [
    ...(result.ok ? [] : result.errors.map((e) => [e, 'error'] as [ValidationIssue, 'error'])),
    ...result.warnings.map((w) => [w, 'warning'] as [ValidationIssue, 'warning']),
  ];
  let sprite: SpriteLocation | undefined;
  for (const [issue, severity] of issues) {
    const message = playerHintForIssue(issue);
    const detail = [issue.message, issue.fix && issue.fix !== issue.message ? `Fix: ${issue.fix}` : ''].filter(Boolean).join('\n');
    let span: Span | null = null;
    if (typeof issue.line === 'number' && issue.line >= 1) {
      span = spanAt(source, issue.line, issue.column);
    } else if (issue.code.startsWith('SPRITE_')) {
      sprite ??= findSprite(source, tree);
      if (sprite.kind === 'found') span = sprite.name;
    } else if (issue.field && STATS.has(issue.field) && issue.code !== 'UNIT_TOO_EXPENSIVE') {
      span = findStatValue(source, issue.field, tree);
    }
    if (span) diagnostics.push({ ...span, severity, code: issue.code, message, detail });
    else banner.push({ severity, code: issue.code, message, detail });
  }
  return { diagnostics, banner };
}

// ---------------------------------------------------------------------------
// Cost panel
// ---------------------------------------------------------------------------

const STAT_LABEL: Record<PricedStat, string> = { maxHealth: 'Health', damage: 'Damage', range: 'Range', speed: 'Speed', size: 'Size' };

const money = (n: number) => (Math.abs(n - Math.round(n)) < 1e-9 ? `$${Math.round(n)}` : `$${n.toFixed(2).replace(/0$/, '')}`);

export interface CostRow {
  label: string;
  /** The stat value (size: the radius). */
  value: number | null;
  /** This row's price: "$45" (or "$45 + $90 near max"). */
  price: string;
  /** Extra for being near the max (0 when none). */
  surcharge: number;
  /** At ≥ 80 % of the max (the W_STAT_NEAR_MAX zone). */
  nearMax: boolean;
}

export interface CostPanel {
  cost: number;
  cap: number;
  overCap: boolean;
  rows: CostRow[];
  /** "×1.33 for fast attacks" (null at ×1). */
  factor: string | null;
  /** Near-max surcharge of the stats at ≥ 80 % of their max, before the attack factor. */
  surcharge: number;
}

/** The live cost panel: base, each stat (with its near-max surcharge), the attack factor, the total vs the cap. */
export function costPanel(b: CostBreakdown, cap: number): CostPanel {
  const rows: CostRow[] = [{ label: 'Base', value: null, price: money(b.terms.base), surcharge: 0, nearMax: false }];
  let surcharge = 0;
  for (const stat of PRICED_STATS) {
    const p = b.parts[stat];
    const nearMax = p.ratio >= NEAR_MAX_RATIO && p.linear > 0 && CURVE_MAX[stat] > 0;
    if (nearMax) surcharge += p.curve;
    rows.push({
      label: STAT_LABEL[stat],
      value: p.value,
      // Every stat has a little curve; it is spelled out where it bites (≥ 80 % of the max).
      price: nearMax ? `${money(p.linear)} + ${money(p.curve)} near max` : money(p.total),
      surcharge: p.curve,
      nearMax,
    });
  }
  const factor = b.factor > 1 + 1e-9 ? `×${b.factor.toFixed(2).replace(/\.?0+$/, '')} for fast attacks` : null;
  return { cost: b.cost, cap, overCap: b.cost > cap, rows, factor, surcharge };
}

/** The breakdown to show for a result: the success's, or UNIT_TOO_EXPENSIVE's. */
export function breakdownOf(result: ValidationResult): CostBreakdown | null {
  if (result.ok) return result.unit.breakdown;
  return result.errors.find((e) => e.code === 'UNIT_TOO_EXPENSIVE')?.breakdown ?? null;
}

// ---------------------------------------------------------------------------
// Live validation: debounce + coalesce (plan §12.1)
// ---------------------------------------------------------------------------

export type LiveOutcome<R> =
  | { kind: 'result'; result: R }
  /** The server said wait (another validate, e.g. Claude's, used the 1/s slot). */
  | { kind: 'rateLimited'; retryAfterMs: number }
  | { kind: 'error'; error: unknown };

export type LiveStatus = 'idle' | 'waiting' | 'checking';

export interface LiveTimers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: LiveTimers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Validates the latest source `debounceMs` after typing stops. Never more
 * than one request in flight and never two starts closer than
 * `minIntervalMs` (the server's 1/s validate limit): changes made meanwhile
 * are coalesced into ONE follow-up request for the newest source. Results
 * for an outdated source are dropped (their line numbers would be wrong).
 */
export class LiveValidator<R> {
  private source = '';
  private gen = 0;
  private debounceTimer: unknown = null;
  private waitTimer: unknown = null;
  private inFlight = false;
  /** A request is due (debounce fired) but had to wait. */
  private due = false;
  private lastStart = -Infinity;
  private stopped = false;
  status: LiveStatus = 'idle';

  constructor(
    private readonly run: (source: string) => Promise<LiveOutcome<R>>,
    private readonly onResult: (outcome: LiveOutcome<R> & { source: string }) => void,
    private readonly opts: { debounceMs?: number; minIntervalMs?: number; onStatus?: (s: LiveStatus) => void } = {},
    private readonly timers: LiveTimers = realTimers,
  ) {}

  private setStatus(s: LiveStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  /** The document changed (typing). */
  change(source: string): void {
    if (this.stopped) return;
    this.source = source;
    this.gen++;
    if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
    this.debounceTimer = this.timers.set(() => {
      this.debounceTimer = null;
      this.due = true;
      this.pump();
    }, this.opts.debounceMs ?? 600);
    if (!this.inFlight) this.setStatus('waiting');
  }

  /** Validate now (on open, after a reload), still within the limits. */
  now(source: string): void {
    if (this.stopped) return;
    this.source = source;
    this.gen++;
    if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
    this.debounceTimer = null;
    this.due = true;
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
    if (this.waitTimer !== null) this.timers.clear(this.waitTimer);
    this.debounceTimer = this.waitTimer = null;
  }

  private pump(): void {
    if (this.stopped || !this.due || this.inFlight || this.waitTimer !== null) return;
    const wait = this.lastStart + (this.opts.minIntervalMs ?? 1000) - this.timers.now();
    if (wait > 0) {
      this.setStatus('waiting');
      this.waitTimer = this.timers.set(() => {
        this.waitTimer = null;
        this.pump();
      }, wait);
      return;
    }
    this.due = false;
    this.inFlight = true;
    this.lastStart = this.timers.now();
    const gen = this.gen;
    const source = this.source;
    this.setStatus('checking');
    void this.run(source)
      .catch((error: unknown): LiveOutcome<R> => ({ kind: 'error', error }))
      .then((outcome) => {
        this.inFlight = false;
        if (this.stopped) return;
        if (outcome.kind === 'rateLimited') {
          // Try again once the server's slot is free (still the newest source).
          this.lastStart = this.timers.now() + outcome.retryAfterMs - (this.opts.minIntervalMs ?? 1000);
          this.due = true;
        } else if (gen === this.gen) {
          this.onResult({ ...outcome, source });
        }
        if (this.due) this.pump();
        else this.setStatus(this.debounceTimer !== null || gen !== this.gen ? 'waiting' : 'idle');
      });
  }
}

// ---------------------------------------------------------------------------
// Drafts (localStorage, per unit)
// ---------------------------------------------------------------------------

export interface Draft {
  source: string;
  /** The version the draft started from (0 for a copy of a template). */
  baseVersion: number;
  savedAt: number;
}

export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One draft per player and unit ("copy:<template>" for a template copy). */
export function draftKey(playerId: string, unitKey: string): string {
  return `pc-draft-${playerId}-${unitKey}`;
}

function storage(s?: DraftStore | null): DraftStore | null {
  if (s !== undefined) return s;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(key: string, s?: DraftStore | null): Draft | null {
  try {
    const raw = storage(s)?.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    return typeof d.source === 'string' && typeof d.baseVersion === 'number' ? { source: d.source, baseVersion: d.baseVersion, savedAt: d.savedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, draft: Draft, s?: DraftStore | null): void {
  try {
    storage(s)?.setItem(key, JSON.stringify(draft));
  } catch {
    // private window or full storage: no draft, that's fine
  }
}

export function clearDraft(key: string, s?: DraftStore | null): void {
  try {
    storage(s)?.removeItem(key);
  } catch {
    // nothing to clear
  }
}

export type DraftChoice =
  /** No draft (or it equals the stored code): open the stored code. */
  | { kind: 'none' }
  /** Same version: carry on with the draft. */
  | { kind: 'restore'; draft: Draft }
  /** The unit changed since the draft (Claude saved a new version): open the new code, offer the draft. */
  | { kind: 'stale'; draft: Draft };

export function draftChoice(draft: Draft | null, stored: { source: string; version: number }): DraftChoice {
  if (!draft || draft.source === stored.source) return { kind: 'none' };
  return draft.baseVersion === stored.version ? { kind: 'restore', draft } : { kind: 'stale', draft };
}

// ---------------------------------------------------------------------------
// Saving and phases
// ---------------------------------------------------------------------------

/** Saving is a submit, so PLAN only (§10.2); validation works in every phase. */
export function saveBlockedReason(phase: Phase | undefined, opts: { busy?: boolean; hasErrors?: boolean; dirty?: boolean; isCopy?: boolean } = {}): string | null {
  if (phase !== 'PLAN') return 'You can save during Plan time';
  if (opts.busy) return 'Saving…';
  if (opts.hasErrors) return 'Fix the red mistakes first';
  if (!opts.dirty && !opts.isCopy) return 'Change something first';
  return null;
}

/**
 * What the open editor does when the phase changes: the roster goes away in
 * PLACEMENT and BATTLE, so the editor closes, after asking if there are
 * unsaved changes (they stay as a draft on this laptop either way).
 */
export function phaseGuard(next: Phase, dirty: boolean): 'stay' | 'close' | 'ask' {
  if (next !== 'PLACEMENT' && next !== 'BATTLE') return 'stay';
  return dirty ? 'ask' : 'close';
}

/** "Saved v6 — $142" */
export function savedToast(version: number, cost: number, isNew: boolean, name: string): string {
  return isNew ? `Saved ${name} (v${version}) — $${cost}` : `Saved v${version} — $${cost}`;
}
