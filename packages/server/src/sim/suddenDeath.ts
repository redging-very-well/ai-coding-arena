// Sudden death (plan §9, tick order step 8): from `startTick` a safe circle
// centred on (400,400) shrinks linearly from 570 to 60 px at `endTick`. Units
// whose centre is outside it lose `damagePctPerSecond`% of maxHP per second
// (spread evenly over the ticks). The kill is nobody's: no damage credit.

import { outsideSafeZone, safeZoneRadius, suddenDeathDamagePerTick, type GameConfig } from '@pixel-clash/shared';
import type { SimUnit } from './types.js';

/** Safe-circle radius during tick `tick` (also sent as `world.safeZone.radius`). */
export function safeRadiusAt(tick: number, config: GameConfig): number {
  return safeZoneRadius(tick, config.suddenDeath);
}

/**
 * Apply one tick of sudden-death damage to living units and refresh their
 * `outsideSafeZone` flag. `units` are the living units in instanceId order.
 */
export function applySuddenDeath(units: readonly SimUnit[], tick: number, config: GameConfig): void {
  const active = tick >= config.suddenDeath.startTick;
  const radius = safeRadiusAt(tick, config);
  for (const u of units) {
    u.outsideSafeZone = active && outsideSafeZone(u, radius);
    if (u.outsideSafeZone && config.suddenDeath.damagePctPerSecond > 0) {
      u.hp -= suddenDeathDamagePerTick(u.maxHp, config);
    }
  }
}
