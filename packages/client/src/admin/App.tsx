// The facilitator page /admin (plan §12.3): login, then the phase controls
// (always on top) and five tabs: Match (the step-by-step match setup in
// LOBBY, a summary after the start), Players (the table, details behind a
// toggle), Game rules (settings that save as they change), AI seats (§11.2)
// and Server. The chosen tab is remembered in this browser; starting a match
// goes from Match to Players, New match back.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../common/api.js';
import { cx } from '../common/ui.js';
import { AdminContext, type AdminCtx } from './context.js';
import { ClaudeSeats } from './ClaudeSeats.js';
import { ConfigProvider } from './configStore.js';
import { Details } from './Details.js';
import { MatchTab } from './MatchTab.js';
import { PhaseControls } from './PhaseControls.js';
import { PlayersTable } from './PlayersTable.js';
import { ServerInfo } from './ServerInfo.js';
import { GameRules, loadPref, savePref } from './Settings.js';
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

const TABS = [
  { id: 'match', label: 'Match' },
  { id: 'players', label: 'Players' },
  { id: 'rules', label: 'Game rules' },
  { id: 'seats', label: 'AI seats' },
  { id: 'server', label: 'Server' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const isTab = (v: string): v is TabId => TABS.some((t) => t.id === v);

function Console({ onLoggedOut }: { onLoggedOut: () => void }) {
  const data = useAdminData();
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const { notify, refresh } = data;
  const [tab, setTabState] = useState<TabId>(() => {
    const saved = loadPref('tab', 'match');
    return isTab(saved) ? saved : 'match';
  });
  const setTab = useCallback((t: TabId) => {
    setTabState(t);
    savePref('tab', t);
  }, []);
  // Start match: the setup is done, the players matter now. New match: back to the setup.
  const phase = data.state?.phase;
  const lastPhase = useRef(phase);
  useEffect(() => {
    const was = lastPhase.current;
    lastPhase.current = phase;
    if (!was || !phase || was === phase) return;
    if (was === 'LOBBY') setTabState((t) => (t === 'match' ? 'players' : t));
    else if (phase === 'LOBBY') setTabState((t) => (t === 'players' ? 'match' : t));
  }, [phase]);

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
        <ConfigProvider>
          <main class="console">
            <PhaseControls />
            <nav class="tabs" role="tablist" aria-label="Admin sections">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`pane-${t.id}`}
                  class={cx('tab', tab === t.id && 'on')}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  {t.id === 'players' && <span class="tab-count">{data.state?.players.length ?? 0}</span>}
                  {t.id === 'match' && phase === 'LOBBY' && <span class="tab-dot" title="Set up the match here" />}
                </button>
              ))}
            </nav>
            {/* Every pane stays mounted (hidden), so half-typed input and drafts survive a tab switch. */}
            <div class="pane" role="tabpanel" id="pane-match" aria-labelledby="tab-match" hidden={tab !== 'match'}>
              <MatchTab onRules={() => setTab('rules')} />
            </div>
            <div class="pane grid" role="tabpanel" id="pane-players" aria-labelledby="tab-players" hidden={tab !== 'players'}>
              <PlayersTable />
              <Details />
            </div>
            <div class="pane" role="tabpanel" id="pane-rules" aria-labelledby="tab-rules" hidden={tab !== 'rules'}>
              <GameRules />
            </div>
            <div class="pane grid" role="tabpanel" id="pane-seats" aria-labelledby="tab-seats" hidden={tab !== 'seats'}>
              <ClaudeSeats />
            </div>
            <div class="pane grid" role="tabpanel" id="pane-server" aria-labelledby="tab-server" hidden={tab !== 'server'}>
              <ServerInfo />
            </div>
          </main>
        </ConfigProvider>
      )}
    </AdminContext.Provider>
  );
}
