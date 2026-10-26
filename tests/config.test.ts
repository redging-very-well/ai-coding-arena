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
    expect(cfg.cost.hp).toBe(0.1875);
    expect(cfg.caps.budget).toBe(6000);
    expect(cfg.caps.unitCost).toBe(3000);
    expect(cfg.caps.copyRamp).toEqual({ freeCopies: 3, pctPerCopy: 15 });
  });

  it('rejects invalid values', () => {
    expect(safeParseConfig({ cost: { hp: -1 } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { damage: { min: 10, max: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ sandbox: { mode: 'yolo' } }).success).toBe(false);
  });
});

describe('$10,000 redesign config keys', () => {
  it('has the redesign economy, the element, accuracy and support constants and economyVersion 3', () => {
    const c = DEFAULT_CONFIG;
    expect(c.economyVersion).toBe(3);
    expect(c.cost).toMatchObject({ base: 50, hp: 0.1875, damage: 1.875, range: 1.38, speed: 90, size: 8, curveK: 1, powerFactor: 2, splash: 0.8, heal: 3.5 });
    expect(c.cost.element).toEqual({ fire: 1.3, ice: 1.75, lightning: 1.3 });
    expect(c.cost.aura).toEqual({ haste: 9, might: 8, shield: 7 });
    expect(c.cost.wall).toEqual({ base: 20, hp: 0.0375 });
    expect(c.cost.factory).toEqual({ base: 50, hp: 0.5, minionDiscount: 0.5 });
    expect(c.caps).toMatchObject({ budget: 10000, unitCost: 3000, maxCopies: 12, maxFactoryCopies: 5, maxWallCopies: 16, copyRamp: { freeCopies: 3, pctPerCopy: 15 } });
    expect(c.stats.bounds).toMatchObject({
      maxHealth: { min: 80, max: 4000 },
      damage: { min: 0, max: 240 },
      range: { min: 20, max: 300 },
      soldierRange: { min: 20, max: 160 },
      wallHealth: { min: 400, max: 12000 },
      factoryHealth: { min: 120, max: 1200 },
      productionInterval: { min: 300, max: 1200 },
      splashRadius: { min: 0, max: 80 },
    });
    expect(c.stats.bounds.support).toEqual({
      heal: { power: { min: 15, max: 400 }, range: { min: 20, max: 200 } },
      haste: { power: { min: 5, max: 50 }, range: { min: 40, max: 150 } },
      might: { power: { min: 5, max: 50 }, range: { min: 40, max: 150 } },
      shield: { power: { min: 5, max: 40 }, range: { min: 40, max: 150 } },
    });
    expect(c.timers.battleTicks).toBe(7200);
    expect(c.suddenDeath).toMatchObject({ startTick: 4500, endTick: 7200 });
    expect(c.factory).toMatchObject({ maxMinionsPerFactory: 12, maxAlivePerFactory: 4, maxAlivePerPlayer: 12 });
    expect(c.elements).toEqual({
      fire: { burnPct: 50, pulses: 6, pulseTicks: 30 },
      ice: { slowPct: 35, ticks: 120 },
      lightning: { chancePct: 35, hopRange: 100, burningExtraHops: 2 },
      shatterPct: 40,
      kindlePct: 25,
      brittlePct: 25,
      splashPct: 50,
    });
    expect(c.accuracy).toEqual({ missMaxPct: 20, speedRef: 5 });
    expect(c.support).toEqual({ healRoomPctPerSecond: 4 });
    expect(c.sim.routeRoundBuildings).toBe(true);
    expect(c.factory.minions.medic).toEqual({ maxHealth: 300, damage: 0, range: 20, speed: 1.4, attackCooldown: 60, size: 7, aggroRange: 150, impatientTicks: 120, wallDamageMultiplier: 1, heal: 60, reach: 60 });
  });

  it('the schema refuses out-of-range redesign values', () => {
    expect(safeParseConfig({ cost: { powerFactor: 4.5 } }).success).toBe(false);
    expect(safeParseConfig({ cost: { powerFactor: 4 } }).success).toBe(true);
    expect(safeParseConfig({ cost: { splash: -0.1 } }).success).toBe(false);
    expect(safeParseConfig({ cost: { element: { fire: 0.9 } } }).success).toBe(false);
    expect(safeParseConfig({ cost: { aura: { might: -1 } } }).success).toBe(false);
    expect(safeParseConfig({ elements: { ice: { slowPct: 100 } } }).success).toBe(false);
    expect(safeParseConfig({ elements: { lightning: { chancePct: 101 } } }).success).toBe(false);
    expect(safeParseConfig({ support: { healRoomPctPerSecond: -1 } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { damage: 10 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { reach: 500 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { archer: { range: 161 } } } }).success).toBe(false); // minions are soldiers: range ≤ 160
    expect(safeParseConfig({ cost: { powerFactor: 0, splash: 2, element: { ice: 1.5 } } }).success).toBe(true);
  });
});

describe('unit contract', () => {
  it('shared/contract.ts carries the verbatim contract block', () => {
    const contract = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
    const codeBlock = contract.split('// --- BEGIN CONTRACT (verbatim) ---\n')[1]!.split('// --- END CONTRACT ---')[0]!;
    expect(codeBlock).toContain('size?: number;');
    expect(codeBlock).toContain('sprite?(): SpriteSpec;');
  });
});
