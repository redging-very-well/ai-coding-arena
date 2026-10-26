// Public REST routes (no auth): health, rules, contract, state, create/login,
// replays.

import { Router } from 'express';
import QRCode from 'qrcode';
import { SESSION_COOKIE, ok, type HealthDTO, type JoinInfoDTO, type LoginResponse, type Result } from '@pixel-clash/shared';
import type { Game } from '../services/game.js';
import { buildGuide } from '../services/guide.js';
import { buildContract, buildRules } from '../services/rules.js';
import { lanUrls } from '../util/lan.js';
import { safeHost } from '../services/kit.js';
import { COOKIE_OPTS, body, cookieOf, optionalPlayer, roundParam, send, sendError, wrap } from './common.js';

export const SERVER_VERSION = '0.1.0';

export function publicRoutes(game: Game): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    const h: HealthDTO = { ok: true, version: SERVER_VERSION, phase: game.store.match.phase };
    res.json(h);
  });

  // Join URL + QR for the projector. The page's own Host when it was
  // opened by a LAN address, else this machine's first LAN address.
  r.get(
    '/join',
    wrap(async (req, res) => {
      const host = safeHost(req.headers.host);
      const urls = lanUrls(game.visibility.port);
      const local = /^(localhost|127\.|\[::1\]|::1)/i.test(host);
      const base = local && urls[0] ? urls[0] : `http://${host}`;
      const joinUrl = `${base}/play`;
      const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      const info: JoinInfoDTO = { joinUrl, lanUrls: urls, qrSvg };
      res.json(info);
    }),
  );

  r.get('/rules', (_req, res) => {
    res.json(buildRules(game.config, game.armory.enabled, game.teams.matchInfo()));
  });

  r.get('/contract', (_req, res) => {
    res.json(buildContract(game.config));
  });

  // The unit guide: the full rulebook for units from the live config. Public: nothing secret in it.
  r.get('/guide', (_req, res) => {
    res.json(buildGuide(game.config, game.units.guideTemplates()));
  });

  r.get('/state', (req, res) => {
    const p = optionalPlayer(game, req);
    res.json(game.visibility.gameState(p ? { role: 'player', playerId: p.id } : { role: 'screen' }));
  });

  r.post(
    '/players',
    wrap(async (req, res) => {
      const b = body(req);
      const result = await game.players.create(b.name, b.pin);
      if (result.ok) {
        res.cookie(SESSION_COOKIE, game.auth.createSession(result.data.player.id), COOKIE_OPTS);
        return send(res, withAutoSeat(game, result.data, b));
      }
      send(res, result);
    }),
  );

  r.post(
    '/login',
    wrap(async (req, res) => {
      const b = body(req);
      const result = await game.players.login(b.name, b.pin);
      if (result.ok) {
        res.cookie(SESSION_COOKIE, game.auth.createSession(result.data.player.id), COOKIE_OPTS);
        return send(res, withAutoSeat(game, result.data, b));
      }
      send(res, result);
    }),
  );

  // The AI session host's agent-loop: the seat's player token -> that
  // player's login, so the AI helper starts logged in. Basic auth with the
  // seat password; never reachable with a player's or admin's cookie alone.
  // With `agent`, also the shared agent login from /admin.
  r.post('/seat-login', (req, res) => {
    const b = body(req);
    res.setHeader('Cache-Control', 'no-store');
    send(res, game.claudeSeats.seatLogin(req.headers.authorization, b.seat, b.token, req.ip ?? req.socket.remoteAddress ?? '?', b.agent));
  });

  r.post('/logout', (req, res) => {
    game.auth.endSession(cookieOf(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
    res.json({ ok: true });
  });

  r.get(
    '/setup',
    wrap(async (req, res) => {
      res.json(await game.setup.info(req.headers.host));
    }),
  );

  // The public result of a released round (ranking, points breakdown, badges,
  // top damage units). Past rounds stay readable for the whole match
  // (Past battles); never a battle that is still playing.
  r.get('/battles/:round/results', (req, res) => {
    const round = roundParam(req.params.round);
    if (round === undefined || Number.isNaN(round)) {
      return sendError(res, { code: 'BAD_REQUEST', message: 'round must be a positive whole number.' });
    }
    const end = game.battle.results(round);
    if (!end) return sendError(res, { code: 'NOT_FOUND', message: `There are no results for round ${round} yet.` });
    if ('stillPlaying' in end) {
      return sendError(res, {
        code: 'PHASE_CLOSED',
        message: `The battle for round ${round} is still playing.`,
        details: { phase: 'BATTLE', opensIn: 'RESULTS' },
      });
    }
    res.json(end);
  });

  r.get('/battles/:round/replay', (req, res) => {
    const round = roundParam(req.params.round);
    if (round === undefined || Number.isNaN(round)) {
      return sendError(res, { code: 'BAD_REQUEST', message: 'round must be a positive whole number.' });
    }
    const replay = game.battle.replay(round);
    if (!replay) return sendError(res, { code: 'NOT_FOUND', message: `There is no replay for round ${round}.` });
    if ('stillPlaying' in replay) {
      return sendError(res, {
        code: 'PHASE_CLOSED',
        message: `The battle for round ${round} is still playing.`,
        details: { phase: 'BATTLE', opensIn: 'RESULTS' },
      });
    }
    res.json(replay);
  });

  return r;
}

/**
 * /play's join and login ask for an AI seat with `claudeSeat: 'auto' | 1-8`
 * (this laptop's seat, preferred): assign one right away. Other
 * callers (scripts, bots, older pages) send nothing and get no seat.
 */
function withAutoSeat(game: Game, data: LoginResponse, b: Record<string, unknown>): Result<LoginResponse> {
  if (!('claudeSeat' in b)) return ok(data);
  const player = game.players.get(data.player.id);
  if (!player) return ok(data);
  return ok({ ...data, claudeSeat: game.claudeSeats.autoAssign(player, b.claudeSeat) });
}
