// The MCP endpoint: Streamable HTTP at POST /mcp in STATELESS
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
import { BADGES, DEFAULT_CONFIG, PHASES, money, type Result, type ServiceError, type SpriteSpec, type ValidationResult } from '@pixel-clash/shared';
import { bearerOf } from './routes/common.js';
import type { Game } from './services/game.js';
import { buildContract, buildRules } from './services/rules.js';
import { WAIT_FOR_PHASE_MAX_SEC, phaseLine, timeLeftText, type WaitReason } from './services/phaseWait.js';
import type { PlayerRecord } from './services/store.js';
import { keyInvalid, authRequired } from './services/auth.js';
import { SERVER_VERSION } from './routes/public.js';
import { originAllowlist } from './util/lan.js';
import { log } from './util/log.js';

export const MCP_INSTRUCTIONS = [
  'Pixel Clash: you help a player (aged 9-13) design battle units. The player talks to you; never ask them to type or edit code (they may choose to tweak units in the web page\'s code editor).',
  'If you have no apiKey (see .pixel-clash/player.json), ask the player for their name and 4-digit PIN and call login.',
  'Save {name, apiKey} from login to .pixel-clash/player.json and pass apiKey on every pixel-clash tool call.',
  'Call get_unit_contract once to learn the unit format, and get_rules for costs and limits.',
  'Four unit types: soldier, tower, wall, factory (see get_unit_contract). Walls block everyone and never attack; factories build minions (grunt, archer, runner, brute or medic via this.produces) and their update() gives them orders (rally, or command attack/defend/swarm/guard) and can save them up for a burst (this.burst, release); an optional updateMinion(self, enemies, allies, world) on the factory decides for each of its minions (returning nothing = the built-in minion logic). A player needs at least one unit that attacks: walls and damage-0 support units alone never win.',
  'Units can have an element (fire, ice, lightning), splash (splashRadius) and one support (heal, haste, might, shield); factories can give minions an element (this.minionElement). See get_unit_contract.',
  `The $10,000 game: by default $${DEFAULT_CONFIG.caps.budget.toLocaleString('en-US')} per army, at most ${DEFAULT_CONFIG.caps.maxCopies} fighters, up to $${DEFAULT_CONFIG.caps.unitCost.toLocaleString('en-US')} per unit, HP ${DEFAULT_CONFIG.stats.bounds.maxHealth.min}-${DEFAULT_CONFIG.stats.bounds.maxHealth.max.toLocaleString('en-US')}, damage 0-${DEFAULT_CONFIG.stats.bounds.damage.max}; get_rules has the exact numbers and the copy ramp (from the 4th copy of ONE design each copy costs more). Never reuse numbers from older games.`,
  'Always validate_unit before submit_unit, and fix problems using each error\'s "fix" text. validate_unit checks everything (sprite rows included), so never run scripts or shell commands to check a unit file.',
  `submit_unit works only in the PLAN phase. The phase changes while you work, so never trust a phase you read earlier: validate_unit and submit_unit results end with the game phase right now. When submissions are closed and the unit is ready, tell the player in one line "I'll send it as soon as the Plan phase starts", then call wait_for_phase (it returns when the Plan phase starts, the phase changes, or after at most ${WAIT_FOR_PHASE_MAX_SEC} s) again and again until submissionsOpen is true, then call submit_unit and tell the player.`,
  'Players can also edit their own units on the web page. So before changing an existing unit ALWAYS call get_unit_source for its latest source and version, change that code, and pass unitId plus baseVersion (that version) to validate_unit and submit_unit, even if you rename it.',
  'If a call fails with UNIT_CHANGED, the unit was saved meanwhile: call get_unit_source again and re-apply the requested change to the new code (never resubmit the old copy).',
  'After a battle, get_battle_report shows errors with unit names and line numbers: fix those units.',
  'Explain results to the player in short, simple, cheerful words (cost, what the unit does).',
  'Selecting and placing units happens on the player\'s Pixel Clash web page, not here.',
  'With Open Armory on, list_armory shows other players\' units the player can borrow (they can\'t be changed).',
  "The host can switch walls off for a match (get_game_state wallsAllowed, get_rules thisMatch.wallsAllowed): then wall designs can't be picked, placed or borrowed that match, but validate_unit and submit_unit still work for them.",
  "With the match setting 'Show enemy names to units' on (get_game_state revealNames), every body in a unit's view also has ownerName (and teamName in team mode) and world.players lists the players; otherwise those fields are missing.",
  'Players discover tactics themselves: build what the player asks for and explain rules and numbers when asked, but never volunteer strategy advice (what to build, what beats what, army mixes, counters).',
].join('\n');

const OUTPUT = z.looseObject({ ok: z.boolean() });
const BASE_VERSION = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('With unitId: the version you revised (from get_unit_source). Always pass it when revising; if the unit changed since, the call fails with UNIT_CHANGED.');
const API_KEY = z.string().optional().describe('The player apiKey from login (needed unless the MCP config sends it as a header).');

/** Player-facing hint for a service error. */
function playerHintForService(code: string): string {
  switch (code) {
    case 'PHASE_CLOSED':
      return "I'll send your unit as soon as the Plan phase starts!";
    case 'AUTH_REQUIRED':
    case 'KEY_INVALID':
      return 'Tell your AI helper your player name and your 4-digit PIN.';
    case 'RATE_LIMITED':
      return 'Whoa, slow down! Your AI helper will try again in a moment.';
    case 'TOO_MANY_DESIGNS':
      return 'You have lots of units! Ask your AI helper to improve one of them instead.';
    case 'BAD_LOGIN':
      return 'Check your player name and 4-digit PIN and tell your AI helper again.';
    case 'NOT_FOUND':
      return 'Nothing to show yet!';
    case 'UNIT_CHANGED':
      return 'Your unit was changed while your AI helper was working on it. It will load the new version and try again.';
    case 'TEMPLATE_PROTECTED':
      return "The starter units can't be changed, so your AI helper will make you your own copy with a new name.";
    case 'GAME_FULL':
      return 'All the seats are taken. Ask a grown-up for help.';
    default:
      return 'Oops, that didn\'t work. Ask your AI helper to take a look.';
  }
}

/** A service error as the error body (isError tool result). */
function errorBody(e: ServiceError): Record<string, unknown> {
  return {
    ok: false,
    errors: [{ code: e.code, message: e.message, fix: e.hint ?? e.message, ...(e.details ? { details: e.details } : {}) }],
    warnings: [],
    cost: null,
    playerHint: playerHintForService(e.code),
  };
}

function toolResult(structured: Record<string, unknown>, summary: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(structured, null, 2)}` }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function serviceError(e: ServiceError, phase = ''): CallToolResult {
  return toolResult(errorBody(e), `Error ${e.code}: ${e.message}${e.hint ? ` Fix: ${e.hint}` : ''}${phase ? `\n${phase}` : ''}`, true);
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

function validationResult(r: Result<ValidationResult>, verb: 'Valid' | 'Submitted', wallsAllowed = true, phase = ''): CallToolResult {
  if (!r.ok) return serviceError(r.error, phase);
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
    const s = `${verb}: ${unit.stats.name} (${id}) costs ${money(unit.cost)}.` +
      (v.warnings.length ? ` Warnings: ${v.warnings.map((w) => w.code).join(', ')}.` : '') +
      // "Walls allowed" off: a wall can be stored, not picked this match.
      (unit.stats.type === 'wall' && !wallsAllowed ? " Walls are switched off for this match, so it can't be picked until a match with walls." : '') +
      (phase ? `\n${phase}` : '');
    return toolResult(structured as unknown as Record<string, unknown>, s);
  }
  const s = `Not valid: ${v.errors.map((e) => `${e.code}${e.field ? ` (${e.field})` : ''}`).join(', ')}. Apply each "fix" and validate again.${phase ? `\n${phase}` : ''}`;
  return toolResult(v as unknown as Record<string, unknown>, s, true);
}

/** The wait_for_phase text: the phase now, and what to do next. */
function waitSummary(target: string, reached: boolean, reason: WaitReason, phase: string, open: boolean, secondsLeft: number | null): string {
  const left = timeLeftText(secondsLeft);
  const now = `Game phase: ${phase}${left ? `, ${left}` : ''}, submissions ${open ? 'open' : 'closed'}.`;
  if (reached) return `${now}${open ? ' Submit the unit now.' : ''}`;
  const why = reason === 'timeout' ? `Still not ${target}` : reason === 'changed' ? `The phase changed, not ${target} yet` : `Stopped waiting, not ${target} yet`;
  return `${why}. ${now} Call wait_for_phase again to keep waiting.`;
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
      description: "Log in with the player's name and 4-digit PIN. Returns the apiKey to save in .pixel-clash/player.json and pass on every later call.",
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
        'Phases, timers, budget ($5,000) and caps (max $2,500 per unit, 4 unit + 4 building types, fighter / factory / wall copies), the cost formula and coefficients for soldier, tower, wall and factory (incl. the power, splash and element factors, heal and aura prices), stat bounds per type (incl. splashRadius and the support bounds per kind), elements (fire, ice, lightning, the shatter and overload combos, splash) and support (heal, haste, might, shield) with one rule each, the factory minion kinds (stats and prices per minionElement, the medic), squad orders and burst, scoring (place points + damage bonus + value-destroyed bonus, badges, match standings), map styles and arena sizes by player count, team modes and team rules, sudden death, and this match\'s settings (thisMatch: map, teams, revealNames, wallsAllowed).',
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
      description:
        'The TypeScript unit contract for the four types (soldier, tower, wall, factory) with elements, splash and support, the four template sources (basic_soldier, basic_tower, basic_wall, basic_factory), the engine rules, the price in one paragraph and rule notes (facts, including every field update() can read). Read this before writing a unit.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async () => toolResult({ ok: true, ...buildContract(game.config) }, 'The unit contract, templates and rule notes.'),
  );

  server.registerTool(
    'validate_unit',
    {
      title: 'Validate a unit',
      description:
        'Check a unit file (soldier, tower, wall or factory; dry run, nothing stored). Works in every phase. Returns the cost or errors with a "fix" for each, and the game phase right now. When revising, pass unitId and baseVersion (the version from get_unit_source).',
      inputSchema: {
        source: z.string().describe('The full text of the unit file'),
        unitId: z.string().optional().describe('The unitId when revising an existing unit'),
        baseVersion: BASE_VERSION,
        apiKey: API_KEY,
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ source, unitId, baseVersion, apiKey }) =>
      withPlayer(apiKey, async (p) => {
        const r = await game.units.validate(p, source, unitId, { baseVersion });
        return validationResult(r, 'Valid', game.teams.wallsAllowed, phaseLine(game.phaseWait.snapshot()));
      }),
  );

  server.registerTool(
    'submit_unit',
    {
      title: 'Submit a unit',
      description:
        'Validate and store a unit (soldier, tower, wall or factory; new, or a revision when unitId is given). Only works in the PLAN phase (PHASE_CLOSED otherwise: call wait_for_phase, then submit again). When revising, first call get_unit_source and pass its version as baseVersion; UNIT_CHANGED means the unit was saved meanwhile: fetch it again and re-apply your change.',
      inputSchema: {
        source: z.string().describe('The full text of the unit file'),
        unitId: z.string().optional().describe('The unitId of the design to revise (from list_my_units)'),
        baseVersion: BASE_VERSION,
        apiKey: API_KEY,
      },
      outputSchema: OUTPUT,
    },
    async ({ source, unitId, baseVersion, apiKey }) =>
      withPlayer(apiKey, async (p) => {
        const r = await game.units.submit(p, source, unitId, { baseVersion });
        return validationResult(r, 'Submitted', game.teams.wallsAllowed, phaseLine(game.phaseWait.snapshot()));
      }),
  );

  server.registerTool(
    'list_my_units',
    {
      title: 'My units',
      description: 'All of the player\'s designs with unitId, stats, cost, breakdown, version, status (valid/invalid + error), warnings, selected and last-battle summary (incl. healing).',
      inputSchema: { apiKey: API_KEY },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ apiKey }) =>
      withPlayer(apiKey, (p) => {
        const units = game.units.list(p.id).map(({ sprite: _s, ...u }) => ({ ...u, hasSprite: _s !== null }));
        return toolResult(
          { ok: true, units },
          `${units.length} units: ${units.map((u) => `${u.name} [${u.unitId}] ${money(u.cost)}${u.status === 'invalid' ? ' (INVALID)' : ''}`).join(', ')}.`,
        );
      }),
  );

  server.registerTool(
    'get_unit_source',
    {
      title: 'Unit source',
      description:
        "The latest stored source and version of one of the player's units. Call it before revising a unit (the player may have edited it on the web page) and pass the version as baseVersion to validate_unit/submit_unit.",
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
        "Phase, round, time left, whether submissions are open, my selection and budget, the scoreboard (per player: total points, total damage, place and badges won), the map style and arena size, the team mode, whether units see enemy names (revealNames), whether walls are allowed this match (wallsAllowed), my team and my teammates' picked unit types (team mode), the team table, and after the last round the match awards (matchAwards, myAwards) to congratulate the player.",
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
          // Maps and teams. Teammates' types only in team mode (never code).
          mapStyle: s.match?.mapStyle ?? null,
          arena: s.match?.map ? { width: s.match.map.width, height: s.match.map.height } : null,
          players: s.players.map((x) => ({ name: x.name, seat: x.seat, ...(x.teamId !== undefined ? { teamId: x.teamId } : {}), active: x.active })),
          teamMode: s.match?.teamMode ?? 'ffa',
          // "Show enemy names to units": bodies carry ownerName/teamName, world.players lists the players.
          revealNames: s.match?.revealNames === true,
          // "Walls allowed": false = wall designs can't be picked, placed or borrowed this match.
          wallsAllowed: s.match?.wallsAllowed !== false,
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
          // Per-team budgets: only when the host gave the teams different budgets.
          ...(s.match?.teamBudgets ? { teamBudgets: s.match.teamBudgets } : {}),
          // MATCH_RESULTS only: every award and the ones this player won, to congratulate them.
          ...(s.matchAwards
            ? {
                matchAwards: s.matchAwards.map((a) => ({
                  award: `${a.emoji} ${a.title}`,
                  rule: a.rule,
                  stat: a.text,
                  winners: a.winners.map((w) => ({ name: w.name, ...(w.detail ? { detail: w.detail } : {}), ...(w.bestUnit ? { bestUnit: w.bestUnit.name } : {}) })),
                })),
                myAwards: s.matchAwards
                  .filter((a) => s.me?.awards?.includes(a.id))
                  .map((a) => `${a.emoji} ${a.title} (${a.text})`),
              }
            : {}),
        };
        const time = data.secondsLeft === null ? '' : `, ${data.secondsLeft} s left`;
        return toolResult(
          data,
          `Phase ${s.phase} (round ${s.round} of ${s.rounds}${time}). Submissions are ${data.submissionsOpen ? 'OPEN' : 'closed'}.` +
            (s.armory.enabled ? ` Open Armory is ON (${s.armory.entries} units; see list_armory).` : '') +
            (data.revealNames ? " Show enemy names to units is ON: in battle every body has ownerName (and teamName in team mode), and world.players lists the players." : '') +
            (data.wallsAllowed ? '' : " Walls are switched off for this match: wall designs can't be picked, placed or borrowed (they can still be validated and submitted).") +
            (data.arena ? ` Map: ${data.mapStyle}, arena ${data.arena.width}x${data.arena.height}.` : '') +
            (team ? ` Team mode: you are on ${team.name} with ${data.myTeam!.members.filter((n) => n !== p.name).join(', ') || 'nobody else'}.` : '') +
            (s.match?.teamBudgets && s.match.teams
              ? ` Budgets differ by team this match (per player): ${s.match.teams.map((t) => `${t.name} $${(s.match!.teamBudgets![t.teamId] ?? 0).toLocaleString('en-US')}`).join(', ')}. Your budget is $${data.myBudget.toLocaleString('en-US')}.`
              : '') +
            (s.matchAwards
              ? ` The game is over! Match awards: ${s.matchAwards.map((a) => `${a.emoji} ${a.title}: ${a.winners.map((w) => w.name).join(' & ')} (${a.text})`).join('; ')}.` +
                (s.me?.awards?.length
                  ? ` This player won: ${s.matchAwards.filter((a) => s.me!.awards!.includes(a.id)).map((a) => `${a.emoji} ${a.title}`).join(', ')}. Congratulate them!`
                  : ' Congratulate the player on a great game!')
              : ''),
        );
      }),
  );

  server.registerTool(
    'wait_for_phase',
    {
      title: 'Wait for a phase',
      description:
        `Waits until the game is in \`phase\` (default PLAN, when submissions open), or the phase or round changes, or at most ${WAIT_FOR_PHASE_MAX_SEC} s (maxWaitSec), then returns the phase, round, time left and submissionsOpen. Returns at once when the game is already in that phase. Use it when a unit is ready but submissions are closed: call it again until submissionsOpen is true, then call submit_unit.`,
      inputSchema: {
        phase: z.enum(PHASES).optional().describe('The phase to wait for (default PLAN: submissions open).'),
        maxWaitSec: z
          .number()
          .int()
          .min(1)
          .max(WAIT_FOR_PHASE_MAX_SEC)
          .optional()
          .describe(`Longest wait in seconds, 1-${WAIT_FOR_PHASE_MAX_SEC} (default ${WAIT_FOR_PHASE_MAX_SEC}).`),
        apiKey: API_KEY,
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true },
    },
    async ({ phase, maxWaitSec, apiKey }, extra) =>
      withPlayer(apiKey, async (p) => {
        const target = phase ?? 'PLAN';
        const out = await game.phaseWait.wait(p.id, target, (maxWaitSec ?? WAIT_FOR_PHASE_MAX_SEC) * 1000, extra.signal);
        const s = out.state;
        const reached = s.phase === target;
        const data = {
          ok: true,
          phase: s.phase,
          round: s.round,
          rounds: s.rounds,
          secondsLeft: s.secondsLeft,
          submissionsOpen: s.submissionsOpen,
          waitedFor: target,
          reached,
          reason: out.reason,
          waitedSec: Math.round(out.waitedMs / 1000),
        };
        return toolResult(data, waitSummary(target, reached, out.reason, s.phase, s.submissionsOpen, s.secondsLeft));
      }),
  );

  server.registerTool(
    'list_armory',
    {
      title: 'Open Armory',
      description:
        "Open Armory (when the host switched it on): units other players fielded in earlier battles, which this player may borrow on the Pixel Clash page. Named \"Unit (Creator)\", with stats, cost and the round added. Their code is never shared and they can't be changed. Empty when Open Armory is off.",
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
            : `${entries.length} Armory units: ${entries.map((e) => `${e.displayName} ${money(e.cost)}${e.status === 'invalid' ? ' (INVALID)' : ''}`).join(', ')}. The player picks them on the Pixel Clash page; they can't be changed.`;
        return toolResult({ ok: true, enabled, entries }, summary);
      }),
  );

  server.registerTool(
    'get_battle_report',
    {
      title: 'Battle report',
      description:
        "Report for the player's own units in a finished battle (default: the latest): survivors, damage, kills, value destroyed, the round score (place points + damage bonus + value bonus, badges), strikes, errors with unit, line and message, per unit type the damage split (hit, splash, burn, zap, shatter), healing, cleanses and aura assist, hints, and the round's top damage units of all players (`mine: true` marks the player's own).",
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
          ? ` Place ${sc.place}: ${sc.placePoints} place + ${sc.damageBonus} damage bonus (${sc.damage} damage) + ${sc.valueBonus} value bonus (${money(sc.valueDestroyed)} destroyed) = ${sc.total} points${sc.badges.length > 0 ? `; badges: ${sc.badges.map((b) => BADGES[b].title).join(', ')}` : ''}.`
          : '';
        // Top damage units of the round, without sprite pixels (Claude only needs who and how much).
        const top = (report.topUnits ?? []).map(({ sprite: _s, stats: _st, ...t }) => ({ ...t, mine: t.playerId === p.id }));
        const mine = top.filter((t) => t.mine);
        const topText =
          top.length > 0
            ? ` Top damage: ${top.map((t) => `${t.rank}. ${t.displayName} by ${t.playerName} (${t.damage})`).join(', ')}.${mine.length > 0 ? ` The player's ${mine[0]!.displayName} is in the top ${mine[0]!.rank === 1 ? 'spot' : 'list'}!` : ''}`
            : '';
        // M8.8: healing per type (Best Medic) in one line.
        const healers = (report.types ?? []).filter((t) => (t.healing ?? 0) > 0 || (t.cleanses ?? 0) > 0);
        const healText =
          healers.length > 0
            ? ` Healing: ${healers.map((t) => `${t.name} healed ${t.healing ?? 0} HP${t.cleanses ? ` and cleansed ${t.cleanses}x` : ''}`).join(', ')}.`
            : '';
        return toolResult(
          { ok: true, ...report, topUnits: top },
          `Round ${report.round}: ${report.survived} survived, ${report.kills} kills, ${report.errors.length} errors.${score}${healText}${topText}`,
        );
      }),
  );

  return server;
}

/** DNS-rebinding protection: reject a present, foreign Origin. */
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
