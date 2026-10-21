// /play root: join screen, or the header plus the panel for the current phase.

import type { Phase } from '@pixel-clash/shared';
import { cx } from '../../common/ui.js';
import { getStore, useStore } from '../store.js';
import { Battle } from './Battle.js';
import { ClaudeKit, ClaudeTerminal } from './ClaudePanel.js';
import { Header } from './Header.js';
import { Join } from './Join.js';
import { Placement } from './Placement.js';
import { Results } from './Results.js';
import { Roster } from './Roster.js';
import { TeamPanel } from './TeamPanel.js';

function Toasts() {
  const st = useStore();
  const store = getStore();
  return (
    <div class="toasts" aria-live="polite">
      {st.toasts.map((t) => (
        <button key={t.id} class={cx('toast', t.level)} onClick={() => store.dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}

function Lobby() {
  const st = useStore();
  const others = st.game?.players.filter((p) => p.id !== st.player?.id) ?? [];
  return (
    <section class="panel lobby">
      <h2>You're in!</h2>
      <p>
        When everyone has joined, the host starts the game. First, open your Claude terminal below and say hi to Claude with your name and PIN.
      </p>
      {others.length > 0 && <p class="dim">Also here: {others.map((p) => p.name).join(', ')}</p>}
    </section>
  );
}

/** Team mode, joined after Start match (§4): sits out until the next match. */
function Benched() {
  const st = useStore();
  if (!st.priv?.benched) return null;
  return (
    <section class="panel benched">
      <h2>Teams are set for this match</h2>
      <p>You'll play in the next match! You can still ask Claude to build units now, so you're ready.</p>
    </section>
  );
}

function Main({ phase }: { phase: Phase }) {
  switch (phase) {
    case 'LOBBY':
      return (
        <>
          <Lobby />
          <ClaudeTerminal />
          <Roster phase={phase} />
        </>
      );
    case 'PLAN':
      return (
        <>
          <Benched />
          <TeamPanel phase={phase} />
          <Roster phase={phase} />
          <ClaudeTerminal />
        </>
      );
    case 'PLACEMENT':
      return (
        <>
          <Placement />
          <TeamPanel phase={phase} />
          <ClaudeTerminal />
        </>
      );
    case 'BATTLE':
      return <Battle />;
    case 'RESULTS':
    case 'MATCH_RESULTS':
      return (
        <>
          <Results />
          <ClaudeTerminal />
          <Roster phase={phase} />
        </>
      );
  }
}

export function App() {
  const st = useStore();

  if (st.auth === 'unknown') {
    return <main class="join"><p class="pixel">Loading…</p></main>;
  }
  if (st.auth === 'kicked') {
    return (
      <main class="join">
        <div class="panel">
          <h2>You left the game</h2>
          <p>A grown-up removed you from this game. If that's a mistake, ask them for help.</p>
          <button class="btn" onClick={() => location.reload()}>
            Back to the start
          </button>
        </div>
      </main>
    );
  }
  if (st.auth === 'out') {
    return (
      <>
        <Join />
        <Toasts />
      </>
    );
  }
  const phase = st.game?.phase ?? 'LOBBY';
  return (
    <>
      <Header />
      <main class={cx('play', `phase-${phase.toLowerCase()}`)}>
        {st.socket !== 'open' && <p class="note offline">Reconnecting to the game…</p>}
        {st.priv && !st.priv.active && !st.priv.benched && phase !== 'LOBBY' && phase !== 'PLACEMENT' && (
          <p class="note">You joined in the middle of a round. You're in from the next round!</p>
        )}
        <Main phase={phase} />
        <ClaudeKit />
      </main>
      <Toasts />
    </>
  );
}
