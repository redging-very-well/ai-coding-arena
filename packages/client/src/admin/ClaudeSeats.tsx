// Claude seats panel (plan §12.3, §11.2): the Claude box address, the shared
// seat password (the value only with "Show details" on, since this page may be
// on the projector), the "Claude box setup" command (`make seats
// PIXEL_CLASH_URL=… SEAT_SECRET=…`, which writes sessions/.env on the Claude
// box; shown only with "Show details", copyable either way), the seats 1-8 with an On switch (off = never assigned or
// pickable; turning off a held seat moves its player to another free seat),
// live status, assigned player (reassign / Unassign), who holds the live
// terminal, and "Open terminal" (rescue: the seat's terminal through the
// proxy, in its own tab). "Agent login" (§11.2 f): the shared Claude Code
// token / API keys every seat's agent starts with, write-only (only "…last 4"
// ever comes back), and per seat which shared login its last start fetched.

import { useEffect, useState } from 'preact/hooks';
import type { AdminClaudeSeatDTO, AdminClaudeSeatsDTO, AgentCredentialKind, ClaudeSeatStatus, SeatCredentialEnv } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { copyText, cx } from '../common/ui.js';
import { adminTerminalTabName, terminalPath } from '../play/claudePane.js';
import { updateSetupSettings } from '../setup/setupApi.js';
import { useAdmin } from './context.js';

/** Same rule as the server (§11.2 a): ttyd's `-c player:<secret>` can't take spaces or ':'. */
export const SEAT_SECRET_RE = /^[A-Za-z0-9._~-]{12,64}$/;

export const STATUS_TEXT: Readonly<Record<ClaudeSeatStatus, string>> = {
  up: 'up',
  down: 'down',
  'wrong-password': 'wrong password',
  'no-box': 'no box address',
  'no-password': 'no seat password',
  unknown: 'not checked yet',
};

/** "12 s ago", "3 min ago". */
function ago(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Same shapes as the server (§11.2 f). Whitespace is removed before the check (wrapped pastes). */
export const AGENT_CREDENTIAL_RE: Readonly<Record<AgentCredentialKind, RegExp>> = {
  claudeToken: /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/,
  anthropicApiKey: /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,500}$/,
  openaiApiKey: /^(?!sk-ant-)sk-[A-Za-z0-9_-]{20,500}$/,
};

const SHARED_LOGIN_TEXT: Readonly<Record<SeatCredentialEnv, string>> = {
  CLAUDE_CODE_OAUTH_TOKEN: 'shared Claude token',
  ANTHROPIC_API_KEY: 'shared Anthropic key',
  OPENAI_API_KEY: 'shared OpenAI key',
};

function liveText(live: AdminClaudeSeatDTO['live'], now: number): string {
  if (!live) return '–';
  const since = ago(live.since, now).replace(' ago', '');
  if (live.by === 'admin') return `admin (${since})`;
  return `${live.playerName ?? 'player'}, ${live.pane ? 'embedded' : 'own tab'} (${since})`;
}

export function ClaudeSeats() {
  const { seats, setup, overview, act, busy, showDetails, setShowDetails, setSetup, setSeats } = useAdmin();
  const [details, setDetails] = useState<AdminClaudeSeatsDTO | null>(null);
  const [now, setNow] = useState(Date.now());
  const [boxHost, setBoxHost] = useState('');
  const savedHost = setup?.settings.claudeBoxHost ?? '';
  useEffect(() => setBoxHost(savedHost), [savedHost]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // The secret fields only while "Show details" is on; refetched when the box or password changes.
  const secretKey = `${seats?.boxHost ?? ''}|${seats?.seatSecretSet ?? false}`;
  useEffect(() => {
    if (!showDetails) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    api.admin
      .claudeSeats(true)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showDetails, secretKey]);

  const saveSetup = async (patch: Parameters<typeof updateSetupSettings>[0], okText: string) => {
    const r = await act(() => updateSetupSettings(patch), okText);
    if (r) {
      setSetup(r);
      // The probe re-checks every seat on setup changes; show the result soon.
      setTimeout(() => void api.admin.claudeSeats().then(setSeats).catch(() => undefined), 1500);
    }
    return !!r;
  };

  const rows = seats?.seats ?? [];
  const wrong = rows.filter((r) => r.status === 'wrong-password').map((r) => r.seat);
  const directOf = (seat: number) => details?.seats.find((d) => d.seat === seat)?.directUrl;
  const players = overview?.players ?? [];

  return (
    <section class="panel claude-seats">
      <div class="panel-head">
        <h2>AI seats</h2>
        <label class="toggle">
          <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.currentTarget.checked)} />
          Show details
        </label>
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
      </div>
      {wrong.length > 0 && (
        <div class="banner-bad" role="alert">
          The seat password here doesn't match SEAT_SECRET on the Claude box (seat {wrong.join(', ')}). Run the Claude box setup command below on the
          Claude box again, or enter the value from its sessions/.env below.
        </div>
      )}

      <p class="dim small">Each seat runs Claude Code or Codex (AGENT in sessions/.env).</p>

      <h3>Claude box</h3>
      <p class="dim small">
        The machine running the seat containers. Players reach their seat's terminal through this server at /terminal/N/, inside /play.
      </p>
      <form
        class="btn-row"
        onSubmit={(e) => {
          e.preventDefault();
          const v = boxHost.trim();
          void saveSetup({ claudeBoxHost: v || null }, v ? 'Claude box address saved' : 'Claude box address cleared');
        }}
      >
        <input placeholder="e.g. 192.168.8.20" value={boxHost} onInput={(e) => setBoxHost(e.currentTarget.value)} />
        <button class="btn" disabled={busy || boxHost.trim() === savedHost}>
          Save
        </button>
      </form>

      <BoxSetup command={details?.setupCommand ?? null} show={showDetails} secretSet={seats?.seatSecretSet ?? false} />

      <SeatPassword set={seats?.seatSecretSet ?? false} value={details?.seatSecret ?? null} show={showDetails} onSave={saveSetup} />

      <AgentLogin hints={seats?.agentCredentials ?? null} />

      <h3>Seats</h3>
      <div class="table-wrap">
        <table class="seat-table">
          <thead>
            <tr>
              <th>Seat</th>
              <th>On</th>
              <th>Status</th>
              <th>Player</th>
              <th>Live terminal</th>
              <th title="Which shared agent login the seat's last terminal start fetched">Agent login</th>
              <th />
              {showDetails && <th>Direct URL</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seat} style={r.enabled ? undefined : { opacity: 0.55 }}>
                <td>
                  <b class="claude-seat-num">{r.seat}</b>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy}
                    aria-label={`AI seat ${r.seat} on`}
                    title={r.enabled ? 'Turn this seat off: nobody gets it' : 'Turn this seat on'}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      const moved = !on && r.playerName ? ` (${r.playerName} moves to another free seat)` : '';
                      void act(() => api.admin.setClaudeSeatEnabled(r.seat, on), on ? `AI seat ${r.seat} is on` : `AI seat ${r.seat} is off${moved}`).then(
                        (d) => d && setSeats(d),
                      );
                    }}
                  />
                </td>
                <td title={r.checkedAt ? `checked ${ago(r.checkedAt, now)}` : 'not checked yet'}>
                  <span class={cx('status-dot', `st-${r.status}`)} aria-hidden="true" /> {STATUS_TEXT[r.status]}
                  {r.reason && <div class="dim small">{r.reason}</div>}
                </td>
                <td>
                  <select
                    value={r.playerId ?? ''}
                    disabled={busy || !r.enabled}
                    aria-label={`Player on AI seat ${r.seat}`}
                    onChange={(e) => {
                      const id = e.currentTarget.value || null;
                      const name = players.find((p) => p.id === id)?.name;
                      void act(
                        () => api.admin.assignClaudeSeat(r.seat, id),
                        id ? `AI seat ${r.seat} is now ${name ?? 'assigned'}'s` : `AI seat ${r.seat} is free`,
                      ).then((d) => d && setSeats(d));
                    }}
                  >
                    <option value="">– nobody –</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.claudeSeat !== null && p.claudeSeat !== r.seat ? ` (now seat ${p.claudeSeat})` : ''}
                      </option>
                    ))}
                  </select>{' '}
                  {r.playerId && (
                    <button
                      class="btn small"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.admin.assignClaudeSeat(r.seat, null), `AI seat ${r.seat} is free`).then((d) => d && setSeats(d))
                      }
                    >
                      Unassign
                    </button>
                  )}
                </td>
                <td>{liveText(r.live, now)}</td>
                <td title={r.sharedLogin ? `fetched ${ago(r.sharedLogin.at, now)}` : 'No shared login fetched since the server started: the seat uses its own stored login, if any'}>
                  {r.sharedLogin ? SHARED_LOGIN_TEXT[r.sharedLogin.env] : <span class="dim">–</span>}
                </td>
                <td>
                  <OpenTerminal row={r} />
                </td>
                {showDetails && (
                  <td>
                    {directOf(r.seat) ? (
                      <code class="direct-url" title="Click to copy" onClick={() => void copyText(directOf(r.seat)!)}>
                        {directOf(r.seat)}
                      </code>
                    ) : (
                      <span class="dim">–</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="dim small">
        Players get a free seat by themselves when they join (their laptop's seat if free, else the lowest free one). Seats that are
        off are never given out. One live terminal per seat: the newest wins. "Open terminal" takes over the player's terminal until they press "Use it here
        instead" on /play.
        {showDetails && ' Direct URLs bypass this server (user "player" + the seat password): the grown-ups\' fallback.'}
      </p>
    </section>
  );
}

/** Rescue: the seat's terminal through the proxy in a named tab; asks first when a player is using it. */
function OpenTerminal({ row }: { row: AdminClaudeSeatDTO }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [row.live?.since]);
  const link = (
    <a class="btn small" href={terminalPath(row.seat)} target={adminTerminalTabName(row.seat)} onClick={() => setConfirm(false)}>
      {confirm ? 'Open anyway ↗' : 'Open terminal ↗'}
    </a>
  );
  if (row.live?.by !== 'player' || confirm) {
    return (
      <span class="open-term">
        {confirm && <span class="warn-text small">Takes over {row.live?.playerName ?? 'the player'}'s terminal. </span>}
        {link}
      </span>
    );
  }
  return (
    <button class="btn small" onClick={() => setConfirm(true)}>
      Open terminal…
    </button>
  );
}

/**
 * The one command the Claude box needs (§11.1): run in the repo there, it
 * writes PIXEL_CLASH_URL and SEAT_SECRET into sessions/.env and starts the
 * seats. It carries the seat password, so the text shows only with "Show
 * details"; Copy works either way (it fetches the details just for the copy).
 */
function BoxSetup(props: { command: string | null; show: boolean; secretSet: boolean }) {
  const { act, busy } = useAdmin();
  const copy = () =>
    act(async () => {
      const cmd = props.command ?? (await api.admin.claudeSeats(true)).setupCommand ?? null;
      if (!cmd) throw new Error('No seat password yet: set one below first.');
      if (!(await copyText(cmd))) throw new Error("Couldn't copy: turn on Show details and copy the command by hand.");
    }, 'Setup command copied: paste it in the repo folder on the Claude box');
  return (
    <div class="box-setup">
      <h3>Claude box setup</h3>
      <p class="dim small">
        Run this in the Pixel Clash repo folder on the Claude box: it saves this server's address and the seat password in sessions/.env and
        starts the seats (add N=4 for seats 1-4 only). Later starts need only <code>make seats</code>.
      </p>
      {props.secretSet ? (
        <div class="btn-row">
          {props.show && props.command ? <code class="secret" style={{ wordBreak: 'break-all', userSelect: 'all' }}>{props.command}</code> : <span class="dim">make seats PIXEL_CLASH_URL=… SEAT_SECRET=…</span>}
          <button class="btn small" disabled={busy} onClick={() => void copy()}>
            Copy
          </button>
        </div>
      ) : (
        <p class="warn-text small">No seat password yet: set one below, then the command appears here.</p>
      )}
    </div>
  );
}

function SeatPassword(props: { set: boolean; value: string | null; show: boolean; onSave: (patch: { seatSecret: string | null }, okText: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const valid = SEAT_SECRET_RE.test(text.trim());
  return (
    <div class="seat-secret">
      <h3>Seat password</h3>
      <p class="dim small">
        The same value as SEAT_SECRET in sessions/.env on the Claude box (this server made one up on its first start; the setup command above
        carries it). Players never see it: this server adds it for them. After changing it, run the setup command on the Claude box again.
      </p>
      {!editing ? (
        <div class="btn-row">
          <span>
            Seat password:{' '}
            {props.set ? (
              props.show && props.value ? (
                <code class="secret">{props.value}</code>
              ) : (
                <b class="yes">set ✓</b>
              )
            ) : (
              <b class="error">not set</b>
            )}
          </span>
          {props.set && props.show && props.value && (
            <button class="btn small" onClick={() => void copyText(props.value!)}>
              Copy
            </button>
          )}
          <button
            class="btn small"
            onClick={() => {
              setText('');
              setEditing(true);
            }}
          >
            {props.set ? 'Change' : 'Set'}
          </button>
        </div>
      ) : (
        <form
          class="btn-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valid) return;
            if (await props.onSave({ seatSecret: text.trim() }, 'Seat password saved')) {
              setEditing(false);
              setText('');
            }
          }}
        >
          <input
            type={props.show ? 'text' : 'password'}
            autoComplete="off"
            spellcheck={false}
            placeholder="e.g. otter-lamp-quartz-ninety"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <button class="btn primary" disabled={!valid}>
            Save
          </button>
          <button type="button" class="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
          {text && !valid && <span class="warn-text small">12-64 characters: letters, digits, . _ ~ - (no spaces or :)</span>}
        </form>
      )}
    </div>
  );
}

const AGENT_FIELDS: ReadonlyArray<{ kind: AgentCredentialKind; label: string; placeholder: string; help: string }> = [
  {
    kind: 'claudeToken',
    label: 'Claude Code token',
    placeholder: 'sk-ant-oat01-…',
    help: 'Claude seats. Run `claude setup-token` on any machine logged in to the event account and paste the token it prints.',
  },
  {
    kind: 'anthropicApiKey',
    label: 'Anthropic API key (optional)',
    placeholder: 'sk-ant-api03-…',
    help: 'Claude seats, instead of the token (the token wins when both are set). From console.anthropic.com → API keys.',
  },
  {
    kind: 'openaiApiKey',
    label: 'OpenAI API key',
    placeholder: 'sk-…',
    help: 'Codex seats. From platform.openai.com → API keys.',
  },
];

/**
 * The shared agent logins (§11.2 f). Write-only: once saved, the page only
 * ever gets "…last 4" back, so it is safe on the projector.
 */
function AgentLogin({ hints }: { hints: AdminClaudeSeatsDTO['agentCredentials'] | null }) {
  const { act, busy, setSeats } = useAdmin();
  const [editing, setEditing] = useState<AgentCredentialKind | null>(null);
  const [text, setText] = useState('');
  const value = text.replace(/\s+/g, '');
  const save = async (kind: AgentCredentialKind, v: string | null, okText: string) => {
    const r = await act(() => api.admin.setAgentCredentials({ [kind]: v }), okText);
    if (r) {
      setSeats(r);
      setEditing(null);
      setText('');
    }
  };
  return (
    <div class="agent-login">
      <h3>Agent login</h3>
      <p class="dim small">
        Paste one login here and every seat's agent starts with it (the next time its terminal opens), so no seat needs its own /login.
        Without one, each seat uses the login stored in it. Any seat's agent can read this login, so use a dedicated event account and
        revoke the token or keys after the event.
      </p>
      {AGENT_FIELDS.map((f) => {
        const hint = hints?.[f.kind] ?? null;
        const valid = AGENT_CREDENTIAL_RE[f.kind].test(value);
        return (
          <div key={f.kind} class="agent-cred">
            {editing !== f.kind ? (
              <div class="btn-row">
                <span>
                  {f.label}: {hint ? <b class="yes">set ({hint})</b> : <span class="dim">not set</span>}
                </span>
                <button
                  class="btn small"
                  disabled={busy}
                  onClick={() => {
                    setText('');
                    setEditing(f.kind);
                  }}
                >
                  {hint ? 'Replace' : 'Set'}
                </button>
                {hint && (
                  <button class="btn small" disabled={busy} onClick={() => void save(f.kind, null, `${f.label.replace(/ \(optional\)$/, '')} cleared`)}>
                    Clear
                  </button>
                )}
              </div>
            ) : (
              <form
                class="btn-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (valid) void save(f.kind, value, `${f.label.replace(/ \(optional\)$/, '')} saved`);
                }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellcheck={false}
                  aria-label={f.label}
                  placeholder={f.placeholder}
                  value={text}
                  onInput={(e) => setText(e.currentTarget.value)}
                />
                <button class="btn primary" disabled={busy || !valid}>
                  Save
                </button>
                <button type="button" class="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                {text && !valid && <span class="warn-text small">Should look like {f.placeholder}</span>}
              </form>
            )}
            <p class="dim small">{f.help}</p>
          </div>
        );
      })}
    </div>
  );
}
