// Support in the sim (M8.8).
//
//   * Heal room: every 60 ticks (one window) each soldier, tower and minion
//     may be healed `healRoomPctPerSecond`% of its max HP, shared by every
//     healer; 0 from `suddenDeath.startTick` (heals stop there), and always 0
//     for walls and factories.
//   * Auras (haste, might, shield) are computed at the start of each tick from
//     the start-of-tick positions: every living ally soldier, tower or minion
//     (same teamId, not the source) whose edge is within the source's
//     supportRange gets it; per kind only the strongest applies (ties: the
//     lower source instanceId), different kinds combine. Disabled sources
//     keep their auras (no code needed).
//   * Heals are actions (`{ action: 'heal', targetId }`, sim/actions.ts),
//     queued in step 6 and applied in step 7b, after every hit of the tick:
//     a body at ≤ 0 hp is not healed; a burning or frozen body is only
//     cleansed (every burn record and the freeze removed); otherwise it gains
//     min(supportPower, maxHp − hp, healRoom).

import { edgeDistance, isAuraKind, supportOf, type GameConfig } from '@pixel-clash/shared';
import { isSupportable, noAura } from './effects.js';
import type { FrameRecorder } from './frames.js';
import type { AuraState, SimUnit } from './types.js';

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A body's heal room for a fresh window: 0 for walls and factories and from sudden death. */
export function freshHealRoom(u: Pick<SimUnit, 'type' | 'maxHp'>, tick: number, config: Pick<GameConfig, 'support' | 'suddenDeath'>): number {
  if (!isSupportable(u) || tick >= config.suddenDeath.startTick) return 0;
  return (u.maxHp * config.support.healRoomPctPerSecond) / 100;
}

/** Step 1: on the first tick of every window, every living body's heal room resets. */
export function resetHealRoom(bodies: readonly SimUnit[], tick: number, config: Pick<GameConfig, 'support' | 'suddenDeath' | 'timers'>): void {
  const window = config.timers.ticksPerSecond;
  if (tick % window !== 0 && tick !== config.suddenDeath.startTick) return;
  for (const u of bodies) u.healRoom = freshHealRoom(u, tick, config);
}

const SRC_KEY = { haste: 'hasteSrc', might: 'mightSrc', shield: 'shieldSrc' } as const;

/**
 * Step 1: every living body's auras from the start-of-tick positions (the
 * strongest per kind, its source kept for the report's assist). `bodies`:
 * the living bodies in instanceId order.
 */
export function computeAuras(bodies: readonly SimUnit[]): void {
  const sources: SimUnit[] = [];
  for (const u of bodies) {
    u.aura = u.aura ? clearAura(u.aura) : noAura();
    const s = supportOf(u.stats);
    if (s && isAuraKind(s.kind) && (u.type === 'soldier' || u.type === 'tower')) sources.push(u);
  }
  for (const src of sources) {
    const s = supportOf(src.stats)!;
    const kind = s.kind as 'haste' | 'might' | 'shield';
    for (const u of bodies) {
      if (u === src || u.teamId !== src.teamId || !isSupportable(u)) continue;
      const a = u.aura!;
      // Strictly stronger replaces: equal auras keep the lower source instanceId (bodies are in that order).
      if (s.power <= a[kind]) continue;
      if (edgeDistance(src, u) > s.range) continue;
      a[kind] = s.power;
      a[SRC_KEY[kind]] = src;
    }
  }
}

function clearAura(a: AuraState): AuraState {
  a.haste = 0;
  a.might = 0;
  a.shield = 0;
  a.hasteSrc = null;
  a.mightSrc = null;
  a.shieldSrc = null;
  return a;
}

/** A heal validated in step 3 and queued in step 6. */
export interface QueuedHeal {
  healer: SimUnit;
  target: SimUnit;
  /** The healer's supportPower (HP per heal). */
  power: number;
}

/**
 * Step 7b: apply the queued heals in seat → instanceId order (the order they
 * were queued). Dead is dead; a burning or frozen ally is only cleansed.
 * Effective healing (HP actually restored) is credited to the healer (a
 * medic minion's goes to its factory's type in the report).
 */
export function applyHeals(heals: readonly QueuedHeal[], recorder: FrameRecorder): void {
  for (const { healer, target: T, power } of heals) {
    if (!T.alive || T.hp <= 0) continue;
    if ((T.burns?.length ?? 0) > 0 || (T.frozen ?? 0) > 0) {
      T.burns = [];
      T.frozen = 0;
      healer.cleanses = (healer.cleanses ?? 0) + 1;
      recorder.event({ type: 'cleanse', from: healer.id, to: T.id });
      continue;
    }
    const amount = Math.max(0, Math.min(power, T.maxHp - T.hp, T.healRoom ?? 0));
    T.hp += amount;
    T.healRoom = (T.healRoom ?? 0) - amount;
    healer.healing = (healer.healing ?? 0) + amount;
    recorder.event({ type: 'heal', from: healer.id, to: T.id, amount: round2(amount) });
  }
}
