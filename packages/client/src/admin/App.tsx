// The facilitator page /admin (plan §12.3): login, then phase controls,
// players, Claude seats (§11.2), details (rosters/sprites, behind a toggle),
// config, server info.

import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../common/api.js';
import { cx } from '../common/ui.js';
import { AdminContext, type AdminCtx } from './context.js';
import { ClaudeSeats } from './ClaudeSeats.js';
import { ConfigEditor } from './ConfigEditor.js';
import { Details } from './Details.js';
import { PhaseControls } from './PhaseControls.js';
import { PlayersTable } from './PlayersTable.js';
import { ServerInfo } from './ServerInfo.js';
import { errorText, useAdminData } from './useAdmin.js';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    api.admin
      .session()
      .then((s) => setAuthed(s.admin))
      .catch(() => setAuthed(false));
  }, []);
  if (authed === null) return <p class="center dim">Loading…</p>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Console onLoggedOut={() => setAuthed(false)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.admin.login(password.trim());
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="login panel" onSubmit={submit}>
      <h1>Pixel Clash</h1>
      <p class="dim">Facilitator login. The password is printed in the server terminal at startup (or set with ADMIN_PASSWORD).</p>
      <label>
        Password
        <input type="password" autoFocus autoComplete="current-password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
      </label>
      <button class="btn primary" disabled={busy || !password.trim()}>
        Log in
      </button>
      {error && <p class="error">{error}</p>}
    </form>
  );
}

function Console({ onLoggedOut }: { onLoggedOut: () => void }) {
  const data = useAdminData();
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const { notify, refresh } = data;

  const act = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (okText) notify('ok', typeof okText === 'function' ? okText(r) : okText);
        void refresh();
        return r;
      } catch (err) {
        notify('error', errorText(err));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [notify, refresh],
  );

  useEffect(() => {
    if (data.lostSession) onLoggedOut();
  }, [data.lostSession, onLoggedOut]);

  const ctx: AdminCtx = useMemo(() => ({ ...data, act, busy, showDetails, setShowDetails }), [data, act, busy, showDetails]);
  const sandbox = data.state?.sandboxMode ?? data.setup?.sandboxMode;

  const logout = async () => {
    await act(() => api.admin.logout());
    onLoggedOut();
  };

  return (
    <AdminContext.Provider value={ctx}>
      <header class="topbar">
        <h1>Pixel Clash · Admin</h1>
        <span class={cx('ws', `ws-${data.wsStatus}`)} title="Live connection to the game server">
          {data.wsStatus === 'open' ? '● live' : data.wsStatus === 'connecting' ? '◌ connecting…' : '○ offline, retrying…'}
        </span>
        <a class="link" href="/setup" target="_blank" rel="noopener">
          /setup
        </a>
        <a class="link" href="/screen" target="_blank" rel="noopener">
          /screen
        </a>
        <button class="btn small" onClick={logout}>
          Log out
        </button>
      </header>
      {sandbox && sandbox !== 'ivm' && (
        <div class="banner-bad" role="alert">
          Sandbox mode is <b>{sandbox}</b>, not isolated-vm. Player code is less isolated
          {sandbox === 'inproc-unsafe' ? ' (UNSAFE: development only, never at the event)' : ''}.
        </div>
      )}
      <div class="notices" aria-live="polite">
        {data.notices.map((n) => (
          <div key={n.id} class={cx('notice', `notice-${n.level}`)} onClick={() => data.dismiss(n.id)}>
            {n.text}
          </div>
        ))}
      </div>
      {!data.state ? (
        <p class="center dim">Loading the game state…</p>
      ) : (
        <main class="grid">
          <PhaseControls />
          <PlayersTable />
          <ClaudeSeats />
          <Details />
          <ServerInfo />
          <ConfigEditor />
        </main>
      )}
    </AdminContext.Provider>
  );
}
