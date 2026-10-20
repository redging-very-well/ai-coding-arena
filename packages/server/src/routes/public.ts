// Public REST routes (no auth): health, rules, contract, state, create/login,
// the generic kit, replays.

import { Router } from 'express';
import QRCode from 'qrcode';
import { SESSION_COOKIE, type HealthDTO, type JoinInfoDTO } from '@pixel-clash/shared';
import type { Game } from '../services/game.js';
import { safeHost, writeKitZip } from '../services/kit.js';
import { buildContract, buildRules } from '../services/rules.js';
import { lanUrls } from '../util/lan.js';
import { COOKIE_OPTS, body, cookieOf, optionalPlayer, roundParam, send, sendError, wrap } from './common.js';

export const SERVER_VERSION = '0.1.0';

export function publicRoutes(game: Game): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    const h: HealthDTO = { ok: true, version: SERVER_VERSION, phase: game.store.match.phase };
    res.json(h);
  });

  // Join URL + QR for the projector (§12.2). The page's own Host when it was
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
    res.json(buildRules(game.config, game.armory.enabled));
  });

  r.get('/contract', (_req, res) => {
    res.json(buildContract(game.config));
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
      if (result.ok) res.cookie(SESSION_COOKIE, game.auth.createSession(result.data.player.id), COOKIE_OPTS);
      send(res, result);
    }),
  );

  r.post(
    '/login',
    wrap(async (req, res) => {
      const b = body(req);
      const result = await game.players.login(b.name, b.pin);
      if (result.ok) res.cookie(SESSION_COOKIE, game.auth.createSession(result.data.player.id), COOKIE_OPTS);
      send(res, result);
    }),
  );

  r.post('/logout', (req, res) => {
    game.auth.endSession(cookieOf(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
    res.json({ ok: true });
  });

  r.get(
    '/setup/kit.zip',
    wrap(async (req, res) => {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="pixel-clash-kit.zip"');
      await writeKitZip(res, { host: safeHost(req.headers.host) });
    }),
  );

  r.get(
    '/setup',
    wrap(async (req, res) => {
      res.json(await game.setup.info(req.headers.host));
    }),
  );

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
