// Facilitator REST routes (cookie pc_admin), mounted at /api/admin.

import { Router } from 'express';
import { ADMIN_COOKIE, deepMerge, migrateConfigPatch, safeParseConfig, type AdminConfigResponse, type DeepPartial, type GameConfig } from '@pixel-clash/shared';
import type { Game } from '../services/game.js';
import { COOKIE_OPTS, body, cookieOf, requireAdmin, send, sendError, sendValidation, wrap } from './common.js';

/** Phases in which PUT /admin/config is allowed (§10.3). */
const CONFIG_PHASES = new Set(['LOBBY', 'PLAN', 'RESULTS', 'MATCH_RESULTS']);

export function adminRoutes(game: Game): Router {
  const r = Router();

  r.post('/login', (req, res) => {
    const result = game.auth.adminLogin(body(req).password, req.socket.remoteAddress ?? '?');
    if (!result.ok) return sendError(res, result.error);
    res.cookie(ADMIN_COOKIE, result.data, COOKIE_OPTS);
    res.json({ ok: true });
  });

  r.get('/session', (req, res) => {
    res.json({ admin: game.auth.isAdmin(cookieOf(req, ADMIN_COOKIE)) });
  });

  r.use(requireAdmin(game));

  r.post('/logout', (req, res) => {
    game.auth.adminLogout(cookieOf(req, ADMIN_COOKIE));
    res.clearCookie(ADMIN_COOKIE, COOKIE_OPTS);
    res.json({ ok: true });
  });

  const stateAfter = (result: { ok: true } | { ok: false; error: Parameters<typeof sendError>[1] }, res: Parameters<typeof send>[0]) => {
    if (!result.ok) return sendError(res, result.error);
    res.json(game.visibility.gameState({ role: 'admin' }));
  };

  r.post('/match', (req, res) => {
    const b = body(req);
    stateAfter(game.match.startMatch(b.rounds, b.armory), res);
  });

  r.post(
    '/match/new',
    wrap(async (_req, res) => {
      stateAfter(await game.match.newMatch(), res);
    }),
  );

  r.post('/phase/next', (_req, res) => {
    stateAfter(game.match.next(), res);
  });

  r.post(
    '/phase/skip',
    wrap(async (_req, res) => {
      stateAfter(await game.match.skip(), res);
    }),
  );

  r.post('/timer', (req, res) => {
    send(res, game.match.adjustTimer(body(req)));
  });

  r.post('/start', (req, res) => {
    stateAfter(game.match.start(body(req).force === true), res);
  });

  r.post('/battle', (req, res) => {
    const pb = game.battle.setPlayback(body(req));
    if (!pb) return sendError(res, { code: 'PHASE_CLOSED', message: 'No battle is playing.', details: { phase: game.store.match.phase } });
    res.json(pb);
  });

  r.post('/players/:id/kick', (req, res) => {
    send(res, game.players.kick(String(req.params.id), body(req).deleteData === true));
  });

  r.post(
    '/players/:id/pin',
    wrap(async (req, res) => {
      send(res, await game.players.resetPin(String(req.params.id), body(req).pin));
    }),
  );

  r.post('/players/:id/rotate-key', (req, res) => {
    send(res, game.players.rotateKey(String(req.params.id)));
  });

  r.post(
    '/players/:id/units',
    wrap(async (req, res) => {
      const player = game.players.get(String(req.params.id));
      if (!player) return sendError(res, { code: 'NOT_FOUND', message: 'No such player.' });
      const b = body(req);
      if (b.dryRun === true) return sendValidation(res, await game.units.validate(player, b.source, b.unitId, false));
      const gate = game.match.gate('adminSubmit');
      if (gate && !gate.ok) return sendError(res, gate.error);
      sendValidation(res, await game.units.submit(player, b.source, b.unitId, { onBehalf: true }));
    }),
  );

  r.post('/units/:playerId/:unitId/sprite', (req, res) => {
    send(res, game.units.setSpriteHidden(String(req.params.playerId), String(req.params.unitId), body(req).hidden === true));
  });

  r.get('/overview', (_req, res) => {
    res.json(game.visibility.adminOverview());
  });

  r.get('/config', (_req, res) => {
    const out: AdminConfigResponse = { config: game.config, repriced: [], invalidated: [] };
    res.json(out);
  });

  r.put('/config', (req, res) => {
    const phase = game.store.match.phase;
    if (!CONFIG_PHASES.has(phase)) {
      return sendError(res, {
        code: 'PHASE_CLOSED',
        message: `The config can't change during ${phase} (unit prices must stay fixed under a live placement or battle).`,
        details: { phase, opensIn: 'RESULTS' },
      });
    }
    const patch = migrateConfigPatch(body(req)) as DeepPartial<GameConfig>;
    const parsed = safeParseConfig(patch, game.config);
    if (!parsed.success) {
      return sendError(res, { code: 'BAD_REQUEST', message: 'Invalid config.', details: { issues: parsed.error.issues } });
    }
    const next = parsed.data;
    if (next.sandbox.mode !== game.config.sandbox.mode) {
      return sendError(res, { code: 'BAD_REQUEST', message: 'The sandbox mode can only be changed in config/default.json before startup.' });
    }
    const breaks = game.units.templateBreaks(next);
    if (breaks) {
      return sendError(res, {
        code: 'TEMPLATE_WOULD_BREAK',
        message: `That change would make a starter template invalid (${breaks}).`,
        hint: 'Loosen the bounds or lower the coefficients.',
      });
    }
    game.config = next;
    game.store.configPatch = deepMerge(game.store.configPatch, patch);
    const { repriced, invalidated } = game.units.repriceAll(next);
    game.store.save();
    game.notifier.stateChanged();
    const out: AdminConfigResponse = { config: next, repriced, invalidated };
    res.json(out);
  });

  r.put(
    '/setup',
    wrap(async (req, res) => {
      const b = body(req);
      const result = game.setup.update({ claudeBoxHost: b.claudeBoxHost, preferredUrl: b.preferredUrl });
      if (!result.ok) return sendError(res, result.error);
      res.json(await game.setup.info(req.headers.host));
    }),
  );

  r.post('/wipe', (req, res) => {
    if (body(req).confirm !== 'WIPE') {
      return sendError(res, { code: 'BAD_REQUEST', message: 'Send {"confirm":"WIPE"} to delete all data.' });
    }
    void game.battle.abort();
    for (const p of game.players.list()) game.notifier.playerRevoked(p.id);
    game.store.wipe(game.bootConfig.timers.defaultRounds);
    game.config = game.bootConfig;
    game.auth.rebuildKeys();
    game.notifier.stateChanged();
    res.json({ ok: true });
  });

  return r;
}
