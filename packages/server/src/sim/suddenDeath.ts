// Sudden death (plan §9, tick order step 8): from `startTick` a safe circle
// centred on the arena centre shrinks linearly from 570 to 60 px at `endTick`
// (radii given for the 800 arena; the engine scales them by S/800 with
// `scaleSuddenDeath`, §9.2). Units
// whose centre is outside it lose `damagePctPerSecond`% of maxHP per second
// (spread evenly over the ticks). The kill is nobody's: no damage credit.

import { CENTER, outsideSafeZone, safeZoneRadius, suddenDeathDamagePerTick, type GameConfig, type Point } from '@pixel-clash/shared';
import type { SimUnit } from './types.js';

/** Safe-circle radius during tick `tick` (also sent as `world.safeZone.radius`). */
export function safeRadiusAt(tick: number, config: GameConfig): number {
  return safeZoneRadius(tick, config.suddenDeath);
}

/**
 * Apply one tick of sudden-death damage to living units and refresh their
 * `outsideSafeZone` flag. `units` are the living units in instanceId order.
 */
export function applySuddenDeath(units: readonly SimUnit[], tick: number, config: GameConfig, center: Point = CENTER): void {
  const active = tick >= config.suddenDeath.startTick;
  const radius = safeRadiusAt(tick, config);
  for (const u of units) {
    u.outsideSafeZone = active && outsideSafeZone(u, radius, center);
    if (u.outsideSafeZone && config.suddenDeath.damagePctPerSecond > 0) {
      u.hp -= suddenDeathDamagePerTick(u.maxHp, config);
    }
  }
}
