// The live config for /admin: one copy shared by the Match tab
// (budget, timers) and the Game rules tab. Every setting saves on its own as
// soon as it changes (PUT /admin/config with just that change); there is no
// Save button. Saves run one after another, each answer becomes the copy, and
// a small "Settings saved ✓" banner confirms it. The config is re-read on
// every state change that matters (a wipe resets it on the server).
// Allowed in LOBBY / PLAN / RESULTS / MATCH_RESULTS (the server refuses otherwise).

import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AdminConfigResponse, GameConfig } from '@pixel-clash/shared';
import { request, type DeepPartial } from '../common/api.js';
import { useAdmin } from './context.js';
import { errorText, stateKey } from './useAdmin.js';

export const CONFIG_EDITABLE = new Set(['LOBBY', 'PLAN', 'RESULTS', 'MATCH_RESULTS']);

/** The config answers, with the config typed (the shared DTO leaves it `unknown`). */
type ConfigResponse = Omit<AdminConfigResponse, 'config'> & { config: GameConfig };

export const configApi = {
  get: () => request<ConfigResponse>('GET', '/admin/config'),
  /** config/default.json (the boot config), for "default …" marks and resets. */
  defaults: () => request<ConfigResponse>('GET', '/admin/config/defaults'),
  update: (patch: DeepPartial<GameConfig>) => request<ConfigResponse>('PUT', '/admin/config', patch),
  /** Every config setting back to the defaults (not venue settings, the match or the teams). */
  reset: () => request<ConfigResponse>('POST', '/admin/config/reset', {}),
};

export type SaveResult = { ok: true; config: GameConfig } | { ok: false; error: unknown };

export interface ConfigCtx {
  config: GameConfig | null;
  defaults: GameConfig | null;
  loadError: string;
  /** Settings may change in this phase. */
  editable: boolean;
  phase: string;
  /** Save a partial config now (queued behind any save in flight). */
  save(patch: unknown, what?: string): Promise<SaveResult>;
  /** Everything back to config/default.json. */
  resetAll(): Promise<SaveResult>;
  reload(): Promise<void>;
}

const Ctx = createContext<ConfigCtx | null>(null);

export function useConfig(): ConfigCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConfig outside <ConfigProvider>');
  return c;
}

interface Toast {
  id: number;
  text: string;
}

export function ConfigProvider({ children }: { children: ComponentChildren }) {
  const { state, overview, notify, refresh } = useAdmin();
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [defaults, setDefaults] = useState<GameConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const phase = state?.phase ?? 'LOBBY';
  const editable = CONFIG_EDITABLE.has(phase);
  const overviewRef = useRef(overview);
  overviewRef.current = overview;

  const reload = useCallback(async () => {
    try {
      const [c, d] = await Promise.all([configApi.get(), configApi.defaults()]);
      setConfig(c.config);
      setDefaults(d.config);
      setLoadError('');
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // A wipe (or another admin tab) can change the config: re-read it, unless a save is in flight.
  const sKey = state ? stateKey(state) : '';
  useEffect(() => {
    if (!sKey || inFlight.current > 0) return;
    let live = true;
    void configApi
      .get()
      .then((r) => {
        if (live && inFlight.current === 0) setConfig(r.config);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sKey]);

  const unitName = (key: string) => {
    const ov = overviewRef.current;
    const borrowed = ov?.armory?.find((e) => e.unitId === key);
    if (borrowed) return `Armory: ${borrowed.displayName}`;
    const [pid, uid] = key.split('/');
    const p = ov?.players.find((x) => x.id === pid);
    const u = p?.units.find((x) => x.unitId === uid);
    return p && u ? `${p.name}: ${u.name}` : key;
  };

  const after = (r: ConfigResponse, what: string) => {
    setConfig(r.config);
    const repriced = r.repriced.length ? ` · ${r.repriced.length} unit${r.repriced.length === 1 ? '' : 's'} re-priced` : '';
    setToast({ id: Date.now(), text: `${what} ✓${repriced}` });
    if (r.invalidated.length) notify('warn', `No longer valid with the new settings: ${r.invalidated.map(unitName).join(', ')}`);
    void refresh();
  };

  const run = (fn: () => Promise<ConfigResponse>, what: string): Promise<SaveResult> => {
    inFlight.current++;
    const p = queue.current.then(async (): Promise<SaveResult> => {
      try {
        const r = await fn();
        after(r, what);
        return { ok: true, config: r.config };
      } catch (err) {
        return { ok: false, error: err };
      } finally {
        inFlight.current--;
      }
    });
    queue.current = p;
    return p;
  };

  const save = useCallback((patch: unknown, what = 'Settings saved') => run(() => configApi.update(patch as DeepPartial<GameConfig>), what), []);
  const resetAll = useCallback(() => run(() => configApi.reset(), 'Settings reset to defaults'), []);

  const value = useMemo<ConfigCtx>(() => ({ config, defaults, loadError, editable, phase, save, resetAll, reload }), [config, defaults, loadError, editable, phase, save, resetAll, reload]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <SavedBanner toast={toast} />
    </Ctx.Provider>
  );
}

/** "Settings saved ✓": a small banner at the top that fades out by itself (non-blocking, click-through). */
function SavedBanner({ toast }: { toast: Toast | null }) {
  const [shown, setShown] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    setShown(toast);
    const t = setTimeout(() => setShown((s) => (s?.id === toast.id ? null : s)), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <div class={shown ? 'saved-banner on' : 'saved-banner'} role="status" aria-live="polite">
      {shown?.text ?? toast?.text ?? ''}
    </div>
  );
}
