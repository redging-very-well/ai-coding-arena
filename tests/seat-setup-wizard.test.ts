// /admin "Set up AI seats" wizard (plan §12.3, §11.1-11.3), DOM-free logic:
// which steps are done from the seats DTO, when the banner hides, where the
// wizard opens, the troubleshooting hints per failure, and the command with
// AGENT=… added.

import { describe, expect, it } from 'vitest';
import type { AdminClaudeSeatDTO, AdminClaudeSeatsDTO } from '@pixel-clash/shared';
import {
  connectHints,
  effectiveAgent,
  firstOpenStep,
  maskedSetupCommand,
  seatsReady,
  wizardSetupCommand,
  wizardSteps,
  type WizardInput,
} from '../packages/client/src/admin/seatSetupSteps.js';

const seat = (n: number, over: Partial<AdminClaudeSeatDTO> = {}): AdminClaudeSeatDTO => ({
  seat: n,
  enabled: true,
  playerId: null,
  playerName: null,
  status: 'unknown',
  checkedAt: null,
  live: null,
  sharedLogin: null,
  ...over,
});

const dto = (over: Partial<AdminClaudeSeatsDTO> = {}, rows?: AdminClaudeSeatDTO[]): AdminClaudeSeatsDTO => ({
  boxHost: null,
  seatSecretSet: true,
  agentCredentials: { claudeToken: null, anthropicApiKey: null, openaiApiKey: null },
  seats: rows ?? [1, 2, 3, 4, 5, 6, 7, 8].map((n) => seat(n, { status: over.boxHost ? 'unknown' : 'no-box' })),
  ...over,
});

const states = (input: WizardInput) => Object.fromEntries(wizardSteps(input).map((s) => [s.id, s.state]));
const token = { claudeToken: '…abcd', anthropicApiKey: null, openaiApiKey: null };

describe('wizardSteps / seatsReady', () => {
  it('a fresh server: nothing done but the seat password, the banner shows, the wizard opens on step 1', () => {
    const input: WizardInput = { seats: dto(), agent: null, ownLogins: false };
    expect(states(input)).toEqual({ agent: 'todo', login: 'todo', box: 'todo', connect: 'todo', seats: 'todo', done: 'todo' });
    expect(seatsReady(input)).toBe(false);
    expect(firstOpenStep(wizardSteps(input))).toBe('agent');
    expect(seatsReady({ seats: null, agent: null, ownLogins: false })).toBe(false);
  });

  it('agent picked and a token saved: the wizard opens on the AI session host step', () => {
    const input: WizardInput = { seats: dto({ agentCredentials: token }), agent: 'claude', ownLogins: false };
    expect(states(input)).toMatchObject({ agent: 'done', login: 'done', box: 'todo' });
    expect(firstOpenStep(wizardSteps(input))).toBe('box');
  });

  it('the login must fit the agent: a Claude token does not count for Codex, an OpenAI key does', () => {
    expect(states({ seats: dto({ agentCredentials: token }), agent: 'codex', ownLogins: false }).login).toBe('todo');
    const openai = { claudeToken: null, anthropicApiKey: null, openaiApiKey: '…wxyz' };
    expect(states({ seats: dto({ agentCredentials: openai }), agent: 'codex', ownLogins: false }).login).toBe('done');
    // Only an OpenAI key and no pick: assume Codex.
    expect(effectiveAgent({ seats: dto({ agentCredentials: openai }), agent: null })).toBe('codex');
    expect(effectiveAgent({ seats: dto({ agentCredentials: token }), agent: null })).toBe('claude');
    // An Anthropic API key counts for Claude; "own logins" counts for either.
    expect(states({ seats: dto({ agentCredentials: { ...token, claudeToken: null, anthropicApiKey: '…k' } }), agent: 'claude', ownLogins: false }).login).toBe('done');
    expect(states({ seats: dto(), agent: 'codex', ownLogins: true }).login).toBe('done');
  });

  it('fully set up: every step done, the banner hides', () => {
    const rows = [1, 2, 3, 4].map((n) => seat(n, { status: 'up' })).concat([5, 6, 7, 8].map((n) => seat(n, { enabled: false, status: 'down', reason: 'ECONNREFUSED' })));
    const input: WizardInput = { seats: dto({ boxHost: '192.168.8.20', agentCredentials: token }, rows), agent: 'claude', ownLogins: false };
    expect(states(input)).toEqual({ agent: 'done', login: 'done', box: 'done', connect: 'done', seats: 'done', done: 'done' });
    expect(seatsReady(input)).toBe(true);
    expect(firstOpenStep(wizardSteps(input))).toBe('done');
    expect(wizardSteps(input).find((s) => s.id === 'done')!.summary).toBe('4 AI seat(s) ready');
  });

  it('seats up but no login: not ready (the login step is the one left)', () => {
    const rows = [1, 2].map((n) => seat(n, { status: 'up' }));
    const input: WizardInput = { seats: dto({ boxHost: 'box' }, rows), agent: null, ownLogins: false };
    expect(seatsReady(input)).toBe(false);
    expect(firstOpenStep(wizardSteps(input))).toBe('login');
    expect(states(input).agent).toBe('done'); // seats are running: the agent is decided on the box
    expect(seatsReady({ ...input, ownLogins: true })).toBe(true);
  });

  it('a seat that is up but turned off does not make it ready', () => {
    const rows = [seat(1, { status: 'up', enabled: false }), seat(2, { status: 'down', reason: 'ECONNREFUSED' })];
    expect(seatsReady({ seats: dto({ boxHost: 'box', agentCredentials: token }, rows), agent: 'claude', ownLogins: false })).toBe(false);
  });

  it('failures show as problems: wrong password, nothing answers, every seat off, some seats on but not running', () => {
    const base = { agentCredentials: token, boxHost: '10.0.0.9' };
    const wrong = dto(base, [seat(1, { status: 'wrong-password' }), seat(2, { status: 'wrong-password' })]);
    expect(states({ seats: wrong, agent: 'claude', ownLogins: false })).toMatchObject({ box: 'done', connect: 'problem' });
    expect(wizardSteps({ seats: wrong, agent: 'claude', ownLogins: false }).find((s) => s.id === 'connect')!.summary).toContain('seat 1, 2');

    const down = dto(base, [seat(1, { status: 'down', reason: 'timeout' })]);
    expect(states({ seats: down, agent: 'claude', ownLogins: false })).toMatchObject({ box: 'todo', connect: 'problem' });

    const off = dto(base, [seat(1, { enabled: false, status: 'up' })]);
    expect(states({ seats: off, agent: 'claude', ownLogins: false }).seats).toBe('problem');

    const partly = dto(base, [seat(1, { status: 'up' }), seat(2, { status: 'down', reason: 'ECONNREFUSED' })]);
    const s = states({ seats: partly, agent: 'claude', ownLogins: false });
    expect(s).toMatchObject({ connect: 'done', seats: 'problem', done: 'done' });

    const noSecret = dto({ ...base, seatSecretSet: false });
    expect(states({ seats: noSecret, agent: 'claude', ownLogins: false }).box).toBe('problem');
    expect(seatsReady({ seats: noSecret, agent: 'claude', ownLogins: false })).toBe(false);
  });
});

describe('connectHints', () => {
  const texts = (s: AdminClaudeSeatsDTO) => connectHints(s).map((h) => `${h.seats.join(',')}|${h.text}`);

  it('asks for the address first', () => {
    expect(texts(dto())).toEqual([expect.stringContaining('Enter the AI session host address')]);
    expect(connectHints(null)).toEqual([]);
  });

  it('one hint per cause, naming the seats; seats that are off are left out', () => {
    const rows = [
      seat(1, { status: 'wrong-password' }),
      seat(2, { status: 'down', reason: 'ECONNREFUSED' }),
      seat(3, { status: 'down', reason: 'EHOSTUNREACH' }),
      seat(4, { status: 'down', reason: 'timeout' }),
      seat(5, { status: 'down', reason: 'ENOTFOUND' }),
      seat(6, { status: 'down', reason: 'ECONNRESET' }),
      seat(7, { status: 'down', reason: 'ECONNREFUSED', enabled: false }),
      seat(8, { status: 'up' }),
    ];
    const t = texts(dto({ boxHost: 'claude-box.local' }, rows));
    expect(t).toHaveLength(5);
    expect(t[0]).toMatch(/^1\|Wrong seat password/);
    expect(t[1]).toMatch(/^2\|.*not started.*turn them off in step 5/);
    expect(t[2]).toMatch(/^3,4\|No answer from claude-box\.local.*firewall/);
    expect(t[3]).toMatch(/^5\|.*IP address/);
    expect(t[4]).toMatch(/^6\|.*ECONNRESET/);
  });

  it('refused everywhere: the seats are not running (or the image is still building)', () => {
    const rows = [1, 2].map((n) => seat(n, { status: 'down', reason: 'ECONNREFUSED' }));
    const t = texts(dto({ boxHost: '10.0.0.9' }, rows));
    expect(t).toEqual([expect.stringMatching(/^1,2\|.*no seat is running.*builds the image/)]);
  });

  it('nothing checked yet: Check now; everything up: no hints', () => {
    expect(texts(dto({ boxHost: '10.0.0.9' }, [seat(1)]))).toEqual(['1|Not checked yet: press Check now.']);
    expect(connectHints(dto({ boxHost: '10.0.0.9' }, [seat(1, { status: 'up' }), seat(2, { status: 'up' })]))).toEqual([]);
  });
});

describe('the setup command', () => {
  it('adds AGENT=… to the server command (set-env.sh writes it to sessions/.env)', () => {
    const cmd = 'make seats PIXEL_CLASH_URL=http://192.168.8.10:8080 SEAT_SECRET=otter-lamp-quartz-ninety';
    expect(wizardSetupCommand(cmd, 'codex')).toBe(`${cmd} AGENT=codex`);
    expect(wizardSetupCommand(cmd, 'claude')).toBe(`${cmd} AGENT=claude`);
    expect(wizardSetupCommand(null, 'claude')).toBeNull();
    expect(maskedSetupCommand('codex')).not.toContain('otter');
  });
});
