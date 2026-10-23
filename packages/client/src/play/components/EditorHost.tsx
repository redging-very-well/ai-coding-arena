// Loads the code editor (plan §12.1) on first use: CodeMirror is a separate
// chunk, so /play's first load stays as light as before. Keyed by the unit,
// so opening another unit starts a fresh editor.

import { useEffect, useState } from 'preact/hooks';
import type { EditorTarget } from '../store.js';
import { getStore } from '../store.js';

type EditorModule = typeof import('../editor/UnitEditor.js');

let loading: Promise<EditorModule> | null = null;

function loadEditor(): Promise<EditorModule> {
  loading ??= import('../editor/UnitEditor.js').catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

export function EditorHost({ target }: { target: EditorTarget }) {
  const [mod, setMod] = useState<EditorModule | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    loadEditor()
      .then((m) => !gone && setMod(m))
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
    };
  }, []);
  if (failed) {
    return (
      <section class="panel unit-editor">
        <p class="note bad">The code editor didn't load. Check the Wi-Fi and try again.</p>
        <button class="btn" onClick={() => getStore().closeEditor()}>
          Close
        </button>
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
