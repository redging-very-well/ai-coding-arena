// Admin data: the live game state from the WebSocket ('admin' role) and the
// detailed overview from GET /api/admin/overview, refetched whenever the state
// changes in a way that matters (not on every 1 Hz timer tick).

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminClaudeSeatsDTO, AdminOverviewDTO, GameStateDTO, SetupInfoDTO } from '@pixel-clash/shared';
import { ApiError, api } from '../common/api.js';
import { GameSocket, type WsStatus } from '../common/ws.js';
import { getSetupInfo } from '../setup/setupApi.js';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error' | 'ok';
  text: string;
}

/** The state without its ticking parts, to decide when to refetch the overview. */
export function stateKey(s: GameStateDTO): string {
  const { timer, battle, ...rest } = s;
  return JSON.stringify([rest, timer.paused, timer.expired, battle?.paused, battle?.speed]);
}

export interface AdminData {
  state: GameStateDTO | null;
  overview: AdminOverviewDTO | null;
  setup: SetupInfoDTO | null;
  /** Claude seats, without the secret fields (WS `terminals` + refetches). */
  seats: AdminClaudeSeatsDTO | null;
  wsStatus: WsStatus;
  /** The admin session is gone (server restarted with a wipe, logged out elsewhere). */
  lostSession: boolean;
  notices: Notice[];
  notify(level: Notice['level'], text: string): void;
  dismiss(id: number): void;
  refresh(): Promise<void>;
  setSetup(info: SetupInfoDTO): void;
  setState(s: GameStateDTO): void;
  setSeats(s: AdminClaudeSeatsDTO): void;
}

let nextNoticeId = 1;

export function useAdminData(): AdminData {
  const [state, setState] = useState<GameStateDTO | null>(null);
  const [overview, setOverview] = useState<AdminOverviewDTO | null>(null);
  const [setup, setSetup] = useState<SetupInfoDTO | null>(null);
  const [seats, setSeats] = useState<AdminClaudeSeatsDTO | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [lostSession, setLostSession] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const lastKey = useRef('');
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((level: Notice['level'], text: string) => {
    const id = nextNoticeId++;
    setNotices((n) => [...n.slice(-4), { id, level, text }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), level === 'error' ? 12_000 : 6_000);
  }, []);
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    try {
      const [ov, su, cs] = await Promise.all([api.admin.overview(), getSetupInfo(), api.admin.claudeSeats()]);
      setOverview(ov);
      setState(ov.state);
      setSetup(su);
      setSeats(cs);
      lastKey.current = stateKey(ov.state);
    } catch (err) {
      if (err instanceof ApiError && err.unauthenticated) setLostSession(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sock = new GameSocket('admin');
    const offs = [
      sock.onStatus((s) => {
        setWsStatus(s);
        if (s === 'open') void refresh();
      }),
      sock.on('hello', (m) => {
        if (m.role !== 'admin') setLostSession(true);
      }),
      sock.on('state', (m) => {
        setState(m.state);
        const key = stateKey(m.state);
        if (key !== lastKey.current) {
          lastKey.current = key;
          if (pending.current) clearTimeout(pending.current);
          pending.current = setTimeout(() => void refresh(), 150);
        }
      }),
      sock.on('toast', (m) => notify(m.level, m.message)),
      sock.on('terminals', (m) => setSeats(m.data)),
    ];
    // Safety net: `connected` flags and strikes without a state change.
    const poll = setInterval(() => void refresh(), 10_000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(poll);
      if (pending.current) clearTimeout(pending.current);
      sock.close();
    };
  }, [refresh, notify]);

  return { state, overview, setup, seats, wsStatus, lostSession, notices, notify, dismiss, refresh, setSetup, setState, setSeats };
}

/** Text of an error for the facilitator (message + hint). */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.hint && err.hint !== err.message ? `${err.message} (${err.hint})` : err.message;
  return err instanceof Error ? err.message : String(err);
}
