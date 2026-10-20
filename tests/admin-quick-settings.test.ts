// /admin Quick settings (DOM-free helpers): the field table's display
// conversions, path access, the patch they produce, validation, server
// refusal mapping and the live cost preview.

import { describe, expect, it } from 'vitest';
import { ConfigSchema, DEFAULT_CONFIG, computeCost, safeParseConfig, type GameConfig } from '@pixel-clash/shared';
import { configDiff } from '../packages/client/src/admin/configDiff.js';
import {
  BASIC_SOLDIER,
  BASIC_TOWER,
  BIG_TANK,
  QUICK_FIELDS,
  QUICK_GROUPS,
  applyField,
  costPreview,
  displayValue,
  fieldChanged,
  fromDisplay,
  getPath,
  inputErrorText,
  parseFieldInput,
  refusalIssues,
  setPath,
  toDisplay,
  typeIntoField,
  unique,
  validateDraft,
} from '../packages/client/src/admin/quickSettings.js';

const cfg = (): GameConfig => structuredClone(DEFAULT_CONFIG);
const field = (path: string) => {
  const f = QUICK_FIELDS.find((x) => x.path === path);
  if (!f) throw new Error(`no field ${path}`);
  return f;
};

describe('quick settings field table', () => {
  it('every field points at a number in the default config, with a label and help', () => {
    for (const f of QUICK_FIELDS) {
      expect(typeof getPath(DEFAULT_CONFIG, f.path), f.path).toBe('number');
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
    }
    expect(new Set(QUICK_FIELDS.map((f) => f.path)).size).toBe(QUICK_FIELDS.length);
    expect(QUICK_GROUPS.map((g) => g.title)).toEqual(['Economy', 'Timers', 'Costs', 'Scoring', 'Sudden death']);
  });

  it('default values sit inside each field’s own bounds', () => {
    for (const f of QUICK_FIELDS) {
      const shown = displayValue(f, DEFAULT_CONFIG)!;
      expect(parseFieldInput(f, String(shown), DEFAULT_CONFIG), f.path).toEqual({ ok: true, stored: getPath(DEFAULT_CONFIG, f.path) });
    }
  });

  it('shows plan/placement seconds as minutes and back', () => {
    const plan = field('timers.planFirstRoundSec');
    expect(toDisplay(plan, 900, DEFAULT_CONFIG)).toBe(15);
    expect(toDisplay(field('timers.planLaterRoundsSec'), 480, DEFAULT_CONFIG)).toBe(8);
    expect(toDisplay(field('timers.placementSec'), 90, DEFAULT_CONFIG)).toBe(1.5);
    expect(fromDisplay(plan, 12.5, DEFAULT_CONFIG)).toBe(750);
    // Stored seconds are whole numbers (the schema wants an int).
    expect(fromDisplay(plan, 1 / 3, DEFAULT_CONFIG)).toBe(20);
  });

  it('shows ticks as seconds using ticksPerSecond', () => {
    const battle = field('timers.battleTicks');
    expect(toDisplay(battle, 5400, DEFAULT_CONFIG)).toBe(90);
    expect(fromDisplay(battle, 120, DEFAULT_CONFIG)).toBe(7200);
    const c30 = setPath(cfg(), 'timers.ticksPerSecond', 30);
    expect(toDisplay(battle, 5400, c30)).toBe(180);
    expect(fromDisplay(field('suddenDeath.startTick'), 45, c30)).toBe(1350);
    expect(toDisplay(field('suddenDeath.startTick'), 3600, DEFAULT_CONFIG)).toBe(60);
  });

  it('round-trips every field (stored → shown → stored)', () => {
    for (const f of QUICK_FIELDS) {
      const stored = getPath(DEFAULT_CONFIG, f.path) as number;
      expect(fromDisplay(f, toDisplay(f, stored, DEFAULT_CONFIG), DEFAULT_CONFIG), f.path).toBe(stored);
    }
    const plan = field('timers.placementSec');
    for (const s of [30, 61, 179, 600]) expect(fromDisplay(plan, toDisplay(plan, s, DEFAULT_CONFIG), DEFAULT_CONFIG)).toBe(s);
  });

  it('reads and writes array paths without touching the original', () => {
    const base = cfg();
    expect(getPath(base, 'scoring.placePoints.0')).toBe(3);
    expect(getPath(base, 'scoring.placePoints.3')).toBe(0);
    expect(getPath(base, 'nope.deeper')).toBeUndefined();
    const next = setPath(base, 'scoring.placePoints.1', 5);
    expect(next.scoring.placePoints).toEqual([3, 5, 1, 0]);
    expect(Array.isArray(next.scoring.placePoints)).toBe(true);
    expect(base.scoring.placePoints).toEqual([3, 2, 1, 0]);
    expect(next.caps).toBe(base.caps); // untouched branches are shared
  });
});

describe('quick settings edits → patch', () => {
  it('a form edit produces the minimal patch (arrays sent whole)', () => {
    const base = cfg();
    let draft = applyField(base, 'caps.budget', 1200);
    draft = applyField(draft, 'scoring.placePoints.0', 4);
    draft = applyField(draft, 'timers.planFirstRoundSec', fromDisplay(field('timers.planFirstRoundSec'), 10, draft));
    const patch = configDiff(base, draft);
    expect(patch).toEqual({ caps: { budget: 1200 }, timers: { planFirstRoundSec: 600 }, scoring: { placePoints: [4, 2, 1, 0] } });
    const r = safeParseConfig(patch, DEFAULT_CONFIG);
    expect(r.success).toBe(true);
    expect(fieldChanged(field('caps.budget'), base, draft)).toBe(true);
    expect(fieldChanged(field('caps.unitCost'), base, draft)).toBe(false);
    expect(fieldChanged(field('scoring.placePoints.0'), base, draft)).toBe(true);
    expect(fieldChanged(field('scoring.placePoints.1'), base, draft)).toBe(false);
  });

  it('battle length drags the sudden-death end along when they were equal', () => {
    const base = cfg();
    const longer = applyField(base, 'timers.battleTicks', 7200);
    expect(longer.suddenDeath.endTick).toBe(7200);
    expect(configDiff(base, longer)).toEqual({ timers: { battleTicks: 7200 }, suddenDeath: { endTick: 7200 } });
    // A custom end (not equal to the battle length) is left alone.
    const custom = setPath(base, 'suddenDeath.endTick', 5000);
    expect(applyField(custom, 'timers.battleTicks', 7200).suddenDeath.endTick).toBe(5000);
  });
});

describe('quick settings validation', () => {
  it('checks typed input against the table (empty, non-number, integer, min/max)', () => {
    const rounds = field('timers.defaultRounds');
    expect(parseFieldInput(rounds, '', DEFAULT_CONFIG).ok).toBe(false);
    expect(parseFieldInput(rounds, 'abc', DEFAULT_CONFIG).ok).toBe(false);
    expect(parseFieldInput(rounds, '2.5', DEFAULT_CONFIG)).toEqual({ ok: false, error: 'Use a whole number.' });
    expect(parseFieldInput(rounds, '11', DEFAULT_CONFIG).ok).toBe(false);
    expect(parseFieldInput(rounds, '0', DEFAULT_CONFIG).ok).toBe(false);
    expect(parseFieldInput(rounds, ' 5 ', DEFAULT_CONFIG)).toEqual({ ok: true, stored: 5 });
    expect(parseFieldInput(field('cost.hp'), '-1', DEFAULT_CONFIG).ok).toBe(false);
    expect(parseFieldInput(field('cost.curveK'), '6', DEFAULT_CONFIG).ok).toBe(false);
    expect(parseFieldInput(field('timers.placementSec'), '2.5', DEFAULT_CONFIG)).toEqual({ ok: true, stored: 150 });
  });

  it('the default config has no issues', () => {
    expect(validateDraft(DEFAULT_CONFIG)).toEqual({ byField: {}, other: [] });
  });

  it('maps zod schema issues to the quick fields', () => {
    const bad = setPath(setPath(cfg(), 'caps.budget', 0.5), 'scoring.placePoints.2', -1);
    const r = validateDraft(bad);
    expect(r.byField['caps.budget']?.length).toBeGreaterThan(0);
    expect(r.byField['scoring.placePoints.2']?.length).toBeGreaterThan(0);
    expect(r.other).toEqual([]);
    // Object-level rule: start must be before end → shown on the sudden-death fields.
    const late = setPath(cfg(), 'suddenDeath.startTick', 6000);
    const s = validateDraft(late);
    expect(s.byField['suddenDeath.startTick']?.join(' ')).toMatch(/must start before the circle finishes shrinking \(at 90 s\), which is the end of the battle/);
    // ...only on the start field, and on Battle length too since the end follows it.
    expect(s.byField['suddenDeath.damagePctPerSecond']).toBeUndefined();
    expect(s.byField['timers.battleTicks']).toEqual(s.byField['suddenDeath.startTick']);
    // Shortening the battle below the start: the error shows on Battle length.
    const short = applyField(cfg(), 'timers.battleTicks', 50 * DEFAULT_CONFIG.timers.ticksPerSecond);
    expect(validateDraft(short).byField['timers.battleTicks']?.length).toBe(1);
    // A custom sudden-death end: Battle length is not to blame.
    const custom = setPath(setPath(cfg(), 'suddenDeath.endTick', 3000), 'suddenDeath.startTick', 3000);
    expect(validateDraft(custom).byField['timers.battleTicks']).toBeUndefined();
    expect(validateDraft(custom).byField['suddenDeath.startTick']?.length).toBe(1);
    // Issues outside the quick fields go to `other`.
    const sandbox = setPath(cfg(), 'sandbox.memoryLimitMb', -3);
    expect(validateDraft(sandbox).other[0]).toMatch(/^sandbox\.memoryLimitMb: /);
  });

  it('agrees with the schema: everything the table allows for defaults parses', () => {
    expect(ConfigSchema.safeParse(applyField(cfg(), 'cost.curveK', 5)).success).toBe(true);
    expect(validateDraft(applyField(cfg(), 'cost.curveK', 5.5)).byField['cost.curveK']).toBeDefined();
  });

  it('puts a server refusal next to the fields that changed', () => {
    const base = cfg();
    const draft = applyField(base, 'cost.range', 3);
    const r = refusalIssues(
      { code: 'TEMPLATE_WOULD_BREAK', message: 'That change would make a starter template invalid (Basic Tower: …).', hint: 'Loosen the bounds or lower the coefficients.' },
      base,
      draft,
    );
    expect(Object.keys(r.byField)).toEqual(['cost.range']);
    expect(r.byField['cost.range']![0]).toContain('Loosen the bounds');
    const zod = refusalIssues(
      { code: 'BAD_REQUEST', message: 'Invalid config.', details: { issues: [{ path: ['caps', 'budget'], message: 'Too small' }] } },
      base,
      draft,
    );
    expect(zod.byField).toEqual({ 'caps.budget': ['Too small'] });
    const phase = refusalIssues({ code: 'PHASE_CLOSED', message: "The config can't change during BATTLE." }, base, draft);
    expect(phase).toEqual({ byField: {}, other: ["The config can't change during BATTLE."] });
  });

  it('blames a template refusal on the price fields, or on the JSON bounds when those broke it', () => {
    const base = cfg();
    const refusal = { code: 'TEMPLATE_WOULD_BREAK', message: 'That change would make a starter template invalid.', hint: 'Loosen the bounds.' };
    // Price: only the cost/cap fields that changed, not the unrelated scoring edit.
    const priced = applyField(applyField(base, 'cost.range', 3), 'scoring.placePoints.0', 9);
    expect(Object.keys(refusalIssues(refusal, base, priced).byField)).toEqual(['cost.range']);
    // Bounds (edited in the JSON): not pinned on the quick field that also changed.
    const bounded = applyField(setPath(base, 'stats.bounds.range.max', 100), 'caps.budget', 1200);
    const r = refusalIssues(refusal, base, bounded);
    expect(r.byField).toEqual({});
    expect(r.other.length).toBe(1);
  });
});

describe('quick settings typing key by key', () => {
  const typeKeys = (path: string, text: string) => {
    const base = cfg();
    let draft = base;
    let error = '';
    for (let i = 1; i <= text.length; i++) ({ draft, error } = typeIntoField(field(path), text.slice(0, i), base, draft));
    return { base, draft, error, patch: configDiff(base, draft) };
  };

  it('an out-of-range or fractional entry never leaves an intermediate keystroke in the draft', () => {
    for (const [path, text] of [
      ['timers.defaultRounds', '12'],
      ['suddenDeath.damagePctPerSecond', '150'],
      ['timers.defaultRounds', '2.5'],
      ['cost.curveK', '10'],
    ] as const) {
      const r = typeKeys(path, text);
      expect(r.error, `${path} ${text}`).not.toBe('');
      expect(r.patch, `${path} ${text}`).toBeUndefined();
      expect(getPath(r.draft, path)).toBe(getPath(r.base, path));
    }
  });

  it('a valid multi-digit entry ends up whole, and the error text names the field', () => {
    expect(typeKeys('timers.defaultRounds', '10')).toMatchObject({ error: '', patch: { timers: { defaultRounds: 10 } } });
    expect(typeKeys('caps.budget', '1500').patch).toEqual({ caps: { budget: 1500 } });
    expect(inputErrorText({})).toBe('');
    expect(inputErrorText({ 'timers.defaultRounds': 'The largest allowed is 10.' })).toBe('Rounds per match: The largest allowed is 10.');
    expect(unique(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('rolling back Battle length takes the linked sudden-death end back too', () => {
    const r = typeKeys('timers.battleTicks', '9x');
    expect(r.error).not.toBe('');
    expect(r.patch).toBeUndefined();
  });
});

describe('quick settings cost preview', () => {
  it('matches computeCost for the default config', () => {
    const p = costPreview(DEFAULT_CONFIG);
    const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    expect(by.basicSoldier!.cost).toBe(computeCost(BASIC_SOLDIER, DEFAULT_CONFIG.cost).cost);
    expect(by.basicTower!.cost).toBe(computeCost(BASIC_TOWER, DEFAULT_CONFIG.cost).cost);
    expect(by.bigTank!.cost).toBe(computeCost(BIG_TANK, DEFAULT_CONFIG.cost).cost);
    // The worked examples in the starter kit's CLAUDE.md.
    expect(by.basicSoldier!.cost).toBe(92);
    expect(by.basicTower!.cost).toBe(198);
    expect(by.bigTank!.cost).toBe(462);
    expect(by.basicSoldier!.overCap || by.basicTower!.overCap || by.bigTank!.overCap).toBe(false);
    // All maxed with the fastest cooldown is far over the cap.
    expect(by.allMax!.overCap).toBe(true);
    expect(by.allMax!.stats).toMatchObject({ maxHealth: 500, damage: 60, range: 300, speed: 5, size: 20, attackCooldown: 10 });
    expect(p.army).toEqual({ soldiers: 4, towers: 3, total: 4 * 92 + 3 * 198, overBudget: false });
    expect(p.cap).toBe(500);
    expect(p.budget).toBe(1000);
  });

  it('follows the draft coefficients and caps', () => {
    const draft = applyField(applyField(cfg(), 'cost.hp', 1), 'caps.unitCost', 300);
    const p = costPreview(draft);
    const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    expect(by.basicSoldier!.cost).toBe(computeCost(BASIC_SOLDIER, draft.cost).cost);
    expect(by.basicTower!.cost).toBe(computeCost(BASIC_TOWER, draft.cost).cost);
    expect(by.bigTank!.overCap).toBe(true);
    expect(by.basicTower!.template).toBe(true);
    expect(p.army.total).toBe(4 * by.basicSoldier!.cost + 3 * by.basicTower!.cost);
    expect(p.army.overBudget).toBe(p.army.total > 1000);
    expect(costPreview(applyField(cfg(), 'caps.budget', 900)).army.overBudget).toBe(true);
  });

  it('flags a starter template outside the draft stat bounds (the server refuses that too)', () => {
    expect(costPreview(DEFAULT_CONFIG).rows.every((r) => r.outOfBounds === null)).toBe(true);
    const p = costPreview(setPath(cfg(), 'stats.bounds.range.max', 100));
    const tower = p.rows.find((r) => r.key === 'basicTower')!;
    expect(tower.overCap).toBe(false);
    expect(tower.outOfBounds).toMatch(/range/);
  });
});
