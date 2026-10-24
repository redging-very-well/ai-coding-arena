// Per-recipient projections (plan §3 privacy). EVERY response and WS message
// that carries game data is built here. Before START nobody but the owner
// (and the facilitator's overview) sees a player's units, selection,
// placement or zone; after START the reveal carries only the fielded types.
// Team mode (§9.2) adds one relation: while a team match runs, teammates see
// each other's selected types (cards, never source), zones and placements
// live (`me.team` / `private.team`, built by TeamsService.privateTeam).
// The ranking, points of the current battle and reports are only visible once
// the battle service released them (playback reached the final frame).

import {
  emptyBadgeCounts,
  legacyCornerOf,
  mapZoneDTO,
  type AdminOverviewDTO,
  type BattleEndDTO,
  type GameStateDTO,
  type MatchAwardDTO,
  type MyStateDTO,
  type PlayerStatusDTO,
  type PrivateStateDTO,
  type ScoreboardEntryDTO,
} from '@pixel-clash/shared';
import { matchStandings } from '../sim/scoring.js';
import { lanUrls } from '../util/lan.js';
import type { Game } from './game.js';
import { toPlayerDTO } from './players.js';
import type { PlayerRecord } from './store.js';

export type Viewer = { role: 'player'; playerId: string } | { role: 'screen' } | { role: 'admin' };

export class VisibilityService {
  /** Server port, for the admin overview's LAN URLs (set by the HTTP layer). */
  port = 0;

  constructor(private readonly game: Game) {}

  private status(p: PlayerRecord): PlayerStatusDTO {
    const g = this.game;
    const rs = g.store.match.perPlayer[p.id];
    const phase = g.store.match.phase;
    const dto: PlayerStatusDTO = {
      ...toPlayerDTO(p),
      connected: g.notifier.isConnected(p.id),
      submitted: rs?.submittedThisPlan ?? false,
      selected: (rs?.selection.length ?? 0) > 0,
      ready: phase === 'PLAN' || phase === 'PLACEMENT' ? (rs?.ready ?? false) : false,
      points: g.store.match.points[p.id] ?? 0,
      active: g.players.isActive(p),
    };
    if (g.store.match.pendingKicks.includes(p.id)) dto.leaving = true;
    // Team membership is public (§3); in LOBBY it is the draft.
    const teamId = g.teams.teamIdOf(p.id);
    if (teamId !== undefined) dto.teamId = teamId;
    if (g.teams.isBenched(p)) dto.benched = true;
    return dto;
  }

  /**
   * Match standings (§9): total points, then total match damage, then a shared
   * place. `exclude` drops players before ranking (kicked during a battle), so
   * the places of the rest have no gaps.
   */
  scoreboard(exclude?: ReadonlySet<string>): ScoreboardEntryDTO[] {
    const m = this.game.store.match;
    const teams = this.game.teams;
    return matchStandings(
      this.game.players.list().filter((p) => !exclude?.has(p.id)).map((p) => ({
        playerId: p.id,
        name: p.name,
        seat: p.seat,
        ...(teams.active && teams.teamIdOf(p.id) !== undefined ? { teamId: teams.teamIdOf(p.id)! } : {}),
        points: m.points[p.id] ?? 0,
        damage: m.damage[p.id] ?? 0,
        badges: { ...emptyBadgeCounts(), ...m.badges[p.id] },
      })),
    );
  }

  /** The released result of the last battle, in RESULTS / MATCH_RESULTS only. */
  private lastBattle(): BattleEndDTO | undefined {
    const m = this.game.store.match;
    if (m.phase !== 'RESULTS' && m.phase !== 'MATCH_RESULTS') return undefined;
    return m.results[m.results.length - 1]?.end;
  }

  /**
   * The match awards (§9 Match awards), MATCH_RESULTS only (undefined in any
   * other phase). A winner kicked since is left out (an award left without
   * winners goes).
   */
  matchAwards(): MatchAwardDTO[] | undefined {
    const m = this.game.store.match;
    if (m.phase !== 'MATCH_RESULTS' || !m.awards) return undefined;
    const here = (id: string) => this.game.players.get(id) !== undefined;
    return m.awards.map((a) => ({ ...a, winners: a.winners.filter((w) => here(w.playerId)) })).filter((a) => a.winners.length > 0);
  }

  /**
   * The owner-only `me` block. `team` (teammates' live selection, zones and
   * placements, §9.2 Team privacy) is included unless `withTeam` is false: the
   * WS `state` push leaves it out (it travels in `private`, debounced).
   */
  me(playerId: string, withTeam = true): MyStateDTO | undefined {
    const g = this.game;
    const p = g.players.get(playerId);
    if (!p) return undefined;
    const rs = g.round.stateOf(playerId);
    const phase = g.store.match.phase;
    const showRound = phase === 'PLACEMENT' || phase === 'BATTLE' || phase === 'RESULTS';
    const zone = showRound ? g.round.zoneOf(playerId) : null;
    const me: MyStateDTO = {
      playerId,
      budget: g.config.caps.budget,
      spent: showRound ? g.round.spent(playerId) : 0,
      selection: rs.selection.slice(),
      placement: showRound ? rs.placements.slice() : [],
      myZone: zone ? mapZoneDTO(zone) : null,
      ready: phase === 'PLAN' || phase === 'PLACEMENT' ? rs.ready : false,
      submissionsOpen: g.match.submissionsOpen(),
      active: g.players.isActive(p),
      hasLastLayout: (rs.lastLayout?.length ?? 0) > 0,
      copyCaps: { fighters: g.config.caps.maxCopies, factories: g.config.caps.maxFactoryCopies, walls: g.config.caps.maxWallCopies },
    };
    const teamId = g.teams.active ? g.teams.teamIdOf(playerId) : undefined;
    if (teamId !== undefined) me.teamId = teamId;
    if (g.teams.isBenched(p)) me.benched = true;
    if (withTeam && g.teams.active) me.team = g.teams.privateTeam(playerId);
    const awards = this.matchAwards();
    if (awards) me.awards = awards.filter((a) => a.winners.some((w) => w.playerId === playerId)).map((a) => a.id);
    return me;
  }

  gameState(viewer: Viewer, opts: { withTeam?: boolean } = {}): GameStateDTO {
    const g = this.game;
    const m = g.store.match;
    const state: GameStateDTO = {
      phase: m.phase,
      round: m.round,
      rounds: m.rounds,
      timer: g.match.timerDTO(),
      players: g.players.list().map((p) => this.status(p)),
      scoreboard: this.scoreboard(),
      sandboxMode: g.config.sandbox.mode,
      armory: g.armory.info(),
      match: g.teams.matchInfo(),
      allReady: g.round.everyoneReady(),
    };
    const pending = g.match.pendingAdvanceDTO();
    if (pending) state.pendingAdvance = pending;
    if (m.phase === 'BATTLE') {
      const pb = g.battle.playback();
      if (pb) state.battle = pb;
    }
    const last = this.lastBattle();
    if (last) state.lastBattle = last;
    const awards = this.matchAwards();
    if (awards) state.matchAwards = awards;
    if (viewer.role === 'player') {
      const me = this.me(viewer.playerId, opts.withTeam !== false);
      if (me) state.me = me;
    }
    return state;
  }

  privateState(playerId: string): PrivateStateDTO | undefined {
    const g = this.game;
    const p = g.players.get(playerId);
    if (!p) return undefined;
    const me = this.me(playerId)!;
    const phase = g.store.match.phase;
    const zone = phase === 'PLACEMENT' || phase === 'BATTLE' || phase === 'RESULTS' ? g.round.zoneOf(playerId) : null;
    const out: PrivateStateDTO = {
      player: toPlayerDTO(p),
      roster: g.units.list(playerId),
      selection: me.selection,
      placement: me.placement,
      lastLayout: g.round.stateOf(playerId).lastLayout,
      zone: zone ? legacyCornerOf(zone) : null,
      mapZone: me.myZone,
      budget: me.budget,
      spent: me.spent,
      ready: me.ready,
      active: me.active,
      armoryEnabled: g.armory.enabled,
      armory: g.armory.list(playerId),
    };
    if (me.teamId !== undefined) out.teamId = me.teamId;
    if (me.benched) out.benched = true;
    if (g.teams.active) out.team = me.team ?? null;
    return out;
  }

  /** Facilitator overview: everything, including sources (§12.3 "show details"). */
  adminOverview(): AdminOverviewDTO {
    const g = this.game;
    const m = g.store.match;
    return {
      state: this.gameState({ role: 'admin' }),
      players: g.players.list().map((p) => {
        const rs = g.round.stateOf(p.id);
        const units = g.units.designs(p.id).map((d) => ({
          ...g.units.card(d),
          // The facilitator sees hidden sprites (to un-hide them).
          sprite: d.versions[d.versions.length - 1]!.sprite,
          source: d.versions[d.versions.length - 1]!.source,
        }));
        const last = m.results[m.results.length - 1];
        return {
          ...this.status(p),
          zone: m.zones[p.id] ? legacyCornerOf(m.zones[p.id]!) : null,
          mapZone: m.zones[p.id] ? mapZoneDTO(m.zones[p.id]!) : null,
          designs: units.filter((u) => !u.isTemplate).length,
          strikes: last?.reports[p.id]?.strikes ?? 0,
          activeFromRound: p.activeFromRound,
          claudeSeat: g.claudeSeats.seatOf(p),
          apiKey: p.apiKey,
          selection: rs.selection.slice(),
          placement: rs.placements.slice(),
          units,
        };
      }),
      lanUrls: lanUrls(this.port),
      sandboxMode: g.config.sandbox.mode,
      setup: g.teams.setupDTO(),
      armory: g.armory.adminList(),
      // M8.8 (§6 migration): old economy overrides dropped at boot (the banner).
      economyReset: g.store.economyReset.slice(),
    };
  }
}
