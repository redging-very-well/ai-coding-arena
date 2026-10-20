// A unit's sprite, idle frame, drawn crisp at a whole-number scale. Used by
// the "Show details" rosters (the facilitator sees hidden sprites too, so they
// can be un-hidden; `showFallback` draws what everyone else sees instead).

import { useEffect, useRef } from 'preact/hooks';
import type { SpriteSpec, StatsSnapshot } from '@pixel-clash/shared';
import { pixelsToCanvas } from '../common/render/canvas.js';
import { rasterizeFrame, resolveSprite } from '../common/render/sprites.js';

export interface SpriteThumbProps {
  sprite: SpriteSpec | null;
  stats: StatsSnapshot;
  /** Draw the fallback (what players see when the sprite is hidden). */
  showFallback?: boolean;
  /** CSS px (square). */
  size?: number;
  title?: string;
}

export function SpriteThumb({ sprite, stats, showFallback = false, size = 64, title }: SpriteThumbProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const spec = resolveSprite({ sprite, spriteHidden: showFallback, stats });
    const frame = spec.frames.idle[0];
    const ctx = canvas.getContext('2d');
    if (!ctx || !frame) return;
    const scale = Math.max(1, Math.floor(size / spec.grid));
    const px = spec.grid * scale;
    canvas.width = px;
    canvas.height = px;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(pixelsToCanvas(rasterizeFrame(spec, frame)), 0, 0, px, px);
  }, [sprite, stats, showFallback, size]);
  return <canvas ref={ref} class="pixelated sprite-thumb" style={{ width: `${size}px`, height: `${size}px` }} title={title} />;
}
