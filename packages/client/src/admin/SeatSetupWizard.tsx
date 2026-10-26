// "Set up AI seats": the banner on top of /admin
// while the AI seats aren't usable yet, and the step-by-step wizard it opens
// (also from AI seats → Setup wizard). Each step says what to do; its ✓ comes
// from the seats DTO the server pushes (seatSetupSteps.ts), so the facilitator
// sees which step fails. The AI seats tab stays the detailed settings page;
// the wizard reuses its pieces (BoxAddress, BoxSetup, AgentLogin).

import { useEffect, useState } from 'preact/hooks';
import type { AdminClaudeSeatsDTO } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { cx } from '../common/ui.js';
import { AgentLogin, BoxAddress, BoxSetup, STATUS_TEXT } from './ClaudeSeats.js';
import { useAdmin } from './context.js';
import {
  connectHints,
  effectiveAgent,
  firstOpenStep,
  seatsReady,
  WIZARD_STEP_IDS,
  wizardSteps,
  type WizardAgent,
  type WizardInput,
  type WizardStep,
  type WizardStepId,
} from './seatSetupSteps.js';
import { loadPref, savePref } from './Settings.js';

const PREF_AGENT = 'seatWizard:agent';
const PREF_OWN = 'seatWizard:ownLogins';
const PREF_DISMISSED = 'seatWizard:dismissed';

const parseAgent = (v: string): WizardAgent | null => (v === 'claude' || v === 'codex' ? v : null);

/** The banner + the wizard; `open` lives in the console so the AI seats tab can open it too. */
export function SeatWizardHost({ open, setOpen }: { open: boolean; setOpen: (on: boolean) => void }) {
  const { seats } = useAdmin();
  const [agent, setAgentState] = useState<WizardAgent | null>(() => parseAgent(loadPref(PREF_AGENT, '')));
  const [ownLogins, setOwnState] = useState(() => loadPref(PREF_OWN, '0') === '1');
  const [dismissed, setDismissedState] = useState(() => loadPref(PREF_DISMISSED, '0') === '1');
  const setAgent = (a: WizardAgent) => {
    setAgentState(a);
    savePref(PREF_AGENT, a);
  };
  const setOwnLogins = (on: boolean) => {
    setOwnState(on);
    savePref(PREF_OWN, on ? '1' : '0');
  };
  const dismiss = () => {
    setDismissedState(true);
    savePref(PREF_DISMISSED, '1');
  };

  const input: WizardInput = { seats, agent, ownLogins };
  const steps = wizardSteps(input);
  const ready = seatsReady(input);
  const doneCount = steps.filter((s) => s.id !== 'done' && s.state === 'done').length;

  return (
    <>
      {seats && !ready && !dismissed && !open && (
        <div class="seat-wizard-banner" role="region" aria-label="AI seats setup">
          <div>
            <b>The AI seats aren't set up yet.</b>{' '}
            <span class="small">
              Each player's AI helper runs in a seat on the AI session host. The setup wizard takes you through it ({doneCount} of 5 steps done).
            </span>
          </div>
          <div class="btn-row">
            <button class="btn primary" onClick={() => setOpen(true)}>
              Set up AI seats
            </button>
            <button class="btn small" title="Reopen it any time from the AI seats tab → Setup wizard" onClick={dismiss}>
              Not now
            </button>
          </div>
        </div>
      )}
      {open && (
        <SeatWizard steps={steps} input={input} agent={effectiveAgent(input)} setAgent={setAgent} setOwnLogins={setOwnLogins} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const STATE_MARK: Readonly<Record<WizardStep['state'], string>> = { done: '✓', todo: '', problem: '!' };

function SeatWizard(props: {
  steps: WizardStep[];
  input: WizardInput;
  agent: WizardAgent;
  setAgent(a: WizardAgent): void;
  setOwnLogins(on: boolean): void;
  onClose(): void;
}) {
  const { steps, onClose } = props;
  const { seats, setSeats } = useAdmin();
  const [current, setCurrent] = useState<WizardStepId>(() => firstOpenStep(steps));
  const idx = WIZARD_STEP_IDS.indexOf(current);
  const step = steps[idx]!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Live ✓: while a step that depends on the seats is open and not every seat that is on answers, check them every 5 s.
  const allUp = !!seats && seats.seats.some((s) => s.enabled) && seats.seats.every((s) => !s.enabled || s.status === 'up');
  const watching = (current === 'box' || current === 'connect' || current === 'seats') && !!seats?.boxHost && seats.seatSecretSet && !allUp;
  useEffect(() => {
    if (!watching) return;
    let stop = false;
    const check = () =>
      void api.admin
        .checkClaudeSeats()
        .then((d) => !stop && setSeats(d))
        .catch(() => undefined);
    check();
    const t = setInterval(check, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [watching, setSeats]);

  return (
    <div class="wizard-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="wizard panel" role="dialog" aria-modal="true" aria-labelledby="seat-wizard-title">
        <div class="wizard-head">
          <h2 id="seat-wizard-title">Set up AI seats</h2>
          <button class="btn small" onClick={onClose} aria-label="Close the setup wizard">
            Close ✕
          </button>
        </div>
        <div class="wizard-body">
          <ol class="wizard-steps">
            {steps.map((s, i) => (
              <li key={s.id}>
                <button class={cx('wizard-step', `ws-${s.state}`, s.id === current && 'on')} aria-current={s.id === current ? 'step' : undefined} onClick={() => setCurrent(s.id)}>
                  <span class="wizard-num" aria-hidden="true">
                    {STATE_MARK[s.state] || i + 1}
                  </span>
                  <span>
                    <span class="wizard-step-title">{s.title}</span>
                    <span class="wizard-step-sum">{s.summary}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div class="wizard-content">
            <div class={cx('wizard-status', `ws-${step.state}`)} role="status">
              {step.state === 'done' ? '✓ ' : step.state === 'problem' ? '! ' : ''}
              {step.summary}
            </div>
            <StepContent {...props} id={current} goto={setCurrent} />
            <div class="wizard-nav">
              <button class="btn" disabled={idx === 0} onClick={() => setCurrent(WIZARD_STEP_IDS[idx - 1]!)}>
                ← Back
              </button>
              {current === 'done' ? (
                <button class="btn primary" onClick={onClose}>
                  Close
                </button>
              ) : (
                <button class="btn primary" onClick={() => setCurrent(WIZARD_STEP_IDS[idx + 1]!)}>
                  Next →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepContent(props: {
  id: WizardStepId;
  steps: WizardStep[];
  input: WizardInput;
  agent: WizardAgent;
  setAgent(a: WizardAgent): void;
  setOwnLogins(on: boolean): void;
  goto(id: WizardStepId): void;
}) {
  const { seats } = useAdmin();
  switch (props.id) {
    case 'agent':
      return <AgentStep agent={props.input.agent} setAgent={props.setAgent} />;
    case 'login':
      return <LoginStep agent={props.agent} ownLogins={props.input.ownLogins} setOwnLogins={props.setOwnLogins} />;
    case 'box':
      return <BoxStep agent={props.agent} />;
    case 'connect':
      return <ConnectStep seats={seats} goto={props.goto} />;
    case 'seats':
      return <SeatsStep seats={seats} />;
    case 'done':
      return <DoneStep steps={props.steps} goto={props.goto} />;
  }
}

function AgentStep({ agent, setAgent }: { agent: WizardAgent | null; setAgent(a: WizardAgent): void }) {
  const opts: Array<{ id: WizardAgent; name: string; text: string }> = [
    { id: 'claude', name: 'Claude Code', text: 'Anthropic. Logs in with a Claude token (Claude subscription) or an Anthropic API key.' },
    { id: 'codex', name: 'Codex', text: 'OpenAI Codex CLI. Logs in with an OpenAI API key.' },
  ];
  return (
    <div>
      <p>
        Every AI seat runs one coding agent in its terminal, and the players prompt it. Both get the same kit and the same game tools. Pick
        the one you have an account for.
      </p>
      <div class="wizard-choices" role="radiogroup" aria-label="Agent">
        {opts.map((o) => (
          <label key={o.id} class={cx('wizard-choice', agent === o.id && 'on')}>
            <input type="radio" name="seat-agent" checked={agent === o.id} onChange={() => setAgent(o.id)} />
            <span>
              <b>{o.name}</b>
              <span class="dim small"> {o.text}</span>
            </span>
          </label>
        ))}
      </div>
      <p class="dim small">
        The agent is set on the AI session host (AGENT in sessions/.env), not on this server: the command in step 3 sets it for you. To run some
        seats on the other agent, add e.g. <code>SEAT_AGENT_7=codex</code> to sessions/.env on the AI session host and run <code>make seats</code>{' '}
        again (each seat then needs a login for its own agent).
      </p>
    </div>
  );
}

function LoginStep({ agent, ownLogins, setOwnLogins }: { agent: WizardAgent; ownLogins: boolean; setOwnLogins(on: boolean): void }) {
  const { seats } = useAdmin();
  return (
    <div>
      {agent === 'claude' ? (
        <p>
          Paste one Claude login here and every seat's agent starts with it. To get a token: on any computer with Claude Code logged in to
          the event account, run <code>claude setup-token</code> in a terminal and paste the token it prints (starts with sk-ant-oat). An
          Anthropic API key works too.
        </p>
      ) : (
        <p>
          Paste an OpenAI API key (platform.openai.com → API keys) and every Codex seat starts with it. Use a key for the event account
          only.
        </p>
      )}
      <AgentLogin hints={seats?.agentCredentials ?? null} kinds={agent === 'claude' ? ['claudeToken', 'anthropicApiKey'] : ['openaiApiKey']} intro={false} />
      <p class="dim small">
        The login is never shown again (only its last 4 characters), so this is safe on the projector. A seat picks it up the next time its
        terminal opens. Revoke it after the event.
      </p>
      <label class="toggle">
        <input type="checkbox" checked={ownLogins} onChange={(e) => setOwnLogins(e.currentTarget.checked)} />
        Skip: I log in each seat by hand on the AI session host instead (
        <code>make {agent === 'codex' ? 'seat-login-codex' : 'seat-login'} SEAT=n</code> for every seat)
      </label>
    </div>
  );
}

function BoxStep({ agent }: { agent: WizardAgent }) {
  const { seats, showDetails, setShowDetails } = useAdmin();
  const [command, setCommand] = useState<string | null>(null);
  const secretKey = `${seats?.boxHost ?? ''}|${seats?.seatSecretSet ?? false}`;
  useEffect(() => {
    if (!showDetails) {
      setCommand(null);
      return;
    }
    let cancelled = false;
    api.admin
      .claudeSeats(true)
      .then((d: AdminClaudeSeatsDTO) => !cancelled && setCommand(d.setupCommand ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showDetails, secretKey]);
  return (
    <div>
      <p>The AI session host is the computer that runs the seats (one Docker container per seat). It can be this computer or another one on the same network.</p>
      <ol class="wizard-list">
        <li>
          Install <b>Docker</b> on it (Docker Desktop on Mac/Windows, Docker Engine with Compose v2 on Linux) and start it. Plan on about 1
          core and 2 GB of memory per seat.
        </li>
        <li>
          Put a copy of this Pixel Clash repo on it (<code>git clone</code>, or copy the folder) and open a terminal in that folder (the one
          with the Makefile).
        </li>
        <li>Copy the command below and run it there. It saves this server's address, the seat password and the agent in sessions/.env, builds the seat image (the first time takes several minutes) and starts the seats.</li>
      </ol>
      <BoxSetup command={command} show={showDetails} secretSet={seats?.seatSecretSet ?? false} agent={agent}>
        <h3>Command for the AI session host</h3>
      </BoxSetup>
      <label class="toggle">
        <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.currentTarget.checked)} />
        Show the command (it holds the seat password: not on the projector). Copy works either way.
      </label>
      <p class="dim small">
        Fewer seats: add <code>N=4</code> for seats 1-4. Later starts need only <code>make seats</code>. The ✓ appears once a seat answers (after step 4).
      </p>
    </div>
  );
}

function SeatList({ seats, toggles }: { seats: AdminClaudeSeatsDTO; toggles: boolean }) {
  const { act, busy, setSeats } = useAdmin();
  return (
    <ul class="wizard-seats">
      {seats.seats.map((r) => (
        <li key={r.seat} class={cx(!r.enabled && 'off')}>
          {toggles && (
            <input
              type="checkbox"
              checked={r.enabled}
              disabled={busy}
              aria-label={`AI seat ${r.seat} on`}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                void act(() => api.admin.setClaudeSeatEnabled(r.seat, on), on ? `AI seat ${r.seat} is on` : `AI seat ${r.seat} is off`).then((d) => d && setSeats(d));
              }}
            />
          )}
          <b class="claude-seat-num">{r.seat}</b>
          <span>
            <span class={cx('status-dot', `st-${r.status}`)} aria-hidden="true" /> {r.enabled ? STATUS_TEXT[r.status] : 'off'}
            {r.enabled && r.reason && <span class="dim small"> ({r.reason})</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConnectStep({ seats, goto }: { seats: AdminClaudeSeatsDTO | null; goto(id: WizardStepId): void }) {
  const { act, busy, setSeats } = useAdmin();
  const hints = connectHints(seats);
  return (
    <div>
      <p>
        Enter the AI session host's address on the event network (its IP, e.g. 192.168.8.20; on the AI session host: <code>ipconfig getifaddr en0</code>{' '}
        on a Mac, <code>hostname -I</code> on Linux, <code>ipconfig</code> on Windows). Use <code>localhost</code> if the seats run on this
        computer. This server then checks every seat.
      </p>
      <BoxAddress />
      {seats && (
        <>
          <div class="btn-row" style={{ marginTop: 12 }}>
            <h3 style={{ margin: 0 }}>Seats</h3>
            <button
              class="btn small"
              disabled={busy}
              onClick={async () => {
                const r = await act(() => api.admin.checkClaudeSeats(), 'Checked every AI seat');
                if (r) setSeats(r);
              }}
            >
              Check now
            </button>
            <span class="dim small">Checked again every 5 s while this step is open.</span>
          </div>
          <SeatList seats={seats} toggles={false} />
        </>
      )}
      {hints.length > 0 && (
        <div class="wizard-hints">
          <h3>What to try</h3>
          <ul>
            {hints.map((h) => (
              <li key={h.text}>
                {h.seats.length > 0 && <b>Seat {h.seats.join(', ')}: </b>}
                {h.text}
              </li>
            ))}
          </ul>
          {seats?.seats.some((s) => s.status === 'wrong-password') && (
            <button class="btn small" onClick={() => goto('box')}>
              Go to step 3 (the command)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SeatsStep({ seats }: { seats: AdminClaudeSeatsDTO | null }) {
  const { act, busy, setSeats } = useAdmin();
  if (!seats) return <p class="dim">Loading…</p>;
  const mismatched = seats.seats.filter((s) => s.enabled !== (s.status === 'up'));
  const anyUp = seats.seats.some((s) => s.status === 'up');
  return (
    <div>
      <p>
        Turn on one seat per player laptop. Seats that are off are never given to a player;
        players get a free seat that is on when they join.
      </p>
      <SeatList seats={seats} toggles />
      {anyUp && mismatched.length > 0 && (
        <button
          class="btn small"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              let last: AdminClaudeSeatsDTO | null = null;
              for (const s of mismatched) last = await api.admin.setClaudeSeatEnabled(s.seat, s.status === 'up');
              return last;
            }, 'Only the seats that answer are on').then((d) => d && setSeats(d))
          }
        >
          Turn on only the seats that answer
        </button>
      )}
    </div>
  );
}

function DoneStep({ steps, goto }: { steps: WizardStep[]; goto(id: WizardStepId): void }) {
  const ready = steps.find((s) => s.id === 'done')?.state === 'done';
  return (
    <div>
      <p>{ready ? 'The AI seats are ready. Players get a seat when they join, and its terminal shows inside /play.' : 'Not finished yet:'}</p>
      <ul class="wizard-summary">
        {steps
          .filter((s) => s.id !== 'done')
          .map((s) => (
            <li key={s.id} class={`ws-${s.state}`}>
              <span class="wizard-num" aria-hidden="true">
                {STATE_MARK[s.state] || '·'}
              </span>
              <span>
                <b>{s.title}</b>: {s.summary}
              </span>
              {s.state !== 'done' && (
                <button class="btn small" style={{ marginLeft: 8 }} onClick={() => goto(s.id)}>
                  Go
                </button>
              )}
            </li>
          ))}
      </ul>
      <p class="dim small">
        Next: work through the checklist on{' '}
        <a class="link" href="/setup" target="_blank" rel="noopener">
          /setup
        </a>
        . Seat details (players, live terminals, the seat password) are on the AI seats tab.
      </p>
    </div>
  );
}
