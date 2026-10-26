// /admin settings that save as they change (Settings.tsx, configStore.tsx):
// the DOM-free helpers behind each field (what a keystroke would save, the
// budget balance note, the per-section reset patch) and the server's
// GET /admin/config/defaults + POST /admin/config/reset (Reset all to defaults).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameConfig } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import {
  BALANCE_BUDGET_LIMIT,
  QUICK_FIELDS,
  QUICK_GROUPS,
  budgetBalanceWarning,
  changedFromDefaults,
  checkField,
  fieldRefusal,
  groupPaths,
  sectionResetPatch,
  setPath,
} from '../packages/client/src/admin/quickSettings.js';
import { Client, adminClient, bootServer, removeDir, tempDataDir } from './helpers/server.js';

const cfg = (): GameConfig => structuredClone(DEFAULT_CONFIG);
const field = (path: string) => QUICK_FIELDS.find((f) => f.path === path)!;
const group = (id: string) => QUICK_GROUPS.find((g) => g.id === id)!;

describe('budget balance note', () => {
  it('shows only above $15,000', () => {
    expect(BALANCE_BUDGET_LIMIT).toBe(15_000);
    expect(budgetBalanceWarning(10_000)).toBe('');
    expect(budgetBalanceWarning(15_000)).toBe('');
    expect(budgetBalanceWarning(15_001)).toBe('Above $15,000 changes game balance');
    expect(budgetBalanceWarning(null)).toBe('');
    expect(budgetBalanceWarning(Number.NaN)).toBe('');
  });
});

describe('checkField: what typing into a field would save', () => {
  it('a valid number gives the minimal patch (in stored units)', () => {
    const r = checkField(field('timers.placementSec'), '4', cfg());
    expect(r).toMatchObject({ ok: true, stored: 240, patch: { timers: { placementSec: 240 } } });
  });

  it('the same value saves nothing', () => {
    const r = checkField(field('caps.budget'), String(DEFAULT_CONFIG.caps.budget), cfg());
    expect(r.ok && r.patch).toBeUndefined();
  });

  it("the field's own bounds and the schema's rules stop the save", () => {
    expect(checkField(field('timers.planFirstRoundSec'), '0', cfg())).toEqual({ ok: false, error: 'The smallest allowed is 0.5 min.' });
    expect(checkField(field('caps.maxCopies'), '2.5', cfg())).toEqual({ ok: false, error: 'Use a whole number.' });
    // Sudden death can't start after the circle finishes shrinking (a cross-field schema rule).
    const late = checkField(field('suddenDeath.startTick'), '500', cfg());
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/Sudden death must start before/);
  });

  it('a new battle length takes the sudden-death end along when it followed it', () => {
    const r = checkField(field('timers.battleTicks'), '150', cfg());
    expect(r.ok && r.patch).toEqual({ timers: { battleTicks: 9000 }, suddenDeath: { endTick: 9000 } });
  });

  it('a refused save becomes the field message', () => {
    const base = cfg();
    const draft = setPath(base, 'caps.unitCost', 100);
    const text = fieldRefusal({ code: 'TEMPLATE_WOULD_BREAK', message: 'That change would make a starter template invalid.', hint: 'Lower the coefficients.' }, 'caps.unitCost', base, draft);
    expect(text).toBe('That change would make a starter template invalid. Lower the coefficients.');
    const zod = fieldRefusal({ code: 'BAD_REQUEST', message: 'Invalid config.', details: { issues: [{ path: ['caps', 'budget'], message: 'Too big' }] } }, 'caps.budget', base, base);
    expect(zod).toBe('Too big');
  });
});

describe('per-section reset', () => {
  it('counts and resets only that section', () => {
    let c = setPath(cfg(), 'caps.budget', 20_000);
    c = setPath(c, 'caps.maxCopies', 20);
    c = setPath(c, 'elements.ice.slowPct', 50);
    expect(changedFromDefaults(group('economy'), c, DEFAULT_CONFIG)).toBe(2);
    expect(changedFromDefaults(group('effects'), c, DEFAULT_CONFIG)).toBe(1);
    expect(sectionResetPatch(group('economy'), c, DEFAULT_CONFIG)).toEqual({ caps: { budget: DEFAULT_CONFIG.caps.budget, maxCopies: DEFAULT_CONFIG.caps.maxCopies } });
    expect(sectionResetPatch(group('costs'), c, DEFAULT_CONFIG)).toBeUndefined();
  });

  it('resets toggles too, and the battle length with the sudden-death end that followed it', () => {
    let c = setPath(cfg(), 'timers.autoAdvanceWhenAllReady', true);
    c = setPath(c, 'timers.battleTicks', 9000);
    c = setPath(c, 'suddenDeath.endTick', 9000);
    expect(groupPaths(group('timers'))).toContain('timers.autoAdvanceWhenAllReady');
    expect(sectionResetPatch(group('timers'), c, DEFAULT_CONFIG)).toEqual({
      timers: { battleTicks: DEFAULT_CONFIG.timers.battleTicks, autoAdvanceWhenAllReady: false },
      suddenDeath: { endTick: DEFAULT_CONFIG.suddenDeath.endTick },
    });
  });
});

describe('server: config defaults and Reset all to defaults', () => {
  let srv: RunningServer;
  const dir = tempDataDir();
  beforeAll(async () => {
    srv = await bootServer({ dataDir: dir });
  });
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('GET /admin/config/defaults is the boot config; POST /admin/config/reset drops every live edit', async () => {
    const admin = await adminClient(srv.url);
    const defaults = (await admin.get('/admin/config/defaults')).body.config as GameConfig;
    expect(defaults.caps.budget).toBe(DEFAULT_CONFIG.caps.budget);
    expect((await admin.put('/admin/config', { caps: { budget: 20_000 }, timers: { autoAdvanceWhenAllReady: true } })).status).toBe(200);
    expect((await admin.get('/admin/config/defaults')).body.config.caps.budget).toBe(DEFAULT_CONFIG.caps.budget);
    const r = await admin.post('/admin/config/reset', {});
    expect(r.status).toBe(200);
    expect(r.body.config.caps.budget).toBe(DEFAULT_CONFIG.caps.budget);
    expect(r.body.config.timers.autoAdvanceWhenAllReady).toBe(false);
    expect((await admin.get('/admin/config')).body.config).toEqual(defaults);
  }, 60_000);

  it('needs the admin', async () => {
    const anon = new Client(srv.url);
    expect((await anon.post('/admin/config/reset', {})).status).toBe(403);
  });
});
