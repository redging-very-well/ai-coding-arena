// /admin and /setup helpers (DOM-free): the config editor's minimal patch,
// the state key that decides when the admin overview is refetched, and the
// setup checklist's shape.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, safeParseConfig, type GameStateDTO } from '@pixel-clash/shared';
import { configDiff, parseConfigText } from '../packages/client/src/admin/configDiff.js';
import { stateKey } from '../packages/client/src/admin/useAdmin.js';
import { CHECKLIST } from '../packages/client/src/setup/checklist.js';

describe('config editor diff', () => {
  it('returns only changed leaves; arrays are replaced whole', () => {
    const base = { a: 1, b: { c: 2, d: [1, 2] }, e: 'x' };
    expect(configDiff(base, structuredClone(base))).toBeUndefined();
    expect(configDiff(base, { a: 1, b: { c: 3, d: [1, 2] }, e: 'x' })).toEqual({ b: { c: 3 } });
    expect(configDiff(base, { a: 1, b: { c: 2, d: [1, 2, 3] }, e: 'x' })).toEqual({ b: { d: [1, 2, 3] } });
    expect(configDiff(base, { a: 1, b: { c: 2 }, e: 'x', f: true })).toEqual({ f: true });
  });

  it('produces a patch the server config schema accepts', () => {
    const text = JSON.stringify(DEFAULT_CONFIG).replace('"budget":5000', '"budget":6000');
    const parsed = parseConfigText(text);
    expect(parsed.ok).toBe(true);
    const patch = configDiff(DEFAULT_CONFIG, parsed.ok ? parsed.value : null);
    expect(patch).toEqual({ caps: { budget: 6000 } });
    const r = safeParseConfig(patch, DEFAULT_CONFIG);
    expect(r.success && r.data.caps.budget).toBe(6000);
  });

  it('reports bad JSON and non-objects', () => {
    expect(parseConfigText('{oops').ok).toBe(false);
    expect(parseConfigText('[1]').ok).toBe(false);
  });
});

describe('admin overview refetch key', () => {
  const s = (over: Partial<GameStateDTO>): GameStateDTO => ({
    phase: 'PLAN',
    round: 1,
    rounds: 3,
    timer: { secondsLeft: 100, paused: false },
    players: [],
    scoreboard: [],
    sandboxMode: 'ivm',
    armory: { enabled: false, entries: 0 },
    allReady: false,
    ...over,
  });

  it('ignores timer ticks but notices pauses and real changes', () => {
    expect(stateKey(s({}))).toBe(stateKey(s({ timer: { secondsLeft: 99, paused: false } })));
    expect(stateKey(s({}))).not.toBe(stateKey(s({ timer: { secondsLeft: 99, paused: true } })));
    expect(stateKey(s({}))).not.toBe(stateKey(s({ phase: 'PLACEMENT' })));
  });
});

describe('setup checklist', () => {
  it('has unique ids and covers the Claude box steps (§11.1)', () => {
    const items = CHECKLIST.flatMap((s) => s.items);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.some((i) => i.command === 'docker compose up -d')).toBe(true);
    expect(items.some((i) => /connected to Pixel Clash/.test(i.title))).toBe(true);
  });
});
