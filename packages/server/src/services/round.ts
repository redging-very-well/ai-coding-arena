// Round (plan §3, §9): selection (PLAN), selection lock + fallback rules,
// per-round zone assignment, placement validation (PLACEMENT), Ready, and
// auto-place at lock.

import {
  MAP_STYLE_INFO,
  READY_MAX_PER_WINDOW,
  READY_MIN_GAP_MS,
  READY_WINDOW_MS,
  assignMapZones,
  assignTeamZones,
  fail,
  groupOf,
  isArmoryUnitId,
  isFighterDesign,
  isValidCell,
  layoutSpent,
  mapFor,
  money,
  ok,
  resolveMapStyle,
  trappedCells,
  zoneCentredOnLine,
  type MapZone,
  type PlacementDTO,
  type PlacementResponse,
  type PlacementWarningDTO,
  type Result,
  type StatsSnapshot,
  type UnitType,
} from '@pixel-clash/shared';
import { autoPlace } from '../sim/autoPlace.js';
import { RateLimiter } from '../util/ratelimit.js';
import { ArmoryService, wallsOffError } from './armory.js';
import type { Game } from './game.js';
import { newRoundState, type LockedUnit, type PlayerRoundState } from './store.js';
import { UnitsService } from './units.js';

/** A locked design resolved to its version record. */
export interface LockedDesign extends LockedUnit {
  name: string;
  cost: number;
  type: UnitType;
  /** M8.8 (§5.2 Fighters): can win a battle (not a wall, a damage-0 unit or a medic factory). */
  fighter?: boolean;
}

export class RoundService {
  /** Ready changes per player (READY_* in shared protocol, or GameOptions.readyLimit): no spamming. */
  private readonly readyGap: RateLimiter | null;
  private readonly readyWindow: RateLimiter | null;

  constructor(private readonly game: Game) {
    const limit = game.options.readyLimit ?? { minGapMs: READY_MIN_GAP_MS, maxPerWindow: READY_MAX_PER_WINDOW, windowMs: READY_WINDOW_MS };
    this.readyGap = limit ? new RateLimiter(1, limit.minGapMs) : null;
    this.readyWindow = limit ? new RateLimiter(limit.maxPerWindow, limit.windowMs) : null;
  }

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
        if (e) out.push({ ...l, name: ArmoryService.displayName(e), cost: e.cost, type: e.stats.type, fighter: isFighterDesign(e.stats) });
        continue;
      }
      const v = this.game.units.versionOf(playerId, l.unitId, l.version);
      if (v) out.push({ ...l, name: v.stats.name, cost: v.cost, type: v.stats.type, fighter: isFighterDesign(v.stats) });
    }
    return out;
  }

  spent(playerId: string): number {
    const designs = new Map(this.lockedDesigns(playerId).map((d) => [d.unitId, d]));
    const ids = this.stateOf(playerId).placements.map((p) => p.unitId).filter((id) => designs.has(id));
    return layoutSpent(ids, (id) => designs.get(id)?.cost, (id) => designs.get(id)?.type, this.game.config.caps.copyRamp) ?? 0;
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
    const caps = this.game.config.caps;
    const maxTotal = caps.maxUnitTypes + caps.maxBuildingTypes;
    if (ids.length > maxTotal) {
      return fail('TOO_MANY_TYPES', `You can pick at most ${caps.maxUnitTypes} unit types and ${caps.maxBuildingTypes} building types per round.`, {
        details: { group: 'all', max: maxTotal, count: ids.length },
      });
    }
    const types: UnitType[] = [];
    for (const id of ids) {
      if (isArmoryUnitId(id)) {
        const e = this.game.armory.checkSelectable(playerId, id);
        // A wall entry already picked (before walls were off) can still be un-picked.
        if (!e.ok && !(e.error.code === 'WALLS_OFF' && this.stateOf(playerId).selection.includes(id))) return e;
        if (!e.ok) {
          types.push('wall');
          continue;
        }
        types.push(e.data.stats.type);
        continue;
      }
      const d = this.game.units.design(playerId, id);
      if (!d) return fail('NOT_FOUND', `You have no unit "${id}".`);
      if (!UnitsService.latestValid(d)) {
        return fail('UNIT_INVALID', `${UnitsService.latest(d).stats.name} is not valid right now, so it can't be picked.`, {
          hint: 'Ask your AI helper to fix it first (list_my_units shows the error).',
        });
      }
      const type = UnitsService.latestValid(d)!.stats.type;
      // §9.1b: with "Walls allowed" off a wall can't be picked (un-picking is always fine).
      if (type === 'wall' && !this.game.teams.wallsAllowed && !this.stateOf(playerId).selection.includes(id)) {
        return wallsOffError(UnitsService.latest(d).stats.name, id);
      }
      types.push(type);
    }
    // §5.2: ≤ maxUnitTypes soldiers and ≤ maxBuildingTypes buildings (towers, walls, factories).
    // Un-picking is always allowed, even from a selection that a revised
    // design pushed over a cap (that is how the player fixes it).
    const unitCount = types.filter((t) => groupOf(t) === 'unit').length;
    const buildingCount = types.length - unitCount;
    const current = this.stateOf(playerId).selection;
    const onlyRemoves = ids.every((id) => current.includes(id));
    if (onlyRemoves) {
      // nothing to check
    } else if (unitCount > caps.maxUnitTypes) {
      return fail('TOO_MANY_TYPES', `You can pick at most ${caps.maxUnitTypes} unit types (soldiers) per round.`, {
        details: { group: 'units', max: caps.maxUnitTypes, count: unitCount },
      });
    }
    if (!onlyRemoves && buildingCount > caps.maxBuildingTypes) {
      return fail('TOO_MANY_TYPES', `You can pick at most ${caps.maxBuildingTypes} building types (towers, walls, factories) per round.`, {
        details: { group: 'buildings', max: caps.maxBuildingTypes, count: buildingCount },
      });
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
   * submitted valid units → the templates. A walls-only result gets a
   * starter fighter added (§5.2 Fighters). With "Walls allowed" off (§9.1b)
   * walls are never locked: a picked one is dropped with a toast.
   */
  lockSelections(): void {
    const caps = this.game.config.caps;
    const wallsOff = !this.game.teams.wallsAllowed;
    for (const p of this.game.players.active()) {
      const rs = this.stateOf(p.id);
      if (wallsOff) this.dropWalls(p.id);
      const resolve = (ids: readonly string[]): LockedUnit[] => {
        const out: LockedUnit[] = [];
        const count = { unit: 0, building: 0 };
        const take = (l: LockedUnit, type: UnitType) => {
          const g = groupOf(type);
          if (count[g] >= (g === 'unit' ? caps.maxUnitTypes : caps.maxBuildingTypes)) return;
          count[g]++;
          out.push(l);
        };
        for (const id of ids) {
          if (isArmoryUnitId(id)) {
            // A borrowed Armory unit: the frozen entry, if still selectable (§9.1).
            const e = this.game.armory.checkSelectable(p.id, id);
            if (e.ok) take({ unitId: id, version: e.data.version }, e.data.stats.type);
            continue;
          }
          const d = this.game.units.design(p.id, id);
          const v = d ? UnitsService.latestValid(d) : undefined;
          if (v && !(wallsOff && v.stats.type === 'wall')) take({ unitId: id, version: v.version }, v.stats.type);
        }
        return out;
      };
      let locked = resolve(rs.selection);
      // Over a type cap (a picked design was revised into the other group and
      // never un-picked): the later picks of the full group are left out; say which.
      const over = this.overCap(p.id, rs.selection);
      if (over) {
        const kept = new Set(locked.map((l) => l.unitId));
        const left = rs.selection.filter((id) => !kept.has(id) && this.selectedType(p.id, id) !== undefined);
        const names = left.map((id) => this.displayName(p.id, id));
        if (names.length > 0) {
          this.game.notifier.toast(
            { playerId: p.id },
            'warn',
            `${names.join(', ')} ${names.length === 1 ? "isn't" : "aren't"} in your army this round: ${over.max} ${over.group === 'unit' ? 'units' : 'buildings'} max.`,
          );
        }
      }
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
      // §5.2 Fighters: walls (M8.8: and pure support) can't win on their own, so
      // such an army gets the first starter fighter that fits the type caps (the Basic Soldier).
      if (!locked.some((l) => this.isFighterId(p.id, l.unitId))) {
        for (const id of this.game.units.templateIds()) {
          if (!this.isFighterId(p.id, id)) continue;
          const extra = resolve([...locked.map((l) => l.unitId), id]);
          if (extra.some((l) => l.unitId === id)) {
            locked = extra;
            break;
          }
        }
      }
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

  /**
   * Validate a full placement list against the locked selection, cells,
   * copies (per group, §5.2 Copies) and budget. The result counts the copies
   * per group and warns W_TRAPPED for every soldier or factory that its walls
   * box in (non-fatal, §9.3 Placement check).
   */
  checkPlacements(playerId: string, input: unknown): Result<PlacementResponse> {
    if (!Array.isArray(input)) return fail('BAD_REQUEST', 'placements must be an array of {unitId, col, row}.');
    const caps = this.game.config.caps;
    const designs = new Map(this.lockedDesigns(playerId).map((d) => [d.unitId, d]));
    const placements: PlacementDTO[] = [];
    const cells = new Set<string>();
    const counts = { fighters: 0, factories: 0, walls: 0 };
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
      const d = designs.get(p.unitId);
      if (d === undefined && !this.game.teams.wallsAllowed && this.selectedType(playerId, p.unitId) === 'wall') {
        return wallsOffError(this.displayName(playerId, p.unitId), p.unitId);
      }
      if (d === undefined) {
        return fail('NOT_SELECTED', `"${p.unitId}" is not one of your units for this round.`, { details: { unitId: p.unitId } });
      }
      if (d.type === 'wall') counts.walls++;
      else counts.fighters++;
      if (d.type === 'factory') counts.factories++;
      placements.push({ unitId: p.unitId, col: p.col, row: p.row });
    }
    if (counts.fighters > caps.maxCopies) {
      return fail('TOO_MANY_COPIES', `You can place at most ${caps.maxCopies} fighters (soldiers, towers and factories).`, {
        details: { group: 'fighters', max: caps.maxCopies, count: counts.fighters },
      });
    }
    if (counts.factories > caps.maxFactoryCopies) {
      return fail('TOO_MANY_COPIES', `You can place at most ${caps.maxFactoryCopies} factories.`, {
        details: { group: 'factories', max: caps.maxFactoryCopies, count: counts.factories },
      });
    }
    if (counts.walls > caps.maxWallCopies) {
      return fail('TOO_MANY_COPIES', `You can place at most ${caps.maxWallCopies} walls.`, {
        details: { group: 'walls', max: caps.maxWallCopies, count: counts.walls },
      });
    }
    // Redesign: copies of one design beyond caps.copyRamp.freeCopies cost more (§6 copy ramp).
    const spent = layoutSpent(placements.map((p) => p.unitId), (id) => designs.get(id)?.cost, (id) => designs.get(id)?.type, caps.copyRamp) ?? 0;
    const budget = this.game.teams.budgetOf(playerId);
    if (spent > budget) {
      return fail('OVER_BUDGET', `That army costs ${money(spent)} but your budget is ${money(budget)}.`, {
        details: { spent, budget },
      });
    }
    const warnings: PlacementWarningDTO[] = [];
    const zone = this.zoneOf(playerId);
    if (zone && counts.walls > 0) {
      for (const t of trappedCells(zone, placements, (id) => designs.get(id)?.type)) {
        warnings.push({
          code: 'W_TRAPPED',
          unitId: t.unitId,
          col: t.col,
          row: t.row,
          message: `Your ${designs.get(t.unitId)?.name ?? 'unit'} is walled in! Leave a gap so it can get out.`,
        });
      }
    }
    return ok({ placements, spent, remaining: budget - spent, counts, warnings });
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
        hint: `Tap up to ${this.game.config.caps.maxUnitTypes} units and ${this.game.config.caps.maxBuildingTypes} buildings in My Units first, then press Ready.`,
      });
    }
    // §5.2 type caps: a picked design revised into the other group can push a
    // selection over a cap after it was picked; Ready waits until it fits.
    const over = ready && this.game.store.match.phase === 'PLAN' ? this.overCap(playerId, rs.selection) : null;
    if (over) {
      return fail('TOO_MANY_TYPES', over.message, {
        hint: 'Tap a picked one in My Units to un-pick it, then press Ready.',
        details: { group: over.group === 'unit' ? 'units' : 'buildings', max: over.max, count: over.count },
      });
    }
    // §5.2 Fighters: walls alone can't win, so Ready needs a fighter.
    if (ready && this.game.store.match.phase === 'PLAN' && !this.selectionHasFighter(playerId, rs.selection)) {
      return fail('NO_FIGHTERS', "Walls, medics and banners can't win on their own. Pick a unit that attacks.", {
        hint: 'Tap a soldier or tower that does damage, or a factory that builds fighting minions, in My Units, then press Ready.',
      });
    }
    if (ready && this.game.store.match.phase === 'PLACEMENT' && rs.placements.length > 0 && !this.placementHasFighter(playerId, rs.placements)) {
      return fail('NO_FIGHTERS', "Walls, medics and banners can't win on their own. Place a unit that attacks.", {
        hint: 'Put a soldier or tower that does damage, or a factory that builds fighting minions, on your grid, then press Ready.',
      });
    }
    if (rs.ready !== ready && this.readyGap && this.readyWindow) {
      // Only real changes count toward the limit; pressing the same state again is a no-op.
      const wait = Math.max(this.readyGap.check(playerId), this.readyWindow.check(playerId));
      if (wait > 0) {
        return fail('RATE_LIMITED', `Easy there! Wait ${Math.ceil(wait / 100) / 10} s before changing Ready again.`, {
          details: { retryAfterMs: wait },
        });
      }
      this.readyGap.hit(playerId);
      this.readyWindow.hit(playerId);
    }
    rs.ready = ready;
    this.game.store.save();
    this.game.match.syncAutoAdvance();
    this.game.notifier.privateChanged(playerId);
    this.game.notifier.stateChanged();
    return ok({ ready });
  }

  /**
   * "Walls allowed" off (§9.1b): take wall designs out of the player's
   * selection, previous selection and last layout, with a toast naming the
   * walls left out of the selection. Callers save and push state.
   */
  dropWalls(playerId: string): void {
    const rs = this.stateOf(playerId);
    const isWall = (id: string) => this.selectedType(playerId, id) === 'wall';
    const walls = rs.selection.filter(isWall);
    if (walls.length > 0) {
      rs.selection = rs.selection.filter((id) => !isWall(id));
      const names = walls.map((id) => this.displayName(playerId, id));
      this.game.notifier.toast(
        { playerId },
        'warn',
        `Walls are switched off for this match: ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} taken out of your picks.`,
      );
    }
    if (rs.prevSelection) rs.prevSelection = rs.prevSelection.filter((id) => !isWall(id));
    if (rs.lastLayout) rs.lastLayout = rs.lastLayout.filter((pl) => !isWall(pl.unitId));
  }

  /** The type of a selectable id (own design's latest valid version or an Armory entry), if known. */
  private selectedType(playerId: string, id: string): UnitType | undefined {
    return this.selectedStats(playerId, id)?.type;
  }

  private selectedStats(playerId: string, id: string): StatsSnapshot | undefined {
    if (isArmoryUnitId(id)) return this.game.armory.forUnitId(id)?.stats;
    const d = this.game.units.design(playerId, id);
    return d ? UnitsService.latestValid(d)?.stats : undefined;
  }

  /** §5.2 Fighters (M8.8): a selectable design that can win a battle. */
  private isFighterId(playerId: string, id: string): boolean {
    const s = this.selectedStats(playerId, id);
    return s !== undefined && isFighterDesign(s);
  }

  /** A selectable id's name for messages (own design's latest version or an Armory entry). */
  private displayName(playerId: string, id: string): string {
    if (isArmoryUnitId(id)) return this.game.armory.forUnitId(id)?.name ?? id;
    const d = this.game.units.design(playerId, id);
    return d ? UnitsService.latest(d).stats.name : id;
  }

  /** The first group (units, then buildings) a selection has more types of than its cap allows, or null. */
  overCap(playerId: string, ids: readonly string[]): { group: 'unit' | 'building'; count: number; max: number; message: string } | null {
    const caps = this.game.config.caps;
    const count = { unit: 0, building: 0 };
    for (const id of ids) {
      const t = this.selectedType(playerId, id);
      if (t) count[groupOf(t)]++;
    }
    const over = (group: 'unit' | 'building', max: number) => ({ group, count: count[group], max, message: overCapMessage({ group, count: count[group], max }) });
    if (count.unit > caps.maxUnitTypes) return over('unit', caps.maxUnitTypes);
    if (count.building > caps.maxBuildingTypes) return over('building', caps.maxBuildingTypes);
    return null;
  }

  /** §5.2 Fighters: soldiers and towers that do damage, factories that don't build medics (M8.8). */
  private selectionHasFighter(playerId: string, ids: readonly string[]): boolean {
    return ids.some((id) => this.isFighterId(playerId, id));
  }

  private placementHasFighter(playerId: string, placements: readonly PlacementDTO[]): boolean {
    const fighters = new Map(this.lockedDesigns(playerId).map((d) => [d.unitId, d.fighter ?? d.type !== 'wall']));
    return placements.some((p) => fighters.get(p.unitId) === true);
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
   * Auto-place (§9) at lock for every active player with zero placements
   * (or only walls: fighters are added in the free cells, the walls stay).
   * Returns the names of the auto-placed players.
   */
  autoPlaceEmpty(): string[] {
    const caps = this.game.config.caps;
    const names: string[] = [];
    for (const p of this.game.players.active()) {
      const rs = this.stateOf(p.id);
      // A layout with a fighter stays; a walls-only one gets fighters added (§9 Auto-place, M8.5).
      if (rs.placements.length > 0 && this.placementHasFighter(p.id, rs.placements)) continue;
      const res = autoPlace({
        ...(rs.placements.length > 0 ? { existing: rs.placements } : {}),
        available: this.lockedDesigns(p.id).map((d) => ({ unitId: d.unitId, cost: d.cost, type: d.type, ...(d.fighter !== undefined ? { fighter: d.fighter } : {}) })),
        lastLayout: rs.lastLayout,
        caps: {
          budget: this.game.teams.budgetOf(p.id),
          maxCopies: caps.maxCopies,
          maxUnitTypes: caps.maxUnitTypes,
          maxBuildingTypes: caps.maxBuildingTypes,
          maxFactoryCopies: caps.maxFactoryCopies,
          maxWallCopies: caps.maxWallCopies,
          copyRamp: caps.copyRamp,
        },
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

/** "You picked 5 buildings; 4 max. Tap one to un-pick it." (TOO_MANY_TYPES after a revision, §5.2). */
export function overCapMessage(over: { group: 'unit' | 'building'; count: number; max: number }): string {
  const what = over.group === 'unit' ? 'units' : 'buildings';
  return `You picked ${over.count} ${what}; ${over.max} max. Tap one to un-pick it.`;
}
