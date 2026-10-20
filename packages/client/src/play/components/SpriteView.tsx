// An animated unit sprite on a small canvas (plan §5.1): idle loop at 8 fps,
// walk while `walking` (hover). Uses the shared baker, so the look matches the
// arena exactly (seat-coloured outline, fallback for missing/hidden sprites).
// All SpriteViews share one requestAnimationFrame loop.

import { useEffect, useRef } from 'preact/hooks';
import type { SpriteSpec } from '@pixel-clash/shared';
import { pixelsToCanvas, type Bitmap } from '../../common/render/canvas.js';
import { ANIM_FRAME_MS, SpriteCache, chooseBakeScale, type AnimState } from '../../common/render/sprites.js';

const cache = new SpriteCache<Bitmap>(pixelsToCanvas, 512);
const drawers = new Set<(now: number) => void>();
let raf = 0;

function loop(now: number): void {
  for (const d of drawers) d(now);
  raf = drawers.size > 0 ? requestAnimationFrame(loop) : 0;
}

function addDrawer(d: (now: number) => void): () => void {
  drawers.add(d);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    drawers.delete(d);
  };
}

const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface SpriteViewProps {
  spec: SpriteSpec;
  /** Identifies the spec for the bake cache (include the version). */
  specKey: string;
  /** Seat colour for the outline, or null. */
  outline: string | null;
  /** Width of the sprite's own pixels in CSS px (the outline adds a little). */
  width: number;
  state?: AnimState;
  mirror?: boolean;
  /** Animate (default true). */
  animate?: boolean;
  class?: string;
  title?: string;
}

export function SpriteView(props: SpriteViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let lastKey = '';
    const draw = (now: number) => {
      const p = live.current;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const scale = chooseBakeScale(p.spec.grid, p.width * dpr);
      const baked = cache.get(p.specKey, p.spec, p.outline, scale);
      const state = p.state ?? 'idle';
      const n = baked.frameCount(state);
      const frame = p.animate === false || reduceMotion ? 0 : Math.floor(now / ANIM_FRAME_MS) % n;
      const key = `${p.specKey}|${p.outline}|${scale}|${state}|${frame}|${p.mirror ? 1 : 0}|${p.width}`;
      if (key === lastKey) return;
      lastKey = key;
      if (canvas.width !== baked.size || canvas.height !== baked.size) {
        canvas.width = baked.size;
        canvas.height = baked.size;
      }
      const cssW = (p.width * baked.size) / (baked.grid * baked.scale);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssW}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(baked.frame(state, frame, p.mirror ?? false), 0, 0);
    };
    draw(performance.now());
    return addDrawer(draw);
  }, []);

  return <canvas ref={ref} class={`sprite pixelated ${props.class ?? ''}`} title={props.title} aria-hidden="true" />;
}
