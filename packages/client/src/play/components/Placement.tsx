// PLACEMENT (plan §12.1): the zone as an enlarged top-down 6×6 grid in its
// true orientation (arrow to the centre), a palette of the selected types,
// tap palette → tap cell, tap a placed unit to remove it, sprites at true
// size, live budget bar, Copy last layout / Clear / READY, autosave
// (debounced 300 ms) and an iso mini-map. Works for every zone orientation of
// the §9.2 maps (row 0 is always the front). Team mode: the mini-map shows the
// teammates' zones and placements live as ghosts, and the Team panel their picks.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cornerZone, sizeOf, type MapZone, type PlacementDTO, type UnitCardDTO } from '@pixel-clash/shared';
import { countdownText } from '../../common/advance.js';
import { ApiError, api } from '../../common/api.js';
import { resolveSprite } from '../../common/render/sprites.js';
import { arenaFor, toMapZone, zoneLabel } from '../../common/maps.js';
import { seatStyle } from '../../common/seats.js';
import { cx, debounce, formatMoney } from '../../common/ui.js';
import {
  budgetText,
  cellFill,
  copiesOf,
  copyLastLayout,
  isFrontCell,
  placementAt,
  spentOf,
  tapCell,
  towardCentre,
  zoneGrid,
  type PlacementRules,
} from '../logic.js';
import { getStore, useStore } from '../store.js';
import { MiniMap } from './MiniMap.js';
import { SpriteView } from './SpriteView.js';
import { specKeyOf } from './UnitCard.js';

/** Width in CSS px of one grid cell (follows the grid's box). Returns a callback ref. */
function useCellPx(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [px, setPx] = useState(60);
  useEffect(() => {
    if (!el) return;
    const measure = () => setPx(Math.max(24, el.clientWidth / 6));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, px];
}

/** This round's zone as a shared/maps.ts zone (the map zone, or a legacy corner). */
export function myMapZone(st: Pick<ReturnType<typeof useStore>, 'priv' | 'game'>): MapZone | null {
  const dto = st.priv?.mapZone ?? st.game?.me?.myZone ?? null;
  if (dto) return toMapZone(dto, arenaFor(dto, st.game?.match?.map));
  return st.priv?.zone ? cornerZone(st.priv.zone) : null;
}

export function Placement() {
  const st = useStore();
  const store = getStore();
  const priv = st.priv;
  const seat = st.player?.seat ?? 0;
  const zone = useMemo(() => myMapZone(st), [priv?.mapZone, priv?.zone, st.game?.me?.myZone, st.game?.match?.map]);
  const [local, setLocal] = useState<PlacementDTO[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [shakeCell, setShakeCell] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  const [readyBusy, setReadyBusy] = useState(false);
  /** Unsaved local edits; `seq` counts edits so an older save can't clear a newer one. */
  const dirty = useRef(false);
  const seq = useRef(0);
  const [gridRef, cellPx] = useCellPx();

  const palette: UnitCardDTO[] = useMemo(() => {
    // Own designs plus borrowed Open Armory units ("Ogre (Ninja Sam)", §9.1).
    const byId = new Map([...(priv?.roster ?? []), ...(priv?.armory ?? [])].map((u) => [u.unitId, u]));
    return (priv?.selection ?? []).map((id) => byId.get(id)).filter((u): u is UnitCardDTO => !!u);
  }, [priv?.roster, priv?.armory, priv?.selection]);
  const unitsById = useMemo(() => new Map(palette.map((u) => [u.unitId, u])), [palette]);
  const rules: PlacementRules = useMemo(
    () => ({ costs: new Map(palette.map((u) => [u.unitId, u.cost])), budget: priv?.budget ?? st.caps.budget, maxCopies: st.caps.maxCopies }),
    [palette, priv?.budget, st.caps],
  );

  // Server placement wins unless we have unsaved local edits.
  useEffect(() => {
    if (!dirty.current) setLocal(null);
  }, [priv?.placement]);
  // Pick the first palette unit to start with.
  useEffect(() => {
    if ((chosen === null || !unitsById.has(chosen)) && palette[0]) setChosen(palette[0].unitId);
  }, [palette]);

  const placements = local ?? priv?.placement ?? [];
  const spent = spentOf(placements, rules.costs);
  const copies = copiesOf(placements);

  const save = useMemo(
    () =>
      debounce(async (next: PlacementDTO[]) => {
        const mySeq = seq.current;
        setSaving('saving');
        try {
          await api.setPlacement(next);
          if (seq.current === mySeq) {
            dirty.current = false;
            setSaving('saved');
          }
        } catch (err) {
          if (seq.current !== mySeq) return;
          dirty.current = false;
          setLocal(null);
          setSaving('error');
          // The phase just moved on (START): nothing to tell the player.
          if (err instanceof ApiError && err.phaseClosed) return;
          const msg = err instanceof ApiError ? err.playerMessage : "Couldn't save. Try again!";
          setNote({ text: msg, bad: true });
          store.toast(msg, 'error');
        }
      }, 300),
    [],
  );
  useEffect(() => () => save.flush(), [save]);

  const commit = (next: PlacementDTO[]) => {
    seq.current++;
    dirty.current = true;
    setLocal(next);
    setSaving('pending');
    save(next);
  };

  const bump = (key: string, text: string) => {
    setShakeCell(key);
    setNote({ text, bad: true });
    setTimeout(() => setShakeCell((k) => (k === key ? null : k)), 400);
  };

  if (!priv || !st.player) return <section class="panel">Loading…</section>;
  if (priv.benched) {
    return (
      <section class="panel placement">
        <h2>Teams are set for this match</h2>
        <p>You'll play in the next match! Meanwhile, ask Claude to make some great units.</p>
      </section>
    );
  }
  if (!priv.active) {
    return (
      <section class="panel placement">
        <h2>Watch this round</h2>
        <p>You joined partway through, so you're in from the next round. Ask Claude to make some units while you wait!</p>
      </section>
    );
  }
  if (!zone) return <section class="panel">Getting your zone…</section>;

  const onCell = (col: number, row: number) => {
    const r = tapCell(placements, col, row, chosen, rules);
    if (!r.ok) {
      bump(`${col},${row}`, r.message);
      return;
    }
    setNote(null);
    store.sound.play(r.placements.length < placements.length ? 'remove' : 'place', { force: true });
    commit(r.placements);
  };

  const dir = towardCentre(zone);
  const grid = zoneGrid(zone);
  const where = zoneLabel(zone, zone.arena);
  const arrowClass = `${dir.dy > 0 ? 'bottom' : dir.dy < 0 ? 'top' : 'mid-y'} ${dir.dx > 0 ? 'right' : dir.dx < 0 ? 'left' : 'mid-x'}`;
  const teammates = (priv.team?.members ?? []).filter((m) => m.playerId !== st.player?.id);
  const over = spent > rules.budget;
  const pct = Math.min(100, (spent / Math.max(1, rules.budget)) * 100);
  const lastLayout = priv.lastLayout;
  const ready = priv.ready;

  const toggleReady = async () => {
    setReadyBusy(true);
    save.flush();
    try {
      await api.setReady(!ready);
      store.sound.play(ready ? 'remove' : 'ready', { force: true });
    } catch (err) {
      store.toast(err instanceof ApiError ? err.playerMessage : "Couldn't change READY. Try again!", 'error');
    } finally {
      setReadyBusy(false);
    }
  };

  return (
    <section class={`panel placement seat-${seat}`}>
      <div class="panel-head">
        <h2>Place your army!</h2>
        <span class={cx('save-state', saving)}>
          {saving === 'pending' || saving === 'saving' ? 'Saving…' : saving === 'saved' ? '✓ Saved' : saving === 'error' ? 'Not saved' : ''}
        </span>
      </div>
      <p class="zone-line">
        This round you're in <strong>{where}</strong>. The arrow points to the middle; the front row is nearest it.
      </p>

      <div class="placement-layout">
        <div class="grid-wrap">
          <div class={cx('zone-grid', ready && 'is-ready')} ref={gridRef} role="grid" aria-label={`Your ${where}, 6 by 6 squares`}>
            {grid.map((c) => {
              const p = placementAt(placements, c.col, c.row);
              const u = p ? unitsById.get(p.unitId) : undefined;
              const key = `${c.col},${c.row}`;
              const front = isFrontCell(zone, c.col, c.row);
              return (
                <button
                  key={key}
                  class={cx('cell', p && 'filled', front && 'front', (c.gx + c.gy) % 2 === 1 && 'alt', shakeCell === key && 'shake')}
                  style={{ gridColumn: c.gx + 1, gridRow: c.gy + 1 }}
                  onClick={() => onCell(c.col, c.row)}
                  aria-label={u ? `${u.name}, tap to remove` : 'Empty square'}
                >
                  {u && (
                    <SpriteView
                      spec={resolveSprite(u)}
                      specKey={specKeyOf(u)}
                      outline={seatStyle(seat).color}
                      width={cellFill(u.stats) * cellPx}
                      mirror={dir.dx < 0}
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div class={`centre-arrow ${arrowClass}`} aria-hidden="true">
            <span>{dir.arrow}</span>
            <small>middle</small>
          </div>
        </div>

        <aside class="placement-side">
          <MiniMap
            zone={zone}
            map={st.game?.match?.map ?? null}
            seat={seat}
            teamId={priv.teamId ?? null}
            teams={st.game?.match?.teams ?? null}
            playerId={st.player.id}
            name={st.player.name}
            placements={placements}
            units={palette}
            teammates={teammates}
          />
          <div class={cx('budget', over && 'over')}>
            <div class="budget-bar" role="meter" aria-valuemin={0} aria-valuemax={rules.budget} aria-valuenow={spent}>
              <span class="budget-fill" style={{ width: `${pct}%` }} />
            </div>
            <div class="budget-text">{budgetText(spent, rules.budget)}</div>
            <div class="dim small">
              {placements.length} / {rules.maxCopies} units
            </div>
          </div>
        </aside>
      </div>

      {note && (
        <p class={cx('note', note.bad && 'bad')} role="alert">
          {note.text}
        </p>
      )}

      <div class="palette" role="radiogroup" aria-label="Choose a unit to place">
        {palette.length === 0 && <p class="dim">No units picked for this round.</p>}
        {palette.map((u) => {
          const affordable = spent + u.cost <= rules.budget;
          return (
            <button
              key={u.unitId}
              role="radio"
              aria-checked={chosen === u.unitId}
              class={cx('pal-item', chosen === u.unitId && 'chosen', !affordable && 'cant')}
              onClick={() => {
                setChosen(chosen === u.unitId ? null : u.unitId);
                setNote(null);
              }}
            >
              <span class="pal-sprite">
                <SpriteView spec={resolveSprite(u)} specKey={specKeyOf(u)} outline={seatStyle(seat).color} width={Math.max(20, sizeOf(u.stats) * 2.4)} />
              </span>
              <span class="pal-name">{u.name}</span>
              <span class="pal-cost">{formatMoney(u.cost)}</span>
              <span class="pal-copies">×{copies.get(u.unitId) ?? 0}</span>
            </button>
          );
        })}
      </div>
      <p class="dim small hint">Tap a unit above, then tap a square. Tap a placed unit to take it away.</p>

      <div class="placement-actions">
        <button
          class="btn"
          disabled={!lastLayout || lastLayout.length === 0}
          onClick={() => {
            const r = copyLastLayout(lastLayout, rules);
            commit(r.placements);
            setNote(
              r.placements.length === 0
                ? { text: "None of last round's units are in your army this time. Place some new ones!", bad: true }
                : r.dropped > 0
                  ? { text: `Copied ${r.placements.length} units (${r.dropped} didn't fit).`, bad: false }
                  : { text: `Copied ${r.placements.length} units from last round.`, bad: false },
            );
          }}
        >
          ↺ Copy last layout
        </button>
        <button class="btn" disabled={placements.length === 0} onClick={() => commit([])}>
          ✕ Clear
        </button>
        <button class={cx('btn ready-btn', ready && 'on')} disabled={readyBusy} onClick={() => void toggleReady()} aria-pressed={ready}>
          {ready ? '✓ READY!' : 'READY'}
        </button>
      </div>
      {ready && <p class="dim small">You're ready! You can still change things until the host presses START.</p>}
      {st.game?.pendingAdvance?.to === 'BATTLE' ? (
        <p class="note countdown pixel" role="status">
          {countdownText(st.game.pendingAdvance)}
        </p>
      ) : (
        st.game?.allReady && <p class="note">Everyone's placed and ready! Waiting for the host to press START.</p>
      )}
      {st.game?.timer.expired && <p class="note">Time's up! Waiting for the host to press START.</p>}
    </section>
  );
}
