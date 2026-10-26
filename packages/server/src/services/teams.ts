// Match setup, maps and teams (plan §9.2, §4 benched, §10.3 admin setup/swap).
//
//   * LOBBY: the host keeps a DRAFT setup ({mapStyle, teamMode}, `PUT
//     /admin/match/setup`). Its teams are dealt with the snake by join order
//     and re-dealt whenever the roster or the draft mode changes (that drops
//     manual swaps/moves: toast "Teams re-balanced"). Swaps and moves happen
//     in LOBBY only; a move can make teams unequal (every team keeps ≥ 1
//     player), and Lanes / Islands then fall back to the default map.
//     A roster change that makes a stored draft value invalid resets it (team
//     mode → free-for-all, style → auto) with an admin toast, and requests
//     only check the fields they send, so the draft can never get stuck.
//   * Start match fixes the setup. Team mode: the teams (draft incl. swaps when
//     the mode matches) and the map (from P at Start) stay fixed until New
//     match; a kicked member keeps their slot (their zone stays empty) and late
//     joiners are benched. Free-for-all: the map is resolved per PLACEMENT.
//   * Team privacy: "same team" is a visibility relation only while a team
//     match runs (in free-for-all nobody is a teammate). Teammates see each
//     other's selected types (cards, never source or unselected designs),
//     zones and placements live, via `privateTeam`.

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  autoBalance,
  groupOf,
  fail,
  MAP_STYLE_INFO,
  isMapStyle,
  isTeamMode,
  isValidMapSetup,
  isValidTeamMode,
  mapDTO,
  mapFor,
  mapZoneDTO,
  moveTeamPlayer,
  ok,
  resolveMapStyle,
  swapTeamPlayers,
  teamModeLabel,
  teamSizesOf,
  validMapStyles,
  validTeamModes,
  type MapDTO,
  type MapLayout,
  type MapStyle,
  type MatchInfoDTO,
  type MatchSetupDTO,
  type Result,
  type TeamDTO,
  type TeamMemberPrivateDTO,
  type TeamMode,
  type TeamPrivateDTO,
  type TeamTableRowDTO,
  type UnitCardDTO,
} from '@pixel-clash/shared';
import { teamTable } from '../sim/scoring.js';
import { ArmoryService } from './armory.js';
import type { Game } from './game.js';
import type { PlayerRecord } from './store.js';
import { UnitsService } from './units.js';

/** What Start match resolved (§9.2). */
export interface ResolvedSetup {
  /** The host's override (null = default by player count). */
  mapStyle: MapStyle | null;
  /** The style used for the players at Start. */
  style: MapStyle;
  teamMode: TeamMode;
  teams: TeamDTO[] | null;
  players: number;
  /** "Show enemy names to units" (§5). */
  revealNames: boolean;
  /** "Walls allowed" (§9.1b). */
  wallsAllowed: boolean;
}

/**
 * The stored form of the match switches: present only when not the default
 * (revealNames on, wallsAllowed off), so older state files stay the same.
 */
function switchesOf(revealNames: boolean, wallsAllowed: boolean): { revealNames?: true; wallsAllowed?: false } {
  return { ...(revealNames ? { revealNames: true as const } : {}), ...(wallsAllowed ? {} : { wallsAllowed: false as const }) };
}

/** A requested switch: undefined/null = keep the draft's, else it must be a boolean. */
function checkSwitch(name: string, v: unknown): Result<boolean | undefined> {
  if (v === undefined || v === null) return ok(undefined);
  if (typeof v !== 'boolean') return fail('BAD_REQUEST', `${name} must be true or false.`);
  return ok(v);
}

export class TeamsService {
  constructor(private readonly game: Game) {}

  private get m() {
    return this.game.store.match;
  }

  /** "Show enemy names to units" (§5): the draft in LOBBY, fixed from Start match. */
  get revealNames(): boolean {
    return this.m.setup.revealNames === true;
  }

  /** "Walls allowed" (§9.1b, default on): the draft in LOBBY, fixed from Start match. */
  get wallsAllowed(): boolean {
    return this.m.setup.wallsAllowed !== false;
  }

  /** A team match is running (teams fixed from Start match to New match). */
  get active(): boolean {
    return this.m.phase !== 'LOBBY' && this.m.teams !== null;
  }

  /** The team slots (draft in LOBBY; fixed in a match). */
  slots(): readonly TeamDTO[] | null {
    return this.m.teams;
  }

  private current(id: string): boolean {
    return this.game.players.get(id) !== undefined;
  }

  /** The teams with current (not kicked) members only (public, §3: team membership is public). */
  publicTeams(): TeamDTO[] | null {
    const teams = this.m.teams;
    if (!teams) return null;
    return teams.map((t) => ({ ...t, members: t.members.filter((id) => this.current(id)) }));
  }

  /** The player's team (draft or match), if any. */
  teamOf(playerId: string): TeamDTO | undefined {
    return this.m.teams?.find((t) => t.members.includes(playerId));
  }

  teamIdOf(playerId: string): number | undefined {
    return this.teamOf(playerId)?.teamId;
  }

  /** Joined after Start match in team mode: sits out until New match (§4). */
  isBenched(p: Pick<PlayerRecord, 'id'>): boolean {
    return this.active && this.teamOf(p.id) === undefined;
  }

  /** Current teammates (self excluded), only while a team match runs. */
  teammatesOf(playerId: string): string[] {
    if (!this.active) return [];
    const team = this.teamOf(playerId);
    if (!team) return [];
    return team.members.filter((id) => id !== playerId && this.current(id));
  }

  // -------------------------------------------------------------------------
  // LOBBY draft
  // -------------------------------------------------------------------------

  /** Player count the setup is for: LOBBY all players, in a match the map's. */
  private setupPlayers(): number {
    if (this.m.phase === 'LOBBY') return this.game.players.list().length;
    return this.m.map?.players ?? this.game.players.active().length;
  }

  /**
   * The draft team sizes when `mode` is the draft's mode (a move can make
   * them unequal); undefined means the snake deal for P.
   */
  private draftSizes(mode: TeamMode = this.m.setup.teamMode): number[] | undefined {
    const teams = this.m.teams;
    return teams && mode !== 'ffa' && mode === this.m.setup.teamMode ? teamSizesOf(teams) : undefined;
  }

  /**
   * The stored draft made valid for P players: a team mode that no longer
   * splits P becomes free-for-all, a style that no longer fits (P, mode)
   * becomes null (auto). `notes` says what was reset, for the admin toast.
   */
  private normalised(players: number): { mapStyle: MapStyle | null; teamMode: TeamMode; notes: string[] } {
    const n = Math.min(Math.max(players, MIN_PLAYERS), MAX_PLAYERS);
    const notes: string[] = [];
    let { mapStyle, teamMode } = this.m.setup;
    if (!isValidTeamMode(teamMode, players)) {
      teamMode = 'ffa';
      notes.push('team mode reset to free-for-all');
    }
    if (mapStyle !== null && !isValidMapSetup(mapStyle, teamMode, n, this.draftSizes(teamMode))) {
      mapStyle = null;
      notes.push(`map reset to auto (${MAP_STYLE_INFO[resolveMapStyle(null, n).style].label})`);
    }
    return { mapStyle, teamMode, notes };
  }

  /**
   * Re-deal the draft teams with the snake (LOBBY only, §9.2 Auto-balance):
   * after a join, kick or delete, a draft mode change, and New match. Swaps
   * are dropped. Draft values the new roster makes invalid are reset first.
   * `quiet` skips the admin toast.
   */
  rebalance(quiet = false): void {
    if (this.m.phase !== 'LOBBY') return;
    const ids = this.game.players.list().map((p) => p.id);
    const fixed = this.normalised(ids.length);
    this.m.setup = { mapStyle: fixed.mapStyle, teamMode: fixed.teamMode, ...switchesOf(this.revealNames, this.wallsAllowed) };
    const mode = fixed.teamMode;
    const before = JSON.stringify(this.m.teams);
    this.m.teams = mode !== 'ffa' && isValidTeamMode(mode, ids.length) ? autoBalance(ids, mode) : null;
    if (quiet) return;
    if (fixed.notes.length > 0) {
      const text = `${fixed.notes.join(' and ')} for ${ids.length} player${ids.length === 1 ? '' : 's'}`;
      this.game.notifier.toast({ admin: true }, 'info', text[0]!.toUpperCase() + text.slice(1));
    } else if (before !== 'null' && this.m.teams !== null && before !== JSON.stringify(this.m.teams)) {
      this.game.notifier.toast({ admin: true }, 'info', 'Teams re-balanced');
    }
  }

  /**
   * Check a requested style / team mode against P (§10.3 BAD_MAP_STYLE /
   * BAD_TEAM_MODE). Only the fields the request sends are checked: an omitted
   * field uses the stored draft value, reset (as in `normalised`) when it no
   * longer fits P, so a stale draft never blocks a request.
   */
  private check(
    mapStyleIn: unknown,
    teamModeIn: unknown,
    players: number,
  ): Result<{ mapStyle: MapStyle | null; teamMode: TeamMode }> {
    const n = Math.min(Math.max(players, MIN_PLAYERS), MAX_PLAYERS);
    const stored = this.normalised(players);
    let teamMode = stored.teamMode;
    if (teamModeIn !== undefined && teamModeIn !== null) {
      if (!isTeamMode(teamModeIn)) {
        return fail('BAD_TEAM_MODE', `Unknown team mode ${JSON.stringify(teamModeIn)}.`, {
          hint: `Pick one of: ${validTeamModes(n).join(', ')}.`,
          details: { players: n, valid: validTeamModes(n) },
        });
      }
      if (!isValidTeamMode(teamModeIn, players)) {
        return fail(
          'BAD_TEAM_MODE',
          `${teamModeIn} doesn't work for ${players} players: every team needs at least 1 player.`,
          { hint: `Pick one of: ${validTeamModes(players).join(', ')}.`, details: { players, valid: validTeamModes(players) } },
        );
      }
      teamMode = teamModeIn;
    }
    if (mapStyleIn === undefined) {
      // The stored style, or auto when it doesn't suit the (possibly new) team mode.
      const mapStyle = stored.mapStyle !== null && isValidMapSetup(stored.mapStyle, teamMode, n, this.draftSizes(teamMode)) ? stored.mapStyle : null;
      return ok({ mapStyle, teamMode });
    }
    const sizes = this.draftSizes(teamMode);
    if (mapStyleIn !== null && (!isMapStyle(mapStyleIn) || !isValidMapSetup(mapStyleIn, teamMode, n, sizes))) {
      const valid = validMapStyles(n, teamMode, sizes);
      const forWhat = isMapStyle(mapStyleIn) && isValidMapSetup(mapStyleIn, 'ffa', n) ? `${n} players in ${teamModeLabel(teamMode, n, sizes)}` : `${n} players`;
      return fail('BAD_MAP_STYLE', `Map style ${JSON.stringify(mapStyleIn)} doesn't work for ${forWhat}.`, {
        hint: `Pick one of: ${valid.join(', ')} (or null for the default).`,
        details: { players: n, teamMode, valid },
      });
    }
    return ok({ mapStyle: mapStyleIn, teamMode });
  }

  /** PUT /admin/match/setup (LOBBY only): store the draft and re-balance its teams. */
  setDraft(body: { mapStyle?: unknown; teamMode?: unknown; revealNames?: unknown; wallsAllowed?: unknown }): Result<MatchSetupDTO> {
    if (this.m.phase !== 'LOBBY') {
      return fail('PHASE_CLOSED', 'The match setup can only change in the lobby.', { details: { phase: this.m.phase, opensIn: 'LOBBY' } });
    }
    const reveal = checkSwitch('revealNames', body.revealNames);
    if (!reveal.ok) return reveal;
    const walls = checkSwitch('wallsAllowed', body.wallsAllowed);
    if (!walls.ok) return walls;
    const checked = this.check(body.mapStyle, body.teamMode, this.game.players.list().length);
    if (!checked.ok) return checked;
    const before = this.m.setup;
    const modeChanged = checked.data.teamMode !== before.teamMode;
    if (body.mapStyle === undefined && before.mapStyle !== null && checked.data.mapStyle === null) {
      const n = Math.min(Math.max(this.game.players.list().length, MIN_PLAYERS), MAX_PLAYERS);
      const auto = MAP_STYLE_INFO[resolveMapStyle(null, n).style].label;
      this.game.notifier.toast(
        { admin: true },
        'info',
        `Map reset to auto (${auto}): ${MAP_STYLE_INFO[before.mapStyle].label} doesn't suit ${teamModeLabel(checked.data.teamMode, n, this.draftSizes(checked.data.teamMode))}`,
      );
    }
    this.m.setup = { ...checked.data, ...switchesOf(reveal.data ?? before.revealNames === true, walls.data ?? before.wallsAllowed !== false) };
    if (modeChanged || this.m.teams === null) this.rebalance(true);
    this.changed();
    return ok(this.setupDTO());
  }

  /** POST /admin/teams/swap (LOBBY, team-mode draft only). */
  swap(a: unknown, b: unknown): Result<{ teams: TeamDTO[] }> {
    if (this.m.phase !== 'LOBBY') {
      return fail('PHASE_CLOSED', 'Teams are fixed once the match has started.', { details: { phase: this.m.phase, opensIn: 'LOBBY' } });
    }
    if (typeof a !== 'string' || typeof b !== 'string') return fail('BAD_REQUEST', 'Send {playerA, playerB} (player ids).');
    const r = swapTeamPlayers(this.m.teams, a, b);
    if (!r.ok) {
      const text = {
        NO_TEAMS: 'There are no teams: pick a team mode first.',
        NOT_FOUND: 'Both players must be on a team.',
        SAME_TEAM: 'Those two players are already on the same team.',
      }[r.code];
      return fail(r.code, text);
    }
    this.m.teams = r.teams;
    this.changed();
    return ok({ teams: this.publicTeams()! });
  }

  /**
   * POST /admin/teams/move {playerId, teamId} (LOBBY, team-mode draft only):
   * move a player to another team, so the host can make any split (e.g.
   * 4v2). Every team keeps ≥ 1 player (LAST_MEMBER). Kept until the roster or
   * the mode changes, like swaps. A draft Lanes / Islands map that no longer
   * suits the (now unequal) teams is reset to auto with a toast.
   */
  move(playerId: unknown, teamId: unknown): Result<{ teams: TeamDTO[] }> {
    if (this.m.phase !== 'LOBBY') {
      return fail('PHASE_CLOSED', 'Teams are fixed once the match has started.', { details: { phase: this.m.phase, opensIn: 'LOBBY' } });
    }
    if (typeof playerId !== 'string' || typeof teamId !== 'number' || !Number.isInteger(teamId)) {
      return fail('BAD_REQUEST', 'Send {playerId, teamId} (a player id and a team number from 0).');
    }
    const r = moveTeamPlayer(this.m.teams, playerId, teamId);
    if (!r.ok) {
      const text = {
        NO_TEAMS: 'There are no teams: pick a team mode first.',
        NOT_FOUND: 'That player is not on a team.',
        BAD_TEAM: `There is no team ${teamId + 1}.`,
        SAME_TEAM: 'That player is already on that team.',
        LAST_MEMBER: 'That player is the last one on their team: every team needs at least 1 player.',
      }[r.code];
      return fail(r.code === 'BAD_TEAM' ? 'BAD_REQUEST' : r.code, text);
    }
    this.m.teams = r.teams;
    const style = this.m.setup.mapStyle;
    const n = Math.min(Math.max(this.game.players.list().length, MIN_PLAYERS), MAX_PLAYERS);
    if (style !== null && !isValidMapSetup(style, this.m.setup.teamMode, n, teamSizesOf(r.teams))) {
      this.m.setup = { ...this.m.setup, mapStyle: null };
      const auto = MAP_STYLE_INFO[resolveMapStyle(null, n).style].label;
      this.game.notifier.toast({ admin: true }, 'info', `Map changed to ${auto}: ${MAP_STYLE_INFO[style].label} needs equal teams`);
    }
    this.changed();
    return ok({ teams: this.publicTeams()! });
  }

  /**
   * Start match (§10.3): check `mapStyle` (undefined = the draft's, or the
   * default when the draft's no longer fits; null = default) and `teamMode`
   * (undefined = the draft's, free-for-all when it no longer fits) against
   * the players now. Team mode uses the draft teams (with swaps) when the draft matches,
   * otherwise it auto-balances. Nothing is stored here.
   */
  resolveStart(mapStyleIn: unknown, teamModeIn: unknown, revealNamesIn?: unknown, wallsAllowedIn?: unknown): Result<ResolvedSetup> {
    const ids = this.game.players.list().map((p) => p.id);
    const reveal = checkSwitch('revealNames', revealNamesIn);
    if (!reveal.ok) return reveal;
    const walls = checkSwitch('wallsAllowed', wallsAllowedIn);
    if (!walls.ok) return walls;
    const checked = this.check(mapStyleIn, teamModeIn, ids.length);
    if (!checked.ok) return checked;
    const { mapStyle, teamMode } = checked.data;
    let teams: TeamDTO[] | null = null;
    if (teamMode !== 'ffa') {
      const draft = this.m.teams;
      const sameRoster = draft !== null && draft.flatMap((t) => t.members).sort().join() === [...ids].sort().join();
      teams = this.m.setup.teamMode === teamMode && sameRoster ? draft!.map((t) => ({ ...t, members: [...t.members] })) : autoBalance(ids, teamMode);
    }
    const revealNames = reveal.data ?? this.revealNames;
    const wallsAllowed = walls.data ?? this.wallsAllowed;
    const style = resolveMapStyle(mapStyle, ids.length, teamMode, teams ? teamSizesOf(teams) : undefined).style;
    return ok({ mapStyle, style, teamMode, teams, players: ids.length, revealNames, wallsAllowed });
  }

  /** Fix the resolved setup for the match (team mode: map and teams; free-for-all: per PLACEMENT). */
  applyStart(s: ResolvedSetup): void {
    this.m.setup = { mapStyle: s.mapStyle, teamMode: s.teamMode, ...switchesOf(s.revealNames, s.wallsAllowed) };
    this.m.teams = s.teams;
    this.m.map = s.teams ? { style: s.style, players: s.players } : null;
    this.m.zones = {};
  }

  // -------------------------------------------------------------------------
  // Maps
  // -------------------------------------------------------------------------

  /**
   * The map to show now: the round's map once zones were dealt (or the fixed
   * team-mode map), else a preview for the current player count.
   */
  currentLayout(): MapLayout | null {
    const m = this.m;
    if (m.map) return mapFor(m.map.style, m.map.players);
    const P = m.phase === 'LOBBY' ? this.game.players.list().length : this.game.players.active().length;
    if (P < 1) return null;
    const n = Math.min(P, MAX_PLAYERS);
    return mapFor(resolveMapStyle(m.setup.mapStyle, n, m.phase === 'LOBBY' ? m.setup.teamMode : 'ffa', m.phase === 'LOBBY' ? this.draftSizes() : undefined).style, n);
  }

  /** The preview map for the setup DTO (at least the 2-player map). */
  private previewMap(): MapDTO {
    const cur = this.m.map;
    if (cur) return mapDTO(mapFor(cur.style, cur.players));
    const n = Math.min(Math.max(this.setupPlayers(), MIN_PLAYERS), MAX_PLAYERS);
    return mapDTO(mapFor(resolveMapStyle(this.m.setup.mapStyle, n, this.m.setup.teamMode, this.draftSizes()).style, n));
  }

  setupDTO(): MatchSetupDTO {
    const n = Math.min(Math.max(this.setupPlayers(), MIN_PLAYERS), MAX_PLAYERS);
    return {
      mapStyle: this.m.setup.mapStyle,
      teamMode: this.m.setup.teamMode,
      revealNames: this.revealNames,
      wallsAllowed: this.wallsAllowed,
      map: this.previewMap(),
      teams: this.publicTeams(),
      validStyles: validMapStyles(n, this.m.setup.teamMode, this.draftSizes()),
      validTeamModes: validTeamModes(n),
    };
  }

  /** `/state` `match` block (§10.3). The map has no zone owners. */
  matchInfo(exclude?: ReadonlySet<string>): MatchInfoDTO {
    const layout = this.currentLayout();
    return {
      mapStyle: layout?.style ?? resolveMapStyle(this.m.setup.mapStyle, MIN_PLAYERS).style,
      teamMode: this.m.setup.teamMode,
      revealNames: this.revealNames,
      wallsAllowed: this.wallsAllowed,
      map: layout ? mapDTO(layout) : null,
      teams: this.publicTeams(),
      teamTable: this.active ? this.teamTable(exclude) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  /**
   * Team table (§9.2): the average of the current members' match totals, then
   * the sum of the team's place points over the released rounds, then a
   * shared place. `exclude` leaves out members leaving with this battle.
   */
  teamTable(exclude?: ReadonlySet<string>): TeamTableRowDTO[] | null {
    const teams = this.publicTeams();
    if (!teams) return null;
    const m = this.m;
    return teamTable(
      teams.map((team) => {
        const members = team.members.filter((id) => !exclude?.has(id));
        return {
          team: { ...team, members },
          memberPoints: members.map((id) => m.points[id] ?? 0),
          placePoints: m.results.reduce((sum, r) => sum + (r.end.teams?.find((t) => t.teamId === team.teamId)?.placePoints ?? 0), 0),
        };
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Team privacy (§9.2)
  // -------------------------------------------------------------------------

  /**
   * A selected type as a teammate sees it: name, type, stats, size, cost,
   * breakdown and sprite. Never source, version history, warnings or errors.
   */
  private teammateCard(ownerId: string, unitId: string): UnitCardDTO | null {
    const g = this.game;
    const rs = g.round.stateOf(ownerId);
    const lockedVersion = rs.locked?.find((l) => l.unitId === unitId)?.version;
    let card: UnitCardDTO;
    if (unitId.startsWith('armory:')) {
      const e = g.armory.forUnitId(unitId);
      if (!e) return null;
      const name = ArmoryService.displayName(e);
      card = {
        unitId,
        name,
        version: 0,
        stats: e.stats,
        group: groupOf(e.stats.type),
        cost: e.cost,
        breakdown: e.breakdown,
        status: e.status,
        warnings: [],
        isTemplate: false,
        ...g.armory.spriteOf(e),
        selected: true,
        updatedAt: 0,
      };
    } else {
      const d = g.units.design(ownerId, unitId);
      if (!d) return null;
      const v = (lockedVersion !== undefined ? g.units.versionOf(ownerId, unitId, lockedVersion) : undefined) ?? UnitsService.latestValid(d);
      if (!v) return null;
      card = {
        unitId,
        name: v.stats.name,
        version: 0,
        stats: v.stats,
        group: groupOf(v.stats.type),
        cost: v.cost,
        breakdown: v.breakdown,
        status: v.status,
        warnings: [],
        isTemplate: d.isTemplate,
        sprite: d.spriteHidden ? null : v.sprite,
        spriteHidden: d.spriteHidden,
        selected: true,
        updatedAt: 0,
      };
    }
    return card;
  }

  /** The `private.team` block of a member (team match only; null otherwise). */
  privateTeam(playerId: string): TeamPrivateDTO | null {
    if (!this.active) return null;
    const team = this.teamOf(playerId);
    if (!team) return null;
    const g = this.game;
    const phase = this.m.phase;
    const showRound = phase === 'PLACEMENT' || phase === 'BATTLE' || phase === 'RESULTS';
    const members: TeamMemberPrivateDTO[] = [];
    for (const id of team.members) {
      const p = g.players.get(id);
      if (!p) continue;
      const rs = g.round.stateOf(id);
      const zone = showRound ? this.m.zones[id] : undefined;
      members.push({
        playerId: id,
        name: p.name,
        seat: p.seat,
        ready: phase === 'PLAN' || phase === 'PLACEMENT' ? rs.ready : false,
        zone: zone ? mapZoneDTO(zone) : null,
        selection: rs.selection.map((u) => this.teammateCard(id, u)).filter((c): c is UnitCardDTO => c !== null),
        placement: showRound ? rs.placements.map((x) => ({ ...x })) : [],
        spent: showRound ? g.round.spent(id) : 0,
      });
    }
    return { teamId: team.teamId, name: team.name, color: team.color, members };
  }

  private changed(): void {
    this.game.store.save();
    this.game.notifier.stateChanged();
  }
}
