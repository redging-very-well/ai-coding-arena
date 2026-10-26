// Players: create, login, seats, kick, PIN reset, key rotation.

import { randomBytes } from 'node:crypto';
import { fail, ok, type LoginResponse, type PlayerDTO, type Result } from '@pixel-clash/shared';
import { RateLimiter } from '../util/ratelimit.js';
import { hashPin, newApiKey, verifyPin } from './auth.js';
import type { Game } from './game.js';
import { newRoundState, type PlayerRecord } from './store.js';

/** The most seats any config allows (seats 0-7). The live limit is `config.match.maxPlayers`. */
export const MAX_SEATS = 8;
export const NAME_RE = /^[A-Za-z0-9 _-]{1,16}$/;
export const PIN_RE = /^\d{4}$/;

export function toPlayerDTO(p: PlayerRecord): PlayerDTO {
  return { id: p.id, name: p.name, seat: p.seat };
}

function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(n) ? n : null;
}

export class PlayersService {
  private readonly loginLimiter = new RateLimiter(5, 60_000);

  constructor(private readonly game: Game) {}

  /** Non-kicked players in join order. */
  list(): PlayerRecord[] {
    return [...this.game.store.players.values()].filter((p) => !p.kicked).sort((a, b) => a.joinSeq - b.joinSeq);
  }

  get(id: string): PlayerRecord | undefined {
    const p = this.game.store.players.get(id);
    return p && !p.kicked ? p : undefined;
  }

  /**
   * Takes part in the current round (or, in LOBBY, in the next match). In a
   * team match a player who is on no team (joined after Start) is benched.
   */
  isActive(p: PlayerRecord): boolean {
    const m = this.game.store.match;
    if (p.kicked) return false;
    if (m.phase === 'LOBBY') return true;
    if (this.game.teams.isBenched(p)) return false;
    return p.activeFromRound <= m.round;
  }

  /** Active players in join order. */
  active(): PlayerRecord[] {
    return this.list().filter((p) => this.isActive(p));
  }

  async create(nameIn: unknown, pinIn: unknown): Promise<Result<LoginResponse>> {
    const name = cleanName(nameIn);
    if (!name) {
      return fail('BAD_NAME_FORMAT', 'The name must be 1-16 letters, digits, spaces, - or _.', {
        hint: 'Pick a short name like "Zoe" or "Ninja_7".',
      });
    }
    if (typeof pinIn !== 'string' || !PIN_RE.test(pinIn)) {
      return fail('BAD_PIN_FORMAT', 'The PIN must be exactly 4 digits.', { hint: 'For example 4821.' });
    }
    // Hash first: everything after this point is synchronous, so players joining
    // at the same moment can't be given the same seat or name.
    const pinHash = await hashPin(pinIn);
    const store = this.game.store;
    const nameKey = name.toLowerCase();
    const existing = [...store.players.values()].find((p) => p.nameKey === nameKey);
    if (existing && !existing.kicked) {
      return fail('NAME_TAKEN', `The name "${name}" is already taken.`, {
        hint: 'If this is you, use "I\'m back" and log in with your PIN. Otherwise pick another name.',
      });
    }
    const used = new Set(this.list().map((p) => p.seat));
    const seats = Math.min(MAX_SEATS, this.game.config.match.maxPlayers);
    let seat = -1;
    for (let s = 0; s < seats; s++) {
      if (!used.has(s)) {
        seat = s;
        break;
      }
    }
    if (seat < 0) return fail('GAME_FULL', `All ${seats} seats are taken.`, { hint: 'Ask a grown-up to free a seat.' });

    // A kicked player's name can be reused: their old record goes away.
    if (existing) this.purge(existing.id);

    const m = store.match;
    let activeFromRound: number;
    if (m.phase === 'LOBBY') activeFromRound = 1;
    else if (m.phase === 'PLAN') activeFromRound = m.round;
    else activeFromRound = m.round + 1;

    const player: PlayerRecord = {
      id: `p_${randomBytes(5).toString('hex')}`,
      name,
      nameKey,
      pinHash,
      apiKey: newApiKey(),
      seat,
      joinSeq: store.nextJoinSeq(),
      activeFromRound,
      kicked: false,
      createdAt: Date.now(),
      claudeSeat: null,
    };
    store.players.set(player.id, player);
    store.match.perPlayer[player.id] = newRoundState();
    store.match.points[player.id] ??= 0;
    this.game.auth.registerKey(player);
    this.game.units.addTemplates(player.id);
    // LOBBY: the draft teams are re-dealt for the new roster.
    this.game.teams.rebalance();
    store.save();
    if (this.game.teams.isBenched(player)) {
      this.game.notifier.toast({ playerId: player.id }, 'info', "Teams are set for this match. You'll play in the next match!");
    } else if (!this.isActive(player)) {
      this.game.notifier.toast({ playerId: player.id }, 'info', "You're in from the next round!");
    }
    this.game.notifier.stateChanged();
    return ok({ player: toPlayerDTO(player), apiKey: player.apiKey });
  }

  async login(nameIn: unknown, pinIn: unknown): Promise<Result<LoginResponse>> {
    const name = typeof nameIn === 'string' ? nameIn.trim().replace(/\s+/g, ' ') : '';
    const rl = this.game.config.rateLimits;
    this.loginLimiter.configure(rl.loginPerMinute, 60_000);
    const wait = this.loginLimiter.hit(name.toLowerCase() || '?');
    if (wait > 0) {
      return fail('RATE_LIMITED', 'Too many login attempts. Wait a minute and try again.', {
        details: { retryAfterMs: wait },
      });
    }
    const player = this.list().find((p) => p.nameKey === name.toLowerCase());
    const pinOk = player && typeof pinIn === 'string' && PIN_RE.test(pinIn) && (await verifyPin(pinIn, player.pinHash));
    if (!player || !pinOk) {
      return fail('BAD_LOGIN', 'That name and PIN do not match a player.', {
        hint: 'Check the spelling of the name and the 4-digit PIN. New here? Create a player on the Pixel Clash page first.',
      });
    }
    return ok({ player: toPlayerDTO(player), apiKey: player.apiKey });
  }

  /** Admin: set a new PIN. Kills web sessions, keeps the API key. */
  async resetPin(playerId: string, pin: unknown): Promise<Result<{ ok: true }>> {
    const p = this.get(playerId);
    if (!p) return fail('NOT_FOUND', 'No such player.');
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) return fail('BAD_PIN_FORMAT', 'The PIN must be exactly 4 digits.');
    p.pinHash = await hashPin(pin);
    this.game.auth.endSessionsOf(p.id);
    this.game.notifier.playerRevoked(p.id);
    this.loginLimiter.reset(p.nameKey);
    this.game.store.save();
    return ok({ ok: true });
  }

  rotateKey(playerId: string): Result<{ apiKey: string }> {
    const p = this.get(playerId);
    if (!p) return fail('NOT_FOUND', 'No such player.');
    this.game.auth.revokeKey(p.apiKey);
    p.apiKey = newApiKey();
    this.game.auth.registerKey(p);
    this.game.store.save();
    this.game.notifier.privateChanged(p.id);
    return ok({ apiKey: p.apiKey });
  }

  /**
   * Kick: immediate, except during BATTLE where it takes effect when the
   * battle ends (the player's units keep fighting, then the player is removed
   * from the ranking).
   */
  kick(playerId: string, deleteData: boolean): Result<{ ok: true; effective: 'now' | 'after-battle' }> {
    const p = this.get(playerId);
    if (!p) return fail('NOT_FOUND', 'No such player.');
    const m = this.game.store.match;
    if (m.phase === 'BATTLE') {
      if (!m.pendingKicks.includes(p.id)) m.pendingKicks.push(p.id);
      if (deleteData && !m.pendingDeletes?.includes(p.id)) (m.pendingDeletes ??= []).push(p.id);
      this.game.store.save();
      this.game.notifier.stateChanged();
      return ok({ ok: true, effective: 'after-battle' });
    }
    this.kickNow(p.id, deleteData);
    return ok({ ok: true, effective: 'now' });
  }

  /** Apply kicks queued during BATTLE (after the result release, a restart or a new match). */
  applyPendingKicks(): void {
    const m = this.game.store.match;
    const ids = m.pendingKicks;
    const deletes = new Set(m.pendingDeletes ?? []);
    m.pendingKicks = [];
    delete m.pendingDeletes;
    for (const id of ids) this.kickNow(id, deletes.has(id));
    if (ids.length > 0) this.game.store.save();
  }

  private kickNow(playerId: string, deleteData: boolean): void {
    const store = this.game.store;
    const p = store.players.get(playerId);
    if (!p) return;
    this.game.auth.endSessionsOf(p.id);
    this.game.auth.revokeKey(p.apiKey);
    this.game.notifier.playerRevoked(p.id);
    // Kick frees the Claude seat; closes their live terminal.
    this.game.claudeSeats.release(p);
    if (deleteData) {
      this.purge(p.id);
      // Kick + delete: their Open Armory entries go too (a plain kick keeps them).
      this.game.armory.removeCreator(p.id);
    } else {
      p.kicked = true;
      p.seat = -1;
      delete store.match.perPlayer[p.id];
      delete store.match.zones[p.id];
    }
    // LOBBY: re-deal the draft teams. In a team match teams never
    // change: the kicked member's slot stays as a hole.
    this.game.teams.rebalance();
    // Zones depend on the active player count: re-deal them so e.g.
    // the last 2 free-for-all players get the Duel map (team mode: the kicked
    // member's zone stays empty). Placements are zone-local, so they stay valid.
    if (store.match.phase === 'PLACEMENT') {
      this.game.round.assignZones();
      for (const other of this.list()) this.game.notifier.privateChanged(other.id);
    }
    store.save();
    this.game.notifier.stateChanged();
  }

  /** Remove a player and all their data. */
  private purge(playerId: string): void {
    const store = this.game.store;
    store.players.delete(playerId);
    store.designs.delete(playerId);
    delete store.match.perPlayer[playerId];
    delete store.match.zones[playerId];
    delete store.match.points[playerId];
    delete store.match.damage[playerId];
    delete store.match.badges[playerId];
    for (const [t, id] of store.sessions) if (id === playerId) store.sessions.delete(t);
    store.deleteUnitFiles(playerId);
  }
}
