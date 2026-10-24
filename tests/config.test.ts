import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ConfigSchema, parseConfig, safeParseConfig } from '@pixel-clash/shared';

describe('config', () => {
  it('config/default.json mirrors DEFAULT_CONFIG', () => {
    const json = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
    expect(json).toEqual(DEFAULT_CONFIG);
  });

  it('defaults satisfy the schema', () => {
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it('partial overrides deep-merge over defaults', () => {
    const cfg = parseConfig({ cost: { base: 25 }, caps: { budget: 6000 } });
    expect(cfg.cost.base).toBe(25);
    expect(cfg.cost.hp).toBe(0.3);
    expect(cfg.caps.budget).toBe(6000);
    expect(cfg.caps.unitCost).toBe(2500);
  });

  it('rejects invalid values', () => {
    expect(safeParseConfig({ cost: { hp: -1 } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { damage: { min: 10, max: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ sandbox: { mode: 'yolo' } }).success).toBe(false);
  });
});

describe('M8.8 config keys (§6 M8.8 coefficients, §9.4 config additions)', () => {
  it('has the ×5 economy, the element and support constants and economyVersion 2', () => {
    const c = DEFAULT_CONFIG;
    expect(c.economyVersion).toBe(2);
    expect(c.cost).toMatchObject({ base: 50, hp: 0.3, damage: 1.5, range: 1.38, speed: 66, size: 8, curveK: 1, powerFactor: 0.6, splash: 0.7, heal: 4.5 });
    expect(c.cost.element).toEqual({ fire: 1.2, ice: 1.2, lightning: 1.2 });
    expect(c.cost.aura).toEqual({ haste: 5, might: 4, shield: 7 });
    expect(c.caps).toMatchObject({ budget: 5000, unitCost: 2500 });
    expect(c.stats.bounds).toMatchObject({ maxHealth: { min: 50, max: 2500 }, damage: { min: 0, max: 300 }, wallHealth: { min: 250, max: 7500 }, factoryHealth: { min: 500, max: 5000 }, splashRadius: { min: 0, max: 80 } });
    expect(c.stats.bounds.support).toEqual({
      heal: { power: { min: 10, max: 250 }, range: { min: 20, max: 200 } },
      haste: { power: { min: 5, max: 50 }, range: { min: 40, max: 150 } },
      might: { power: { min: 5, max: 50 }, range: { min: 40, max: 150 } },
      shield: { power: { min: 5, max: 40 }, range: { min: 40, max: 150 } },
    });
    expect(c.elements).toEqual({ fire: { burnPct: 50, pulses: 6, pulseTicks: 30 }, ice: { slowPct: 35, ticks: 120 }, lightning: { chancePct: 35, hopRange: 100, burningExtraHops: 1 }, shatterPct: 50, splashPct: 50 });
    expect(c.support).toEqual({ healRoomPctPerSecond: 5 });
    expect(c.factory.minions.medic).toEqual({ maxHealth: 150, damage: 0, range: 20, speed: 1.4, attackCooldown: 60, size: 7, aggroRange: 150, impatientTicks: 120, wallDamageMultiplier: 1, heal: 40, reach: 60 });
  });

  it('the schema refuses out-of-range M8.8 values', () => {
    expect(safeParseConfig({ cost: { powerFactor: 2.5 } }).success).toBe(false);
    expect(safeParseConfig({ cost: { splash: -0.1 } }).success).toBe(false);
    expect(safeParseConfig({ cost: { element: { fire: 0.9 } } }).success).toBe(false);
    expect(safeParseConfig({ cost: { aura: { might: -1 } } }).success).toBe(false);
    expect(safeParseConfig({ elements: { ice: { slowPct: 100 } } }).success).toBe(false);
    expect(safeParseConfig({ elements: { lightning: { chancePct: 101 } } }).success).toBe(false);
    expect(safeParseConfig({ support: { healRoomPctPerSecond: -1 } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { damage: 10 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { reach: 500 } } } }).success).toBe(false);
    expect(safeParseConfig({ cost: { powerFactor: 0, splash: 2, element: { ice: 1.5 } } }).success).toBe(true);
  });
});

describe('unit contract (§5)', () => {
  it('the verbatim block in shared/contract.ts matches plan §5 exactly', () => {
    const plan = readFileSync(new URL('../plan.md', import.meta.url), 'utf8');
    const contract = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
    const planBlock = plan.split('// packages/shared/src/contract.ts\n')[1]!.split('\n```')[0]!;
    const codeBlock = contract.split('// --- BEGIN CONTRACT (plan §5, verbatim) ---\n')[1]!.split('// --- END CONTRACT ---')[0]!;
    expect(codeBlock.trimEnd()).toBe(planBlock.trimEnd());
    expect(codeBlock).toContain('size?: number;');
    expect(codeBlock).toContain('sprite?(): SpriteSpec;');
  });
});
