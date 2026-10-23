// The in-browser unit code editor (plan §12.1 "✏️ Edit code"), loaded lazily
// by EditorHost so CodeMirror stays out of /play's first load.
//
// CodeMirror 6 with JavaScript highlighting, line numbers, bracket matching,
// auto-indent, Tab indents, undo/redo and search. The whole file shows, but
// sprite() is folded and read-only ("Ask Claude to change how it looks"):
// the player edits the constructor (stats) and update(). While typing, the
// code is checked on the server (POST /units/validate, debounced, ≤ 1/s):
// mistakes become red squiggles (warnings yellow), with a live cost panel.
// "Save new version" is a normal submit (PLAN only) with `baseVersion`, so a
// version Claude saved meanwhile is never overwritten (409 UNIT_CHANGED →
// "Reload latest"). Unsaved code is kept as a draft per unit (localStorage).

import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, codeFolding, foldEffect, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_CONFIG, type SubmitUnitResponse, type ValidationResult } from '@pixel-clash/shared';
import { ApiError, api } from '../../common/api.js';
import { cx } from '../../common/ui.js';
import { getStore, useStore, type EditorTarget } from '../store.js';
import {
  LiveValidator,
  breakdownOf,
  clearDraft,
  copyNameProblem,
  costPanel,
  draftChoice,
  draftKey,
  findSprite,
  isTypeScript,
  loadDraft,
  phaseGuard,
  saveBlockedReason,
  saveDraft,
  savedToast,
  toDiagnostics,
  withUnitName,
  type BannerItem,
  type Draft,
  type EditorDiagnostic,
  type LiveOutcome,
  type LiveStatus,
  type SpriteLocation,
} from './logic.js';
import { allowProtectedEdit, protectSprite, protectedRange, setProtected } from './protect.js';

const LOCK_TEXT = 'Ask Claude to change how it looks';

// ---------------------------------------------------------------------------
// CodeMirror setup
// ---------------------------------------------------------------------------

class LockNote extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-sprite-note';
    el.textContent = `🔒 sprite() draws your unit, so it can't be changed here. ${LOCK_TEXT}!`;
    return el;
  }
}

/** Grey lines and a lock note on the read-only sprite() method. */
const spriteDecorations = StateField.define<DecorationSet>({
  create: (s) => buildSpriteDecorations(s),
  update: (d, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setProtected)) ? buildSpriteDecorations(tr.state) : d),
  provide: (f) => EditorView.decorations.from(f),
});

function buildSpriteDecorations(state: EditorState): DecorationSet {
  const r = state.field(protectedRange, false);
  if (!r) return Decoration.none;
  const first = state.doc.lineAt(r.from);
  const decos = [Decoration.widget({ widget: new LockNote(), block: true, side: -1 }).range(first.from)];
  for (let pos = first.from; pos <= r.to && pos <= state.doc.length; ) {
    const line = state.doc.lineAt(pos);
    decos.push(Decoration.line({ class: 'cm-sprite-line' }).range(line.from));
    pos = line.to + 1;
  }
  return Decoration.set(decos, true);
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c792ea' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#c792ea', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: t.number, color: '#f78c6c' },
  { tag: [t.bool, t.null, t.self], color: '#ff9cac' },
  { tag: t.comment, color: '#8a93b8', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: t.definition(t.propertyName), color: '#82aaff' },
  { tag: t.propertyName, color: '#ffcb6b' },
  { tag: [t.className, t.definition(t.className)], color: '#ffd447', fontWeight: '600' },
  { tag: t.operator, color: '#89ddff' },
  { tag: t.invalid, color: '#f87171' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: '#0b0d17', color: '#f2f3fa', fontSize: '15px' },
    '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", lineHeight: '1.5' },
    '.cm-content': { caretColor: '#ffd447' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffd447', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#3a4166 !important' },
    '.cm-gutters': { backgroundColor: '#11142a', color: '#6b7299', borderRight: '1px solid #262c48' },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff10', color: '#f2f3fa' },
    '.cm-matchingBracket': { backgroundColor: '#ffd44733', outline: '1px solid #ffd44788' },
    '.cm-foldPlaceholder': { backgroundColor: '#262c48', border: '1px solid #3a4166', color: '#ffd447', padding: '0 6px', borderRadius: '4px' },
    '.cm-sprite-line': { backgroundColor: '#ffffff06', color: '#8a93b8' },
    '.cm-sprite-note': {
      margin: '4px 0',
      padding: '4px 10px',
      borderLeft: '4px solid #ffd447',
      backgroundColor: '#262c48',
      color: '#f2f3fa',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
    },
    '.cm-tooltip': { backgroundColor: '#1d2238', border: '1px solid #3a4166', color: '#f2f3fa' },
    '.cm-diagnostic': { padding: '6px 10px', maxWidth: '32rem', fontFamily: 'system-ui, sans-serif' },
    '.cm-diag-detail': { marginTop: '4px', color: '#aab0cc', fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' },
    '.cm-panels': { backgroundColor: '#1d2238', color: '#f2f3fa' },
    '.cm-panels input, .cm-panels button': { fontSize: '14px' },
  },
  { dark: true },
);

function toCm(d: EditorDiagnostic): Diagnostic {
  return {
    from: d.from,
    to: d.to,
    severity: d.severity,
    source: d.code,
    message: d.message,
    renderMessage: () => {
      const box = document.createElement('div');
      const hint = document.createElement('strong');
      hint.textContent = d.message;
      const detail = document.createElement('div');
      detail.className = 'cm-diag-detail';
      detail.textContent = d.detail;
      box.append(hint, detail);
      return box;
    },
  };
}

function extensions(typescript: boolean, sprite: Span | null, onChange: (doc: string) => void, onBlocked: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    codeFolding({ placeholderText: '🎨 pixel art (folded)' }),
    drawSelection(),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab]),
    javascript({ typescript }),
    lintGutter(),
    EditorState.tabSize.of(2),
    // Long comments wrap instead of scrolling sideways (the pixel rows are folded away).
    EditorView.lineWrapping,
    protectSprite(sprite, onBlocked),
    spriteDecorations,
    theme,
    EditorView.contentAttributes.of({ 'aria-label': 'Unit code', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
    }),
  ];
}

type Span = { from: number; to: number };

function spriteSpan(loc: SpriteLocation): Span | null {
  return loc.kind === 'found' ? loc.range : null;
}

function foldSprite(view: EditorView, loc: SpriteLocation): void {
  if (loc.kind === 'found' && loc.fold) view.dispatch({ effects: foldEffect.of(loc.fold) });
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface Opened {
  /** null while it is a not-yet-saved copy of a template. */
  unitId: string | null;
  baseVersion: number | null;
  /** What's stored on the server (the "clean" text). */
  saved: string;
  /** The text to open with (a restored draft, or `saved`). */
  start: string;
  draftKey: string;
  name: string;
}

type Confirm = null | 'close' | 'phase' | 'reload';

type Note = { kind: 'restored' } | { kind: 'stale'; draft: Draft; now: number } | null;

export function UnitEditor({ target }: { target: EditorTarget }) {
  const st = useStore();
  const store = getStore();
  const phase = st.game?.phase;
  const playerId = st.player?.id ?? 'me';
  const cap = Number(st.rules?.caps.unitCost ?? DEFAULT_CONFIG.caps.unitCost);

  // Loading the code (and, for a template copy, the new name first).
  const [opened, setOpened] = useState<Opened | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copySource, setCopySource] = useState<string | null>(null);
  const [copyName, setCopyName] = useState('');
  const [note, setNote] = useState<Note>(null);

  // Editor state.
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const liveRef = useRef<LiveValidator<ValidationResult> | null>(null);
  const openedRef = useRef<Opened | null>(null);
  openedRef.current = opened;
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [banner, setBanner] = useState<BannerItem[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [spriteUnknown, setSpriteUnknown] = useState(false);
  const [blocked, setBlocked] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isCopy = opened ? opened.unitId === null : target.mode === 'copy';
  const title = opened?.name ?? (target.mode === 'edit' ? target.name : target.templateName);

  // --- load ---------------------------------------------------------------
  useEffect(() => {
    let gone = false;
    const id = target.mode === 'edit' ? target.unitId : target.templateId;
    api
      .unit(id)
      .then((u) => {
        if (gone) return;
        if (target.mode === 'edit') {
          const key = draftKey(playerId, u.unitId);
          const choice = draftChoice(loadDraft(key), { source: u.source, version: u.version });
          setNote(choice.kind === 'restore' ? { kind: 'restored' } : choice.kind === 'stale' ? { kind: 'stale', draft: choice.draft, now: u.version } : null);
          setOpened({
            unitId: u.unitId,
            baseVersion: u.version,
            saved: u.source,
            start: choice.kind === 'restore' ? choice.draft.source : u.source,
            draftKey: key,
            name: u.name,
          });
        } else {
          const key = draftKey(playerId, `copy:${u.unitId}`);
          const draft = loadDraft(key);
          if (draft && draft.source !== u.source) {
            setNote({ kind: 'restored' });
            setOpened({ unitId: null, baseVersion: null, saved: u.source, start: draft.source, draftKey: key, name: `Copy of ${u.name}` });
          } else {
            setCopySource(u.source);
            setCopyName(`My ${({ soldier: 'Soldier', tower: 'Tower', wall: 'Wall', factory: 'Factory' } as const)[u.stats.type] ?? 'Unit'}`);
          }
        }
      })
      .catch((err: unknown) => {
        if (!gone) setLoadError(err instanceof ApiError ? err.playerMessage : "Couldn't load the code. Try again!");
      });
    return () => {
      gone = true;
    };
  }, [target.mode === 'edit' ? target.unitId : target.templateId]);

  const startCopy = () => {
    if (copySource === null || target.mode !== 'copy') return;
    const name = copyName.trim();
    if (copyNameProblem(name, target.templateName)) return;
    const renamed = withUnitName(copySource, name);
    setOpened({
      unitId: null,
      baseVersion: null,
      saved: copySource,
      start: renamed?.source ?? copySource,
      draftKey: draftKey(playerId, `copy:${target.templateId}`),
      name,
    });
  };

  // --- live validation ----------------------------------------------------
  const applyResult = (r: ValidationResult, source: string) => {
    const view = viewRef.current;
    const { diagnostics, banner: items } = toDiagnostics(r, source);
    if (view && view.state.doc.toString() === source) view.dispatch(setDiagnostics(view.state, diagnostics.map(toCm)));
    setResult(r);
    setBanner(items);
    setRequestError(null);
  };

  const onOutcome = (o: LiveOutcome<ValidationResult> & { source: string }) => {
    if (o.kind === 'result') return applyResult(o.result, o.source);
    if (o.kind !== 'error') return;
    const err = o.error;
    if (err instanceof ApiError && err.code === 'UNIT_CHANGED') {
      setConflict(Number(err.details?.version) || null);
      return;
    }
    setRequestError(err instanceof ApiError ? `${err.playerMessage}` : "Couldn't check the code. Is the Wi-Fi OK?");
  };

  // --- the CodeMirror view ------------------------------------------------
  useEffect(() => {
    if (!opened || !hostRef.current) return;
    const loc = findSprite(opened.start);
    setSpriteUnknown(loc.kind === 'unknown');
    const live = new LiveValidator<ValidationResult>(
      async (source) => {
        const o = openedRef.current;
        try {
          const r = await api.validateUnit(source, o?.unitId ?? undefined, o?.unitId ? (o.baseVersion ?? undefined) : undefined);
          return { kind: 'result', result: r };
        } catch (err) {
          if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
            return { kind: 'rateLimited', retryAfterMs: Number(err.details?.retryAfterMs) || 1000 };
          }
          return { kind: 'error', error: err };
        }
      },
      onOutcome,
      { debounceMs: 600, minIntervalMs: 1100, onStatus: setStatus },
    );
    liveRef.current = live;
    const onChange = (doc: string) => {
      const o = openedRef.current;
      const isDirty = o ? doc !== o.saved || o.unitId === null : false;
      setDirty(isDirty);
      live.change(doc);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        const cur = openedRef.current;
        if (!cur) return;
        if (doc === cur.saved) clearDraft(cur.draftKey);
        else saveDraft(cur.draftKey, { source: doc, baseVersion: cur.baseVersion ?? 0, savedAt: Date.now() });
      }, 400);
    };
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: opened.start, extensions: extensions(isTypeScript(opened.start), spriteSpan(loc), onChange, () => setBlocked((n) => n + 1)) }),
    });
    viewRef.current = view;
    foldSprite(view, loc);
    setDirty(opened.start !== opened.saved || opened.unitId === null);
    live.now(opened.start);
    view.focus();
    return () => {
      live.stop();
      view.destroy();
      viewRef.current = null;
      liveRef.current = null;
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    // One view per editor (EditorHost remounts for another unit); a save or reload keeps it.
  }, [opened !== null]);

  // The lock note fades after a moment.
  useEffect(() => {
    if (!blocked) return;
    const tm = setTimeout(() => setBlocked(0), 4000);
    return () => clearTimeout(tm);
  }, [blocked]);

  // Claude saved a newer version meanwhile (the `private` push): say so right away.
  const rosterVersion = opened?.unitId ? st.priv?.roster.find((u) => u.unitId === opened.unitId)?.version : undefined;
  const changedTo = conflict ?? (!saving && rosterVersion !== undefined && opened?.baseVersion != null && rosterVersion > opened.baseVersion ? rosterVersion : null);

  // --- phase changes ------------------------------------------------------
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (!phase || phase === lastPhase.current) return;
    lastPhase.current = phase;
    const g = phaseGuard(phase, dirtyRef.current);
    if (g === 'close') store.closeEditor();
    else if (g === 'ask') setConfirm('phase');
  }, [phase]);

  // --- actions ------------------------------------------------------------
  const close = (discard = false) => {
    const o = openedRef.current;
    if (discard && o) clearDraft(o.draftKey);
    store.closeEditor();
  };

  const replaceDoc = (source: string) => {
    const view = viewRef.current;
    if (!view) return;
    const loc = findSprite(source);
    setSpriteUnknown(loc.kind === 'unknown');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: source },
      effects: setProtected.of(spriteSpan(loc)),
      annotations: allowProtectedEdit.of(true),
    });
    foldSprite(view, loc);
  };

  const reloadLatest = async () => {
    const o = openedRef.current;
    if (!o?.unitId) return;
    try {
      const u = await api.unit(o.unitId);
      const next = { ...o, saved: u.source, baseVersion: u.version, name: u.name };
      openedRef.current = next;
      setOpened(next);
      setConflict(null);
      setConfirm(null);
      setNote(null);
      clearDraft(o.draftKey);
      replaceDoc(u.source);
      setDirty(false);
    } catch (err) {
      store.toast(err instanceof ApiError ? err.playerMessage : "Couldn't load the new code. Try again!", 'error');
    }
  };

  const useOldDraft = (draft: Draft) => {
    // The player chose their draft over the newer version: it now builds on that one.
    setNote(null);
    replaceDoc(draft.source);
  };

  const throwAwayDraft = () => {
    const o = openedRef.current;
    if (!o) return;
    clearDraft(o.draftKey);
    setNote(null);
    replaceDoc(o.saved);
  };

  const save = async () => {
    const view = viewRef.current;
    const o = openedRef.current;
    if (!view || !o || savingRef.current) return;
    const source = view.state.doc.toString();
    savingRef.current = true;
    setSaving(true);
    try {
      const r: SubmitUnitResponse = await api.submitUnit(source, o.unitId ?? undefined, o.unitId ? (o.baseVersion ?? undefined) : undefined);
      clearDraft(o.draftKey);
      const next: Opened = {
        unitId: r.unitId,
        baseVersion: r.version,
        saved: source,
        start: source,
        // A saved copy is now a unit of its own: later drafts belong to it.
        draftKey: draftKey(playerId, r.unitId),
        name: r.unit.stats.name,
      };
      openedRef.current = next;
      setOpened(next);
      setConflict(null);
      setDirty(view.state.doc.toString() !== source);
      applyResult(r, source);
      store.toast(savedToast(r.version, r.unit.cost, o.unitId === null, r.unit.stats.name), 'good');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNIT_CHANGED') {
        setConflict(Number(err.details?.version) || null);
      } else if (err instanceof ApiError && err.validation) {
        applyResult(err.validation, source);
        store.toast('Not saved: fix the red mistakes first.', 'warn');
      } else {
        store.toast(err instanceof ApiError ? err.playerMessage : "Couldn't save. Try again!", 'error');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const errors = result && !result.ok ? result.errors.length : 0;
  const blockedWhy = saveBlockedReason(phase, { busy: saving, hasErrors: errors > 0 && status === 'idle', dirty, isCopy });
  const breakdown = result ? breakdownOf(result) : null;
  const panel = useMemo(() => (breakdown ? costPanel(breakdown, cap) : null), [breakdown, cap]);

  // --- render -------------------------------------------------------------
  if (loadError) {
    return (
      <section class="panel unit-editor">
        <EditorHead title={title} onClose={() => close()} />
        <p class="note bad">{loadError}</p>
      </section>
    );
  }

  if (!opened && copySource !== null && target.mode === 'copy') {
    const problem = copyNameProblem(copyName, target.templateName);
    return (
      <section class="panel unit-editor copy-prompt">
        <EditorHead title={`Copy of ${target.templateName}`} onClose={() => close()} />
        <form
          class="copy-form"
          onSubmit={(e) => {
            e.preventDefault();
            startCopy();
          }}
        >
          <label class="field">
            <span>What's your new unit called?</span>
            <input
              value={copyName}
              maxLength={24}
              autoFocus
              onInput={(e) => setCopyName((e.currentTarget as HTMLInputElement).value)}
              aria-describedby="copy-name-hint"
            />
          </label>
          <p id="copy-name-hint" class={cx('dim', problem && 'bad-text')}>
            {problem ?? `It starts as a copy of ${target.templateName}. Saving makes it a new unit of yours.`}
          </p>
          <div class="btn-row">
            <button class="btn primary" type="submit" disabled={!!problem}>
              Start editing
            </button>
            <button class="btn" type="button" onClick={() => close()}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section class="panel unit-editor" aria-label={`Code editor: ${title}`}>
      <EditorHead
        title={title}
        sub={isCopy ? 'new unit (not saved yet)' : opened?.baseVersion ? `v${opened.baseVersion}` : ''}
        dirty={dirty}
        onClose={() => (dirty ? setConfirm('close') : close())}
      />

      {confirm === 'close' && (
        <div class="note confirm" role="alertdialog" aria-label="Close the editor?">
          <p>
            <strong>Your changes aren't saved yet.</strong> They stay as a draft on this laptop if you close.
          </p>
          <div class="btn-row">
            <button class="btn" onClick={() => setConfirm(null)}>
              Keep editing
            </button>
            <button class="btn" onClick={() => close()}>
              Close (keep my draft)
            </button>
            <button class="btn bad" onClick={() => close(true)}>
              Throw my changes away
            </button>
          </div>
        </div>
      )}
      {confirm === 'phase' && (
        <div class="note confirm" role="alertdialog" aria-label="Plan time is over">
          <p>
            <strong>Plan time is over!</strong> Close the editor to see the game? Your changes stay as a draft on this laptop, so you can save them next Plan time.
          </p>
          <div class="btn-row">
            <button class="btn primary" onClick={() => close()}>
              Close the editor
            </button>
            <button class="btn" onClick={() => setConfirm(null)}>
              Keep editing
            </button>
          </div>
        </div>
      )}

      {note?.kind === 'restored' && (
        <p class="note">
          We brought back your unsaved changes.{' '}
          <button class="mini" onClick={throwAwayDraft}>
            Throw them away
          </button>
        </p>
      )}
      {note?.kind === 'stale' && (
        <p class="note">
          You had unsaved changes from v{note.draft.baseVersion}, but this unit is now v{note.now}, so we opened v{note.now}.{' '}
          <button class="mini" onClick={() => useOldDraft(note.draft)}>
            Open my old changes instead
          </button>
        </p>
      )}

      {changedTo !== null && (
        <div class="note bad conflict" role="alert">
          <span>This unit changed since you opened it (now v{changedTo}). Reload to see the new code.</span>
          {confirm === 'reload' ? (
            <span class="btn-row">
              <span>Your changes here will be replaced.</span>
              <button class="btn bad" onClick={() => void reloadLatest()}>
                Yes, reload
              </button>
              <button class="btn" onClick={() => setConfirm(null)}>
                Not yet
              </button>
            </span>
          ) : (
            <button class="btn" onClick={() => (dirty ? setConfirm('reload') : void reloadLatest())}>
              ↻ Reload latest
            </button>
          )}
        </div>
      )}

      {spriteUnknown && (
        <p class="note warn">We couldn't find where this unit's picture code starts, so all of it can be changed. Be careful with sprite()!</p>
      )}
      {blocked > 0 && (
        <p class="note lock-note" role="status">
          🔒 That part draws your unit. {LOCK_TEXT}!
        </p>
      )}

      <div class="editor-body">
        <div class="code-box">
          <div ref={hostRef} class="code-host" />
          <p class="dim small code-help">
            {result?.ok && result.unit.stats.type === 'wall'
              ? 'Change the numbers in constructor(). Walls have no update(): they just stand there.'
              : 'Change the numbers in constructor() and the moves in update().'}{' '}
            Tab indents; press Esc then Tab to leave the code.
          </p>
        </div>
        <aside class="editor-side" aria-live="polite">
          <CheckStatus status={status} result={result} requestError={requestError} />
          {banner.length > 0 && (
            <ul class="editor-banner">
              {banner.map((b, i) => (
                <li key={`${b.code}-${i}`} class={b.severity} title={b.detail}>
                  <span class="sev">{b.severity === 'error' ? '✗' : '⚠'}</span> {b.message}
                  <details>
                    <summary>details</summary>
                    <pre>{b.detail}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {panel && (
            <div class={cx('cost-panel', panel.overCap && 'over')}>
              <div class="cost-total">
                <span class="cost">${panel.cost}</span>
                <span class="dim">{panel.overCap ? `Too expensive! The max is $${panel.cap}` : `of $${panel.cap} max`}</span>
              </div>
              <table class="breakdown">
                <tbody>
                  {panel.rows.map((r) => (
                    <tr key={r.label} class={cx(r.nearMax && 'near-max')}>
                      <th>
                        {r.label}
                        {r.value !== null && <span class="dim"> {r.value}</span>}
                        {r.nearMax && <span title="80% or more of the max: costs extra"> ⚠</span>}
                      </th>
                      <td>{r.price}</td>
                    </tr>
                  ))}
                  {panel.factor && (
                    <tr>
                      <th>Fast attacks</th>
                      <td>{panel.factor.split(' ')[0]}</td>
                    </tr>
                  )}
                  <tr class="total">
                    <th>Cost</th>
                    <td>${panel.cost}</td>
                  </tr>
                </tbody>
              </table>
              {panel.surcharge > 0 && (
                <p class="dim small">
                  Stats near their max cost up to 3 times as much (+${Math.round(panel.surcharge)} here). Two medium units often beat one giant!
                </p>
              )}
            </div>
          )}
        </aside>
      </div>

      <div class="editor-foot">
        <button class="btn primary save-btn" disabled={blockedWhy !== null} onClick={() => void save()} title={blockedWhy ?? undefined}>
          {saving ? 'Saving…' : isCopy ? '💾 Save as a new unit' : '💾 Save new version'}
        </button>
        {blockedWhy && blockedWhy !== 'Saving…' && <span class="dim save-why">{blockedWhy}</span>}
      </div>
    </section>
  );
}

function EditorHead(props: { title: string; sub?: string; dirty?: boolean; onClose: () => void }) {
  return (
    <div class="panel-head editor-head">
      <h2>
        ✏️ {props.title} {props.sub && <span class="tag dim">{props.sub}</span>}{' '}
        {props.dirty && <span class="tag warn-tag">unsaved</span>}
      </h2>
      <button class="btn" onClick={props.onClose}>
        ✕ Close
      </button>
    </div>
  );
}

function CheckStatus({ status, result, requestError }: { status: LiveStatus; result: ValidationResult | null; requestError: string | null }) {
  if (status === 'idle' && requestError) return <p class="check-status bad">{requestError}</p>;
  if (status !== 'idle' || !result) return <p class="check-status checking">Checking your code…</p>;
  if (result.ok) {
    const w = result.warnings.length;
    return <p class="check-status good">✓ No mistakes!{w > 0 ? ` (${w} tip${w === 1 ? '' : 's'})` : ''}</p>;
  }
  const n = result.errors.length;
  return (
    <p class="check-status bad">
      ✗ {n} mistake{n === 1 ? '' : 's'} to fix
    </p>
  );
}
