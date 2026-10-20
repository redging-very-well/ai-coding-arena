// A tiny RGBA pixel buffer and the pixel-art operations the renderer needs
// (nearest-neighbour upscale, outline, mirror, flash). DOM-free so the sprite
// and floor generators can be unit-tested in Node; render/canvas.ts turns a
// PixelImage into a canvas.

import type { Rgb } from '../seats.js';

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel (same layout as ImageData.data). */
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): PixelImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function alphaAt(img: PixelImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.data[(y * img.width + x) * 4 + 3]!;
}

export function getPixel(img: PixelImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
}

export function setPixel(img: PixelImage, x: number, y: number, [r, g, b]: Rgb, a = 255): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

/** Nearest-neighbour upscale by an integer factor (pixel-art crisp). */
export function scaleNearest(src: PixelImage, factor: number): PixelImage {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return { width: src.width, height: src.height, data: src.data.slice() };
  const out = createImage(src.width * f, src.height * f);
  const s = src.data;
  const d = out.data;
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / f);
    for (let x = 0; x < out.width; x++) {
      const si = (sy * src.width + Math.floor(x / f)) * 4;
      const di = (y * out.width + x) * 4;
      d[di] = s[si]!;
      d[di + 1] = s[si + 1]!;
      d[di + 2] = s[si + 2]!;
      d[di + 3] = s[si + 3]!;
    }
  }
  return out;
}

/** Copy into a larger transparent image with `pad` pixels on every side. */
export function padImage(src: PixelImage, pad: number): PixelImage {
  const out = createImage(src.width + pad * 2, src.height + pad * 2);
  for (let y = 0; y < src.height; y++) {
    const from = y * src.width * 4;
    out.data.set(src.data.subarray(from, from + src.width * 4), ((y + pad) * out.width + pad) * 4);
  }
  return out;
}

/**
 * Paint `color` on every transparent pixel within `width` pixels (4-neighbour
 * steps, so corners stay crisp) of an opaque one. Mutates and returns `img`;
 * pad first so the outline has room.
 */
export function outlineImage(img: PixelImage, color: Rgb, width = 1): PixelImage {
  const { width: w, height: h } = img;
  let solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = img.data[i * 4 + 3]! > 0 ? 1 : 0;
  const original = solid;
  for (let step = 0; step < width; step++) {
    const next = solid.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (solid[i]) continue;
        if ((x > 0 && solid[i - 1]) || (x < w - 1 && solid[i + 1]) || (y > 0 && solid[i - w]) || (y < h - 1 && solid[i + w])) {
          next[i] = 1;
        }
      }
    }
    solid = next;
  }
  for (let i = 0; i < w * h; i++) {
    if (solid[i] && !original[i]) {
      img.data[i * 4] = color[0];
      img.data[i * 4 + 1] = color[1];
      img.data[i * 4 + 2] = color[2];
      img.data[i * 4 + 3] = 255;
    }
  }
  return img;
}

/** Horizontal mirror (sprites are drawn facing right; mirrored = facing left). */
export function mirrorImage(src: PixelImage): PixelImage {
  const out = createImage(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      const di = (y * src.width + (src.width - 1 - x)) * 4;
      out.data[di] = src.data[si]!;
      out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!;
      out.data[di + 3] = src.data[si + 3]!;
    }
  }
  return out;
}

/** Every opaque pixel turned (mostly) white: the default `hit` flash. */
export function flashImage(src: PixelImage, amount = 0.8): PixelImage {
  const out = { width: src.width, height: src.height, data: src.data.slice() };
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = d[i]! + (255 - d[i]!) * amount;
    d[i + 1] = d[i + 1]! + (255 - d[i + 1]!) * amount;
    d[i + 2] = d[i + 2]! + (255 - d[i + 2]!) * amount;
  }
  return out;
}

/** Count of pixels with alpha > 0. */
export function opaqueCount(img: PixelImage): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++;
  return n;
}
