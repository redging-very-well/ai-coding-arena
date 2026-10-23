// Round (plan §3, §9): selection (PLAN), selection lock + fallback rules,
// per-round zone assignment, placement validation (PLACEMENT), Ready, and
// auto-place at lock.

import {
  MAP_STYLE_INFO,
  assignMapZones,
  assignTeamZones,
  fail,
  isArmoryUnitId,
  isValidCell,
  mapFor,
  ok,
  resolveMapStyle,
  zoneCentredOnLine,
  type MapZone,
  type PlacementDTO,
  type PlacementResponse,
  type Result,
} from '@pixel-clash/shared';
import { autoPlace } from '../sim/autoPlace.js';
import { ArmoryService } from './armory.js';
import type { Game } from './game.js';
import { newRoundState, type LockedUnit, type PlayerRoundState } from './store.js';
import { UnitsService } from './units.js';

/** A locked design resolved to its version record. */
export interface LockedDesign extends LockedUnit {
  name: string;
  cost: number;
}

export class RoundService {
  constructor(private readonly game: Game) {}

  stateOf(playerId: string): PlayerRoundState {
    const m = this.game.store.match;
    let rs = m.perPlayer[playerId];
    if (!rs) {
      rs = newRoundState();
      m.perPlayer[playerId] = rs;
    }
    return rs;
  }

  zoneOf(playerId: string): MapZone | null {
    return this.game.store.match.zones[playerId] ?? null;
  }

  /**
   * The locked designs with their (lock-time) version and current cost.
   * Borrowed Armory units (`armory:<id>`, §9.1) resolve to their entry and are
   * named "Ogre (Ninja Sam)".
   */
  lockedDesigns(playerId: string): LockedDesign[] {
    const rs = this.stateOf(playerId);
    const out: LockedDesign[] = [];
    for (const l of rs.locked ?? []) {
      if (isArmoryUnitId(l.unitId)) {
        const e = this.game.armory.forUnitId(l.unitId);
        if (e) out.push({ ...l, name: ArmoryService.displayName(e), cost: e.cost });
        continue;
      }
      const v = this.game.units.versionOf(playerId, l.unitId, l.version);
      if (v) out.push({ ...l, name: v.stats.name, cost: v.cost });
    }
    return out;
  }

  spent(playerId: string): number {
    const costs = new Map(this.lockedDesigns(playerId).map((d) => [d.unitId, d.cost]));
    return this.stateOf(playerId).placements.reduce((s, p) => s + (costs.get(p.unitId) ?? 0), 0);
  }

  // -------------------------------------------------------------------------
  // PLAN: selection
  // -------------------------------------------------------------------------

  setSelection(playerId: string, unitIds: unknown): Result<{ selection: string[] }> {
    const gate = this.game.match.gate('selection');
    if (gate) return gate;
    if (!Array.isArray(unitIds) || unitIds.some((u) => typeof u !== 'string')) {
      return fail('BAD_REQUEST', 'unitIds must be an array of unitId strings.');
    }
    const ids = [...new Set(unitIds as string[])];
    const max = this.game.config.caps.maxTypes;
    if (ids.length > max) {
      return fail('TOO_MANY_TYPES', `You can pick at most ${max} unit types per round.`, { details: { max } });
    }
    for (const id of ids) {
      if (isArmoryUnitId(id)) {
        const e = this.game.armory.checkSelectable(playerId, id);
        if (!e.ok) return e;
        continue;
      }
      const d = this.game.units.design(playerId, id);
      if (!d) return fail('NOT_FOUND', `You have no unit "${id}".`);
      if (!UnitsService.latestValid(d)) {
        return fail('UNIT_INVALID', `${UnitsService.latest(d).stats.name} is not valid right now, so it can't be picked.`, {
          hint: 'Ask Claude to fix it first (list_my_units shows the error).',
        });
      }
    }
    const rs = this.stateOf(playerId);
    if (!sameSet(rs.selection, ids)) this.armyChanged(playerId);
    rs.selection = ids;
    this.game.store.save();
    this.game.notifier.privateChanged(playerId);
    this.game.notifier.stateChanged();
    return ok({ selection: ids });
  }

  /**
   * Lock every active player's selection at the end of PLAN (§3): each unitId
   * resolves to its latest valid version; invalid ones are dropped. Empty →
   * the previous round's selection if all still valid → the 3 most recently
   * submitted valid units → the templates.
   */
  lockSelections(): void {
    const max = this.game.config.caps.maxTypes;
    for (const p of this.game.players.active()) {
      const rs = this.stateOf(p.id);
      const resolve = (ids: readonly string[]): LockedUnit[] => {
        const out: LockedUnit[] = [];
        for (const id of ids) {
          if (isArmoryUnitId(id)) {
            // A borrowed Armory unit: the frozen entry, if still selectable (§9.1).
            const e = this.game.armory.checkSelectable(p.id, id);
            if (e.ok) out.push({ unitId: id, version: e.data.version });
            continue;
          }
          const d = this.game.units.design(p.id, id);
          const v = d ? UnitsService.latestValid(d) : undefined;
          if (v) out.push({ unitId: id, version: v.version });
        }
        return out.slice(0, max);
      };
      let locked = resolve(rs.selection);
      if (locked.length === 0 && rs.prevSelection && rs.prevSelection.length > 0) {
        const prev = resolve(rs.prevSelection);
        if (prev.length === rs.prevSelection.length) locked = prev;
      }
      if (locked.length === 0) {
        const recent = this.game.units
          .designs(p.id)
          .filter((d) => !d.isTemplate && UnitsService.latestValid(d))
          .sort((a, b) => UnitsService.latestValid(b)!.createdAt - UnitsService.latestValid(a)!.createdAt)
          .map((d) => d.unitId);
        locked = resolve(recent);
      }
      if (locked.length === 0) locked = resolve(this.game.units.templateIds());
      rs.locked = locked;
      rs.selection = locked.map((l) => l.unitId);
      rs.prevSelection = rs.selection.slice();
      rs.placements = [];
      rs.ready = false;
    }
  }

  /**
   * Assign this round's zones (§9.2), at the start of PLACEMENT (and again
   * when a kick changes the active players).
   *   * Team mode: the map fixed at Start match; whole teams rotate as blocks
   *     and members inside their block. A kicked member's zone stays empty.
   *   * Free-for-all: the map is resolved from the active player count P (the
   *     host's style if valid for P, else the default, with an admin toast);
   *     active players in join order get zones[(i + round) % P].
   */
  assignZones(): void {
    const g = this.game;
    const m = g.store.match;
    const ids = g.players.active().map((p) => p.id);
    const teams = g.teams.slots();
    if (g.teams.active && teams && m.map) {
      const active = new Set(ids);
      const slots = teams.map((t) => ({ members: t.members.map((id) => (active.has(id) ? id : null)) }));
      m.zones = Object.fromEntries(assignTeamZones(mapFor(m.map.style, m.map.players), slots, m.round));
      return;
    }
    if (ids.length === 0) {
      m.zones = {};
      return;
    }
    const players = ids.length;
    const { style, fellBack } = resolveMapStyle(m.setup.mapStyle, players);
    const prev = m.map;
    m.map = { style, players };
    if (fellBack && (prev?.style !== style || prev?.players !== players)) {
      g.notifier.toast({ admin: true }, 'info', `Map changed to ${MAP_STYLE_INFO[style].label} for ${players} player${players === 1 ? '' : 's'}`);
    }
    m.zones = Object.fromEntries(assignMapZones(mapFor(style, players), ids, m.round));
  }

  // -------------------------------------------------------------------------
  // PLACEMENT
  // -------------------------------------------------------------------------

  /** Validate a full placement list against the locked selection, cells, copies and budget. */
  checkPlacements(playerId: string, input: unknown): Result<PlacementResponse> {
    if (!Array.isArray(input)) return fail('BAD_REQUEST', 'placements must be an array of {unitId, col, row}.');
    const caps = this.game.config.caps;
    const costs = new Map(this.lockedDesigns(playerId).map((d) => [d.unitId, d.cost]));
    const placements: PlacementDTO[] = [];
    const cells = new Set<string>();
    let spent = 0;
    for (const raw of input as unknown[]) {
      const p = raw as Partial<PlacementDTO> | null;
      if (!p || typeof p !== 'object' || typeof p.unitId !== 'string' || typeof p.col !== 'number' || typeof p.row !== 'number') {
        return fail('BAD_REQUEST', 'Each placement needs {unitId, col, row}.');
      }
      if (!isValidCell(p.col, p.row)) {
        return fail('CELL_OUT_OF_ZONE', `Cell (${p.col}, ${p.row}) is outside your zone (col and row are 0-5).`, {
          details: { col: p.col, row: p.row },
        });
      }
      const key = `${p.col},${p.row}`;
      if (cells.has(key)) {
        return fail('CELL_TAKEN', `Cell (${p.col}, ${p.row}) already has a unit.`, { details: { col: p.col, row: p.row } });
      }
      cells.add(key);
      const cost = costs.get(p.unitId);
      if (cost === undefined) {
        return fail('NOT_SELECTED', `"${p.unitId}" is not one of your units for this round.`, { details: { unitId: p.unitId } });
      }
      spent += cost;
      placements.push({ unitId: p.unitId, col: p.col, row: p.row });
    }
    if (placements.length > caps.maxCopies) {
      return fail('TOO_MANY_COPIES', `You can place at most ${caps.maxCopies} units.`, { details: { max: caps.maxCopies } });
    }
    if (spent > caps.budget) {
      return fail('OVER_BUDGET', `That army costs $${spent} but your budget is $${caps.budget}.`, {
        details: { spent, budget: caps.budget },
      });
    }
    return ok({ placements, spent, remaining: caps.budget - spent });
  }

  setPlacements(playerId: string, input: unknown): Result<PlacementResponse> {
    const gate = this.game.match.gate('placement');
    if (gate) return gate;
    if (!this.game.players.isActive(this.game.players.get(playerId)!)) {
      return fail('PHASE_CLOSED', "You're in from the next round.", { details: { phase: this.game.store.match.phase } });
    }
    const checked = this.checkPlacements(playerId, input);
    if (!checked.ok) return checked;
    const rs = this.stateOf(playerId);
    rs.placements = checked.data.placements;
    this.game.store.save();
    this.game.notifier.privateChanged(playerId);
    return checked;
  }

  /**
   * The Ready toggle (§3): in PLAN "my army is picked" (needs a non-empty
   * selection), in PLACEMENT "my army is placed". One flag, reset whenever the
   * phase changes (enterPlan, lockSelections), so PLAN Ready never carries
   * into PLACEMENT. Only active players can be ready.
   */
  setReady(playerId: string, ready: unknown): Result<{ ready: boolean }> {
    const gate = this.game.match.gate('ready');
    if (gate) return gate;
    if (typeof ready !== 'boolean') return fail('BAD_REQUEST', 'ready must be true or false.');
    const player = this.game.players.get(playerId);
    if (!player || !this.game.players.isActive(player)) {
      return fail('PHASE_CLOSED', "You're in from the next round.", { details: { phase: this.game.store.match.phase } });
    }
    const rs = this.stateOf(playerId);
    if (ready && this.game.store.match.phase === 'PLAN' && rs.selection.length === 0) {
      return fail('NOTHING_SELECTED', 'Pick at least one unit type before getting ready.', {
        hint: `Tap up to ${this.game.config.caps.maxTypes} units in My Units first, then press Ready.`,
      });
    }
    rs.ready = ready;
    this.game.store.save();
    this.game.match.syncAutoAdvance();
    this.game.notifier.privateChanged(playerId);
    this.game.notifier.stateChanged();
    return ok({ ready });
  }

  /**
   * The player's PLAN army changed (a different selection, or a new/revised
   * unit of theirs was submitted, retired or invalidated): their PLAN Ready no
   * longer stands, so it is cleared. Callers save and push state themselves.
   */
  armyChanged(playerId: string): void {
    if (this.game.store.match.phase !== 'PLAN') return;
    const rs = this.game.store.match.perPlayer[playerId];
    if (!rs?.ready) return;
    rs.ready = false;
    this.game.match.syncAutoAdvance();
  }

  allReady(): boolean {
    return this.game.players.active().every((p) => this.stateOf(p.id).ready);
  }

  /** Public `allReady` (§10.3): PLAN or PLACEMENT, at least one active player, all of them ready. */
  everyoneReady(): boolean {
    const phase = this.game.store.match.phase;
    if (phase !== 'PLAN' && phase !== 'PLACEMENT') return false;
    const active = this.game.players.active();
    return active.length > 0 && active.every((p) => this.stateOf(p.id).ready);
  }

  /**
   * Auto-place (§9) at lock for every active player with zero placements.
   * Returns the names of the auto-placed players.
   */
  autoPlaceEmpty(): string[] {
    const caps = this.game.config.caps;
    const names: string[] = [];
    for (const p of this.game.players.active()) {
      const rs = this.stateOf(p.id);
      if (rs.placements.length > 0) continue;
      const res = autoPlace({
        available: this.lockedDesigns(p.id).map((d) => ({ unitId: d.unitId, cost: d.cost })),
        lastLayout: rs.lastLayout,
        caps: { budget: caps.budget, maxCopies: caps.maxCopies, maxTypes: caps.maxTypes },
        ...(this.zoneOf(p.id) ? { facing: this.zoneOf(p.id)!.facing, centred: zoneCentredOnLine(this.zoneOf(p.id)!) } : {}),
      });
      rs.placements = res.placements;
      if (res.placements.length > 0) names.push(p.name);
    }
    return names;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
