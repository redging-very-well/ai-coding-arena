// /guide entry: the standalone unit guide, opened
// from /play's overlay with "Open in new tab ↗". Public (no login); the data is
// GET /guide, built from the live config. Refetched when the tab comes back
// into view and every 30 s, so an admin retune shows up. Print-friendly.

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GuideDTO } from '@pixel-clash/shared';
import '../common/theme.css';
import './guide.css';
import { ApiError, api } from '../common/api.js';
import { ensureFonts } from '../common/ui.js';
import { GuideView } from './GuideView.js';

const POLL_MS = 30_000;

/** Print: open every "For Claude / code" box, then restore. */
function printAll(): void {
  const closed = [...document.querySelectorAll<HTMLDetailsElement>('details.guide-code:not([open])')];
  for (const d of closed) d.open = true;
  window.addEventListener(
    'afterprint',
    () => {
      for (const d of closed) d.open = false;
    },
    { once: true },
  );
  window.print();
}

function GuidePage() {
  const [guide, setGuide] = useState<GuideDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const stamp = useRef<string | null>(null);

  useEffect(() => {
    let flash: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api.guide().then(
        (g) => {
          setError(null);
          if (stamp.current === g.stamp) return;
          if (stamp.current !== null) {
            setUpdated(true);
            if (flash) clearTimeout(flash);
            flash = setTimeout(() => setUpdated(false), 4000);
          }
          stamp.current = g.stamp;
          setGuide(g);
        },
        (err) => setError(err instanceof ApiError ? err.playerMessage : "Couldn't load the guide. Try again!"),
      );
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(poll);
      if (flash) clearTimeout(flash);
    };
  }, []);

  const hash = decodeURIComponent(location.hash.replace(/^#/, '')) || null;
  return (
    <main class="guide-page">
      <GuideView
        guide={guide}
        error={error}
        mode="page"
        updated={updated}
        initialSection={hash}
        actions={
          <button class="guide-btn" onClick={printAll} title="Print the whole guide">
            🖨️ Print
          </button>
        }
      />
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<GuidePage />, root);
void ensureFonts();
