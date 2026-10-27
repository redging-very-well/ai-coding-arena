// /observe: the 3D voxel view as a page of its own, replaying a stored battle.
//
//   /observe?round=N   a stored battle (default: the latest)
//   /observe?demo      the canned dev replay (needs `npm run dev`)
//   /observe?demo=showcase   the same with elemental, aura and healer units (scripts/demo-replay.ts --showcase)
//
// The page owns the controls (pause, speed, scrub, legend, sound); the view
// itself (voxelView.ts) is the one /screen and /play use, reading a headless
// ArenaRenderer that does the playback.

import type { FrameEvent, ReplayDTO } from '@pixel-clash/shared';
import '../common/theme.css';
import { api } from '../common/api.js';
import { SoundEngine } from '../common/audio.js';
import { ArenaRenderer, bodyOf } from '../common/render/arena.js';
import { isBigHit } from '../common/render/fx.js';
import { TICKS_PER_SECOND } from '../common/render/playback.js';
import { seatStyle } from '../common/seats.js';
import { shotPitch } from '../common/sfx.js';
import { formatClock } from '../common/ui.js';
import { createVoxelView } from './voxelView.js';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

async function loadReplay(): Promise<ReplayDTO> {
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    // Only the Vite dev server (default :5173) serves this file; the game server's built client does not.
    const file = params.get('demo') === 'showcase' ? 'replay-showcase.json' : 'replay.json';
    const res = await fetch(`/src/common/render/__demo/${file}`);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('json')) {
      throw new Error(`the demo replay is only served by the Vite dev server (npm run dev, usually http://localhost:5173/observe?demo; got ${res.status} here). On the game server use /observe?round=N.`);
    }
    return (await res.json()) as ReplayDTO;
  }
  const round = params.get('round');
  return api.replay(round ? Number(round) : 'latest');
}

async function main(): Promise<void> {
  const app = $('#app');
  app.innerHTML = `
    <style>
      body { margin: 0; overflow: hidden; background: #8ec5ff; }
      canvas.stage { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
      canvas.flat { position: fixed; left: 0; top: 0; width: 2px; height: 2px; visibility: hidden; }
      .hud { position: fixed; left: 0; right: 0; top: 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 8px 12px; background: rgba(13,15,26,.78); color: var(--text, #fff); font: 13px system-ui, sans-serif; }
      .hud button { font: inherit; padding: 5px 10px; cursor: pointer; }
      .hud input[type=range] { flex: 1; min-width: 160px; }
      .hud .title { font-size: 12px; color: var(--accent, #ffd447); }
      .legend, .pick { position: fixed; background: rgba(13,15,26,.78); color: #fff; font: 13px system-ui, sans-serif; padding: 8px 10px; }
      .legend { left: 12px; top: 60px; }
      .legend div { display: flex; gap: 8px; align-items: center; margin: 3px 0; }
      .legend i { width: 12px; height: 12px; display: inline-block; border: 2px solid #000; }
      .pick { right: 12px; top: 60px; min-width: 190px; }
      .help { position: fixed; left: 12px; bottom: 10px; color: #fff; text-shadow: 0 1px 3px #000; font: 12px system-ui, sans-serif; }
      #msg { position: fixed; inset: 0; display: grid; place-items: center; color: #fff; font: 16px system-ui, sans-serif; text-shadow: 0 1px 4px #000; }
    </style>
    <canvas class="flat"></canvas>
    <canvas class="stage"></canvas>
    <div class="hud">
      <span class="title pixel">3D OBSERVER</span>
      <button id="play">Pause</button><button id="speed">1x</button>
      <input id="scrub" type="range" min="0" max="1" value="0" step="1" />
      <span id="time">0:00</span>
      <button id="view">View: orbit</button>
      <button id="sound">Sound: on</button>
    </div>
    <div class="legend" id="legend"></div>
    <div class="pick" id="pick" hidden></div>
    <div class="help">Drag: orbit · wheel: zoom · right-drag: pan · click a unit to follow it · V: follow / chase view · Tab: next unit · Esc: release · Space: pause · ←/→: ±5 s</div>
    <div id="msg">Loading battle…</div>`;
  const msg = $('#msg');

  let replay: ReplayDTO;
  try {
    replay = await loadReplay();
  } catch (e) {
    msg.textContent = `Could not load a battle: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }

  // The arena does the playback (and draws nothing: the 3D view reads its state).
  const arena = new ArenaRenderer($<HTMLCanvasElement>('canvas.flat'), { headless: true });
  arena.loadReplay(replay);
  arena.start();
  let view;
  try {
    view = createVoxelView($<HTMLCanvasElement>('canvas.stage'), arena, {
      interactive: true,
      shadowMapSize: 4096,
      onPick: (p) => {
        const pick = $('#pick');
        pick.hidden = !p;
        if (p) pick.innerHTML = `<b>${p.name}</b><br>${replay.reveal.players.find((q) => q.seat === p.owner)?.name ?? ''} · ${p.kind}`;
      },
      onViewMode: (m) => ($('#view').textContent = `View: ${m}`),
    });
  } catch (e) {
    msg.textContent = `3D needs WebGL, which this browser doesn't have: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  view.setEnabled(true);
  msg.remove();
  const endTick = replay.end.endTick;

  // Controls.
  const scrub = $<HTMLInputElement>('#scrub');
  scrub.max = String(endTick);
  $('#play').onclick = () => {
    if (arena.tick >= endTick - 1) arena.seek(0);
    const paused = !arena.clock.paused;
    arena.setPlayback({ paused });
    $('#play').textContent = paused ? 'Play' : 'Pause';
  };
  $('#speed').onclick = () => {
    const speed = arena.clock.speed === 1 ? 2 : 1;
    arena.setPlayback({ speed });
    $('#speed').textContent = `${speed}x`;
  };
  $('#view').onclick = () => view.cycleViewMode();
  let scrubbing = false;
  scrub.oninput = () => {
    scrubbing = true;
    arena.seek(Number(scrub.value));
  };
  scrub.onchange = () => (scrubbing = false);
  addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      $('#play').click();
    } else if (e.key === 'ArrowRight') arena.seek(arena.tick + 5 * TICKS_PER_SECOND);
    else if (e.key === 'ArrowLeft') arena.seek(arena.tick - 5 * TICKS_PER_SECOND);
  });

  // Legend with the units still standing per player.
  const legend = $('#legend');
  legend.innerHTML = replay.reveal.players.map((p) => `<div><i style="background:${seatStyle(p.seat).color}"></i>${seatStyle(p.seat).symbol} ${p.name} <span data-alive="${p.seat}"></span></div>`).join('');
  const alive = (): void => {
    const counts = new Map<number, number>();
    for (const u of arena.currentSample?.units ?? []) {
      const info = arena.instance(u.id);
      if (info && bodyOf(info) !== 'wall') counts.set(info.seat, (counts.get(info.seat) ?? 0) + 1);
    }
    for (const el of legend.querySelectorAll<HTMLElement>('[data-alive]')) el.textContent = `(${counts.get(Number(el.dataset.alive)) ?? 0})`;
  };
  const tickUi = (): void => {
    if (!scrubbing) scrub.value = String(Math.round(arena.tick));
    $('#time').textContent = formatClock((endTick - arena.tick) / TICKS_PER_SECOND);
    alive();
    requestAnimationFrame(tickUi);
  };
  tickUi();

  // Sound: the game's synthesized effects, louder near the camera. Browsers start audio only after a click or key press.
  const sound = new SoundEngine('pixel-clash:observe-muted', false);
  sound.installUnlock();
  const syncSound = (): void => {
    $('#sound').textContent = sound.muted ? 'Sound: off' : sound.state === 'running' ? 'Sound: on' : 'Sound: click to enable';
  };
  sound.subscribe(syncSound);
  syncSound();
  $('#sound').onclick = () => (sound.state === 'locked' && !sound.muted ? sound.unlock() : sound.toggleMuted());
  const where = (id: string): { x: number; y: number } | null => arena.currentSample?.units.find((u) => u.id === id) ?? null;
  const play = (name: Parameters<SoundEngine['play']>[0], at: { x: number; y: number } | null, extra: { pitch?: number } = {}): void => {
    if (at) sound.play(name, { gain: view.near(at.x, at.y), ...extra });
  };
  arena.subscribeEvents((ev: FrameEvent) => {
    if (ev.type === 'fire') {
      const info = arena.instance(ev.instanceId);
      const at = where(ev.instanceId);
      if (!info) return;
      const body = bodyOf(info);
      if (info.element === 'fire') play('fireShot', at);
      else if (info.element === 'ice') play('iceShot', at);
      else if (info.element === 'lightning') play('zapShot', at);
      else if (ev.melee) play('swing', at);
      else play('shoot', at, { pitch: shotPitch({ type: body === 'minion' ? 'soldier' : body, range: info.stats.range ?? 100 }) });
    } else if (ev.type === 'hit') {
      // Burn ticks, splash and zap hits are silent: the shot, the blast or the arc already sounded.
      if (ev.kind === 'burn' || ev.kind === 'splash' || ev.kind === 'zap') return;
      const info = arena.instance(ev.targetId);
      if (info) play(bodyOf(info) === 'wall' ? 'wallHit' : isBigHit(ev.damage, info.stats.maxHealth) ? 'bigHit' : 'hit', where(ev.targetId));
    } else if (ev.type === 'death') {
      const info = arena.instance(ev.instanceId);
      if (info) play(bodyOf(info) === 'wall' ? 'crumble' : 'death', where(ev.instanceId));
    } else if (ev.type === 'crumble') play('crumble', where(ev.ids[0] ?? ''));
    else if (ev.type === 'arc') play('zap', where(ev.from));
    else if (ev.type === 'splash') play('boom', ev);
    else if (ev.type === 'shatter') play('shatter', where(ev.id));
    else if (ev.type === 'heal') play('heal', where(ev.to));
  });
}

void main();
