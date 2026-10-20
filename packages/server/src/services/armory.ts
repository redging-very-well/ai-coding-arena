// Open Armory (plan §9.1): an optional, per-match mechanic. When a battle's
// result is released (playback end or Skip), every non-template unit type
// fielded in it gets a FROZEN entry (an immutable copy of the version that
// fought: stats, sprite, cost and compiled code, never the source). From the
// next PLAN on, every player except the creator may select it as
// `armory:<armoryId>` within the usual ≤ 3 types. A borrowed unit runs in the
// BORROWER's sandbox, and its damage, points, strikes and errors are the
// borrower's. The creator gets a 💡 Inventor badge (no points) when another
// player fields their entry.
//
// Privacy: entries are created only at result release, and fielded types were
// already revealed at START, so nothing secret leaks; unfielded designs and
// the creator's later revisions stay private.

import { randomBytes } from 'node:crypto';
import {
  ARMORY_PREFIX,
  armoryDisplayName,
  fail,
  isArmoryUnitId,
  ok,
  type AdminArmoryEntryDTO,
  type ArmoryCardDTO,
  type ArmoryInfoDTO,
  type CostBreakdown,
  type GameConfig,
  type Result,
  type SpriteSpec,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import type { Game } from './game.js';
import type { ArmoryEntryRecord, ArmoryState } from './store.js';
import { UnitsService } from './units.js';

/** One own design version fielded in a battle (snapshotted at START). */
export interface FieldedDesign {
  playerId: string;
  unitId: string;
  version: number;
  stats: StatsSnapshot;
  sprite: SpriteSpec | null;
  spriteHidden: boolean;
  compiledJs: string;
  cost: number;
  breakdown: CostBreakdown;
}

/** A borrowed type fielded in a battle (for the 💡 Inventor badge). */
export interface BorrowedUse {
  borrowerId: string;
  armoryId: string;
  creatorId: string;
}

export interface InventorAward {
  playerId: string;
  name: string;
  /** Distinct other players who fielded this creator's entries. */
  usedBy: number;
  /** Display names of the entries used. */
  units: string[];
}

export class ArmoryService {
  constructor(private readonly game: Game) {}

  private get a(): ArmoryState {
    return (this.game.store.match.armory ??= { enabled: false, entries: [] });
  }

  get enabled(): boolean {
    return this.a.enabled;
  }

  info(): ArmoryInfoDTO {
    return { enabled: this.a.enabled, entries: this.a.entries.length };
  }

  entries(): readonly ArmoryEntryRecord[] {
    return this.a.entries;
  }

  entry(armoryId: string): ArmoryEntryRecord | undefined {
    return this.a.entries.find((e) => e.armoryId === armoryId);
  }

  /** The entry behind an `armory:<armoryId>` selection id. */
  forUnitId(unitId: string): ArmoryEntryRecord | undefined {
    return isArmoryUnitId(unitId) ? this.entry(unitId.slice(ARMORY_PREFIX.length)) : undefined;
  }

  static unitIdOf(e: Pick<ArmoryEntryRecord, 'armoryId'>): string {
    return `${ARMORY_PREFIX}${e.armoryId}`;
  }

  static displayName(e: Pick<ArmoryEntryRecord, 'name' | 'creatorName'>): string {
    return armoryDisplayName(e.name, e.creatorName);
  }

  /** The entry's sprite after moderation (Hide sprite on the design hides the entry too). */
  private hidden(e: ArmoryEntryRecord): boolean {
    const d = this.game.store.designsOf(e.creatorId).get(e.sourceUnitId);
    return d ? d.spriteHidden || e.spriteHidden : e.spriteHidden;
  }

  /** Visible sprite and hidden flag of an entry. */
  spriteOf(e: ArmoryEntryRecord): { sprite: SpriteSpec | null; spriteHidden: boolean } {
    const hidden = this.hidden(e);
    return { sprite: hidden ? null : e.sprite, spriteHidden: hidden };
  }

  card(e: ArmoryEntryRecord, viewerId: string): ArmoryCardDTO {
    const unitId = ArmoryService.unitIdOf(e);
    const rs = this.game.store.match.perPlayer[viewerId];
    const last = this.game.store.match.results[this.game.store.match.results.length - 1];
    const summary = last?.unitSummaries[viewerId]?.[unitId];
    const displayName = ArmoryService.displayName(e);
    return {
      unitId,
      armoryId: e.armoryId,
      name: displayName,
      displayName,
      creatorId: e.creatorId,
      creatorName: e.creatorName,
      roundAdded: e.roundAdded,
      version: e.version,
      stats: e.stats,
      cost: e.cost,
      breakdown: e.breakdown,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
      warnings: [],
      isTemplate: false,
      ...this.spriteOf(e),
      selected: rs?.selection.includes(unitId) ?? false,
      updatedAt: 0,
      ...(summary ? { lastBattle: summary } : {}),
    };
  }

  /** Every entry for the facilitator (§9.1 Moderation): real sprites, newest first. */
  adminList(): AdminArmoryEntryDTO[] {
    return [...this.a.entries]
      .sort((x, y) => y.roundAdded - x.roundAdded || (x.armoryId < y.armoryId ? -1 : 1))
      .map((e) => ({
        unitId: ArmoryService.unitIdOf(e),
        armoryId: e.armoryId,
        displayName: ArmoryService.displayName(e),
        creatorId: e.creatorId,
        creatorName: e.creatorName,
        sourceUnitId: e.sourceUnitId,
        version: e.version,
        stats: e.stats,
        cost: e.cost,
        status: e.status,
        roundAdded: e.roundAdded,
        sprite: e.sprite,
        spriteHidden: this.hidden(e),
      }));
  }

  /** Entries `playerId` may borrow (never their own), newest first. Empty when the Armory is off. */
  list(playerId: string): ArmoryCardDTO[] {
    if (!this.a.enabled) return [];
    return this.a.entries
      .filter((e) => e.creatorId !== playerId)
      .sort((x, y) => y.roundAdded - x.roundAdded || (x.armoryId < y.armoryId ? -1 : 1))
      .map((e) => this.card(e, playerId));
  }

  /** Can `playerId` select `unitId` (an `armory:` id) right now? */
  checkSelectable(playerId: string, unitId: string): Result<ArmoryEntryRecord> {
    if (!this.a.enabled) {
      return fail('ARMORY_OFF', 'Open Armory is off in this match, so you can only pick your own units.', {
        details: { unitId },
      });
    }
    const e = this.forUnitId(unitId);
    if (!e) return fail('NOT_FOUND', `There is no Armory unit "${unitId}".`, { details: { unitId } });
    if (e.creatorId === playerId) {
      return fail('ARMORY_OWN_UNIT', `${e.name} is your own unit. Pick it from My Units instead.`, {
        details: { unitId, ownUnitId: e.sourceUnitId },
      });
    }
    if (e.status !== 'valid') {
      return fail('UNIT_INVALID', `${ArmoryService.displayName(e)} is not valid under the current rules, so it can't be picked.`, {
        details: { unitId },
      });
    }
    return ok(e);
  }

  // -------------------------------------------------------------------------
  // Battle release
  // -------------------------------------------------------------------------

  /**
   * After a battle's result is released: every fielded non-template design
   * enters the Armory as a frozen copy (one entry per design; a newer fielded
   * version replaces the older entry). No-op when the Armory is off.
   */
  addFielded(round: number, fielded: readonly FieldedDesign[]): void {
    if (!this.a.enabled) return;
    const config = this.game.config;
    let changed = false;
    for (const f of fielded) {
      const existing = this.a.entries.find((e) => e.creatorId === f.playerId && e.sourceUnitId === f.unitId);
      if (existing && existing.version >= f.version) continue;
      const creator = this.game.store.players.get(f.playerId);
      const armoryId = existing?.armoryId ?? `ar_${randomBytes(4).toString('hex')}`;
      const checked = UnitsService.checkVersion({ stats: f.stats }, config);
      const rec: ArmoryEntryRecord = {
        armoryId,
        sourceUnitId: f.unitId,
        version: f.version,
        creatorId: f.playerId,
        creatorName: creator?.name ?? existing?.creatorName ?? '?',
        name: f.stats.name,
        stats: f.stats,
        sprite: f.sprite,
        spriteHidden: f.spriteHidden,
        compiledJs: f.compiledJs,
        cost: checked.cost.cost,
        breakdown: checked.cost.breakdown,
        roundAdded: round,
        status: checked.error ? 'invalid' : 'valid',
        ...(checked.error ? { error: checked.error } : {}),
      };
      this.game.store.writeArmoryFile(armoryId, rec.version, rec.compiledJs);
      if (existing) this.a.entries[this.a.entries.indexOf(existing)] = rec;
      else this.a.entries.push(rec);
      changed = true;
    }
    if (changed) this.game.store.save();
  }

  /** 💡 Inventor (§9.1): creators whose entries other players fielded in this battle. */
  inventors(uses: readonly BorrowedUse[], exclude: ReadonlySet<string>): InventorAward[] {
    const by = new Map<string, { borrowers: Set<string>; units: Set<string> }>();
    for (const u of uses) {
      if (u.borrowerId === u.creatorId || exclude.has(u.creatorId)) continue;
      const creator = this.game.players.get(u.creatorId);
      if (!creator) continue;
      const e = this.entry(u.armoryId);
      const g = by.get(u.creatorId) ?? { borrowers: new Set<string>(), units: new Set<string>() };
      g.borrowers.add(u.borrowerId);
      if (e) g.units.add(ArmoryService.displayName(e));
      by.set(u.creatorId, g);
    }
    return [...by].map(([playerId, g]) => ({
      playerId,
      name: this.game.players.get(playerId)?.name ?? '?',
      usedBy: g.borrowers.size,
      units: [...g.units].sort(),
    }));
  }

  // -------------------------------------------------------------------------
  // Re-pricing, moderation, lifecycle
  // -------------------------------------------------------------------------

  /** Re-price every entry under `config`; a retune may make an entry invalid (§6). */
  reprice(config: GameConfig): { repriced: string[]; invalidated: string[] } {
    const repriced: string[] = [];
    const invalidated: string[] = [];
    for (const e of this.a.entries) {
      const r = UnitsService.checkVersion(e, config);
      e.breakdown = r.cost.breakdown;
      if (r.cost.cost !== e.cost) {
        e.cost = r.cost.cost;
        repriced.push(ArmoryService.unitIdOf(e));
      }
      if (r.error) {
        if (e.status === 'valid') invalidated.push(ArmoryService.unitIdOf(e));
        e.status = 'invalid';
        e.error = r.error;
      } else {
        e.status = 'valid';
        delete e.error;
      }
    }
    return { repriced, invalidated };
  }

  /** Hide sprite on a design also hides (or shows) its Armory entry's sprite. */
  setSpriteHidden(creatorId: string, unitId: string, hidden: boolean): boolean {
    let touched = false;
    for (const e of this.a.entries) {
      if (e.creatorId === creatorId && e.sourceUnitId === unitId) {
        e.spriteHidden = hidden;
        touched = true;
      }
    }
    return touched;
  }

  /**
   * "Kick + delete data": the player's entries go with their data. A plain
   * kick keeps them. During PLACEMENT other players may have locked and placed
   * those entries, so they stay until the next PLAN (`applyPendingRemovals`)
   * and the borrowers' armies and budgets don't change mid-round.
   */
  removeCreator(playerId: string): void {
    if (!this.a.entries.some((e) => e.creatorId === playerId)) return;
    if (this.game.store.match.phase === 'PLACEMENT') {
      const pending = (this.a.pendingRemovals ??= []);
      if (!pending.includes(playerId)) pending.push(playerId);
      this.game.store.save();
      return;
    }
    this.removeNow(new Set([playerId]));
  }

  /** Entering PLAN: drop the entries of creators deleted during PLACEMENT. */
  applyPendingRemovals(): void {
    const pending = this.a.pendingRemovals;
    if (!pending?.length) return;
    delete this.a.pendingRemovals;
    this.removeNow(new Set(pending));
  }

  private removeNow(creators: ReadonlySet<string>): void {
    const gone = new Set(this.a.entries.filter((e) => creators.has(e.creatorId)).map((e) => ArmoryService.unitIdOf(e)));
    this.a.entries = this.a.entries.filter((e) => !creators.has(e.creatorId));
    // Nobody keeps a selection that points at a removed entry.
    for (const [pid, rs] of Object.entries(this.game.store.match.perPlayer)) {
      const before = rs.selection.length;
      rs.selection = rs.selection.filter((id) => !gone.has(id));
      if (rs.prevSelection) rs.prevSelection = rs.prevSelection.filter((id) => !gone.has(id));
      if (rs.selection.length !== before) this.game.notifier.privateChanged(pid);
    }
    this.game.store.save();
  }

  /** New match / Start match: a fresh, empty Armory. */
  reset(enabled: boolean): void {
    this.game.store.match.armory = { enabled, entries: [] };
    this.game.store.deleteArmoryFiles();
  }
}
