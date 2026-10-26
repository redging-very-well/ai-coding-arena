// Loads the code editor on first use: CodeMirror is a separate
// chunk, so /play's first load stays as light as before. Keyed by the unit,
// so opening another unit starts a fresh editor. A failed load is retried
// once, then explained (editorLoad.ts) with Try again and Reload: nothing is
// typed yet while the editor loads, so reloading loses no code.

import { useEffect, useState } from 'preact/hooks';
import type { EditorTarget } from '../store.js';
import { getStore } from '../store.js';
import { LOAD_FAILURE_TEXT, classifyLoadFailure, loadWithRetry, pathOf, retryUrl, type LoadFailure } from '../editorLoad.js';

type EditorModule = typeof import('../editor/UnitEditor.js');

let loading: Promise<EditorModule> | null = null;
let lastError: unknown;
let attempts = 0;

/** The editor chunk; after a failure, its URL with a fresh query (the browser caches failed imports). */
function importEditor(previousError: unknown): Promise<EditorModule> {
  const url = previousError === undefined ? null : retryUrl(previousError, ++attempts);
  return url ? (import(/* @vite-ignore */ url) as Promise<EditorModule>) : import('../editor/UnitEditor.js');
}

function loadEditor(): Promise<EditorModule> {
  loading ??= loadWithRetry((prev) => importEditor(prev ?? lastError)).catch((err: unknown) => {
    lastError = err;
    loading = null;
    throw err;
  });
  return loading;
}

/** Why the chunk failed: re-fetch this page's HTML and compare its entry script with ours. */
async function diagnose(): Promise<LoadFailure> {
  const loaded = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => pathOf(s.src, location.href));
  let page: { ok: boolean; html: string } | null = null;
  try {
    const res = await fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' });
    page = { ok: res.ok, html: await res.text() };
  } catch {
    page = null;
  }
  return classifyLoadFailure({ online: navigator.onLine, page, loaded });
}

export function EditorHost({ target }: { target: EditorTarget }) {
  const [mod, setMod] = useState<EditorModule | null>(null);
  const [failed, setFailed] = useState<LoadFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    loadEditor()
      .then((m) => !gone && setMod(m))
      .catch(async (err: unknown) => {
        console.warn('code editor chunk failed to load', err);
        const why = await diagnose();
        if (!gone) setFailed(why);
      });
    return () => {
      gone = true;
    };
  }, [attempt]);
  if (failed) {
    return (
      <section class="panel unit-editor">
        <p class="note bad">{LOAD_FAILURE_TEXT[failed]}</p>
        <div class="btn-row">
          {failed !== 'updated' && (
            <button
              class="btn"
              onClick={() => {
                setFailed(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
          <button class={failed === 'updated' ? 'btn primary' : 'btn'} onClick={() => location.reload()}>
            Reload
          </button>
          <button class="btn" onClick={() => getStore().closeEditor()}>
            Close
          </button>
        </div>
      </section>
    );
  }
  if (!mod) {
    return (
      <section class="panel unit-editor">
        <p class="dim">Opening the code editor…</p>
      </section>
    );
  }
  const key = target.mode === 'edit' ? `edit:${target.unitId}` : `copy:${target.templateId}`;
  return <mod.UnitEditor key={key} target={target} />;
}
