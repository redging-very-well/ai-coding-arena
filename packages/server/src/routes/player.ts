// Player REST routes (Bearer key or pc_session cookie).

import { Router } from 'express';
import type { MeResponse } from '@pixel-clash/shared';
import type { Game } from '../services/game.js';
import { kitZipName, parseKitAgent, safeHost, writeKitZip } from '../services/kit.js';
import { toPlayerDTO } from '../services/players.js';
import { body, requirePlayer, roundParam, send, sendError, sendValidation, wrap } from './common.js';

export function playerRoutes(game: Game): Router {
  const r = Router();
  r.use(requirePlayer(game));

  r.get('/me', (req, res) => {
    const p = req.player!;
    const me: MeResponse = {
      player: toPlayerDTO(p),
      apiKey: p.apiKey,
      seat: p.seat,
      connected: game.notifier.isConnected(p.id),
      active: game.players.isActive(p),
      benched: game.teams.isBenched(p),
      claudeSeat: game.claudeSeats.seatOf(p),
    };
    const teamId = game.teams.active ? game.teams.teamIdOf(p.id) : undefined;
    if (teamId !== undefined) me.teamId = teamId;
    res.json(me);
  });

  // Claude seat (§11.2 c): the laptop's terminal. Any phase, also for benched players.
  r.get('/claude-seats', (req, res) => {
    res.json(game.claudeSeats.playerDTO(req.player!));
  });

  r.put('/me/claude-seat', (req, res) => {
    const b = body(req);
    if (!('seat' in b)) return sendError(res, { code: 'BAD_REQUEST', message: 'Send {"seat": 1-8} or {"seat": null}.' });
    send(res, game.claudeSeats.claim(req.player!, b.seat));
  });

  r.post(
    '/units/validate',
    wrap(async (req, res) => {
      const b = body(req);
      sendValidation(res, await game.units.validate(req.player!, b.source, b.unitId, { baseVersion: b.baseVersion }));
    }),
  );

  r.post(
    '/units',
    wrap(async (req, res) => {
      const b = body(req);
      sendValidation(res, await game.units.submit(req.player!, b.source, b.unitId, { baseVersion: b.baseVersion }));
    }),
  );

  r.get('/units', (req, res) => {
    res.json(game.units.list(req.player!.id));
  });

  r.get('/units/:id', (req, res) => {
    send(res, game.units.getSource(req.player!.id, req.params.id));
  });

  r.delete('/units/:id', (req, res) => {
    send(res, game.units.retire(req.player!.id, String(req.params.id)));
  });

  r.put('/round/selection', (req, res) => {
    send(res, game.round.setSelection(req.player!.id, body(req).unitIds));
  });

  r.put('/round/placement', (req, res) => {
    send(res, game.round.setPlacements(req.player!.id, body(req).placements));
  });

  r.post('/round/ready', (req, res) => {
    send(res, game.round.setReady(req.player!.id, body(req).ready));
  });

  r.get('/battles/:round/report', (req, res) => {
    const round = roundParam(req.params.round);
    if (Number.isNaN(round)) return sendError(res, { code: 'BAD_REQUEST', message: 'round must be a positive whole number.' });
    const report = game.battle.report(req.player!.id, round);
    if (!report) return sendError(res, { code: 'NOT_FOUND', message: 'There is no battle report for that round yet.' });
    if ('stillPlaying' in report) {
      return sendError(res, {
        code: 'PHASE_CLOSED',
        message: `The battle for round ${report.stillPlaying} is still playing. The report is ready when it ends.`,
        details: { phase: 'BATTLE', opensIn: 'RESULTS' },
      });
    }
    res.json(report);
  });

  r.get(
    '/kit.zip',
    wrap(async (req, res) => {
      // ?agent=codex: the OpenAI Codex CLI kit (AGENTS.md + .codex/config.toml, §11.3).
      const agent = parseKitAgent(req.query.agent);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${kitZipName(agent)}"`);
      await writeKitZip(res, { host: safeHost(req.headers.host), player: req.player!, agent });
    }),
  );

  return r;
}
