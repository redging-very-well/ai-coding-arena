// Settings that save as they change: one labelled
// field per quick setting (quickSettings.ts), grouped into collapsible
// sections on the Game rules tab, plus a few of them on the Match tab.
//
// - Number fields save 500 ms after the last keystroke, or at once on Enter
//   or when the field loses focus. What's typed is checked first (the field's
//   bounds and the schema's rules for it); a bad value is not sent, and on
//   leaving the field it goes back to the saved value with the reason shown.
//   A save the server refuses shows its reason at the field, which goes back.
// - Toggles save on click.
// - Each section can go back to the defaults (with a confirm step), and so
//   can everything (Reset all to defaults: only these settings, never the
//   venue settings, the match or the teams).
// - The section open/closed state is remembered in this browser.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GameConfig } from '@pixel-clash/shared';
import { ApiError } from '../common/api.js';
import { cx, formatMoney } from '../common/ui.js';
import { configDiff, parseConfigText } from './configDiff.js';
import { useConfig } from './configStore.js';
import { errorText } from './useAdmin.js';
import {
  QUICK_FIELDS,
  QUICK_GROUPS,
  QUICK_TOGGLES,
  budgetBalanceWarning,
  changedFromDefaults,
  checkField,
  costPreview,
  displayValue,
  fieldChanged,
  fieldRefusal,
  formatShown,
  sectionResetPatch,
  setPath,
  toggleValue,
  validateDraft,
  type CostPreview,
  type QuickField,
  type QuickGroup,
  type QuickToggle,
} from './quickSettings.js';

const DEBOUNCE_MS = 500;

// --- remembered UI state (per browser; storage may be blocked) ---------------------

export function loadPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`pc-admin:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`pc-admin:${key}`, value);
  } catch {
    // private window or blocked storage: the default comes back next time
  }
}

/** A collapsible block whose open state is remembered. */
export function Fold({ id, title, note, defaultOpen = false, class: klass, children }: { id: string; title: ComponentChildren; note?: ComponentChildren; defaultOpen?: boolean; class?: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(() => loadPref(`open:${id}`, defaultOpen ? '1' : '0') === '1');
  return (
    <details
      class={cx('fold', klass)}
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== open) {
          setOpen(now);
          savePref(`open:${id}`, now ? '1' : '0');
        }
      }}
    >
      <summary>
        <span class="fold-title">{title}</span>
        {note && <span class="fold-note">{note}</span>}
      </summary>
      <div class="fold-body">{open && children}</div>
    </details>
  );
}

// --- fields --------------------------------------------------------------------------

const fieldByPath = new Map(QUICK_FIELDS.map((f) => [f.path, f]));
const toggleByPath = new Map(QUICK_TOGGLES.map((t) => [t.path, t]));

/** A quick number field by its config path (for the Match tab: ids start "mt-", the Game rules ones "cf-"). */
export function ConfigNumberAt({ path, label, compact }: { path: string; label?: string; compact?: boolean }) {
  const field = fieldByPath.get(path);
  if (!field) return null;
  return <ConfigNumber field={label ? { ...field, label } : field} compact={compact} scope="mt" />;
}

export function ConfigToggleAt({ path, label }: { path: string; label?: string }) {
  const toggle = toggleByPath.get(path);
  if (!toggle) return null;
  return <ConfigToggle toggle={label ? { ...toggle, label } : toggle} scope="mt" />;
}

function refusalText(err: unknown, path: string, base: GameConfig, draft: GameConfig): string {
  return err instanceof ApiError ? fieldRefusal(err, path, base, draft) : errorText(err);
}

export function ConfigNumber({ field, compact, scope = 'cf' }: { field: QuickField; compact?: boolean; scope?: string }) {
  const { config, defaults, editable, save } = useConfig();
  const shown = config ? displayValue(field, config) : undefined;
  const [raw, setRaw] = useState(shown === undefined ? '' : String(shown));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  /** The text was typed and not yet saved or put back. */
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The text whose save is in flight (Enter then blur must not send it twice). */
  const sending = useRef<string | null>(null);
  const latest = useRef({ raw, config });
  latest.current = { raw, config };

  // Follow the saved value unless the facilitator is mid-edit.
  useEffect(() => {
    if (!dirty.current && shown !== undefined) setRaw(String(shown));
  }, [shown]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** Save what's typed now. `leaving`: the field lost focus, so a bad value goes back. */
  const commit = async (leaving: boolean) => {
    stop();
    const cfg = latest.current.config;
    if (!cfg || !dirty.current) return;
    const text = latest.current.raw;
    if (sending.current === text) return;
    const was = displayValue(field, cfg);
    const r = checkField(field, text, cfg);
    if (!r.ok) {
      setError(leaving ? `${r.error} Kept ${formatShown(field, was)}.` : r.error);
      if (leaving) {
        dirty.current = false;
        setRaw(was === undefined ? '' : String(was));
      }
      return;
    }
    if (r.patch === undefined) {
      dirty.current = false;
      setError('');
      return;
    }
    setSaving(true);
    sending.current = text;
    const res = await save(r.patch, `${field.label.replace(/ \(\$\)$/, '')} saved`);
    sending.current = null;
    setSaving(false);
    // Typed again while saving: that newer text gets its own save.
    if (latest.current.raw !== text) return;
    dirty.current = false;
    if (res.ok) {
      setError('');
      const now = displayValue(field, res.config);
      setRaw(now === undefined ? '' : String(now));
    } else {
      setError(`${refusalText(res.error, field.path, cfg, r.draft)} Kept ${formatShown(field, was)}.`);
      setRaw(was === undefined ? '' : String(was));
    }
  };

  const onInput = (value: string) => {
    setRaw(value);
    latest.current.raw = value;
    dirty.current = true;
    stop();
    if (!config) return;
    const r = checkField(field, value, config);
    setError(r.ok ? '' : r.error);
    if (r.ok) timer.current = setTimeout(() => void commit(false), DEBOUNCE_MS);
  };

  const id = `${scope}-${field.path.replace(/\./g, '-')}`;
  const typed = Number(raw);
  const balance = field.path === 'caps.budget' ? budgetBalanceWarning(raw.trim() !== '' && Number.isFinite(typed) ? typed : shown) : '';
  const def = defaults ? displayValue(field, defaults) : undefined;
  const changed = config && defaults ? fieldChanged(field, defaults, config) : false;

  return (
    <div class={cx('qs-field', changed && 'qs-changed', error && 'qs-bad', compact && 'qs-compact')}>
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
          disabled={!editable || !config}
          aria-invalid={error !== ''}
          aria-describedby={`${id}-help${error ? ` ${id}-err` : ''}${balance ? ` ${id}-bal` : ''}`}
          onInput={(e) => onInput(e.currentTarget.value)}
          onBlur={() => void commit(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit(false);
          }}
        />
        {field.unit && field.unit !== '$' && <span class="qs-unit">{field.unit}</span>}
        {saving && <span class="qs-saving">saving…</span>}
        {changed && !saving && <span class="qs-was">default {formatShown(field, def)}</span>}
      </div>
      {balance && (
        <p class="qs-balance" id={`${id}-bal`}>
          ⚠ {balance}
        </p>
      )}
      {!compact && (
        <p class="qs-help" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {compact && (
        <span hidden id={`${id}-help`}>
          {field.help}
        </span>
      )}
      {error && (
        <p class="error qs-error" id={`${id}-err`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ConfigToggle({ toggle, scope = 'cf' }: { toggle: QuickToggle; scope?: string }) {
  const { config, defaults, editable, save } = useConfig();
  const [error, setError] = useState('');
  /** Shown at once while its save is in flight (back to the saved value if refused). */
  const [pending, setPending] = useState<boolean | null>(null);
  const id = `${scope}-${toggle.path.replace(/\./g, '-')}`;
  const on = config ? toggleValue(config, toggle.path) : false;
  const changed = config && defaults ? fieldChanged(toggle, defaults, config) : false;
  return (
    <div class={cx('qs-field qs-toggle', changed && 'qs-changed', error && 'qs-bad')}>
      <label for={id} class="inline">
        <input
          id={id}
          type="checkbox"
          checked={pending ?? on}
          disabled={!editable || !config || pending !== null}
          aria-describedby={`${id}-help`}
          onChange={async (e) => {
            const value = e.currentTarget.checked;
            setPending(value);
            const r = await save(setPath({}, toggle.path, value), `${toggle.label}: ${value ? 'on' : 'off'}`);
            setPending(null);
            setError(r.ok ? '' : `${r.error instanceof ApiError ? r.error.message : errorText(r.error)} Kept ${on ? 'on' : 'off'}.`);
          }}
        />
        {toggle.label}
        {changed && <span class="qs-was">default {defaults && toggleValue(defaults, toggle.path) ? 'on' : 'off'}</span>}
      </label>
      <p class="qs-help" id={`${id}-help`}>
        {toggle.help}
      </p>
      {error && (
        <p class="error qs-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// --- resets --------------------------------------------------------------------------

/** A button with a confirm step ("Reset…" → "Yes, reset" / "Cancel"). */
export function ConfirmButton({ label, confirmText, question, disabled, onConfirm, small }: { label: string; confirmText: string; question?: string; disabled?: boolean; onConfirm: () => Promise<void> | void; small?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking)
    return (
      <button class={cx('btn', small && 'small')} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span class="confirm-row">
      {question && <span class="small">{question}</span>}
      <button
        class={cx('btn danger', small && 'small')}
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {confirmText}
      </button>
      <button class={cx('btn', small && 'small')} onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

function SectionReset({ group }: { group: QuickGroup }) {
  const { config, defaults, editable, save } = useConfig();
  const [error, setError] = useState('');
  if (!config || !defaults) return null;
  const count = changedFromDefaults(group, config, defaults);
  if (!count) return null;
  return (
    <div class="section-reset">
      <ConfirmButton
        small
        label={`Reset this section to defaults (${count})`}
        question={`Put ${count} setting${count === 1 ? '' : 's'} back to the default?`}
        confirmText="Yes, reset"
        disabled={!editable}
        onConfirm={async () => {
          const patch = sectionResetPatch(group, config, defaults);
          if (patch === undefined) return;
          const r = await save(patch, `${group.title}: back to defaults`);
          setError(r.ok ? '' : errorText(r.error));
        }}
      />
      {error && <p class="error small">{error}</p>}
    </div>
  );
}

// --- the Game rules tab ----------------------------------------------------------------

export function LockedNote() {
  const { editable, phase } = useConfig();
  if (editable) return null;
  return (
    <p class="warn-text qs-locked" role="status">
      Settings are locked during {phase}: unit prices must stay fixed while armies are placed or fighting. They unlock in RESULTS (after the battle) and
      in PLAN.
    </p>
  );
}

export function GameRules() {
  const { config, defaults, loadError, editable, resetAll } = useConfig();
  const [error, setError] = useState('');
  if (!config) return <p class="dim">{loadError ? <span class="error">{loadError}</span> : 'Loading the settings…'}</p>;
  const changed = defaults ? QUICK_GROUPS.reduce((n, g) => n + changedFromDefaults(g, config, defaults), 0) : 0;
  const anyDiff = defaults ? configDiff(defaults, config) !== undefined : false;
  return (
    <section class="game-rules">
      <div class="rules-head">
        <div>
          <h2>Game rules</h2>
          <p class="dim small">Changes save as you go (about half a second after you stop typing, or when you press Enter or leave the field).</p>
        </div>
        <div class="rules-actions">
          <span class="dim small">{anyDiff ? `${changed} quick setting${changed === 1 ? '' : 's'} changed from the defaults` : 'All defaults'}</span>
          <ConfirmButton
            label="Reset all to defaults…"
            question="Put every game rule back to config/default.json? (Venue, AI seat and match setup settings stay.)"
            confirmText="Yes, reset everything"
            disabled={!editable || !anyDiff}
            onConfirm={async () => {
              const r = await resetAll();
              setError(r.ok ? '' : errorText(r.error));
            }}
          />
        </div>
      </div>
      <LockedNote />
      {error && <p class="error">{error}</p>}
      <div class="rules-cols">
        {QUICK_GROUPS.map((g, i) => (
          <Fold
            key={g.id}
            id={`rules-${g.id}`}
            defaultOpen={i < 2}
            class="rules-section"
            title={g.title}
            note={
              <>
                <span class="dim">{g.blurb}</span>
                {defaults && changedFromDefaults(g, config, defaults) > 0 && <span class="fold-badge">{changedFromDefaults(g, config, defaults)} changed</span>}
              </>
            }
          >
            <div class={g.id === 'costs' ? 'rules-with-preview' : undefined}>
              <fieldset class="qs-fields" disabled={!editable}>
                {g.fields.map((f) => (
                  <ConfigNumber key={f.path} field={f} />
                ))}
                {g.toggles?.map((t) => <ConfigToggle key={t.path} toggle={t} />)}
              </fieldset>
              {g.id === 'costs' && <PreviewTable config={config} />}
            </div>
            <SectionReset group={g} />
          </Fold>
        ))}
        <Fold id="rules-json" class="rules-section" title="Everything else (full config JSON)" note={<span class="dim">Coefficients, stat bounds, sandbox limits… for experts.</span>}>
          <JsonEditor />
        </Fold>
      </div>
    </section>
  );
}

/** The whole config as JSON: edit and press Apply (the one place with an explicit button: half-typed JSON can't save itself). */
function JsonEditor() {
  const { config, editable, save } = useConfig();
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState('');
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setText(JSON.stringify(config, null, 2));
  }, [config]);
  const parsed = parseConfigText(text);
  const patch = parsed.ok && config ? configDiff(config, parsed.value) : undefined;
  const issues = parsed.ok ? validateDraft(parsed.value) : null;
  const problems = issues ? [...Object.entries(issues.byField).flatMap(([p, m]) => m.map((x) => `${p}: ${x}`)), ...issues.other] : [];
  return (
    <div class="qs-json">
      <textarea
        class="code config-text"
        rows={20}
        spellcheck={false}
        aria-label="Full config JSON"
        value={text}
        readOnly={!editable}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setEdited(true);
        }}
      />
      {!parsed.ok && <p class="error">{parsed.error}</p>}
      {problems.slice(0, 5).map((m) => (
        <p class="error small" key={m}>
          {m}
        </p>
      ))}
      <div class="btn-row">
        <button
          class="btn primary"
          disabled={!editable || !parsed.ok || patch === undefined || problems.length > 0}
          onClick={async () => {
            const r = await save(patch, 'Config saved');
            if (r.ok) {
              setEdited(false);
              setError('');
              setText(JSON.stringify(r.config, null, 2));
            } else setError(errorText(r.error));
          }}
        >
          Apply JSON
        </button>
        <button
          class="btn"
          disabled={!edited}
          onClick={() => {
            setEdited(false);
            setError('');
            setText(JSON.stringify(config, null, 2));
          }}
        >
          Discard edits
        </button>
        <span class="dim small">{patch === undefined ? 'No changes.' : `Will send: ${JSON.stringify(patch)}`}</span>
      </div>
      {error && <p class="error">{error}</p>}
    </div>
  );
}

function PreviewTable({ config }: { config: GameConfig }) {
  let preview: CostPreview | null = null;
  try {
    preview = costPreview(config);
  } catch {
    preview = null;
  }
  if (!preview) return <p class="dim">The cost preview needs valid cost, caps and stat bounds.</p>;
  const { rows, cap, budget, army } = preview;
  return (
    <div class="qs-preview" aria-live="polite">
      <h4>Live price check (with the prices above)</h4>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} class={cx(r.overCap && 'qs-over')}>
              <td>{r.label}</td>
              <td class="qs-cost">{formatMoney(r.cost)}</td>
              <td>
                {!r.overCap && !r.outOfBounds ? (
                  <span class="qs-badge qs-badge-ok">OK</span>
                ) : r.template ? (
                  <span class="qs-badge qs-badge-bad">
                    {r.overCap ? `Over the ${formatMoney(cap)} cap` : `Outside the stat bounds (${r.outOfBounds})`}: refused (starter template)
                  </span>
                ) : (
                  <span class="qs-badge qs-badge-warn">{r.overCap ? `Over the ${formatMoney(cap)} cap` : 'Outside the stat bounds'}: would be rejected</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class={cx('qs-army', army.overBudget && 'warn-text')}>
        {army.soldiers} soldiers + {army.towers} towers (with the copy ramp) = <b>{formatMoney(army.total)}</b> of {formatMoney(budget)}
        {army.overBudget ? ' (over budget!)' : ''}
      </p>
    </div>
  );
}
