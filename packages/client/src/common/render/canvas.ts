// DOM glue for the pure renderers: PixelImage → canvas, and HiDPI canvas
// sizing with pixel-art (nearest-neighbour) drawing.

import type { PixelImage } from './pixels.js';

export type Bitmap = HTMLCanvasElement;

/** A canvas holding the pixels of `img` (1:1). */
export function pixelsToCanvas(img: PixelImage): Bitmap {
  const c = document.createElement('canvas');
  c.width = Math.max(1, img.width);
  c.height = Math.max(1, img.height);
  const ctx = c.getContext('2d');
  if (ctx && img.width > 0 && img.height > 0) {
    const data = new ImageData(img.width, img.height);
    data.data.set(img.data);
    ctx.putImageData(data, 0, 0);
  }
  return c;
}

export interface CanvasSize {
  /** CSS px. */
  width: number;
  height: number;
  dpr: number;
}

/**
 * Size the backing store of `canvas` to its CSS box × devicePixelRatio and
 * set a transform so drawing code works in CSS px. Returns the CSS size, or
 * null when nothing changed.
 */
export function fitCanvasToBox(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, force = false): CanvasSize | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const bw = Math.round(width * dpr);
  const bh = Math.round(height * dpr);
  if (!force && canvas.width === bw && canvas.height === bh) return null;
  canvas.width = bw;
  canvas.height = bh;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return { width, height, dpr };
}

/** Get a 2D context set up for crisp pixel art. Throws if canvas is unsupported. */
export function pixelContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not supported in this browser');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}
