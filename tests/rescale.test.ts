// The ×5 rescale on its own changes no outcome (M8.8): HP, damage, prices and minion stats
// are all ×5, sudden death and the heal room are percentages and the geometry
// is unchanged, so every time-to-kill is identical. Run the same battle
// (k = 2, no elements, no support) at the ×1 scale and at ×5: identical
// positions, flags, events and ranking, with HP and damage exactly ×5.
//
// The redesign's new mechanics stay on here (building routing, the accuracy
// roll): both are geometry (who moved how far, where the buildings stand),
// never HP or damage, so they must be scale-invariant too.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, type FrameDTO, type GameConfig, type PlacementDTO, type StatsSnapshot } from '@pixel-clash/shared';
import { runBattle } from '../packages/server/src/sim/engine.js';
import { design, fakePlayers, idleBrain, scripted, soldierBrain, stats, towerBrain, type FakePlayerSpec } from './helpers/fakeRunner.js';
import { LEGACY_ECONOMY_CONFIG } from './helpers/legacyEconomy.js';

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

/** The M8.7 minions at ×1; X5 gets every one of them at exactly ×5 (HP, damage, heal). */
const X1_MINIONS = {
  grunt: { maxHealth: 40, damage: 5 },
  archer: { maxHealth: 24, damage: 5 },
  runner: { maxHealth: 28, damage: 4 },
  brute: { maxHealth: 100, damage: 8 },
  medic: { maxHealth: 30, damage: 0, heal: 8 },
};
const times5 = <T extends Record<string, number>>(m: T): T => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v * 5])) as T;
const X5_MINIONS = Object.fromEntries(Object.entries(X1_MINIONS).map(([k, m]) => [k, times5(m)])) as typeof X1_MINIONS;
// Both configs are built explicitly from the same base (the k = 2 legacy
// pricing, so prices scale ×5 too) and differ only in the minion numbers.
const battle = { timers: { battleTicks: 4200 }, suddenDeath: { startTick: 2400, endTick: 4200 } };
const BASE: GameConfig = deepMerge(LEGACY_ECONOMY_CONFIG, battle);
const X1: GameConfig = deepMerge(BASE, { factory: { minions: X1_MINIONS } });
const X5: GameConfig = deepMerge(BASE, { factory: { minions: X5_MINIONS } });

function army(scale: 1 | 5, seat: number, zone: 'TL' | 'BR', variant: number): FakePlayerSpec {
  const k = (s: StatsSnapshot) => ({ ...s, maxHealth: s.maxHealth * scale, damage: s.damage * scale }) as StatsSnapshot;
  const S = k(stats({ type: 'soldier', name: 'S', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 }));
  const T = k(stats({ type: 'tower', name: 'T', maxHealth: 150, damage: 15, range: 180, attackCooldown: 45, size: 14 }));
  const W = k(stats({ type: 'wall', name: 'W', maxHealth: 400 }));
  const F = k(stats({ type: 'factory', name: 'F', maxHealth: 300, productionInterval: 600, produces: variant ? 'brute' : 'archer', burst: 2 }));
  const rally = scripted((_s, enemies, _a, world) => ({ action: 'rally', destination: enemies.find((e) => e.type !== 'wall') ?? world.center }));
  return {
    playerId: `p${seat}`,
    seat,
    zone,
    units: [design('s', S, 92 * scale), design('t', T, 198 * scale), design('w', W, 32 * scale), design('f', F, 300 * scale)],
    placements: variant
      ? [at(0, 0, 's'), at(1, 1, 't'), at(2, 0, 't'), at(5, 5, 'f'), at(2, 2, 'w')]
      : [at(0, 0, 's'), at(1, 0, 's'), at(0, 1, 's'), at(2, 2, 't'), at(3, 0, 'w'), at(3, 1, 'w'), at(4, 4, 'f')],
    brains: { s: soldierBrain, t: towerBrain, f: rally, w: idleBrain },
  };
}

async function run(scale: 1 | 5) {
  const { setups } = fakePlayers([army(scale, 0, 'TL', 0), army(scale, 1, 'BR', 1)], 5);
  return runBattle({ players: setups, config: scale === 1 ? X1 : X5, seed: 5 });
}

/** A frame without its hit points and damage numbers (checked separately). */
function shape(f: FrameDTO) {
  return {
    t: f.t,
    units: f.units.map((u) => [u[0], u[1], u[2], u[4]]),
    projectiles: f.projectiles,
    safeZoneRadius: f.safeZoneRadius,
    fac: f.fac,
    events: f.events.map((e) => (e.type === 'hit' ? { ...e, damage: 0 } : e)),
  };
}

describe('the ×5 rescale changes no battle', () => {
  it('×1 and ×5: identical positions, flags and events; HP and damage exactly ×5; the same ranking', async () => {
    const a = await run(1);
    const b = await run(5);
    expect(a.frames.length).toBe(b.frames.length);
    expect(a.frames.flatMap((f) => f.events).some((e) => e.type === 'death')).toBe(true);
    expect(a.frames.flatMap((f) => f.events).some((e) => e.type === 'spawn' && e.factoryId)).toBe(true);
    // The accuracy roll really played: some shots at moving bodies missed (in both, identically).
    expect(a.frames.flatMap((f) => f.events).some((e) => e.type === 'miss')).toBe(true);
    for (let i = 0; i < a.frames.length; i++) {
      const fa = a.frames[i]!;
      const fb = b.frames[i]!;
      expect(shape(fb)).toEqual(shape(fa));
      fa.units.forEach((u, j) => expect(fb.units[j]![3]).toBeCloseTo(u[3] * 5, 1));
      fa.events.forEach((e, j) => {
        const e5 = fb.events[j]!;
        if (e.type === 'hit' && e5.type === 'hit') expect(e5.damage).toBeCloseTo(e.damage * 5, 6);
      });
    }
    expect(b.endTick).toBe(a.endTick);
    expect(b.endReason).toBe(a.endReason);
    expect(b.ranking.map((r) => [r.playerId, r.place, r.placePoints, r.damageBonus, r.valueBonus, r.badges])).toEqual(
      a.ranking.map((r) => [r.playerId, r.place, r.placePoints, r.damageBonus, r.valueBonus, r.badges]),
    );
    expect(b.ranking.map((r) => r.damage)).toEqual(a.ranking.map((r) => Math.round(r.damage * 5)));
  });

  it('the two configs are the redesign default but for the pricing, the battle length and the minion scale', () => {
    // The new mechanics are on in both (so the battle above exercises them).
    for (const c of [X1, X5]) {
      expect(c.sim.routeRoundBuildings).toBe(true);
      expect(c.accuracy).toEqual(DEFAULT_CONFIG.accuracy);
      expect(c.elements).toEqual(DEFAULT_CONFIG.elements);
      expect(c.support).toEqual(DEFAULT_CONFIG.support);
    }
    for (const k of Object.keys(X1_MINIONS) as (keyof typeof X1_MINIONS)[]) {
      expect(X5.factory.minions[k]).toMatchObject(times5(X1_MINIONS[k]));
      // Everything but HP, damage and heal is the default's.
      expect({ ...X5.factory.minions[k], ...X1_MINIONS[k] }).toEqual(X1.factory.minions[k]);
    }
  });
});

describe('how the redesign default differs from the M8.8 ×5 world', () => {
  it('a longer battle, minions at ×2 HP and ×0.8 damage, gentler shatter, new synergies, accuracy and building routing', () => {
    const d = DEFAULT_CONFIG;
    // Battle length: 90 s → 120 s; sudden death from 75 s (was 50 s to 90 s).
    expect(d.timers.battleTicks).toBe(7200);
    expect([d.suddenDeath.startTick, d.suddenDeath.endTick, d.suddenDeath.damagePctPerSecond]).toEqual([4500, 7200, 10]);
    // Economy: a $10,000 budget, $3,000 unit cap, and the copy ramp.
    expect([d.caps.budget, d.caps.unitCost, d.caps.maxCopies, d.caps.maxFactoryCopies, d.caps.maxWallCopies]).toEqual([10000, 3000, 12, 5, 16]);
    expect(d.caps.copyRamp).toEqual({ freeCopies: 3, pctPerCopy: 15 });
    expect([d.factory.maxMinionsPerFactory, d.factory.maxAlivePerFactory, d.factory.maxAlivePerPlayer]).toEqual([12, 4, 12]);
    // Minions: time-to-kill ×2.5 against M8.8 (HP ×2, damage ×0.8); the runner was retuned on top.
    const m88 = { grunt: [180, 25], archer: [120, 25], brute: [550, 40] } as const;
    for (const [k, [hp, dmg]] of Object.entries(m88) as [keyof typeof m88, readonly [number, number]][]) {
      expect([d.factory.minions[k].maxHealth, d.factory.minions[k].damage]).toEqual([hp * 2, dmg * 0.8]);
    }
    expect([d.factory.minions.runner.maxHealth, d.factory.minions.runner.damage]).toEqual([480, 24]);
    expect([d.factory.minions.medic.maxHealth, d.factory.minions.medic.heal]).toEqual([300, 60]);
    // Elements: shatter +40% (was +50%), overload 3 zaps, and the kindle / brittle synergies (+25%).
    expect([d.elements.shatterPct, d.elements.kindlePct, d.elements.brittlePct, d.elements.lightning.burningExtraHops]).toEqual([40, 25, 25, 2]);
    // Heals: 4% of max HP per second (was 5%).
    expect(d.support.healRoomPctPerSecond).toBe(4);
    // Moving targets dodge up to 20% of ranged shots; towers and factories are solid for routing.
    expect(d.accuracy.missMaxPct).toBe(20);
    expect(d.sim.routeRoundBuildings).toBe(true);
  });
});
