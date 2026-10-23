// PLAN "I'm ready!" (plan §12.1): once at least one unit type is picked, a
// big toggle says "my army is picked". Disabled with a hint before any pick.
// The server clears it when the army changes (another pick, or Claude sends a
// new or revised unit): then a small note asks to press Ready again. PLAN
// Ready is separate from PLACEMENT Ready (the server resets it per phase).
// With the host's auto-advance on, the countdown to placement shows here.

import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api } from '../../common/api.js';
import { cx } from '../../common/ui.js';
import { planReadyView, readyWasCleared } from '../logic.js';
import { getStore, useStore } from '../store.js';

export function PlanReady() {
  const st = useStore();
  const store = getStore();
  const [busy, setBusy] = useState(false);
  const [changedNote, setChangedNote] = useState(false);
  const own = useRef(false);
  const prev = useRef<{ phase: string; ready: boolean } | null>(null);
  const priv = st.priv;
  const phase = st.game?.phase ?? 'LOBBY';
  const ready = priv?.ready ?? false;

  useEffect(() => {
    const next = { phase, ready };
    if (readyWasCleared(prev.current, next, own.current)) setChangedNote(true);
    if (ready || phase !== 'PLAN') setChangedNote(false);
    prev.current = next;
    own.current = false;
  }, [phase, ready]);

  if (!priv || !priv.active || priv.benched) return null;
  const allReady = st.game?.allReady ?? false;
  const pending = st.game?.pendingAdvance?.to === 'PLACEMENT' ? st.game.pendingAdvance.secondsLeft : undefined;
  const view = planReadyView(priv.selection.length, ready, st.caps.maxTypes, pending);

  const toggle = async () => {
    setBusy(true);
    own.current = true;
    try {
      await api.setReady(!ready);
      setChangedNote(false);
      store.sound.play(ready ? 'remove' : 'ready', { force: true });
    } catch (err) {
      own.current = false;
      store.toast(err instanceof ApiError ? err.playerMessage : "Couldn't change Ready. Try again!", 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class={cx('panel plan-ready', ready && 'is-ready')}>
      <button class={cx('btn ready-btn', ready && 'on')} disabled={busy || !view.enabled} onClick={() => void toggle()} aria-pressed={ready}>
        {view.label}
      </button>
      <div class="plan-ready-text">
        {changedNote && !ready && (
          <p class="note bad" role="status">
            You changed your army: press Ready again
          </p>
        )}
        <p class={cx('small', ready && allReady ? 'good-text' : 'dim')} aria-live="polite">
          {ready && allReady && pending === undefined ? "Everyone's ready! Waiting for the host to start placement." : view.hint}
        </p>
      </div>
    </section>
  );
}
