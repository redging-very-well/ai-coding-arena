// The "Set up AI seats" wizard in /admin (plan §12.3, §11.1-11.3), DOM-free:
// which steps are done, from the seats DTO the server sends (live ✓), plus
// the two things only this browser knows (the agent picked in step 1, and
// "the seats log in on their own"). Also the troubleshooting hints for seats
// that don't answer, and the setup command with AGENT=… added.

import type { AdminClaudeSeatDTO, AdminClaudeSeatsDTO } from '@pixel-clash/shared';

export type WizardAgent = 'claude' | 'codex';
export type WizardStepId = 'agent' | 'login' | 'box' | 'connect' | 'seats' | 'done';
/** done = confirmed (by the server where it can tell); problem = it was tried and fails; todo = not yet. */
export type WizardStepState = 'done' | 'todo' | 'problem';

export interface WizardInput {
  seats: AdminClaudeSeatsDTO | null;
  /** The agent picked in step 1 (this browser), or null. */
  agent: WizardAgent | null;
  /** Ticked in step 2: each seat logs in with its own stored login (make seat-login), no shared login. */
  ownLogins: boolean;
}

export interface WizardStep {
  id: WizardStepId;
  title: string;
  state: WizardStepState;
  /** One line under the title: what is confirmed, or what's missing. */
  summary: string;
}

export const WIZARD_STEP_IDS: readonly WizardStepId[] = ['agent', 'login', 'box', 'connect', 'seats', 'done'];

const AGENT_NAME: Readonly<Record<WizardAgent, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** The agent to assume: the one picked, else a guess from the shared logins (only an OpenAI key → Codex), else Claude Code. */
export function effectiveAgent(input: Pick<WizardInput, 'seats' | 'agent'>): WizardAgent {
  if (input.agent) return input.agent;
  const c = input.seats?.agentCredentials;
  if (c && c.openaiApiKey && !c.claudeToken && !c.anthropicApiKey) return 'codex';
  return 'claude';
}

/** A shared login exists for this agent (Claude: token or Anthropic key; Codex: OpenAI key). */
export function hasSharedLogin(seats: AdminClaudeSeatsDTO | null, agent: WizardAgent): boolean {
  const c = seats?.agentCredentials;
  if (!c) return false;
  return agent === 'codex' ? !!c.openaiApiKey : !!(c.claudeToken || c.anthropicApiKey);
}

const enabledSeats = (seats: AdminClaudeSeatsDTO | null): AdminClaudeSeatDTO[] => (seats?.seats ?? []).filter((s) => s.enabled);
/** Seats that answered at all: up, or wrong password (ttyd is there, the password differs). */
const answering = (rows: AdminClaudeSeatDTO[]) => rows.filter((s) => s.status === 'up' || s.status === 'wrong-password');

export function wizardSteps(input: WizardInput): WizardStep[] {
  const { seats } = input;
  const agent = effectiveAgent(input);
  const all = seats?.seats ?? [];
  const on = enabledSeats(seats);
  const upOn = on.filter((s) => s.status === 'up');
  const wrong = all.filter((s) => s.status === 'wrong-password');
  const anyUp = all.some((s) => s.status === 'up');
  const anyAnswer = answering(all).length > 0;
  const checked = all.some((s) => s.status === 'up' || s.status === 'down' || s.status === 'wrong-password');

  const agentStep: WizardStep = input.agent
    ? { id: 'agent', title: 'Pick the agent', state: 'done', summary: `${AGENT_NAME[input.agent]} on every seat` }
    : anyUp
      ? { id: 'agent', title: 'Pick the agent', state: 'done', summary: `Seats are running (assuming ${AGENT_NAME[agent]})` }
      : { id: 'agent', title: 'Pick the agent', state: 'todo', summary: 'Claude Code or Codex' };

  const shared = hasSharedLogin(seats, agent);
  const loginStep: WizardStep = shared
    ? { id: 'login', title: 'Agent login', state: 'done', summary: `Shared ${agent === 'codex' ? 'OpenAI key' : 'Claude login'} saved` }
    : input.ownLogins
      ? { id: 'login', title: 'Agent login', state: 'done', summary: 'Each seat uses its own login (make seat-login)' }
      : {
          id: 'login',
          title: 'Agent login',
          state: 'todo',
          summary: agent === 'codex' ? 'No OpenAI key saved yet' : 'No Claude token or Anthropic key saved yet',
        };

  const boxStep: WizardStep = !seats?.seatSecretSet
    ? { id: 'box', title: 'Start the seats on the AI session host', state: 'problem', summary: 'No seat password yet: set one on the AI seats tab' }
    : anyAnswer
      ? { id: 'box', title: 'Start the seats on the AI session host', state: 'done', summary: `${answering(all).length} seat(s) answer from the AI session host` }
      : { id: 'box', title: 'Start the seats on the AI session host', state: 'todo', summary: 'Run the make seats command on the AI session host' };

  let connectStep: WizardStep;
  if (!seats?.boxHost) connectStep = { id: 'connect', title: 'Connect', state: 'todo', summary: 'Enter the AI session host address' };
  else if (wrong.length > 0)
    connectStep = { id: 'connect', title: 'Connect', state: 'problem', summary: `Wrong seat password on seat ${wrong.map((s) => s.seat).join(', ')}` };
  else if (anyUp) connectStep = { id: 'connect', title: 'Connect', state: 'done', summary: `Connected to ${seats.boxHost}` };
  else if (checked) connectStep = { id: 'connect', title: 'Connect', state: 'problem', summary: `No seat answers at ${seats.boxHost}` };
  else connectStep = { id: 'connect', title: 'Connect', state: 'todo', summary: `Checking ${seats.boxHost}…` };

  let seatsStep: WizardStep;
  if (on.length === 0) seatsStep = { id: 'seats', title: 'Choose the seats', state: 'problem', summary: 'Every seat is off' };
  else if (!anyUp) seatsStep = { id: 'seats', title: 'Choose the seats', state: 'todo', summary: `${on.length} seat(s) on, none answering yet` };
  else if (upOn.length === on.length) seatsStep = { id: 'seats', title: 'Choose the seats', state: 'done', summary: `${on.length} seat(s) on, all answering` };
  else
    seatsStep = {
      id: 'seats',
      title: 'Choose the seats',
      state: 'problem',
      summary: `Only ${upOn.length} of the ${on.length} seats that are on answer: turn off the ones you don't run`,
    };

  const ready = seatsReady(input);
  const doneStep: WizardStep = ready
    ? { id: 'done', title: 'Done', state: 'done', summary: `${upOn.length} AI seat(s) ready` }
    : { id: 'done', title: 'Done', state: 'todo', summary: 'Finish the steps above' };

  return [agentStep, loginStep, boxStep, connectStep, seatsStep, doneStep];
}

/**
 * The AI seats are usable (the banner hides): the AI session host address is set,
 * a login exists for the agent (shared, or "own logins" ticked), and at least
 * one seat that is on answers with the right password.
 */
export function seatsReady(input: WizardInput): boolean {
  const { seats } = input;
  if (!seats?.boxHost || !seats.seatSecretSet) return false;
  if (!hasSharedLogin(seats, effectiveAgent(input)) && !input.ownLogins) return false;
  return enabledSeats(seats).some((s) => s.status === 'up');
}

/** The first step that isn't done (where the wizard opens), else 'done'. */
export function firstOpenStep(steps: readonly WizardStep[]): WizardStepId {
  return steps.find((s) => s.state !== 'done')?.id ?? 'done';
}

export interface SeatHint {
  /** The seats it applies to (empty = all / none in particular). */
  seats: number[];
  text: string;
}

const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'timeout', 'ETIMEDOUT']);
const NO_NAME = new Set(['ENOTFOUND', 'EAI_AGAIN']);

/**
 * What to try for the seats that don't answer, grouped by cause, for the
 * Connect step. Seats that are off are left out. Empty when everything that
 * is on answers.
 */
export function connectHints(seats: AdminClaudeSeatsDTO | null): SeatHint[] {
  if (!seats) return [];
  const out: SeatHint[] = [];
  if (!seats.boxHost) out.push({ seats: [], text: 'Enter the AI session host address above: its IP on the event network, e.g. 192.168.8.20.' });
  if (!seats.seatSecretSet) out.push({ seats: [], text: 'No seat password: set one on the AI seats tab, then run the make seats command again.' });
  if (out.length) return out;

  const on = enabledSeats(seats);
  const by = (pred: (s: AdminClaudeSeatDTO) => boolean) => on.filter(pred).map((s) => s.seat);
  const anyUp = on.some((s) => s.status === 'up');

  const wrong = by((s) => s.status === 'wrong-password');
  if (wrong.length)
    out.push({
      seats: wrong,
      text: "Wrong seat password: SEAT_SECRET in sessions/.env on the AI session host isn't this server's. Copy the make seats command again (step 3) and run it on the AI session host.",
    });

  const refused = by((s) => s.status === 'down' && s.reason === 'ECONNREFUSED');
  if (refused.length)
    out.push({
      seats: refused,
      text: anyUp
        ? 'The AI session host answers, but nothing listens on these seats: they are not started (e.g. make seats N=4 starts 1-4 only). Start them, or turn them off in step 5.'
        : 'The AI session host answers, but no seat is running. Run the make seats command (the first run builds the image: wait until it finishes), then make seats-ps to see them. If it failed, run it again and read the error.',
    });

  const unreachable = by((s) => s.status === 'down' && UNREACHABLE.has(s.reason ?? ''));
  if (unreachable.length)
    out.push({
      seats: unreachable,
      text: `No answer from ${seats.boxHost}: check the address (on the AI session host: ip addr or ipconfig), that both machines are on the same network, that the AI session host allows inbound TCP 7781-7788 from this server (firewall) and that it isn't asleep.`,
    });

  const noName = by((s) => s.status === 'down' && NO_NAME.has(s.reason ?? ''));
  if (noName.length) out.push({ seats: noName, text: `This server can't look up the name ${seats.boxHost}: use the AI session host's IP address instead.` });

  const known = new Set([...wrong, ...refused, ...unreachable, ...noName]);
  const other = by((s) => s.status === 'down' && !known.has(s.seat));
  if (other.length)
    out.push({
      seats: other,
      text: `These seats don't answer (${[...new Set(on.filter((s) => other.includes(s.seat)).map((s) => s.reason ?? 'no answer'))].join(', ')}). Check the address and the firewall, and make seats-logs SEAT=n on the AI session host.`,
    });

  const unknown = by((s) => s.status === 'unknown');
  if (unknown.length && !anyUp) out.push({ seats: unknown, text: 'Not checked yet: press Check now.' });
  return out;
}

/**
 * The server's `make seats PIXEL_CLASH_URL=… SEAT_SECRET=…` with `AGENT=…`
 * added, so the AI session host runs the agent picked in step 1 (set-env.sh writes
 * it into sessions/.env; SEAT_AGENT_N overrides there stay).
 */
export function wizardSetupCommand(serverCommand: string | null | undefined, agent: WizardAgent): string | null {
  if (!serverCommand) return null;
  return `${serverCommand} AGENT=${agent}`;
}

/** The command with the seat password masked, for when "Show details" is off (the page may be on the projector). */
export function maskedSetupCommand(agent: WizardAgent): string {
  return `make seats PIXEL_CLASH_URL=… SEAT_SECRET=… AGENT=${agent}`;
}
