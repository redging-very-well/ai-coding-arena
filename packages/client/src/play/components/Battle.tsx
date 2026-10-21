// BATTLE (plan §12.1): the live isometric arena (shared renderer, own units
// highlighted) and a list of my units with HP and status (napping 💤 / KO).
// Also used in RESULTS to watch the replay of the last battle.

import { useEffect, useRef } from 'preact/hooks';
import { formatClock, ticksToSeconds } from '../../common/ui.js';
import { getStore, useStore, type MyBattleUnit } from '../store.js';

/** Mounts the store's arena canvas and runs the render loop while visible. */
export function ArenaView(props: { class?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const store = getStore();
    const el = host.current;
    if (!el) return;
    el.appendChild(store.arenaCanvas);
    store.arena.resize(true);
    store.arena.start();
    return () => {
      store.arena.stop();
      store.arenaCanvas.remove();
    };
  }, []);
  return <div ref={host} class={`arena-host ${props.class ?? ''}`} />;
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
  const alive = mine.filter((u) => u.alive).length;
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
                My army: {alive} / {mine.length} standing
              </h3>
              <ul class="bu-list">
                {mine.map((u) => (
                  <UnitRow key={u.instanceId} u={u} />
                ))}
              </ul>
              {napping.length > 0 && (
                <p class="note small">
                  💤 A unit takes a nap when its code keeps going wrong or thinks too slowly. After the battle, ask Claude to fix it!
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
