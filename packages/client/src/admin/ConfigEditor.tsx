// Config editor (plan §12.3): "Quick settings" (labelled fields for the
// high-level knobs, with a live cost preview) above the full config as JSON.
// Both edit ONE draft: the JSON text. The form reads the parsed text and
// writes back to it, so editing either updates the other; while the JSON is
// invalid the form is disabled (the text is kept as typed). Save sends only
// the changed keys (PUT /admin/config takes a partial) and lists the units
// that were re-priced or invalidated. Allowed in LOBBY / PLAN / RESULTS /
// MATCH_RESULTS (the server refuses otherwise).
//
// A quick field holding text that isn't an allowed number blocks Save (and its
// value in the draft goes back to the saved one). The config is re-checked on
// every state change (a wipe resets it on the server) and again before Save.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AdminConfigResponse, GameConfig } from '@pixel-clash/shared';
import { ApiError, api, type DeepPartial } from '../common/api.js';
import { cx } from '../common/ui.js';
import { useAdmin } from './context.js';
import { configDiff, parseConfigText } from './configDiff.js';
import { errorText, stateKey } from './useAdmin.js';
import {
  QUICK_GROUPS,
  costPreview,
  displayValue,
  fieldChanged,
  formatShown,
  inputErrorText,
  refusalIssues,
  typeIntoField,
  unique,
  validateDraft,
  type CostPreview,
  type DraftIssues,
  type QuickField,
} from './quickSettings.js';

const EDITABLE = new Set(['LOBBY', 'PLAN', 'RESULTS', 'MATCH_RESULTS']);

const NO_ISSUES: DraftIssues = { byField: {}, other: [] };

export function ConfigEditor() {
  const { state, overview, notify, refresh } = useAdmin();
  const [base, setBase] = useState<unknown>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [last, setLast] = useState<AdminConfigResponse | null>(null);
  const [refused, setRefused] = useState<DraftIssues>(NO_ISSUES);
  const [saving, setSaving] = useState(false);
  const [showJson, setShowJson] = useState(false);
  /** Bumped on load/reset so fields drop half-typed (invalid) input. */
  const [generation, setGeneration] = useState(0);
  /** Per quick-field path: what's wrong with the text typed there. */
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  /** The server's config moved on (e.g. a wipe) while there were unsaved edits. */
  const [stale, setStale] = useState(false);
  const phase = state?.phase ?? 'LOBBY';
  const editable = EDITABLE.has(phase);

  const adopt = (config: unknown) => {
    setBase(config);
    setText(JSON.stringify(config, null, 2));
    setRefused(NO_ISSUES);
    setInputErrors({});
    setStale(false);
    setGeneration((g) => g + 1);
  };

  const onInputError = useCallback((path: string, message: string) => {
    setInputErrors((prev) => {
      if ((prev[path] ?? '') === message) return prev;
      const next = { ...prev };
      if (message) next[path] = message;
      else delete next[path];
      return next;
    });
  }, []);

  const load = async () => {
    try {
      const r = await api.admin.config();
      adopt(r.config);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const parsed = parseConfigText(text);
  const draft = parsed.ok ? (parsed.value as GameConfig) : null;
  const patch = draft && base !== null ? configDiff(base, draft) : undefined;
  const issues = useMemo(() => (draft ? validateDraft(draft) : NO_ISSUES), [text]);
  const hasIssues = Object.keys(issues.byField).length > 0 || issues.other.length > 0;
  const inputErrorMsg = inputErrorText(inputErrors);
  const dirty = !parsed.ok || patch !== undefined || inputErrorMsg !== '';

  // Re-check the server's config whenever the game state changes (a wipe
  // resets it to the boot config): adopt it when nothing is being edited,
  // otherwise say so (Reload drops the edits).
  const latest = useRef({ base, dirty, saving: false });
  latest.current = { base, dirty, saving: latest.current.saving };
  const sKey = state ? stateKey(state) : '';
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    let live = true;
    void api.admin
      .config()
      .then((r) => {
        const now = latest.current;
        if (!live || now.saving || now.base === null || configDiff(now.base, r.config) === undefined) return;
        if (now.dirty) setStale(true);
        else adopt(r.config);
      })
      .catch(() => undefined); // the next state change (or Reload) tries again
    return () => {
      live = false;
    };
  }, [sKey]);

  const editDraft = (next: GameConfig) => {
    setText(JSON.stringify(next, null, 2));
    setRefused(NO_ISSUES);
  };

  const save = async () => {
    if (!parsed.ok) return setError(parsed.error);
    if (patch === undefined) return setError('Nothing changed.');
    if (inputErrorMsg) return setError(`Fix the quick settings first. ${inputErrorMsg}`);
    setError('');
    setSaving(true);
    latest.current.saving = true;
    try {
      // The diff is against `base`: refuse to send it if the server moved on.
      const current = await api.admin.config();
      if (configDiff(base, current.config) !== undefined) {
        setStale(true);
        return;
      }
      const r = await api.admin.updateConfig(patch as DeepPartial<GameConfig>);
      notify('ok', 'Config saved');
      setLast(r);
      adopt(r.config);
      void refresh();
    } catch (err) {
      notify('error', errorText(err));
      if (err instanceof ApiError) setRefused(refusalIssues(err, base, draft));
      else setError(errorText(err));
    } finally {
      latest.current.saving = false;
      setSaving(false);
    }
  };

  const reset = () => {
    if (base === null) return;
    adopt(base);
    setError('');
  };

  const unitName = (key: string) => {
    // Armory entries are keyed `armory:<id>` (§9.1): show "Ogre (Ninja Sam)".
    const borrowed = overview?.armory?.find((e) => e.unitId === key);
    if (borrowed) return `Armory: ${borrowed.displayName}`;
    const [pid, uid] = key.split('/');
    const p = overview?.players.find((x) => x.id === pid);
    const u = p?.units.find((x) => x.unitId === uid);
    return p && u ? `${p.name}: ${u.name}` : key;
  };

  const changedCount = draft && base !== null ? QUICK_GROUPS.flatMap((g) => g.fields).filter((f) => fieldChanged(f, base, draft)).length : 0;
  const saveDisabled = saving || !parsed.ok || patch === undefined || inputErrorMsg !== '' || stale || !editable;

  const actions = (
    <div class="btn-row">
      <button class="btn primary" disabled={saveDisabled} onClick={save}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
      <button class="btn" disabled={saving || base === null || (patch === undefined && inputErrorMsg === '')} onClick={reset} title="Throw away unsaved edits">
        Reset
      </button>
      <button class="btn" disabled={saving} onClick={load} title="Load the config from the server again (drops unsaved edits)">
        Reload
      </button>
      <span class="dim small">
        {!parsed.ok
          ? 'Fix the JSON below first.'
          : stale
            ? 'The server’s config changed: Reload first.'
            : inputErrorMsg
              ? 'Fix the marked quick settings first.'
              : patch === undefined
            ? 'No changes.'
            : `${changedCount ? `${changedCount} quick setting${changedCount === 1 ? '' : 's'} changed. ` : ''}Will send: ${JSON.stringify(patch)}`}
      </span>
    </div>
  );

  return (
    <section class="panel config">
      <div class="panel-head">
        <h2>Config</h2>
      </div>
      {base === null ? (
        <p class="dim">{error ? <span class="error">{error}</span> : 'Loading the config…'}</p>
      ) : (
        <>
          {!editable && (
            <p class="warn-text qs-locked" role="status">
              Settings are locked during {phase}: unit prices must stay fixed while armies are placed or fighting. They unlock in RESULTS
              (after the battle) and in PLAN.
            </p>
          )}

          <h3 class="qs-title">Quick settings</h3>
          {!draft ? (
            <p class="error" role="alert">
              The full JSON below isn't valid right now, so the quick settings are paused (your text is kept). {parsed.ok ? '' : parsed.error}
            </p>
          ) : (
            <QuickSettings
              base={base as GameConfig}
              draft={draft}
              issues={issues}
              refused={refused}
              generation={generation}
              locked={!editable}
              onChange={editDraft}
              onInputError={onInputError}
            />
          )}
          {unique([...issues.other, ...refused.other]).map((m) => (
            <p class="error" key={m}>
              {m}
            </p>
          ))}
          {/* The one live region for problems (the per-field messages are not announced one by one). */}
          <div aria-live="polite">
            {stale && (
              <p class="warn-text">
                The config on the server changed (for example after a wipe), so these edits are against an old copy. Reload to see it (this
                drops your unsaved edits).
              </p>
            )}
            {inputErrorMsg && <p class="warn-text small">Can’t save yet: {inputErrorMsg}</p>}
            {hasIssues && <p class="warn-text small">The server will refuse a config with the problems marked above.</p>}
          </div>

          {actions}
          {error && <p class="error">{error}</p>}
          {last && (
            <div class="result ok">
              Saved. Re-priced: {last.repriced.length ? last.repriced.map(unitName).join(', ') : 'none'}. Invalidated:{' '}
              {last.invalidated.length ? <span class="warn-text">{last.invalidated.map(unitName).join(', ')}</span> : 'none'}.
            </div>
          )}

          <div class="qs-json">
            <button class="btn small" aria-expanded={showJson} onClick={() => setShowJson(!showJson)}>
              {showJson ? 'Hide full config (JSON)' : 'Show full config (JSON)…'}
            </button>
            {!showJson && !parsed.ok && <span class="error small"> The JSON has an error.</span>}
            {showJson && (
              <>
                <p class="dim small">
                  Everything: coefficients, caps, budget, bounds, timers, scoring, sudden death and sandbox limits. Edits here and in the quick
                  settings are the same draft.
                </p>
                <textarea
                  class="code config-text"
                  rows={24}
                  spellcheck={false}
                  aria-label="Full config JSON"
                  value={text}
                  readOnly={!editable}
                  onInput={(e) => {
                    setText(e.currentTarget.value);
                    setRefused(NO_ISSUES);
                  }}
                />
                {!parsed.ok && <p class="error">{parsed.error}</p>}
                {actions}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

interface QuickProps {
  base: GameConfig;
  draft: GameConfig;
  issues: DraftIssues;
  refused: DraftIssues;
  generation: number;
  locked: boolean;
  onChange(next: GameConfig): void;
  onInputError(path: string, message: string): void;
}

function QuickSettings({ base, draft, issues, refused, generation, locked, onChange, onInputError }: QuickProps) {
  let preview: CostPreview | null = null;
  try {
    preview = costPreview(draft);
  } catch {
    preview = null; // the JSON lacks cost/caps/bounds: the schema errors say why
  }
  return (
    <div class="qs">
      {QUICK_GROUPS.map((g) => (
        <fieldset class="qs-group" key={g.id} disabled={locked}>
          <legend>{g.title}</legend>
          <div class="qs-fields">
            {g.fields.map((f) => (
              <NumberField
                key={`${f.path}:${generation}`}
                field={f}
                base={base}
                draft={draft}
                problems={[...(issues.byField[f.path] ?? []), ...(refused.byField[f.path] ?? [])]}
                onChange={onChange}
                onInputError={onInputError}
              />
            ))}
          </div>
          {g.id === 'costs' && <PreviewTable preview={preview} />}
        </fieldset>
      ))}
    </div>
  );
}

interface FieldProps {
  field: QuickField;
  base: GameConfig;
  draft: GameConfig;
  problems: string[];
  onChange(next: GameConfig): void;
  onInputError(path: string, message: string): void;
}

function NumberField({ field, base, draft, problems, onChange, onInputError }: FieldProps) {
  const shown = displayValue(field, draft);
  const [raw, setRaw] = useState(shown === undefined ? '' : String(shown));
  const [inputError, setInputError] = useState('');
  /** The value our own last keystroke left in the draft (a rolled-back one included). */
  const own = useRef<number | undefined>(shown);
  const setError = (message: string) => {
    setInputError(message);
    onInputError(field.path, message);
  };
  // Follow edits made elsewhere (JSON text, linked fields) unless the box
  // already shows that number (so typing "1." isn't rewritten to "1") or the
  // change is our own (an invalid entry rolls the draft back but keeps the text).
  useEffect(() => {
    if (shown === own.current) return;
    own.current = shown;
    if (shown !== undefined && Number(raw.trim()) !== shown) {
      setRaw(String(shown));
      setError('');
    }
  }, [shown]);
  // A field that goes away (invalid JSON, reload) takes its error with it.
  useEffect(() => () => onInputError(field.path, ''), []);

  const id = `qs-${field.path.replace(/\./g, '-')}`;
  const changed = fieldChanged(field, base, draft);
  const was = displayValue(field, base);
  const messages = unique(inputError ? [inputError, ...problems] : problems);

  const onInput = (value: string) => {
    setRaw(value);
    const r = typeIntoField(field, value, base, draft);
    setError(r.error);
    own.current = displayValue(field, r.draft);
    if (r.draft !== draft) onChange(r.draft);
  };

  return (
    <div class={cx('qs-field', changed && 'qs-changed', messages.length > 0 && 'qs-bad')}>
      <label for={id}>{field.label}</label>
      <div class="qs-input">
        {field.unit === '$' && <span class="qs-unit">$</span>}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={raw}
          min={field.min}
          max={field.max}
          step={field.step ?? (field.integer ? 1 : 'any')}
          aria-invalid={messages.length > 0}
          aria-describedby={messages.length ? `${id}-help ${id}-err` : `${id}-help`}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
        {field.unit && field.unit !== '$' && <span class="qs-unit">{field.unit}</span>}
        {changed && <span class="qs-was">was {formatShown(field, was)}</span>}
      </div>
      <p class="qs-help" id={`${id}-help`}>
        {field.help}
      </p>
      {messages.length > 0 && (
        <div id={`${id}-err`}>
          {messages.map((m) => (
            <p class="error qs-error" key={m}>
              {m}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewTable({ preview }: { preview: CostPreview | null }) {
  if (!preview) return <p class="dim">The cost preview needs valid cost, caps and stat bounds.</p>;
  const { rows, cap, budget, army } = preview;
  return (
    <div class="qs-preview" aria-live="polite">
      <h4>Live price check (with the numbers above)</h4>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} class={cx(r.overCap && 'qs-over')}>
              <td>{r.label}</td>
              <td class="qs-cost">${r.cost}</td>
              <td>
                {!r.overCap && !r.outOfBounds ? (
                  <span class="qs-badge qs-badge-ok">OK</span>
                ) : r.template ? (
                  <span class="qs-badge qs-badge-bad">
                    {r.overCap ? `Over the $${cap} cap` : `Outside the stat bounds (${r.outOfBounds})`}: save will be refused (starter template)
                  </span>
                ) : (
                  <span class="qs-badge qs-badge-warn">
                    {r.overCap ? `Over the $${cap} cap` : 'Outside the stat bounds'}: would be rejected
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class={cx('qs-army', army.overBudget && 'warn-text')}>
        {army.soldiers} soldiers + {army.towers} towers = <b>${army.total}</b> of ${budget}
        {army.overBudget ? ' (over budget!)' : ''}
      </p>
    </div>
  );
}
