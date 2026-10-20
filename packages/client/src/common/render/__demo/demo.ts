// Dev-only harness to eyeball the renderer: plays a canned battle produced by
// the real sim (scripts/demo-replay.ts) and shows every unit's baked sprite
// states. Open http://localhost:5173/src/common/render/__demo/ under `npm run dev`
// (or `npx vite` in packages/client). Not part of the production build.

import type { ReplayDTO } from '@pixel-clash/shared';
import '../../theme.css';
import { ArenaRenderer } from '../arena.js';
import { pixelsToCanvas } from '../canvas.js';
import { ANIM_STATES, bakeFrame, resolveSprite, stateFrames } from '../sprites.js';
import { hexToRgb, seatStyle } from '../../seats.js';
import { ensureFonts, formatClock } from '../../ui.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const style = document.createElement('style');
style.textContent = `
  body { padding: 12px; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 8px; }
  .bar h1 { font-size: 14px; margin: 0 12px 0 0; }
  #scrub { flex: 1; min-width: 200px; }
  main { display: grid; grid-template-columns: 1fr 340px; gap: 12px; }
  #arena { width: 100%; height: calc(100vh - 90px); background: #0d0f1a; border: 1px solid var(--border); }
  #sheet { overflow: auto; height: calc(100vh - 90px); }
  .unit { background: var(--panel); border-left: 4px solid var(--seat); padding: 6px 8px; margin-bottom: 8px; }
  .unit h3 { font-size: 10px; margin: 0 0 6px; }
  .row { display: flex; gap: 4px; align-items: end; flex-wrap: wrap; font-size: 11px; color: var(--text-dim); }
  .row canvas { image-rendering: pixelated; width: 48px; height: 48px; background: #262c48; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } #sheet { height: auto; } }
`;
document.head.appendChild(style);

const canvas = $<HTMLCanvasElement>('arena');
const arena = new ArenaRenderer(canvas, {
  onEvent: (ev) => {
    if (ev.type === 'disable') console.info('napping:', ev.instanceId, ev.reason);
  },
});

async function main(): Promise<void> {
  await ensureFonts();
  let replay: ReplayDTO;
  try {
    const res = await fetch(new URL('./replay.json', import.meta.url));
    if (!res.ok) throw new Error(String(res.status));
    replay = (await res.json()) as ReplayDTO;
  } catch {
    $('msg').textContent =
      'No replay.json yet. Run: npx tsx --no-node-snapshot --conditions=source scripts/demo-replay.ts — then reload.';
    arena.setZones([
      { corner: 'TL', seat: 0 },
      { corner: 'TR', seat: 1 },
      { corner: 'BR', seat: 2 },
      { corner: 'BL', seat: 3 },
    ]);
    arena.start();
    return;
  }

  arena.loadReplay(replay);
  arena.start();
  buildSheet(replay);

  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(replay.end.endTick);
  let paused = false;
  let speed: 1 | 2 = 1;
  $('play').onclick = () => {
    paused = !paused;
    arena.setPlayback({ paused });
    $('play').textContent = paused ? 'Play' : 'Pause';
  };
  $('speed').onclick = () => {
    speed = speed === 1 ? 2 : 1;
    arena.setPlayback({ speed });
    $('speed').textContent = `${speed}x`;
  };
  let scrubbing = false;
  scrub.oninput = () => {
    scrubbing = true;
    arena.seek(Number(scrub.value));
  };
  scrub.onchange = () => (scrubbing = false);
  $<HTMLSelectElement>('seat').onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    arena.setOptions({ highlightSeat: v === '' ? null : Number(v) });
  };
  $<HTMLInputElement>('snap').onchange = (e) => {
    arena.setOptions({ fit: { pixelSnap: (e.target as HTMLInputElement).checked } });
  };
  $('reveal').onclick = () => {
    // Reveal only (units drop in), then start the replay after 2 s.
    arena.setReveal(replay.reveal);
    setTimeout(() => arena.loadReplay(replay), 2000);
  };
  const tick = () => {
    if (!scrubbing) scrub.value = String(Math.round(arena.tick));
    $('time').textContent = formatClock((replay.end.endTick - arena.tick) / 60);
    requestAnimationFrame(tick);
  };
  tick();
}

/** Every revealed design's states, baked with its seat outline. */
function buildSheet(replay: ReplayDTO): void {
  const sheet = $('sheet');
  for (const p of replay.reveal.players) {
    for (const u of p.units) {
      const spec = resolveSprite(u);
      const box = document.createElement('div');
      box.className = `unit seat-${p.seat}`;
      const h = document.createElement('h3');
      h.textContent = `${p.name}: ${u.name} (${u.sprite ? `${spec.grid}px sprite` : 'fallback'}, size ${u.stats.size})`;
      box.appendChild(h);
      for (const state of ANIM_STATES) {
        const sf = stateFrames(spec, state);
        const row = document.createElement('div');
        row.className = 'row';
        row.append(`${state}${sf.flash ? ' (flash)' : sf.fadeOnly ? ' (fade)' : ''}: `);
        sf.frames.forEach((f) => {
          const c = pixelsToCanvas(
            bakeFrame(spec, f, { scale: 2, outline: hexToRgb(seatStyle(p.seat).color), flash: sf.flash }),
          );
          row.appendChild(c);
        });
        box.appendChild(row);
      }
      sheet.appendChild(box);
    }
  }
}

void main();
