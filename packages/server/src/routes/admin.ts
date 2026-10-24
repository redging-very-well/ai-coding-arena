// Facilitator REST routes (cookie pc_admin), mounted at /api/admin.

import { Router } from 'express';
import { ADMIN_COOKIE, deepMerge, parseScreenCommand, migrateConfigPatch, safeParseConfig, type AdminConfigResponse, type DeepPartial, type GameConfig } from '@pixel-clash/shared';
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
    // `mapStyle`/`teamMode` left out = the LOBBY draft's (§9.2); mapStyle null = default for the player count.
    // `revealNames` ("Show enemy names to units", §5) left out = the draft's.
    stateAfter(game.match.startMatch(b.rounds, b.armory, b.mapStyle, b.teamMode, b.revealNames), res);
  });

  // Match setup draft (§9.2, LOBBY only): map style override + team mode, with the preview.
  r.get('/match/setup', (_req, res) => {
    res.json(game.teams.setupDTO());
  });

  r.put('/match/setup', (req, res) => {
    const b = body(req);
    send(res, game.teams.setDraft({ mapStyle: b.mapStyle, teamMode: b.teamMode, revealNames: b.revealNames }));
  });

  // Swap two players between draft teams (§9.2, LOBBY only).
  r.post('/teams/swap', (req, res) => {
    const b = body(req);
    send(res, game.teams.swap(b.playerA, b.playerB));
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

  r.post('/phase/advance', (req, res) => {
    stateAfter(game.match.startAdvance(body(req).delaySec), res);
  });

  r.post('/phase/advance/cancel', (_req, res) => {
    stateAfter(game.match.cancelAdvance(), res);
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
      if (b.dryRun === true) return sendValidation(res, await game.units.validate(player, b.source, b.unitId, { rateLimited: false, baseVersion: b.baseVersion }));
      const gate = game.match.gate('adminSubmit');
      if (gate && !gate.ok) return sendError(res, gate.error);
      sendValidation(res, await game.units.submit(player, b.source, b.unitId, { onBehalf: true, baseVersion: b.baseVersion }));
    }),
  );

  r.post('/units/:playerId/:unitId/sprite', (req, res) => {
    send(res, game.units.setSpriteHidden(String(req.params.playerId), String(req.params.unitId), body(req).hidden === true));
  });

  // Projector remote (§12.2): replay on /screen and the join poster.
  r.post('/screen', (req, res) => {
    const command = parseScreenCommand(req.body);
    if (!command) {
      return sendError(res, {
        code: 'BAD_REQUEST',
        message: 'Unknown screen command.',
        hint: "Send {action:'replay'|'replaySpeed'|'replayPause'|'poster'}.",
      });
    }
    const phase = game.store.match.phase;
    if (command.action.startsWith('replay') && phase !== 'RESULTS' && phase !== 'MATCH_RESULTS') {
      return sendError(res, { code: 'PHASE_CLOSED', message: 'The replay is shown after a battle (RESULTS).', details: { phase } });
    }
    const screens = game.notifier.screenCommand?.(command) ?? 0;
    res.json({ ok: true, screens });
  });

  r.get('/overview', (_req, res) => {
    res.json(game.visibility.adminOverview());
  });

  // Diagnostics for the facilitator and `npm run loadtest` (§14, §15 "check CPU per tick"):
  // server memory, WS connections and the running (else last) battle's sim ms/tick and playback stalls.
  r.get('/metrics', (_req, res) => {
    const mem = process.memoryUsage();
    const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
    res.json({
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      phase: game.store.match.phase,
      round: game.store.match.round,
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      heapTotalMb: mb(mem.heapTotal),
      externalMb: mb(mem.external),
      arrayBuffersMb: mb(mem.arrayBuffers),
      wsClients: game.notifier.clientCount?.() ?? null,
      battle: game.battle.metrics() ?? null,
    });
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
      const result = game.setup.update({ claudeBoxHost: b.claudeBoxHost, preferredUrl: b.preferredUrl, seatSecret: b.seatSecret });
      if (!result.ok) return sendError(res, result.error);
      res.json({ ...(await game.setup.info(req.headers.host)), seatSecretSet: game.setup.seatSecretSet });
    }),
  );

  // Claude seats (§11.2): assignments, live terminals and the seat probe.
  // The seat password and direct URLs only with ?details=1 ("Show details").
  r.get('/claude-seats', (req, res) => {
    res.json(game.claudeSeats.adminDTO(req.query.details === '1'));
  });

  r.post(
    '/claude-seats/check',
    wrap(async (_req, res) => {
      await game.claudeSeats.probeAll();
      res.json(game.claudeSeats.adminDTO(false));
    }),
  );

  r.put('/claude-seats/:seat', (req, res) => {
    const b = body(req);
    if (!('playerId' in b)) {
      return sendError(res, { code: 'BAD_REQUEST', message: 'Send {"playerId": "<id>"} to assign, or {"playerId": null} to unassign.' });
    }
    send(res, game.claudeSeats.adminAssign(String(req.params.seat), b.playerId));
  });

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
    // Every Claude seat is free now; live terminals of the old sessions close.
    game.notifier.terminalsChanged?.();
    game.claudeSeats.accessChanged();
    res.json({ ok: true });
  });

  return r;
}
