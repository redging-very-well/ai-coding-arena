// The /play code editor (plan §12.1 "✏️ Edit code"), DOM-free parts: the
// read-only sprite() range found in the lezer syntax tree, the CodeMirror
// transaction filter that protects it, validator issues → diagnostics, the
// cost panel, the debounced/coalesced live validation, drafts and guards.

import { readFileSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, type ValidationResult } from '@pixel-clash/shared';
import {
  LiveValidator,
  copyNameProblem,
  costPanel,
  draftChoice,
  findSprite,
  findStatValue,
  isTypeScript,
  loadDraft,
  phaseGuard,
  saveBlockedReason,
  saveDraft,
  savedToast,
  spanAt,
  toDiagnostics,
  unitNameOf,
  withUnitName,
  type LiveOutcome,
  type LiveTimers,
} from '../packages/client/src/play/editor/logic.js';
import { allowProtectedEdit, protectSprite, protectedRange, setProtected, touchesProtected } from '../packages/client/src/play/editor/protect.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const soldier = read('../packages/starter-kit/units/basic_soldier.js');
const tower = read('../packages/starter-kit/units/basic_tower.js');
const bat = read('./fixtures/units/good/pixel_bat.js');
const typed = read('./fixtures/units/good/typescript_unit.js');

/** The text of the found sprite() member. */
function spriteText(src: string): string {
  const loc = findSprite(src);
  if (loc.kind !== 'found') throw new Error(`no sprite: ${loc.kind}`);
  return src.slice(loc.range.from, loc.range.to);
}

const CLAUDE_STYLE = `// Ogre Smash: a big slow bruiser (made with Claude)
const RANGE = 30;

function nearest(self, list) {
  let best = null, bestD = Infinity;
  for (const e of list) { const d = Math.hypot(e.x - self.x, e.y - self.y); if (d < bestD) { bestD = d; best = e; } }
  return best;
}

class OgreSmash {
  constructor() {
    this.name = "Ogre Smash";
    this.type = 'soldier';
    this.maxHealth = 320;
    this.damage = 25;
    this.range = RANGE;
    this.speed = 1;
    this.attackCooldown = 60;
    this.color = '#AA5533';
  }

  // sprite() is below; update() first
  update(self, enemies) {
    const t = nearest(self, enemies);
    if (!t) return { action: 'idle' };
    return { action: 'attack', targetId: t.id };
  }

  /* how it looks */
  sprite() {
    const row = '.'.repeat(16);
    const frame = Array.from({ length: 16 }, (_, i) => (i === 8 ? 'oooooooooooooooo' : row));
    return { grid: 16, palette: { o: '#111111' }, frames: { idle: [frame], walk: [frame] } };
  }
}

export default OgreSmash;
`;

describe('sprite() range (lezer tree)', () => {
  it('finds sprite() in both templates, from the method name to its closing brace', () => {
    for (const src of [soldier, tower]) {
      const text = spriteText(src);
      expect(text.startsWith('sprite() {')).toBe(true);
      expect(text.endsWith('}')).toBe(true);
      expect(text).toContain('frames:');
      expect(text).not.toContain('update(');
      // The class's own closing brace is outside.
      const loc = findSprite(src);
      expect(loc.kind === 'found' && src.slice(loc.range.to).trim()).toBe('}');
    }
  });

  it('folds the inside of the body and points the name at "sprite"', () => {
    const loc = findSprite(bat);
    expect(loc.kind).toBe('found');
    if (loc.kind !== 'found') return;
    expect(bat.slice(loc.name.from, loc.name.to)).toBe('sprite');
    expect(bat[loc.fold!.from - 1]).toBe('{');
    expect(bat[loc.fold!.to]).toBe('}');
  });

  it('handles Claude-style files: helpers outside, comments mentioning sprite, `export default Name`', () => {
    const text = spriteText(CLAUDE_STYLE);
    expect(text.startsWith('sprite() {')).toBe(true);
    expect(text).toContain("palette: { o: '#111111' }");
  });

  it('reports none when there is no sprite()', () => {
    const noSprite = CLAUDE_STYLE.replace(/\/\* how it looks \*\/[\s\S]*?\n  }\n(?=})/, '');
    expect(noSprite).not.toContain('sprite() {');
    expect(findSprite(noSprite)).toEqual({ kind: 'none' });
    expect(findSprite('export default class A { constructor() { this.name = "A"; } update() { return { action: "idle" }; } }')).toEqual({ kind: 'none' });
  });

  it('copes with weird formatting: one line, odd spacing, a class field arrow, TypeScript', () => {
    const oneLine = "export default class X{constructor(){this.name='X'}update(){return{action:'idle'}}sprite(){return{grid:8,palette:{},frames:{idle:[]}}}}";
    expect(spriteText(oneLine)).toBe('sprite(){return{grid:8,palette:{},frames:{idle:[]}}}');
    const spaced = 'export   default\n class   Y {\n  sprite ( )\n  {\n    return null\n  }\n  update() {}\n}\n';
    expect(spriteText(spaced)).toBe('sprite ( )\n  {\n    return null\n  }');
    const field = "export default class Z { sprite = () => { return { grid: 8 }; }; update() {} }";
    expect(spriteText(field)).toBe('sprite = () => { return { grid: 8 }; };');
    // A static sprite() is not the unit's sprite.
    expect(findSprite('export default class S { static sprite() { return 1; } update() {} }')).toEqual({ kind: 'none' });
    expect(isTypeScript(typed)).toBe(true);
    expect(isTypeScript(soldier)).toBe(false);
    expect(findStatValue(typed, 'damage')).not.toBeNull();
  });

  it('says "unknown" (whole file editable, with a warning) when it cannot tell', () => {
    // Two sprite() members.
    expect(findSprite('export default class D { sprite() { return 1; } sprite() { return 2; } }')).toEqual({ kind: 'unknown' });
    // A broken file that mentions sprite where the tree can't see a method.
    expect(findSprite('export default class B { update() { return { action: "idle" } \n sprite() { return {')).not.toEqual({ kind: 'none' });
    // No class at all, but sprite is mentioned.
    expect(findSprite('const sprite = 1; export default sprite;')).toEqual({ kind: 'unknown' });
  });

  it('finds stat values in the constructor and renames copies', () => {
    const d = findStatValue(soldier, 'damage')!;
    expect(soldier.slice(d.from, d.to)).toBe('56');
    expect(unitNameOf(soldier)).toBe('Basic Soldier');
    const r = withUnitName(soldier, "Zoe's Knight")!;
    expect(unitNameOf(r.source)).toBe("Zoe's Knight");
    expect(r.source).toContain("this.name = 'Zoe\\'s Knight';");
    expect(findStatValue(CLAUDE_STYLE, 'range')).not.toBeNull();
    expect(copyNameProblem('', 'Basic Soldier')).toBeTruthy();
    expect(copyNameProblem('basic soldier', 'Basic Soldier')).toBeTruthy();
    expect(copyNameProblem('x'.repeat(25), 'Basic Soldier')).toBeTruthy();
    expect(copyNameProblem('My Knight', 'Basic Soldier')).toBeNull();
  });
});

describe('read-only sprite() filter', () => {
  const doc = 'class A {\n  update() {}\n  sprite() { return 1; }\n}\n';
  const from = doc.indexOf('sprite()');
  const to = doc.indexOf('}\n}') + 1;
  const state = () => EditorState.create({ doc, extensions: protectSprite({ from, to }) });

  it('lets edits elsewhere through and keeps the range mapped', () => {
    const s = state().update({ changes: { from: doc.indexOf('{}'), insert: ' /* hi */ ' } }).state;
    expect(s.doc.toString()).toContain('update()  /* hi */ {}');
    const r = s.field(protectedRange)!;
    expect(s.doc.sliceString(r.from, r.to)).toBe('sprite() { return 1; }');
    // Typing right before and right after the method is fine (and stays outside).
    const s2 = s.update({ changes: [{ from: r.from, insert: '// look\n  ' }, { from: r.to, insert: ' // end' }] }).state;
    const r2 = s2.field(protectedRange)!;
    expect(s2.doc.sliceString(r2.from, r2.to)).toBe('sprite() { return 1; }');
    expect(s2.doc.toString()).toContain('// look\n  sprite() { return 1; } // end');
  });

  it('blocks edits inside, deletions across it and select-all delete', () => {
    const s = state();
    const inside = s.update({ changes: { from: from + 12, insert: '2' } }).state;
    expect(inside.doc.toString()).toBe(doc);
    const across = s.update({ changes: { from: from - 5, to: from + 3 } }).state;
    expect(across.doc.toString()).toBe(doc);
    const all = s.update({ changes: { from: 0, to: doc.length } }).state;
    expect(all.doc.toString()).toBe(doc);
    // A transaction with one allowed and one blocked change is refused whole.
    const mixed = s.update({ changes: [{ from: 0, insert: 'x' }, { from: from + 1, insert: 'y' }] }).state;
    expect(mixed.doc.toString()).toBe(doc);
  });

  it('allows a full reload (annotated) and a new range by effect', () => {
    const s = state().update({ changes: { from: 0, to: doc.length, insert: 'class B {}' }, annotations: allowProtectedEdit.of(true), effects: setProtected.of(null) }).state;
    expect(s.doc.toString()).toBe('class B {}');
    expect(s.field(protectedRange)).toBeNull();
    // Nothing protected: anything goes.
    expect(s.update({ changes: { from: 0, to: s.doc.length } }).state.doc.length).toBe(0);
  });

  it('touchesProtected: edges are free, overlaps are not', () => {
    const r = { from: 10, to: 20 };
    expect(touchesProtected(r, 10, 10)).toBe(false);
    expect(touchesProtected(r, 20, 20)).toBe(false);
    expect(touchesProtected(r, 11, 11)).toBe(true);
    expect(touchesProtected(r, 5, 10)).toBe(false);
    expect(touchesProtected(r, 20, 25)).toBe(false);
    expect(touchesProtected(r, 5, 11)).toBe(true);
    expect(touchesProtected(r, 19, 25)).toBe(true);
  });
});

describe('diagnostics from validator results', () => {
  const fail = (errors: object[], warnings: object[] = []): ValidationResult =>
    ({ ok: false, errors, warnings, cost: null, playerHint: '' }) as unknown as ValidationResult;

  it('puts a syntax error at its line and column', () => {
    const src = 'export default class A {\n  update() {\n    return { action: "idle" \n  }\n}\n';
    const { diagnostics, banner } = toDiagnostics(
      fail([{ code: 'SYNTAX_ERROR', line: 4, column: 3, message: 'Syntax error on line 4, column 3: Expected "}" but found "}"', fix: 'Fix the syntax.' }]),
      src,
    );
    expect(banner).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d).toMatchObject({ severity: 'error', code: 'SYNTAX_ERROR' });
    expect(src.slice(0, d.from).split('\n').length).toBe(4);
    expect(d.message).toContain('typo'); // the player hint
    expect(d.detail).toContain('Syntax error on line 4');
  });

  it('puts stat errors and near-max warnings on the stat value; cost errors go to the banner', () => {
    const src = soldier.replace(/this\.damage = \d+/, 'this.damage = 60');
    const r = fail(
      [
        { code: 'STAT_OUT_OF_RANGE', field: 'maxHealth', value: 900, allowed: { min: 10, max: 500 }, message: 'maxHealth is 900 (max 500).', fix: 'Lower it.' },
        { code: 'UNIT_TOO_EXPENSIVE', field: 'cost', value: 900, allowed: { max: 500 }, message: 'Costs $900.', fix: 'Cheaper.' },
      ],
      [{ code: 'W_STAT_NEAR_MAX', field: 'damage', value: 60, message: 'damage is at 100% of max', fix: 'Set this.damage to 36.' }],
    );
    const { diagnostics, banner } = toDiagnostics(r, src);
    const hp = diagnostics.find((d) => d.code === 'STAT_OUT_OF_RANGE')!;
    expect(src.slice(hp.from, hp.to)).toBe(String(/this\.maxHealth = (\d+)/.exec(soldier)![1]));
    expect(hp.message).toContain('health is too big');
    const dmg = diagnostics.find((d) => d.code === 'W_STAT_NEAR_MAX')!;
    expect(dmg.severity).toBe('warning');
    expect(src.slice(dmg.from, dmg.to)).toBe('60');
    expect(banner.map((b) => b.code)).toEqual(['UNIT_TOO_EXPENSIVE']);
    expect(banner[0]!.message).toContain('$900, the max is $500');
  });

  it('puts sprite errors on the sprite() name, and location-less ones in the banner', () => {
    const r = fail([{ code: 'SPRITE_BAD_FRAME', state: 'idle', frame: 0, row: 3, message: 'Row 3 is 15 long.', fix: 'Make it 16.' }], [
      { code: 'W_NEVER_ATTACKS', message: 'Never attacks.', fix: 'Attack.' },
    ]);
    const { diagnostics, banner } = toDiagnostics(r, tower);
    expect(tower.slice(diagnostics[0]!.from, diagnostics[0]!.to)).toBe('sprite');
    expect(banner).toEqual([expect.objectContaining({ code: 'W_NEVER_ATTACKS', severity: 'warning' })]);
  });

  it('spanAt marks the word at a column, or the line text without one', () => {
    const src = 'a\n  foo(bar)\nz';
    expect(spanAt(src, 2, 3)).toEqual({ from: 4, to: 7 });
    expect(spanAt(src, 2)).toEqual({ from: 4, to: 12 });
    // Past the end of the line: the last character.
    expect(spanAt(src, 2, 99)).toEqual({ from: 11, to: 12 });
  });
});

describe('cost panel', () => {
  it('shows the near-max surcharge and the over-cap state', () => {
    const stats = { name: 'Big', type: 'soldier' as const, maxHealth: 1600, damage: 240, range: 40, speed: 1.5, attackCooldown: 60, color: '#112233' };
    const priced = computeCost(stats, DEFAULT_CONFIG.cost);
    const p = costPanel(priced.breakdown, 3000);
    const dmg = p.rows.find((r) => r.label === 'Damage')!;
    expect(dmg.nearMax).toBe(true);
    expect(dmg.price).toMatch(/^\$450 \+ \$450 near max$/);
    expect(p.surcharge).toBeCloseTo(450, 6); // only the near-max stats count
    expect(p.rows.find((r) => r.label === 'Health')!.price).toMatch(/^\$\d+(\.\d+)?$/);
    expect(p.overCap).toBe(false);
    expect(costPanel(priced.breakdown, 100).overCap).toBe(true);
    expect(p.rows.find((r) => r.label === 'Health')!.nearMax).toBe(false);
  });
});

// A fake clock for LiveValidator.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const t: LiveTimers & { advance(ms: number): Promise<void> } = {
    now: () => now,
    set: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h) => void timers.delete(h as number),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      now = end;
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  return t;
}

describe('live validation (debounce + coalesce)', () => {
  function setup(respond: (src: string) => LiveOutcome<string> = (s) => ({ kind: 'result', result: `ok:${s}` })) {
    const timers = fakeTimers();
    const calls: Array<{ src: string; at: number; resolve: () => void }> = [];
    const results: string[] = [];
    const live = new LiveValidator<string>(
      (src) =>
        new Promise((resolve) => {
          calls.push({ src, at: timers.now(), resolve: () => resolve(respond(src)) });
        }),
      (o) => results.push(o.kind === 'result' ? o.result : o.kind),
      { debounceMs: 600, minIntervalMs: 1000 },
      timers,
    );
    return { timers, calls, results, live };
  }

  it('waits 600 ms after the last keystroke', async () => {
    const { timers, calls, live } = setup();
    live.change('a');
    await timers.advance(400);
    live.change('ab');
    await timers.advance(400);
    expect(calls).toHaveLength(0);
    await timers.advance(200);
    expect(calls.map((c) => c.src)).toEqual(['ab']);
  });

  it('never has two in flight; changes meanwhile become ONE follow-up for the newest code, ≥ 1 s apart', async () => {
    const { timers, calls, results, live } = setup();
    live.now('v1');
    await timers.advance(0);
    expect(calls).toHaveLength(1);
    live.change('v2');
    await timers.advance(700);
    live.change('v3');
    await timers.advance(700);
    live.change('v4');
    await timers.advance(700);
    expect(calls).toHaveLength(1); // still waiting for the first
    calls[0]!.resolve();
    await timers.advance(0);
    // v1's result is outdated (the code changed): dropped.
    expect(results).toEqual([]);
    expect(calls.map((c) => c.src)).toEqual(['v1', 'v4']);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1000);
    calls[1]!.resolve();
    await timers.advance(0);
    expect(results).toEqual(['ok:v4']);
    expect(live.status).toBe('idle');
  });

  it('keeps 1 s between starts even when the answer is quick', async () => {
    const { timers, calls, live } = setup();
    live.now('a');
    await timers.advance(0);
    calls[0]!.resolve();
    await timers.advance(0);
    live.change('b');
    await timers.advance(600); // debounce done at t=600, but the slot frees at t=1000
    expect(calls).toHaveLength(1);
    await timers.advance(400);
    expect(calls.map((c) => [c.src, c.at])).toEqual([
      ['a', 0],
      ['b', 1000],
    ]);
  });

  it('retries after RATE_LIMITED (Claude used the slot) without showing anything', async () => {
    let first = true;
    const { timers, calls, results, live } = setup((s) => {
      if (first) {
        first = false;
        return { kind: 'rateLimited', retryAfterMs: 800 };
      }
      return { kind: 'result', result: `ok:${s}` };
    });
    live.now('x');
    await timers.advance(0);
    calls[0]!.resolve();
    await timers.advance(0);
    expect(results).toEqual([]);
    await timers.advance(799);
    expect(calls).toHaveLength(1);
    await timers.advance(1);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve();
    await timers.advance(0);
    expect(results).toEqual(['ok:x']);
  });

  it('stops cleanly', async () => {
    const { timers, calls, live } = setup();
    live.change('a');
    live.stop();
    await timers.advance(5000);
    expect(calls).toHaveLength(0);
  });
});

describe('drafts, saving and phase guard', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it('restores a draft of the same version, offers a stale one, ignores an equal one', () => {
    const s = mem();
    saveDraft('k', { source: 'edited', baseVersion: 5, savedAt: 1 }, s);
    const d = loadDraft('k', s);
    expect(draftChoice(d, { source: 'orig', version: 5 })).toEqual({ kind: 'restore', draft: d });
    expect(draftChoice(d, { source: 'claude', version: 6 })).toEqual({ kind: 'stale', draft: d });
    expect(draftChoice(d, { source: 'edited', version: 6 })).toEqual({ kind: 'none' });
    expect(draftChoice(null, { source: 'x', version: 1 })).toEqual({ kind: 'none' });
    s.setItem('bad', '{nope');
    expect(loadDraft('bad', s)).toBeNull();
    // Storage that throws (private mode) is fine.
    const throwing = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
    expect(loadDraft('k', throwing)).toBeNull();
    expect(() => saveDraft('k', { source: '', baseVersion: 1, savedAt: 0 }, throwing)).not.toThrow();
  });

  it('saves only in PLAN, without known mistakes, when something changed', () => {
    expect(saveBlockedReason('PLACEMENT', { dirty: true })).toBe('You can save during Plan time');
    expect(saveBlockedReason('RESULTS', { dirty: true })).toBe('You can save during Plan time');
    expect(saveBlockedReason('PLAN', { dirty: true })).toBeNull();
    expect(saveBlockedReason('PLAN', { dirty: false })).toBeTruthy();
    expect(saveBlockedReason('PLAN', { dirty: false, isCopy: true })).toBeNull();
    expect(saveBlockedReason('PLAN', { dirty: true, hasErrors: true })).toBe('Fix the red mistakes first');
  });

  it('closes (or asks first) when the roster goes away', () => {
    expect(phaseGuard('PLACEMENT', false)).toBe('close');
    expect(phaseGuard('PLACEMENT', true)).toBe('ask');
    expect(phaseGuard('BATTLE', true)).toBe('ask');
    expect(phaseGuard('RESULTS', true)).toBe('stay');
    expect(phaseGuard('PLAN', true)).toBe('stay');
  });

  it('toast text', () => {
    expect(savedToast(6, 142, false, 'Big Tank')).toBe('Saved v6 — $142');
    expect(savedToast(1, 80, true, 'My Knight')).toBe('Saved My Knight (v1) — $80');
  });
});
