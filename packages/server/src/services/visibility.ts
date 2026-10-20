// Per-recipient projections (plan §3 privacy). EVERY response and WS message
// that carries game data is built here. Before START nobody but the owner
// (and the facilitator's overview) sees a player's units, selection,
// placement or zone; after START the reveal carries only the fielded types.
// The ranking, points of the current battle and reports are only visible once
// the battle service released them (playback reached the final frame).

import {
  emptyBadgeCounts,
  type AdminOverviewDTO,
  type BattleEndDTO,
  type GameStateDTO,
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
      ready: phase === 'PLACEMENT' ? (rs?.ready ?? false) : false,
      points: g.store.match.points[p.id] ?? 0,
      active: g.players.isActive(p),
    };
    if (g.store.match.pendingKicks.includes(p.id)) dto.leaving = true;
    return dto;
  }

  /**
   * Match standings (§9): total points, then total match damage, then a shared
   * place. `exclude` drops players before ranking (kicked during a battle), so
   * the places of the rest have no gaps.
   */
  scoreboard(exclude?: ReadonlySet<string>): ScoreboardEntryDTO[] {
    const m = this.game.store.match;
    return matchStandings(
      this.game.players.list().filter((p) => !exclude?.has(p.id)).map((p) => ({
        playerId: p.id,
        name: p.name,
        seat: p.seat,
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

  me(playerId: string): MyStateDTO | undefined {
    const g = this.game;
    const p = g.players.get(playerId);
    if (!p) return undefined;
    const rs = g.round.stateOf(playerId);
    const phase = g.store.match.phase;
    const showRound = phase === 'PLACEMENT' || phase === 'BATTLE' || phase === 'RESULTS';
    return {
      playerId,
      budget: g.config.caps.budget,
      spent: showRound ? g.round.spent(playerId) : 0,
      selection: rs.selection.slice(),
      placement: showRound ? rs.placements.slice() : [],
      myZone: showRound ? g.round.zoneOf(playerId) : null,
      ready: phase === 'PLACEMENT' ? rs.ready : false,
      submissionsOpen: g.match.submissionsOpen(),
      active: g.players.isActive(p),
      hasLastLayout: (rs.lastLayout?.length ?? 0) > 0,
    };
  }

  gameState(viewer: Viewer): GameStateDTO {
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
    };
    if (m.phase === 'BATTLE') {
      const pb = g.battle.playback();
      if (pb) state.battle = pb;
    }
    const last = this.lastBattle();
    if (last) state.lastBattle = last;
    if (viewer.role === 'player') {
      const me = this.me(viewer.playerId);
      if (me) state.me = me;
    }
    return state;
  }

  privateState(playerId: string): PrivateStateDTO | undefined {
    const g = this.game;
    const p = g.players.get(playerId);
    if (!p) return undefined;
    const me = this.me(playerId)!;
    return {
      player: toPlayerDTO(p),
      roster: g.units.list(playerId),
      selection: me.selection,
      placement: me.placement,
      lastLayout: g.round.stateOf(playerId).lastLayout,
      zone: me.myZone,
      budget: me.budget,
      spent: me.spent,
      ready: me.ready,
      active: me.active,
      armoryEnabled: g.armory.enabled,
      armory: g.armory.list(playerId),
    };
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
          zone: m.zones[p.id] ?? null,
          designs: units.filter((u) => !u.isTemplate).length,
          strikes: last?.reports[p.id]?.strikes ?? 0,
          activeFromRound: p.activeFromRound,
          apiKey: p.apiKey,
          selection: rs.selection.slice(),
          placement: rs.placements.slice(),
          units,
        };
      }),
      lanUrls: lanUrls(this.port),
      sandboxMode: g.config.sandbox.mode,
      armory: g.armory.adminList(),
    };
  }
}
