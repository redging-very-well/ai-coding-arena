// Shared admin context: live data plus `act`, which runs an admin action,
// shows its error (or success text) as a notice and refreshes the overview.

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { AdminData } from './useAdmin.js';

export interface AdminCtx extends AdminData {
  /** Run an action; resolves with its result, or undefined when it failed (the error is shown). */
  act<T>(fn: () => Promise<T>, okText?: string | ((r: T) => string)): Promise<T | undefined>;
  busy: boolean;
  /** "Show details" (default off, the panel may be on the projector): rosters, sprites, seat password, direct seat URLs. */
  showDetails: boolean;
  setShowDetails(on: boolean): void;
}

export const AdminContext = createContext<AdminCtx | null>(null);

export function useAdmin(): AdminCtx {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin outside <AdminContext.Provider>');
  return ctx;
}
