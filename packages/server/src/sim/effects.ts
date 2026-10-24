// Elements and splash in the sim (plan §5.4, §9.4 Hit pipeline, Fire: burn,
// Ice: freeze, M8.8).
//
// Every landed hit of a tick goes through `HitPipeline.land`, in the engine's
// seat → instanceId → projectile id order (`resolveHits`). For a hit by
// attacker A on target T with damage d (A's damage × wall multiplier × (1 +
// might%), fixed at fire time):
//   1. a wall target takes plain damage (no element, no splash, no zap);
//   2. shatter: a fire hit on a frozen target does ×(1 + shatterPct%) and thaws it;
//   3. apply d × (1 − T.shield%), credited to A's owner and type (effective damage);
//   4. status: fire adds burnPct% of the pre-shatter d to A's owner's burn
//      record on T; ice sets T.frozen = ice.ticks (refreshes, never stacks);
//   5. splash (A.splashRadius R > 0): every other living enemy body (not a wall)
//      whose edge is within R of T's centre takes a splash hit of splashPct% of
//      d through steps 2-4 (so fire splash burns and can shatter, ice splash
//      freezes), in instanceId order;
//   6. lightning (main hits only): one draw of `elementRng`; below chancePct%
//      the nearest other living enemy of A (not a wall, not already hit by
//      this attack) whose edge is within hopRange of T's edge takes d × (1 −
//      its shield%), plain damage; a target that was burning before the hit
//      overloads: the zap hops on once more.
// Burn pulses (`burnPulses`, tick step 7c) deal pool / pulsesLeft × (1 −
// shield%) every pulseTicks and credit the record's last fire attacker, even
// after it died. Pure functions of state apart from the one lightning draw,
// so a battle without lightning never touches `elementRng`.

import { edgeDistance, elementOf, type Element, type GameConfig, type HitKind, type StatusView } from '@pixel-clash/shared';
import type { FrameRecorder } from './frames.js';
import { applyHit } from './projectiles.js';
import type { Rng } from './prng.js';
import type { AuraState, BurnRecord, DamageSplit, SimUnit } from './types.js';

/** A body with no aura on it. */
export function noAura(): AuraState {
  return { haste: 0, might: 0, shield: 0, hasteSrc: null, mightSrc: null, shieldSrc: null };
}

/** An all-zero damage split. */
export function emptySplit(): DamageSplit {
  return { hit: 0, splash: 0, burn: 0, zap: 0, shatter: 0 };
}

/**
 * A body's tempo this tick (§9.4 Ice: freeze): 1 normally, × (1 − slowPct%)
 * while frozen, × (1 + haste%) while hasted. It scales the move step, the
 * cooldown recovery and a factory's production timer.
 */
export function tempoOf(u: Pick<SimUnit, 'frozen' | 'aura'>, config: Pick<GameConfig, 'elements'>): number {
  let t = (u.frozen ?? 0) > 0 ? 1 - config.elements.ice.slowPct / 100 : 1;
  const haste = u.aura?.haste ?? 0;
  if (haste > 0) t *= 1 + haste / 100;
  return t;
}

/** Bodies that can burn, freeze, get zapped and splashed: everything but walls (§9.4 interactions). */
export function takesEffects(u: Pick<SimUnit, 'type'>): boolean {
  return u.type !== 'wall';
}

/** Bodies that can be healed and get auras: soldiers, towers and minions (§5.5). */
export function isSupportable(u: Pick<SimUnit, 'type'>): boolean {
  return u.type === 'soldier' || u.type === 'tower' || u.type === 'minion';
}

/** Whether a heal on this body would do something (§5 rule 4): hurt with heal room left, or burning, or frozen. */
export function needsHealing(u: Pick<SimUnit, 'hp' | 'maxHp' | 'healRoom' | 'burns' | 'frozen'>): boolean {
  return (u.burns?.length ?? 0) > 0 || (u.frozen ?? 0) > 0 || (u.hp < u.maxHp && (u.healRoom ?? 0) > 0);
}

/** Ticks until the last burn pulse on `u` lands (0 = not burning). */
export function burningTicks(u: Pick<SimUnit, 'burns'>, tick: number, pulseTicks: number): number {
  let out = 0;
  for (const b of u.burns ?? []) out = Math.max(out, b.nextPulseTick + (b.pulsesLeft - 1) * pulseTicks - tick);
  return Math.max(0, out);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** A body's `status` in the views (§5 StatusView), as of the start of the tick. */
export function statusOf(u: SimUnit, tick: number, config: Pick<GameConfig, 'elements'>): StatusView {
  let burnLeft = 0;
  for (const b of u.burns ?? []) burnLeft += b.pool;
  const a = u.aura;
  return {
    burning: burningTicks(u, tick, config.elements.fire.pulseTicks),
    burnLeft: round2(burnLeft),
    frozen: u.frozen ?? 0,
    haste: a?.haste ?? 0,
    might: a?.might ?? 0,
    shield: a?.shield ?? 0,
    // "HP it can still be healed this second": 0 when full, for walls and factories, when the cap is used, or in sudden death.
    healRoom: isSupportable(u) ? round2(Math.max(0, Math.min(u.healRoom ?? 0, u.maxHp - u.hp))) : 0,
  };
}

/** Above this many bodies, splash and zap queries go through a 40 px spatial hash (§9.4 Performance). */
export const EFFECT_HASH_MIN_BODIES = 64;
const HASH_CELL = 40;

/**
 * The living bodies of one tick's step 7, for splash and zap queries. Bodies
 * don't move during step 7, so the hash is built once (lazily) per tick.
 */
export class BodyIndex {
  private buckets: Map<number, SimUnit[]> | null = null;
  private cols = 0;

  /** `bodies`: the living bodies, in instanceId order. */
  constructor(private readonly bodies: readonly SimUnit[], private readonly arena: number) {}

  /** Bodies whose centre may lie within `r` (+ 20 px, the largest radius) of (x, y), in instanceId order. */
  near(x: number, y: number, r: number): readonly SimUnit[] {
    if (this.bodies.length <= EFFECT_HASH_MIN_BODIES) return this.bodies;
    if (!this.buckets) {
      this.cols = Math.ceil(this.arena / HASH_CELL) + 1;
      this.buckets = new Map();
      for (const u of this.bodies) {
        const k = Math.floor(u.y / HASH_CELL) * this.cols + Math.floor(u.x / HASH_CELL);
        const b = this.buckets.get(k);
        if (b) b.push(u);
        else this.buckets.set(k, [u]);
      }
    }
    const reach = r + 20;
    const c0 = Math.floor((x - reach) / HASH_CELL);
    const c1 = Math.floor((x + reach) / HASH_CELL);
    const r0 = Math.floor((y - reach) / HASH_CELL);
    const r1 = Math.floor((y + reach) / HASH_CELL);
    const out: SimUnit[] = [];
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const b = this.buckets.get(row * this.cols + col);
        if (b) for (const u of b) out.push(u);
      }
    }
    // Back to instanceId order, so ties and splash order never depend on the hash.
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}

/** One landed hit (melee swipe or projectile impact), with what was fixed at fire time. */
export interface LandedHit {
  /** The attacker's instanceId (events name it), and the attacker (it may have died since it fired). */
  attackerId: string;
  attacker: SimUnit | undefined;
  target: SimUnit;
  /** Damage fixed at fire time (wall multiplier and might baked in). */
  damage: number;
  element: Element;
  splash: number;
  /** The might % baked into `damage`, and its source (display-only assist). */
  might: number;
  mightSrc: SimUnit | null;
}

/** Credit `dealt` effective damage of kind `kind` to the attacker's split (its damageDealt is credited by applyHit). */
function creditSplit(attacker: SimUnit | undefined, kind: HitKind, dealt: number): void {
  if (!attacker || dealt <= 0) return;
  (attacker.damageSplit ??= emptySplit())[kind] += dealt;
}

/** Credit an aura source's display-only assist. */
function creditAssist(src: SimUnit | null | undefined, amount: number): void {
  if (src && amount > 0) src.assist = (src.assist ?? 0) + amount;
}

/** The hit pipeline of one tick's step 7 (and the burn pulses of step 7c). */
export class HitPipeline {
  constructor(
    private readonly config: GameConfig,
    private readonly tick: number,
    private readonly recorder: FrameRecorder,
    /** The lightning stream (`elementRng`), drawn once per lightning main hit. */
    private readonly elementRng: Rng,
    private readonly index: BodyIndex,
  ) {}

  /** Land one main hit (§9.4 Hit pipeline steps 1-7). */
  land(h: LandedHit): void {
    const T = h.target;
    const A = h.attacker;
    if (T.hp <= 0 || !takesEffects(T)) {
      // A wall (or a body already at ≤ 0 hp): plain damage, nothing else.
      const hit = applyHit(A, T, h.damage);
      creditSplit(A, 'hit', hit.dealt);
      this.recorder.event({ type: 'hit', instanceId: h.attackerId, targetId: T.id, damage: hit.dealt });
      return;
    }
    const wasBurning = (T.burns?.length ?? 0) > 0;
    const hitIds = new Set<string>([T.id]);
    this.strike(h, T, h.damage, 'hit');
    // Splash: every other living enemy body near the target takes splashPct% (steps 2-4 again).
    if (h.splash > 0 && A) {
      const ds = (h.damage * this.config.elements.splashPct) / 100;
      for (const E of this.index.near(T.x, T.y, h.splash)) {
        if (E === T || !E.alive || E.hp <= 0 || !takesEffects(E) || E.teamId === A.teamId) continue;
        if (Math.hypot(E.x - T.x, E.y - T.y) - E.radius > h.splash) continue;
        hitIds.add(E.id);
        this.strike(h, E, ds, 'splash');
      }
      this.recorder.event({ type: 'splash', x: round2(T.x), y: round2(T.y), r: h.splash, element: h.element });
    }
    // Lightning (main hits only): one draw per hit, in hit order.
    if (h.element === 'lightning' && A) {
      const L = this.config.elements.lightning;
      const u = this.elementRng();
      if (u < L.chancePct / 100) {
        const hops = 1 + (wasBurning ? L.burningExtraHops : 0);
        const to: string[] = [];
        let from: SimUnit = T;
        for (let i = 0; i < hops; i++) {
          const next = this.nearestZappable(A, from, hitIds, L.hopRange);
          if (!next) break;
          hitIds.add(next.id);
          to.push(next.id);
          const shield = next.aura?.shield ?? 0;
          const applied = h.damage * (1 - shield / 100);
          const hit = applyHit(A, next, applied);
          creditSplit(A, 'zap', hit.dealt);
          creditAssist(next.aura?.shieldSrc, h.damage - applied);
          this.recorder.event({ type: 'hit', instanceId: A.id, targetId: next.id, damage: round2(hit.dealt), kind: 'zap', element: 'lightning' });
          // An overload hop (past the first) is a combo.
          if (i >= 1) A.combos = (A.combos ?? 0) + 1;
          from = next;
        }
        if (to.length > 0) this.recorder.event({ type: 'arc', from: T.id, to });
      }
    }
  }

  /**
   * Steps 2-4 on one body (the main target or a splash victim): shatter,
   * the shield, the credit, then the element's status.
   */
  private strike(h: LandedHit, T: SimUnit, d: number, kind: 'hit' | 'splash'): void {
    const A = h.attacker;
    const E = this.config.elements;
    let dealtAs: HitKind = kind;
    let amount = d;
    if (h.element === 'fire' && (T.frozen ?? 0) > 0) {
      amount = d * (1 + E.shatterPct / 100);
      T.frozen = 0;
      dealtAs = 'shatter';
      if (A) A.combos = (A.combos ?? 0) + 1;
    }
    const shield = T.aura?.shield ?? 0;
    const applied = amount * (1 - shield / 100);
    const hit = applyHit(A, T, applied);
    creditSplit(A, dealtAs, hit.dealt);
    creditAssist(T.aura?.shieldSrc, amount - applied);
    if (h.might > 0) creditAssist(h.mightSrc, (hit.dealt * h.might) / (100 + h.might));
    this.recorder.event({
      type: 'hit',
      instanceId: h.attackerId,
      targetId: T.id,
      damage: kind === 'hit' && dealtAs === 'hit' ? hit.dealt : round2(hit.dealt),
      ...(dealtAs !== 'hit' ? { kind: dealtAs } : {}),
      ...(h.element !== 'normal' ? { element: h.element } : {}),
    });
    if (dealtAs === 'shatter') this.recorder.event({ type: 'shatter', id: T.id, amount: round2(hit.dealt) });
    // Status from the pre-shatter damage (§9.4 step 5).
    if (h.element === 'fire' && A) this.addBurn(T, A, (d * E.fire.burnPct) / 100);
    else if (h.element === 'ice') T.frozen = E.ice.ticks;
  }

  /** A new fire hit from A's owner on T: pool += amount, pulses reset, the phase kept (§9.4 Fire: burn). */
  private addBurn(T: SimUnit, A: SimUnit, amount: number): void {
    if (!(amount > 0)) return;
    const pulses = this.config.elements.fire.pulses;
    const burns = (T.burns ??= []);
    const rec = burns.find((b) => b.ownerId === A.playerId);
    if (rec) {
      rec.pool += amount;
      rec.pulsesLeft = pulses;
      rec.source = A;
      return;
    }
    const fresh: BurnRecord = { ownerId: A.playerId, seat: A.seat, pool: amount, pulsesLeft: pulses, nextPulseTick: this.tick + this.config.elements.fire.pulseTicks, source: A };
    // Kept in seat order: pulses of different owners land in seat order (§9.4 step 7c).
    let i = burns.length;
    while (i > 0 && burns[i - 1]!.seat > fresh.seat) i--;
    burns.splice(i, 0, fresh);
  }

  /** The nearest living enemy of A (not a wall, not hit yet) within `range` of `from`, edge to edge; ties: lower instanceId. */
  private nearestZappable(A: SimUnit, from: SimUnit, hit: ReadonlySet<string>, range: number): SimUnit | undefined {
    let best: SimUnit | undefined;
    let bestGap = Infinity;
    for (const E of this.index.near(from.x, from.y, range + from.radius)) {
      if (!E.alive || E.hp <= 0 || !takesEffects(E) || E.teamId === A.teamId || hit.has(E.id)) continue;
      const gap = edgeDistance(from, E);
      if (gap > range) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = E;
      }
    }
    return best;
  }

  /**
   * Step 7c: the burn pulses that are due, in body instanceId order, then
   * owner seat order. Each takes pool / pulsesLeft × (1 − shield%) and
   * credits the record's last fire attacker.
   */
  burnPulses(bodies: readonly SimUnit[]): void {
    const pulseTicks = this.config.elements.fire.pulseTicks;
    for (const u of bodies) {
      const burns = u.burns;
      if (!burns || burns.length === 0 || !u.alive) continue;
      for (let i = 0; i < burns.length; i++) {
        const b = burns[i]!;
        if (this.tick < b.nextPulseTick) continue;
        const share = b.pool / b.pulsesLeft;
        b.pool -= share;
        b.pulsesLeft -= 1;
        b.nextPulseTick += pulseTicks;
        if (u.hp > 0) {
          const shield = u.aura?.shield ?? 0;
          const applied = share * (1 - shield / 100);
          const hit = applyHit(b.source, u, applied);
          creditSplit(b.source, 'burn', hit.dealt);
          creditAssist(u.aura?.shieldSrc, share - applied);
          this.recorder.event({ type: 'hit', instanceId: b.source.id, targetId: u.id, damage: round2(hit.dealt), kind: 'burn', element: 'fire' });
        }
        if (b.pulsesLeft <= 0) {
          burns.splice(i, 1);
          i--;
        }
      }
    }
  }
}

/** The element an attacker's hits carry (a minion: its factory's minionElement). */
export function attackElement(u: Pick<SimUnit, 'stats'>): Element {
  return elementOf(u.stats);
}
