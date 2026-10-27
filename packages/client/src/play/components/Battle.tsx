// BATTLE: the live isometric arena (shared renderer, own units
// highlighted) and a list of my units with HP and status (napping 💤 / KO).
// Also used in RESULTS to watch the replay of the last battle.

import { useEffect, useRef, useState } from 'preact/hooks';
import { formatClock, ticksToSeconds } from '../../common/ui.js';
import { getStore, useStore, type MyBattleUnit } from '../store.js';

/** Mounts the store's arena canvas and runs the render loop while visible. */
export function ArenaView(props: { class?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{ mode: '2d' | '3d'; unavailable: boolean; follow: string | null }>({ mode: '2d', unavailable: false, follow: null });
  useEffect(() => {
    const store = getStore();
    const el = host.current;
    if (!el) return;
    el.appendChild(store.arenaCanvas);
    el.appendChild(store.arenaCanvas3d);
    store.arena.resize(true);
    store.arena.start();
    const v = store.ensureView3d();
    const sync = () => setView({ mode: v.mode, unavailable: v.unavailable, follow: v.following ? `${v.following.mode === 'chase' ? 'Chasing' : 'Following'} ${v.following.name}` : null });
    sync();
    const off = v.subscribe(sync);
    return () => {
      off();
      store.arena.stop();
      store.arenaCanvas.remove();
      store.arenaCanvas3d.remove();
    };
  }, []);
  return (
    <div ref={host} class={`arena-host ${props.class ?? ''}`}>
      {!view.unavailable && (
        <button
          type="button"
          class="view-toggle"
          title="Switch between the 3D and 2D arena"
          onClick={() => getStore().view3d?.toggle()}
        >
          {view.mode === '3d' ? '3D' : '2D'}
        </button>
      )}
      {view.mode === '3d' && (
        <div class="view-hint">
          {view.follow ? (
            <>
              🎥 {view.follow} · <kbd>V</kbd> camera · <kbd>N</kbd> next · <kbd>Esc</kbd> release
            </>
          ) : (
            'Click a unit to follow it'
          )}
        </div>
      )}
    </div>
  );
}

function UnitRow({ u }: { u: MyBattleUnit }) {
  const frac = u.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / u.maxHp)) : 0;
  const color = frac > 0.5 ? 'var(--good)' : frac > 0.25 ? 'var(--warn)' : 'var(--bad)';
  return (
    <li class={`bu ${u.alive ? '' : 'ko'}`}>
      <span class="bu-name">{u.name}</span>
      <span class="bar hp">
        <span class="fill" style={{ width: `${Math.round(frac * 100)}%`, background: color }} />
      </span>
      <span class="bu-status">
        {!u.alive ? 'KO' : u.napping ? '💤 napping' : `${Math.ceil(u.hp)} HP`}
      </span>
    </li>
  );
}

export function Battle() {
  const st = useStore();
  const pb = st.game?.battle;
  const secondsLeft = pb ? ticksToSeconds(pb.totalTicks - pb.tick) : null;
  const mine = st.myBattle;
  // Fighters only, like the /screen army bars (walls don't count as standing).
  const fighters = mine.filter((u) => !u.wall);
  const alive = fighters.filter((u) => u.alive).length;
  const walls = mine.length - fighters.length;
  const wallsUp = mine.filter((u) => u.wall && u.alive).length;
  const fielded = st.reveal?.players.some((p) => p.playerId === st.player?.id) ?? false;
  const napping = mine.filter((u) => u.alive && u.napping);

  return (
    <section class="panel battle">
      <div class="panel-head">
        <h2>CLASH!</h2>
        <span class={`battle-clock ${secondsLeft !== null && secondsLeft <= 10 ? 'urgent' : ''}`}>
          {formatClock(secondsLeft)}
          {pb?.paused && <span class="tag">paused</span>}
          {pb?.speed === 2 && <span class="tag">2×</span>}
          {pb?.thinking && <span class="tag dim">thinking…</span>}
        </span>
      </div>
      <div class="battle-layout">
        <div class="arena-box">
          <ArenaView />
          {pb && pb.tick === 0 && <div class="arena-overlay pixel">Get ready…</div>}
        </div>
        <aside class="my-units">
          {fielded ? (
            <>
              <h3>
                My army: {alive} / {fighters.length} standing
              </h3>
              {walls > 0 && (
                <p class="small dim">
                  🧱 Walls: {wallsUp} / {walls} up
                </p>
              )}
              {st.myMinions > 0 && (
                <p class="small minion-count">
                  🏭 {st.myMinions} minion{st.myMinions === 1 ? '' : 's'} out fighting
                </p>
              )}
              <ul class="bu-list">
                {mine.map((u) => (
                  <UnitRow key={u.instanceId} u={u} />
                ))}
              </ul>
              {napping.length > 0 && (
                <p class="note small">
                  💤 A unit takes a nap when its code keeps going wrong or thinks too slowly. After the battle, ask your AI helper to fix it!
                </p>
              )}
            </>
          ) : (
            <p class="dim">You're watching this one. You're in from the next round!</p>
          )}
          <p class="dim small">Your units have a bouncing arrow over them. The big screen shows the battle too!</p>
        </aside>
      </div>
    </section>
  );
}
