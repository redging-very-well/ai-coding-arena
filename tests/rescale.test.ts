// The ×5 rescale on its own changes no outcome (plan §9.4 Scoring and
// reports, §14 rescale.test.ts, M8.8): HP, damage, prices and minion stats
// are all ×5, sudden death is a percentage and the geometry is unchanged, so
// every time-to-kill is identical. Run the same battle (k = 2, no elements,
// no support) at the ×1 scale and at ×5: identical positions, flags, events
// and ranking, with HP and damage exactly ×5.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, type FrameDTO, type GameConfig, type PlacementDTO, type StatsSnapshot } from '@pixel-clash/shared';
import { runBattle } from '../packages/server/src/sim/engine.js';
import { design, fakePlayers, idleBrain, scripted, soldierBrain, stats, towerBrain, type FakePlayerSpec } from './helpers/fakeRunner.js';
import { LEGACY_ECONOMY_CONFIG } from './helpers/legacyEconomy.js';

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

/** The M8.7 minions at ×1 (the ×5 ones are LEGACY_ECONOMY_CONFIG's: exactly ×5, brute 500). */
const X1_MINIONS = { grunt: { maxHealth: 40, damage: 5 }, archer: { maxHealth: 24, damage: 5 }, runner: { maxHealth: 28, damage: 4 }, brute: { maxHealth: 100, damage: 8 } };
const battle = { timers: { battleTicks: 4200 }, suddenDeath: { startTick: 2400, endTick: 4200 } };
const X1: GameConfig = deepMerge(LEGACY_ECONOMY_CONFIG, { ...battle, factory: { minions: X1_MINIONS } });
const X5: GameConfig = deepMerge(LEGACY_ECONOMY_CONFIG, battle);

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

describe('the ×5 rescale changes no battle (§9.4)', () => {
  it('×1 and ×5: identical positions, flags and events; HP and damage exactly ×5; the same ranking', async () => {
    const a = await run(1);
    const b = await run(5);
    expect(a.frames.length).toBe(b.frames.length);
    expect(a.frames.flatMap((f) => f.events).some((e) => e.type === 'death')).toBe(true);
    expect(a.frames.flatMap((f) => f.events).some((e) => e.type === 'spawn' && e.factoryId)).toBe(true);
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

  it('the default (M8.8) config only differs from the ×5 rescale in the economy, the brute and the grunt', () => {
    const d = DEFAULT_CONFIG.factory.minions;
    for (const k of ['archer', 'runner'] as const) {
      expect(d[k].maxHealth).toBe(X1_MINIONS[k].maxHealth * 5);
      expect(d[k].damage).toBe(X1_MINIONS[k].damage * 5);
    }
    expect([d.brute.maxHealth, d.brute.damage]).toEqual([550, 40]);
    // The M8.8 balance retune (§14): grunt HP 200 → 180.
    expect([d.grunt.maxHealth, d.grunt.damage]).toEqual([180, X1_MINIONS.grunt.damage * 5]);
    expect(LEGACY_ECONOMY_CONFIG.factory.minions.grunt.maxHealth).toBe(X1_MINIONS.grunt.maxHealth * 5);
    expect(DEFAULT_CONFIG.suddenDeath).toEqual(LEGACY_ECONOMY_CONFIG.suddenDeath);
    expect(DEFAULT_CONFIG.stats.bounds).toEqual(LEGACY_ECONOMY_CONFIG.stats.bounds);
  });
});
