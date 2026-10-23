// "My Units" (plan §12.1): the roster as cards. In PLAN a tap selects a card
// (max 3 types; a 4th tap shakes the card). Outside PLAN the cards are
// read-only and the status line explains when Claude can submit. With Open
// Armory on (§9.1) a second tab "Armory" lists other players' units named
// "Ogre (Ninja Sam)", selectable in the same ≤ 3 pool.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Phase, UnitCardDTO } from '@pixel-clash/shared';
import { ApiError, api } from '../../common/api.js';
import { toggleSelection } from '../logic.js';
import { getStore, useStore } from '../store.js';
import { UnitCard } from './UnitCard.js';

// ---------------------------------------------------------------------------
// "new!" badges: remember which version of each unit the player has seen.
// ---------------------------------------------------------------------------

function seenKey(playerId: string): string {
  return `pc-seen-${playerId}`;
}

function loadSeen(playerId: string): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(seenKey(playerId));
    return raw ? (JSON.parse(raw) as Record<string, number>) : null;
  } catch {
    return null;
  }
}

function saveSeen(playerId: string, seen: Record<string, number>): void {
  try {
    localStorage.setItem(seenKey(playerId), JSON.stringify(seen));
  } catch {
    // private mode: badges just won't persist
  }
}

function useSeen(playerId: string | undefined, roster: readonly UnitCardDTO[] | undefined) {
  const [seen, setSeen] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!playerId || !roster) return;
    let s = seen ?? loadSeen(playerId);
    if (!s) {
      // First visit: everything that exists now counts as seen.
      s = Object.fromEntries(roster.map((u) => [u.unitId, u.version]));
      saveSeen(playerId, s);
    }
    if (s !== seen) setSeen(s);
  }, [playerId, roster]);
  const markSeen = (u: UnitCardDTO) => {
    if (!playerId || !seen || seen[u.unitId] === u.version) return;
    const next = { ...seen, [u.unitId]: u.version };
    setSeen(next);
    saveSeen(playerId, next);
  };
  const isNew = (u: UnitCardDTO) => seen !== null && seen[u.unitId] !== u.version;
  return { isNew, markSeen };
}

// ---------------------------------------------------------------------------

export function Roster(props: { phase: Phase }) {
  const st = useStore();
  const store = getStore();
  const priv = st.priv;
  const seat = st.player?.seat ?? 0;
  const roster = priv?.roster;
  const { isNew, markSeen } = useSeen(st.player?.id, roster);
  const planning = props.phase === 'PLAN';
  const [pending, setPending] = useState<string[] | null>(null);
  const [shake, setShake] = useState<{ id: string; n: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tab, setTab] = useState<'mine' | 'armory'>('mine');
  const armoryOn = priv?.armoryEnabled ?? false;
  const armory = priv?.armory ?? [];
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selection = pending ?? priv?.selection ?? [];
  const max = st.caps.maxTypes;

  // Server state wins once it catches up.
  useEffect(() => setPending(null), [priv?.selection.join(',')]);
  useEffect(() => setNote(null), [props.phase]);

  const doShake = (id: string, msg: string) => {
    setShake({ id, n: (shake?.n ?? 0) + 1 });
    setNote(msg);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShake(null), 400);
  };

  const tap = async (u: UnitCardDTO) => {
    const r = toggleSelection(selection, u, max);
    if (!r.ok) {
      doShake(
        u.unitId,
        r.reason === 'full'
          ? `You can pick ${max} units. Tap a picked one to swap it out.`
          : 'armoryId' in u
            ? `${u.name} doesn't fit the rules right now. Pick another one!`
            : `${u.name} needs fixing before you can pick it. Ask Claude!`,
      );
      return;
    }
    setNote(null);
    setPending(r.selection);
    try {
      await api.setSelection(r.selection);
    } catch (err) {
      setPending(null);
      const msg = err instanceof ApiError ? err.playerMessage : "Your pick didn't save. Try again!";
      doShake(u.unitId, msg);
    }
  };

  const retire = async (u: UnitCardDTO) => {
    try {
      await api.retireUnit(u.unitId);
      store.toast(`${u.name} was removed.`);
    } catch (err) {
      store.toast(err instanceof ApiError ? err.playerMessage : "Couldn't remove it. Try again!", 'error');
    }
  };

  const sorted = useMemo(() => {
    if (!roster) return [];
    // Newest first (server order), templates last.
    return [...roster].sort((a, b) => Number(a.isTemplate) - Number(b.isTemplate));
  }, [roster]);

  if (!priv) {
    return (
      <section class="panel roster">
        <h2>My Units</h2>
        <p class="dim">Loading your units…</p>
      </section>
    );
  }

  return (
    <section class="panel roster">
      <div class="panel-head">
        {armoryOn ? (
          <div class="tabs" role="tablist">
            <button role="tab" class={tab === 'mine' ? 'tab on' : 'tab'} aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>
              My Units
            </button>
            <button role="tab" class={tab === 'armory' ? 'tab on' : 'tab'} aria-selected={tab === 'armory'} onClick={() => setTab('armory')}>
              💡 Armory ({armory.length})
            </button>
          </div>
        ) : (
          <h2>My Units</h2>
        )}
        {planning ? (
          <span class={`pick-count ${selection.length === max ? 'full' : ''}`}>
            Picked {selection.length} / {max}
          </span>
        ) : null}
      </div>
      <p class="status-line">
        {planning ? (
          <>
            <strong>Tap up to {max} units</strong> to use this round. Claude can send new units now!
          </>
        ) : props.phase === 'LOBBY' ? (
          <>Claude can send new units at Plan time. It can already make and check them now!</>
        ) : (
          <>Claude can send new units at Plan time.</>
        )}
      </p>
      {note && (
        <p class="note bad" role="alert">
          {note}
        </p>
      )}
      {armoryOn && tab === 'armory' && (
        <>
          <p class="dim small">
            Open Armory: units other players used in a battle. Borrow them for your army (they count toward your {max} picks). They can't
            be changed, but Claude can build you a counter or an improved version!
          </p>
          {armory.length === 0 && <p class="dim">No units in the Armory yet. Units join it when a battle ends.</p>}
          <div class="card-grid">
            {armory.map((u) => (
              <UnitCard
                key={u.unitId}
                unit={u}
                seat={seat}
                bounds={st.bounds}
                selected={selection.includes(u.unitId)}
                onTap={planning ? () => void tap(u) : undefined}
                shake={shake?.id === u.unitId}
                borrowedRound={u.roundAdded}
              />
            ))}
          </div>
        </>
      )}
      <div class="card-grid" hidden={armoryOn && tab === 'armory'}>
        {sorted.map((u) => (
          <UnitCard
            key={u.unitId}
            unit={u}
            seat={seat}
            bounds={st.bounds}
            selected={selection.includes(u.unitId)}
            onTap={planning ? () => void tap(u) : undefined}
            shake={shake?.id === u.unitId}
            isNew={isNew(u)}
            onSeen={() => markSeen(u)}
            onRetire={planning ? () => void retire(u) : undefined}
            onEdit={() => store.openEditor({ mode: 'edit', unitId: u.unitId, name: u.name })}
            onCopy={() => store.openEditor({ mode: 'copy', templateId: u.unitId, templateName: u.name })}
          />
        ))}
      </div>
    </section>
  );
}
