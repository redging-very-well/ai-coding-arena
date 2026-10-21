// The MCP endpoint (plan §10.4): Streamable HTTP at POST /mcp in STATELESS
// mode (a fresh server + transport per request, no Mcp-Session-Id), so a
// server restart is invisible to connected Claude Code clients.
//
// Auth per request: `Authorization: Bearer pc_…` first, then the tool's
// optional `apiKey` argument. /mcp NEVER answers 401/403 for auth (Claude Code
// would treat that as "needs OAuth"): tools/list always works, and tools
// without an identity return a tool error (AUTH_REQUIRED / KEY_INVALID).
// The only 403 is the Origin check (DNS-rebinding protection), which Claude
// Code never trips because it sends no Origin header.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BADGES, type Result, type ServiceError, type SpriteSpec, type ValidationResult } from '@pixel-clash/shared';
import { bearerOf } from './routes/common.js';
import type { Game } from './services/game.js';
import { buildContract, buildRules } from './services/rules.js';
import type { PlayerRecord } from './services/store.js';
import { keyInvalid, authRequired } from './services/auth.js';
import { SERVER_VERSION } from './routes/public.js';
import { originAllowlist } from './util/lan.js';
import { log } from './util/log.js';

export const MCP_INSTRUCTIONS = [
  'Pixel Clash: you help a kid (9-13) design battle units. The kid only talks to you; never ask them to type or edit code.',
  'If you have no apiKey (see .pixel-clash/player.json), ask the kid for their player name and 4-digit PIN and call login.',
  'Save {name, apiKey} from login to .pixel-clash/player.json and pass apiKey on every pixel-clash tool call.',
  'Call get_unit_contract once to learn the unit format, and get_rules for costs and limits.',
  'Always validate_unit before submit_unit, and fix problems using each error\'s "fix" text. validate_unit checks everything (sprite rows included), so never run scripts or shell commands to check a unit file.',
  'submit_unit works only in the PLAN phase (get_game_state shows submissionsOpen). Otherwise keep the unit validated and say "we\'ll send it when Plan starts".',
  'When changing an existing unit, pass its unitId (from list_my_units), even if you rename it.',
  'After a battle, get_battle_report shows errors with unit names and line numbers: fix those units.',
  'Explain results to the kid in short, simple, cheerful words (cost, what the unit does).',
  'Selecting and placing units happens on the kid\'s Pixel Clash web page, not here.',
  'With Open Armory on, list_armory shows other players\' units the kid can borrow (they can\'t be changed): suggest counters or improved versions.',
].join('\n');

const OUTPUT = z.looseObject({ ok: z.boolean() });
const API_KEY = z.string().optional().describe('The player apiKey from login (needed unless the MCP config sends it as a header).');

/** Kid-facing hint for a service error. */
function kidHintForService(code: string): string {
  switch (code) {
    case 'PHASE_CLOSED':
      return "We'll send your unit when Plan time starts!";
    case 'AUTH_REQUIRED':
    case 'KEY_INVALID':
      return 'Tell Claude your player name and your 4-digit PIN.';
    case 'RATE_LIMITED':
      return 'Whoa, slow down! Claude will try again in a moment.';
    case 'TOO_MANY_DESIGNS':
      return 'You have lots of units! Ask Claude to improve one of them instead.';
    case 'BAD_LOGIN':
      return 'Check your player name and 4-digit PIN and tell Claude again.';
    case 'NOT_FOUND':
      return 'Nothing to show yet!';
    case 'TEMPLATE_PROTECTED':
      return "The starter units can't be changed, so Claude will make you your own copy with a new name.";
    case 'GAME_FULL':
      return 'All the seats are taken. Ask a grown-up for help.';
    default:
      return 'Oops, that didn\'t work. Ask Claude to take a look.';
  }
}

/** A service error as the §7 error body (isError tool result). */
function errorBody(e: ServiceError): Record<string, unknown> {
  return {
    ok: false,
    errors: [{ code: e.code, message: e.message, fix: e.hint ?? e.message, ...(e.details ? { details: e.details } : {}) }],
    warnings: [],
    cost: null,
    kidHint: kidHintForService(e.code),
  };
}

function toolResult(structured: Record<string, unknown>, summary: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(structured, null, 2)}` }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function serviceError(e: ServiceError): CallToolResult {
  return toolResult(errorBody(e), `Error ${e.code}: ${e.message}${e.hint ? ` Fix: ${e.hint}` : ''}`, true);
}

function fromResult<T>(r: Result<T>, summary: (d: T) => string, shape: (d: T) => Record<string, unknown>): CallToolResult {
  if (!r.ok) return serviceError(r.error);
  return toolResult({ ok: true, ...shape(r.data) }, summary(r.data));
}

/**
 * The sprite as a small summary (a 32-grid sprite is ~15-20 KB of JSON; it
 * would be repeated on every validate/fix loop and fill the seat's context).
 */
export function spriteSummary(sprite: SpriteSpec | null): Record<string, unknown> {
  if (!sprite) return { hasSprite: false };
  const frames = Object.fromEntries(Object.entries(sprite.frames).map(([state, list]) => [state, list?.length ?? 0]));
  return { hasSprite: true, grid: sprite.grid, frames };
}

function validationResult(r: Result<ValidationResult>, verb: 'Valid' | 'Submitted'): CallToolResult {
  if (!r.ok) return serviceError(r.error);
  const v = r.data;
  if (v.ok) {
    const { sprite, ...unit } = v.unit;
    const structured = { ...v, unit: { ...unit, sprite: spriteSummary(sprite) } };
    // A dry run of a NEW design: nothing is stored yet, so its future unitId
    // must not be passed to submit_unit (that would be NOT_FOUND).
    const id =
      verb === 'Valid' && unit.version === 1
        ? `new design: submit WITHOUT unitId; it will get unitId "${unit.unitId}"`
        : `unitId "${unit.unitId}", version ${unit.version}`;
    const s = `${verb}: ${unit.stats.name} (${id}) costs $${unit.cost}.` +
      (v.warnings.length ? ` Warnings: ${v.warnings.map((w) => w.code).join(', ')}.` : '');
    return toolResult(structured as unknown as Record<string, unknown>, s);
  }
  const s = `Not valid: ${v.errors.map((e) => `${e.code}${e.field ? ` (${e.field})` : ''}`).join(', ')}. Apply each "fix" and validate again.`;
  return toolResult(v as unknown as Record<string, unknown>, s, true);
}

/** Build the per-request MCP server; `bearer` is the request's Bearer key, if any. */
export function buildMcpServer(game: Game, bearer: string | undefined): McpServer {
  const server = new McpServer({ name: 'pixel-clash', version: SERVER_VERSION }, { instructions: MCP_INSTRUCTIONS });

  /** Header key first, then the apiKey argument. */
  const identify = (apiKey: unknown): Result<PlayerRecord> => {
    const fromHeader = game.auth.playerForKey(bearer);
    if (fromHeader) return { ok: true, data: fromHeader };
    const arg = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
    const fromArg = game.auth.playerForKey(arg);
    if (fromArg) return { ok: true, data: fromArg };
    return bearer || arg ? keyInvalid() : authRequired();
  };

  const withPlayer = async (apiKey: unknown, fn: (p: PlayerRecord) => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> => {
    const who = identify(apiKey);
    if (!who.ok) return serviceError(who.error);
    return fn(who.data);
  };

  server.registerTool(
    'login',
    {
      title: 'Log in',
      description: "Log in with the kid's player name and 4-digit PIN. Returns the apiKey to save in .pixel-clash/player.json and pass on every later call.",
      inputSchema: { name: z.string().describe('Player name'), pin: z.string().describe('4-digit PIN') },
      outputSchema: OUTPUT,
    },
    async ({ name, pin }) => {
      const r = await game.players.login(name, pin);
      return fromResult(
        r,
        (d) => `Logged in as ${d.player.name}. Save this to .pixel-clash/player.json and pass apiKey on every pixel-clash call.`,
        (d) => ({ player: { id: d.player.id, name: d.player.name }, apiKey: d.apiKey }),
      );
    },
  );

  server.registerTool(
    'get_rules',
    {
      title: 'Game rules',
      description:
        'Phases, timers, budget, caps, the cost formula and coefficients, stat bounds, scoring (place points + damage bonus + value-destroyed bonus, badges, match standings), map styles and arena sizes by player count, team modes and team rules, and sudden death.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async () => toolResult({ ok: true, ...buildRules(game.config, game.armory.enabled, game.teams.matchInfo()) }, 'The Pixel Clash rules.'),
  );

  server.registerTool(
    'get_unit_contract',
    {
      title: 'Unit contract',
      description: 'The TypeScript unit contract, both template sources, the engine rules and strategy tips. Read this before writing a unit.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async () => toolResult({ ok: true, ...buildContract(game.config) }, 'The unit contract, templates and tips.'),
  );

  server.registerTool(
    'validate_unit',
    {
      title: 'Validate a unit',
      description: 'Check a unit file (dry run, nothing stored). Works in every phase. Returns the cost or errors with a "fix" for each.',
      inputSchema: {
        source: z.string().describe('The full text of the unit file'),
        unitId: z.string().optional().describe('The unitId when revising an existing unit'),
        apiKey: API_KEY,
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ source, unitId, apiKey }) =>
      withPlayer(apiKey, async (p) => validationResult(await game.units.validate(p, source, unitId), 'Valid')),
  );

  server.registerTool(
    'submit_unit',
    {
      title: 'Submit a unit',
      description: 'Validate and store a unit (new, or a revision when unitId is given). Only works in the PLAN phase.',
      inputSchema: {
        source: z.string().describe('The full text of the unit file'),
        unitId: z.string().optional().describe('The unitId of the design to revise (from list_my_units)'),
        apiKey: API_KEY,
      },
      outputSchema: OUTPUT,
    },
    async ({ source, unitId, apiKey }) =>
      withPlayer(apiKey, async (p) => validationResult(await game.units.submit(p, source, unitId), 'Submitted')),
  );

  server.registerTool(
    'list_my_units',
    {
      title: 'My units',
      description: 'All of the player\'s designs with unitId, stats, cost, breakdown, version, status (valid/invalid + error), selected and last-battle summary.',
      inputSchema: { apiKey: API_KEY },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ apiKey }) =>
      withPlayer(apiKey, (p) => {
        const units = game.units.list(p.id).map(({ sprite: _s, ...u }) => ({ ...u, hasSprite: _s !== null }));
        return toolResult(
          { ok: true, units },
          `${units.length} units: ${units.map((u) => `${u.name} [${u.unitId}] $${u.cost}${u.status === 'invalid' ? ' (INVALID)' : ''}`).join(', ')}.`,
        );
      }),
  );

  server.registerTool(
    'get_unit_source',
    {
      title: 'Unit source',
      description: "The stored source of one of the player's units (lets you revise it even if the local file is lost).",
      inputSchema: { unitId: z.string().describe('The unitId (from list_my_units)'), apiKey: API_KEY },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ unitId, apiKey }) =>
      withPlayer(apiKey, (p) =>
        fromResult(
          game.units.getSource(p.id, unitId),
          (d) => `Source of ${d.name} (version ${d.version}).`,
          (d) => ({ unitId: d.unitId, name: d.name, version: d.version, source: d.source }),
        ),
      ),
  );

  server.registerTool(
    'get_game_state',
    {
      title: 'Game state',
      description:
        "Phase, round, time left, whether submissions are open, my selection and budget, the scoreboard (per player: total points, total damage, place and badges won), the map style and arena size, the team mode, my team and my teammates' picked unit types (team mode), and the team table.",
      inputSchema: { apiKey: API_KEY },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ apiKey }) =>
      withPlayer(apiKey, (p) => {
        const s = game.visibility.gameState({ role: 'player', playerId: p.id });
        const team = s.me?.team ?? null;
        const data = {
          ok: true,
          player: { id: p.id, name: p.name },
          phase: s.phase,
          round: s.round,
          rounds: s.rounds,
          secondsLeft: s.timer.secondsLeft,
          submissionsOpen: s.me?.submissionsOpen ?? false,
          mySelection: s.me?.selection ?? [],
          myBudget: s.me?.budget ?? game.config.caps.budget,
          myZone: s.me?.myZone ?? null,
          active: s.me?.active ?? false,
          benched: s.me?.benched === true,
          armory: s.armory,
          scoreboard: s.scoreboard,
          // Maps and teams (§9.2). Teammates' types only in team mode (never code).
          mapStyle: s.match?.mapStyle ?? null,
          arena: s.match?.map ? { width: s.match.map.width, height: s.match.map.height } : null,
          players: s.players.map((x) => ({ name: x.name, seat: x.seat, ...(x.teamId !== undefined ? { teamId: x.teamId } : {}), active: x.active })),
          teamMode: s.match?.teamMode ?? 'ffa',
          myTeam: team ? { teamId: team.teamId, name: team.name, members: team.members.map((m) => m.name) } : null,
          teammates: team
            ? team.members
                .filter((m) => m.playerId !== p.id)
                .map((m) => ({
                  name: m.name,
                  selectedTypes: m.selection.map((c) => ({ displayName: c.name, type: c.stats.type, stats: c.stats, cost: c.cost })),
                }))
            : [],
          teamTable: s.match?.teamTable ?? null,
        };
        const time = data.secondsLeft === null ? '' : `, ${data.secondsLeft} s left`;
        return toolResult(
          data,
          `Phase ${s.phase} (round ${s.round} of ${s.rounds}${time}). Submissions are ${data.submissionsOpen ? 'OPEN' : 'closed'}.` +
            (s.armory.enabled ? ` Open Armory is ON (${s.armory.entries} units; see list_armory).` : '') +
            (data.arena ? ` Map: ${data.mapStyle}, arena ${data.arena.width}x${data.arena.height}.` : '') +
            (team ? ` Team mode: you are on ${team.name} with ${data.myTeam!.members.filter((n) => n !== p.name).join(', ') || 'nobody else'}.` : ''),
        );
      }),
  );

  server.registerTool(
    'list_armory',
    {
      title: 'Open Armory',
      description:
        "Open Armory (when the host switched it on): units other players fielded in earlier battles, which this player may borrow on the Pixel Clash page. Named \"Unit (Creator)\", with stats, cost and the round added. Their code is never shared and they can't be changed: use them to plan counters or improved designs of your own. Empty when Open Armory is off.",
      inputSchema: { apiKey: API_KEY },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ apiKey }) =>
      withPlayer(apiKey, (p) => {
        const entries = game.armory.list(p.id).map((e) => ({
          armoryId: e.armoryId,
          selectId: e.unitId,
          displayName: e.displayName,
          creatorName: e.creatorName,
          stats: e.stats,
          cost: e.cost,
          breakdown: e.breakdown,
          roundAdded: e.roundAdded,
          status: e.status,
          ...(e.error ? { error: e.error } : {}),
        }));
        const enabled = game.armory.enabled;
        const summary = !enabled
          ? 'Open Armory is off in this match.'
          : entries.length === 0
            ? 'Open Armory is on, but no units are in it yet (units enter when a battle ends).'
            : `${entries.length} Armory units: ${entries.map((e) => `${e.displayName} $${e.cost}${e.status === 'invalid' ? ' (INVALID)' : ''}`).join(', ')}. The kid picks them on the Pixel Clash page; they can't be changed.`;
        return toolResult({ ok: true, enabled, entries }, summary);
      }),
  );

  server.registerTool(
    'get_battle_report',
    {
      title: 'Battle report',
      description:
        "Report for the player's own units in a finished battle (default: the latest): survivors, damage, kills, value destroyed, the round score (place points + damage bonus + value bonus, badges), strikes, and errors with unit, line and message.",
      inputSchema: { round: z.number().int().positive().optional().describe('Round number (default: latest finished)'), apiKey: API_KEY },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ round, apiKey }) =>
      withPlayer(apiKey, (p) => {
        const report = game.battle.report(p.id, round);
        if (!report) return serviceError({ code: 'NOT_FOUND', message: 'There is no finished battle yet.', hint: 'Try again after a battle has ended.' });
        if ('stillPlaying' in report) {
          return serviceError({
            code: 'PHASE_CLOSED',
            message: `The battle for round ${report.stillPlaying} is still playing.`,
            hint: 'Call get_battle_report again when the battle has ended.',
            details: { phase: 'BATTLE', opensIn: 'RESULTS' },
          });
        }
        const sc = report.score;
        const score = sc
          ? ` Place ${sc.place}: ${sc.placePoints} place + ${sc.damageBonus} damage bonus (${sc.damage} damage) + ${sc.valueBonus} value bonus ($${sc.valueDestroyed} destroyed) = ${sc.total} points${sc.badges.length > 0 ? `; badges: ${sc.badges.map((b) => BADGES[b].title).join(', ')}` : ''}.`
          : '';
        return toolResult(
          { ok: true, ...report },
          `Round ${report.round}: ${report.survived} survived, ${report.kills} kills, ${report.errors.length} errors.${score}`,
        );
      }),
  );

  return server;
}

/** DNS-rebinding protection: reject a present, foreign Origin (§10.4). */
function originCheck(port: () => number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin || originAllowlist(port()).has(origin)) return next();
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: `Origin ${origin} is not allowed.` }, id: null });
  };
}

export function mountMcp(app: Express, game: Game, opts: { port: () => number }): void {
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', originCheck(opts.port), notAllowed);
  app.delete('/mcp', originCheck(opts.port), notAllowed);
  app.post('/mcp', originCheck(opts.port), express.json({ limit: '512kb' }), (req: Request, res: Response) => {
    // No keep-alive: after a server restart a client must never reuse a dead
    // pooled socket, so the restart stays invisible (one TCP connect per call
    // is nothing on a LAN).
    res.setHeader('Connection', 'close');
    const server = buildMcpServer(game, bearerOf(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, req.body))
      .catch((err: unknown) => {
        log.error('MCP request failed', err);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
      });
  });
}
