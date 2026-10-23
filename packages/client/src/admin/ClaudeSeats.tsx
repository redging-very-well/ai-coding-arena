// Claude seats panel (plan §12.3, §11.2): the Claude box address, the shared
// seat password (the value only with "Show details" on, since this page may be
// on the projector), the seats 1-8 with live status, assigned player
// (reassign / Unassign), who holds the live terminal, and "Open terminal"
// (rescue: the seat's terminal through the proxy, in its own tab).

import { useEffect, useState } from 'preact/hooks';
import type { AdminClaudeSeatDTO, AdminClaudeSeatsDTO, ClaudeSeatStatus } from '@pixel-clash/shared';
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
        <h2>Claude seats</h2>
        <label class="toggle">
          <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.currentTarget.checked)} />
          Show details
        </label>
        <button
          class="btn small"
          disabled={busy}
          onClick={async () => {
            const r = await act(() => api.admin.checkClaudeSeats(), 'Checked every Claude seat');
            if (r) setSeats(r);
          }}
        >
          Check now
        </button>
      </div>
      {wrong.length > 0 && (
        <div class="banner-bad" role="alert">
          The seat password here doesn't match SEAT_SECRET on the Claude box (seat {wrong.join(', ')}). Enter the value from sessions/.env below.
        </div>
      )}

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

      <SeatPassword set={seats?.seatSecretSet ?? false} value={details?.seatSecret ?? null} show={showDetails} onSave={saveSetup} />

      <h3>Seats</h3>
      <div class="table-wrap">
        <table class="seat-table">
          <thead>
            <tr>
              <th>Seat</th>
              <th>Status</th>
              <th>Player</th>
              <th>Live terminal</th>
              <th />
              {showDetails && <th>Direct URL</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seat}>
                <td>
                  <b class="claude-seat-num">{r.seat}</b>
                </td>
                <td title={r.checkedAt ? `checked ${ago(r.checkedAt, now)}` : 'not checked yet'}>
                  <span class={cx('status-dot', `st-${r.status}`)} aria-hidden="true" /> {STATUS_TEXT[r.status]}
                  {r.reason && <div class="dim small">{r.reason}</div>}
                </td>
                <td>
                  <select
                    value={r.playerId ?? ''}
                    disabled={busy}
                    aria-label={`Player on Claude seat ${r.seat}`}
                    onChange={(e) => {
                      const id = e.currentTarget.value || null;
                      const name = players.find((p) => p.id === id)?.name;
                      void act(
                        () => api.admin.assignClaudeSeat(r.seat, id),
                        id ? `Claude seat ${r.seat} is now ${name ?? 'assigned'}'s` : `Claude seat ${r.seat} is free`,
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
                        void act(() => api.admin.assignClaudeSeat(r.seat, null), `Claude seat ${r.seat} is free`).then((d) => d && setSeats(d))
                      }
                    >
                      Unassign
                    </button>
                  )}
                </td>
                <td>{liveText(r.live, now)}</td>
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
        One live terminal per seat: the newest wins. "Open terminal" takes over the player's terminal until they press "Use it here
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

function SeatPassword(props: { set: boolean; value: string | null; show: boolean; onSave: (patch: { seatSecret: string | null }, okText: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const valid = SEAT_SECRET_RE.test(text.trim());
  return (
    <div class="seat-secret">
      <h3>Seat password</h3>
      <p class="dim small">
        The same value as SEAT_SECRET in sessions/.env on the Claude box. Players never see it: this server adds it for them.
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
