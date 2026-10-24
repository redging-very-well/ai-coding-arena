// PLACEMENT (plan §12.1): the zone as an enlarged top-down 6×6 grid in its
// true orientation (arrow to the centre), a palette of the selected types,
// tap palette → tap cell, tap a placed unit to remove it, sprites at true
// size, live budget bar, Copy last layout / Clear / READY, autosave
// (debounced 300 ms) and an iso mini-map. Works for every zone orientation of
// the §9.2 maps (row 0 is always the front). Team mode: the mini-map shows the
// teammates' zones and placements live as ghosts, and the Team panel their picks.
// M8.5 (§12.5): the palette has a Units row and a Buildings row, counters
// "Fighters 7/12 · Factories 1/2 · Walls 6/12", walls are solid squares that
// join their neighbours, soldiers and factories boxed in by walls get a red
// outline ("Walled in! Leave a gap."), and with a wall chosen a press-and-drag
// paints walls along the cells passed over (stops at the copy cap or budget).

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { READY_MIN_GAP_MS, cornerZone, groupOf, sizeOf, type MapZone, type PlacementDTO, type UnitCardDTO } from '@pixel-clash/shared';
import { countdownText } from '../../common/advance.js';
import { ApiError, api, retryAfterMs } from '../../common/api.js';
import { resolveSprite } from '../../common/render/sprites.js';
import { arenaFor, toMapZone, zoneLabel } from '../../common/maps.js';
import { seatStyle } from '../../common/seats.js';
import { cx, debounce, formatMoney } from '../../common/ui.js';
import {
  GROUP_TITLES,
  combatChips,
  factoryKindChip,
  typeTitle,
  budgetText,
  cellFill,
  copiesOf,
  copyCounterText,
  copyCounts,
  copyLastLayout,
  isFrontCell,
  placementAt,
  spentOf,
  tapCell,
  towardCentre,
  trappedKeys,
  typeLookup,
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
  const typeOf = useMemo(() => typeLookup(palette), [palette]);
  const rules: PlacementRules = useMemo(
    () => ({
      costs: new Map(palette.map((u) => [u.unitId, u.cost])),
      budget: priv?.budget ?? st.caps.budget,
      maxCopies: st.caps.maxCopies,
      typeOf,
      maxWallCopies: st.caps.maxWallCopies,
      maxFactoryCopies: st.caps.maxFactoryCopies,
    }),
    [palette, typeOf, priv?.budget, st.caps],
  );
  /** The newest placements (a wall paint stroke places several before the next render). */
  const latest = useRef<PlacementDTO[]>([]);
  /** A wall paint stroke is under way (pointer held down with a wall chosen). */
  const painting = useRef(false);
  /** The click that ends a press which already placed a wall must not remove it again. */
  const swallowClick = useRef(false);

  // Server placement wins unless we have unsaved local edits.
  useEffect(() => {
    if (!dirty.current) setLocal(null);
  }, [priv?.placement]);
  // Pick the first palette unit to start with.
  useEffect(() => {
    if ((chosen === null || !unitsById.has(chosen)) && palette[0]) setChosen(palette[0].unitId);
  }, [palette]);

  const placements = local ?? priv?.placement ?? [];
  latest.current = placements;
  const spent = spentOf(placements, rules.costs);
  const copies = copiesOf(placements);
  const counts = copyCounts(placements, typeOf);
  const trapped = useMemo(() => (zone ? trappedKeys(zone, placements, typeOf) : new Set<string>()), [zone, placements, typeOf]);
  useEffect(() => {
    const stop = () => (painting.current = false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

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
    latest.current = next;
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
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    const now = latest.current;
    const r = tapCell(now, col, row, chosen, rules);
    if (!r.ok) {
      bump(`${col},${row}`, r.message);
      return;
    }
    setNote(null);
    store.sound.play(r.placements.length < now.length ? 'remove' : 'place', { force: true });
    commit(r.placements);
  };

  const wallChosen = chosen !== null && typeOf(chosen) === 'wall';
  /** Paint a wall on an empty cell (press or drag); false stops the stroke (cap, budget). */
  const paintAt = (col: number, row: number): boolean => {
    if (placementAt(latest.current, col, row)) return true;
    const r = tapCell(latest.current, col, row, chosen, rules);
    if (!r.ok) {
      bump(`${col},${row}`, r.message);
      return false;
    }
    setNote(null);
    store.sound.play('place', { force: true });
    commit(r.placements);
    return true;
  };
  const onCellDown = (e: PointerEvent, col: number, row: number) => {
    swallowClick.current = false;
    if (!wallChosen || e.button > 0 || placementAt(latest.current, col, row)) return;
    painting.current = paintAt(col, row);
    swallowClick.current = true;
    // Touch pointers are captured by the pressed cell: release so the stroke can cross cells.
    (e.target as Element | null)?.releasePointerCapture?.(e.pointerId);
  };
  const onGridMove = (e: PointerEvent) => {
    if (!painting.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-cell]');
    const key = el?.dataset.cell;
    if (!key) return;
    const [col, row] = key.split(',').map(Number) as [number, number];
    if (!paintAt(col, row)) painting.current = false;
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
    let holdMs = READY_MIN_GAP_MS;
    try {
      await api.setReady(!ready);
      store.sound.play(ready ? 'remove' : 'ready', { force: true });
    } catch (err) {
      holdMs = Math.max(holdMs, retryAfterMs(err));
      store.toast(err instanceof ApiError ? err.playerMessage : "Couldn't change READY. Try again!", 'error');
    } finally {
      // No spamming (§3): the button stays off for the server's minimum gap.
      setTimeout(() => setReadyBusy(false), holdMs);
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
          <div
            class={cx('zone-grid', ready && 'is-ready', wallChosen && 'paint-walls')}
            ref={gridRef}
            role="grid"
            aria-label={`Your ${where}, 6 by 6 squares`}
            onPointerMove={onGridMove}
          >
            {grid.map((c) => {
              const p = placementAt(placements, c.col, c.row);
              const u = p ? unitsById.get(p.unitId) : undefined;
              const key = `${c.col},${c.row}`;
              const front = isFrontCell(zone, c.col, c.row);
              const wall = u?.stats.type === 'wall';
              const boxed = !!u && trapped.has(key);
              return (
                <button
                  key={key}
                  data-cell={key}
                  class={cx('cell', p && 'filled', wall && 'wall', boxed && 'trapped', front && 'front', (c.gx + c.gy) % 2 === 1 && 'alt', shakeCell === key && 'shake')}
                  style={{ gridColumn: c.gx + 1, gridRow: c.gy + 1, ...(wall && u ? { '--wall': u.stats.color } : {}) }}
                  onPointerDown={(e) => onCellDown(e, c.col, c.row)}
                  onClick={() => onCell(c.col, c.row)}
                  aria-label={u ? `${u.name}${boxed ? ', walled in' : ''}, tap to remove` : 'Empty square'}
                >
                  {u && (
                    <SpriteView
                      spec={resolveSprite(u)}
                      specKey={specKeyOf(u)}
                      outline={wall ? null : seatStyle(seat).color}
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
            <div class="dim small copy-counts">
              {copyCounterText(counts, rules, {
                walls: palette.some((u) => u.stats.type === 'wall'),
                factories: palette.some((u) => u.stats.type === 'factory'),
              })}
            </div>
          </div>
        </aside>
      </div>

      {note && (
        <p class={cx('note', note.bad && 'bad')} role="alert">
          {note.text}
        </p>
      )}
      {trapped.size > 0 && (
        <p class="note bad trapped-note" role="status">
          🧱 Walled in! Leave a gap so your {trapped.size === 1 ? 'unit' : 'units'} can get out.
        </p>
      )}

      <div class="palette-groups" role="radiogroup" aria-label="Choose a unit to place">
        {palette.length === 0 && <p class="dim">No units picked for this round.</p>}
        {(['unit', 'building'] as const).map((group) => {
          const items = palette.filter((u) => groupOf(u.stats.type) === group);
          if (items.length === 0) return null;
          return (
            <div key={group} class="palette-row">
              <span class="palette-title">{GROUP_TITLES[group]}</span>
              <div class="palette">
                {items.map((u) => {
                  const affordable = spent + u.cost <= rules.budget;
                  return (
                    <button
                      key={u.unitId}
                      role="radio"
                      aria-checked={chosen === u.unitId}
                      class={cx('pal-item', chosen === u.unitId && 'chosen', !affordable && 'cant')}
                      title={typeTitle(u.stats)}
                      onClick={() => {
                        setChosen(chosen === u.unitId ? null : u.unitId);
                        setNote(null);
                      }}
                    >
                      <span class="pal-sprite">
                        <SpriteView
                          spec={resolveSprite(u)}
                          specKey={specKeyOf(u)}
                          outline={u.stats.type === 'wall' ? null : seatStyle(seat).color}
                          width={u.stats.type === 'wall' ? 40 : Math.max(20, sizeOf(u.stats) * 2.4)}
                        />
                      </span>
                      <span class="pal-name">
                        {u.name}
                        {u.stats.type === 'factory' && <span class="pal-kind"> {factoryKindChip(u.stats).icon}</span>}
                        {combatChips(u.stats).length > 0 && (
                          <span class="pal-kind" title={combatChips(u.stats).map((c) => c.label).join(', ')}>
                            {' '}
                            {combatChips(u.stats)
                              .map((c) => c.icon)
                              .join('')}
                          </span>
                        )}
                      </span>
                      <span class="pal-cost">{formatMoney(u.cost)}</span>
                      <span class="pal-copies">×{copies.get(u.unitId) ?? 0}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p class="dim small hint">
        Tap a unit above, then tap a square. Tap a placed unit to take it away.
        {wallChosen && ' With a wall chosen, press and drag to paint a line of walls.'}
      </p>

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
