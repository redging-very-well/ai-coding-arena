// "📖 Unit guide" (plan §12.1): a header button that opens the full rulebook
// for units (GET /guide, built from the live config) as an overlay inside the
// play shell. The Claude pane stays mounted underneath (no terminal reload);
// Esc or ✕ closes it; "Open in new tab ↗" opens the standalone /guide page.
// Refetched on every open and, while open, after game-state pushes (an admin
// config change pushes the state), at most every few seconds.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { GuideDTO } from '@pixel-clash/shared';
import { ApiError, api } from '../../common/api.js';
import { cx } from '../../common/ui.js';
import { GuideView } from '../../guide/GuideView.js';
import '../../guide/guide.css';
import { useStore } from '../store.js';

/** Minimum gap between two refetches while the overlay is open. */
const REFETCH_MS = 5000;

// Open/closed lives here (not in the play store): only the button and the overlay use it.
let guideOpen = false;
const listeners = new Set<() => void>();

export function setGuideOpen(open: boolean): void {
  if (guideOpen === open) return;
  guideOpen = open;
  for (const l of listeners) l();
}

function useGuideOpen(): boolean {
  const [, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return guideOpen;
}

/** The header button. */
export function GuideButton() {
  const open = useGuideOpen();
  return (
    <button
      class={cx('guide-open-btn', open && 'on')}
      onClick={() => setGuideOpen(!open)}
      aria-expanded={open}
      title="Everything your units can do: stats, elements, actions, prices"
    >
      📖<span class="guide-open-word"> Unit guide</span>
    </button>
  );
}

/** The overlay (rendered inside the play shell; nothing while closed). */
export function GuideOverlay() {
  const open = useGuideOpen();
  const st = useStore();
  const [guide, setGuide] = useState<GuideDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const lastFetch = useRef(0);
  const stamp = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = () => {
    lastFetch.current = Date.now();
    api.guide().then(
      (g) => {
        setError(null);
        if (stamp.current === g.stamp) return;
        if (stamp.current !== null) {
          setUpdated(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setUpdated(false), 4000);
        }
        stamp.current = g.stamp;
        setGuide(g);
      },
      (err) => setError(err instanceof ApiError ? err.playerMessage : "Couldn't load the guide. Try again!"),
    );
  };

  // Every open fetches fresh numbers.
  useEffect(() => {
    if (open) load();
  }, [open]);

  // A state push while open (e.g. the host retuned the config): refetch, throttled.
  useEffect(() => {
    if (!open || Date.now() - lastFetch.current < REFETCH_MS) return;
    load();
  }, [st.game]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGuideOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (!open) return null;
  return (
    <div class="guide-overlay" role="dialog" aria-label="Unit guide">
      <GuideView guide={guide} error={error} mode="overlay" updated={updated} onClose={() => setGuideOpen(false)} />
    </div>
  );
}
