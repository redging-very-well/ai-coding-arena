// "My Units" (plan §12.1, §12.5): the roster as cards in two sections,
// Units (soldiers) and Buildings (towers, walls, factories). In PLAN a tap
// selects a card (up to 4 of each group; a 5th tap in a group shakes the card
// with "4 buildings max"). Outside PLAN the cards are read-only and the status
// line explains when Claude can submit. With Open Armory on (§9.1) a second
// tab "Armory" lists other players' units named "Ogre (Ninja Sam)", grouped
// the same way and selectable in the same pools.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { groupOf, type Phase, type UnitCardDTO, type UnitGroup } from '@pixel-clash/shared';
import { ApiError, api } from '../../common/api.js';
import { GROUP_TITLES, groupFullText, overCapText, pickCounterText, pickCounts, toggleGroupedSelection, typeLookup } from '../logic.js';
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
  const limits: Record<UnitGroup, number> = { unit: st.caps.maxUnitTypes, building: st.caps.maxBuildingTypes };
  const typeOf = useMemo(() => typeLookup([...(roster ?? []), ...armory]), [roster, armory]);
  const counts = pickCounts(selection, typeOf);
  const full = counts.unit >= limits.unit && counts.building >= limits.building;
  const overCap = planning ? overCapText(counts, limits) : null;

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
    const r = toggleGroupedSelection(selection, u, typeOf, limits);
    if (!r.ok) {
      doShake(
        u.unitId,
        r.reason === 'full'
          ? groupFullText(r.group, r.max)
          : 'armoryId' in u
            ? `${u.name} doesn't fit the rules right now. Pick another one!`
            : `${u.name} needs fixing before you can pick it. Ask your AI helper!`,
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
        {planning ? <span class={`pick-count ${full ? 'full' : ''}`}>{pickCounterText(counts, limits)}</span> : null}
      </div>
      <p class="status-line">
        {planning ? (
          <>
            <strong>
              Tap up to {limits.unit} units and {limits.building} buildings
            </strong>{' '}
            to use this round. Your AI helper can send new units now!
          </>
        ) : props.phase === 'LOBBY' ? (
          <>Your AI helper can send new units at Plan time. It can already make and check them now!</>
        ) : (
          <>Your AI helper can send new units at Plan time.</>
        )}
      </p>
      {(note ?? overCap) && (
        <p class="note bad" role="alert">
          {note ?? overCap}
        </p>
      )}
      {armoryOn && tab === 'armory' && (
        <>
          <p class="dim small">
            Open Armory: units other players used in a battle. Borrow them for your army (they count toward your picks). They can't
            be changed, but your AI helper can build you a counter or an improved version!
          </p>
          {armory.length === 0 && <p class="dim">No units in the Armory yet. Units join it when a battle ends.</p>}
          {grouped(armory).map(([group, cards]) => (
            <RosterSection key={group} group={group} picked={counts[group]} max={limits[group]} planning={planning}>
              {cards.map((u) => (
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
            </RosterSection>
          ))}
        </>
      )}
      <div hidden={armoryOn && tab === 'armory'}>
        {grouped(sorted).map(([group, cards]) => (
          <RosterSection key={group} group={group} picked={counts[group]} max={limits[group]} planning={planning}>
            {cards.map((u) => (
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
          </RosterSection>
        ))}
      </div>
    </section>
  );
}

/** Cards split into Units and Buildings (in order; an empty group is left out). */
function grouped<T extends UnitCardDTO>(cards: readonly T[]): Array<[UnitGroup, T[]]> {
  const out: Array<[UnitGroup, T[]]> = [
    ['unit', cards.filter((u) => groupOf(u.stats.type) === 'unit')],
    ['building', cards.filter((u) => groupOf(u.stats.type) === 'building')],
  ];
  return out.filter(([, list]) => list.length > 0);
}

function RosterSection(props: { group: UnitGroup; picked: number; max: number; planning: boolean; children: preact.ComponentChildren }) {
  return (
    <div class="roster-group">
      <h3 class="group-head">
        {props.group === 'unit' ? '⚔️' : '🏰'} {GROUP_TITLES[props.group]}
        {props.planning && (
          <span class={`pick-count ${props.picked > props.max ? 'over' : props.picked >= props.max ? 'full' : ''}`}>
            {props.picked} / {props.max} picked
          </span>
        )}
      </h3>
      <div class="card-grid">{props.children}</div>
    </div>
  );
}
