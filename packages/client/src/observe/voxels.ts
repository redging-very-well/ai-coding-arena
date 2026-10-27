// Voxel geometry for the 3D observer prototype. Every sprite pixel becomes a
// cube, extruded to a few voxels of depth, so a player's pixel-art unit turns
// into a Minecraft-style figure. Faces hidden by a neighbouring voxel are
// skipped and every unit frame ends up as one vertex-coloured BufferGeometry.
//
// A sprite is drawn facing right, so a model's local +x is its front; the
// model stands on y = 0 and is centred on x and z.

import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { SpriteFrame, SpriteSpec } from '@pixel-clash/shared';

/** Per-face shading, so the blocks read as cubes even under flat lighting. */
const FACE_SHADE = { top: 1, bottom: 0.55, side: 0.8, front: 0.9 } as const;

/** Cheap deterministic hash in [0, 1) for the per-voxel colour noise. */
function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ Math.imul(z + 97, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface Voxel {
  x: number;
  y: number;
  z: number;
  color: Color;
}

/**
 * Cubes → one geometry. `cell` is the cube edge; `voxels` use integer
 * coordinates (x right, y up, z towards the viewer of the sprite).
 */
export function voxelGeometry(voxels: readonly Voxel[], cell: number, noise = 0.06): BufferGeometry {
  const filled = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
  const has = (x: number, y: number, z: number): boolean => filled.has(`${x},${y},${z}`);
  const pos: number[] = [];
  const col: number[] = [];
  const norm: number[] = [];

  // Neighbour offset (= the face normal), the 4 corners counter-clockwise seen from outside, and the shade.
  const FACES: Array<{ d: [number, number, number]; c: Array<[number, number, number]>; shade: number }> = [
    { d: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: FACE_SHADE.front },
    { d: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: FACE_SHADE.side },
    { d: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: FACE_SHADE.top },
    { d: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: FACE_SHADE.bottom },
    { d: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: FACE_SHADE.side },
    { d: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: FACE_SHADE.side },
  ];

  for (const v of voxels) {
    const jitter = 1 + (hash(v.x, v.y, v.z) - 0.5) * 2 * noise;
    for (const f of FACES) {
      if (has(v.x + f.d[0], v.y + f.d[1], v.z + f.d[2])) continue;
      // A quad as two triangles: corners 0,1,2 and 0,2,3.
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const [cx, cy, cz] = f.c[k]!;
        pos.push((v.x + cx) * cell, (v.y + cy) * cell, (v.z + cz) * cell);
        col.push(v.color.r * f.shade * jitter, v.color.g * f.shade * jitter, v.color.b * f.shade * jitter);
        norm.push(...f.d);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(norm), 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * One sprite frame as a voxel figure: `cell` = cube edge, `depth` = voxels of
 * thickness. The rows are top to bottom, so row 0 is the highest layer. The
 * outer layers are a shade darker, which gives the slab some body.
 */
export function spriteVoxels(spec: SpriteSpec, rows: SpriteFrame, depth: number): Voxel[] {
  const palette = new Map<string, Color>();
  // Seen from above, a thin slab shows mostly its outline colour, which sprites make near-black:
  // lift very dark entries to a mid grey so the figure reads as shaded, not black.
  const dark = new Color(0.18, 0.18, 0.18);
  for (const [key, hex] of Object.entries(spec.palette)) {
    const c = new Color(hex);
    if (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.05) c.lerp(dark, 0.6);
    palette.set(key, c);
  }
  const grid = spec.grid;
  const voxels: Voxel[] = [];
  for (let r = 0; r < grid; r++) {
    const row = rows[r] ?? '';
    for (let c = 0; c < grid; c++) {
      const base = palette.get(row[c] ?? '.');
      if (!base) continue;
      // A pixel with no opaque neighbour is a spark or an ember: one small cube, not a bar of full depth.
      const lone = ![[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dc, dr]) => palette.has(rows[r + dr!]?.[c + dc!] ?? '.'));
      if (lone) {
        voxels.push({ x: c - grid / 2, y: grid - 1 - r, z: -0.5, color: base.clone() });
        continue;
      }
      for (let z = 0; z < depth; z++) {
        const color = base.clone();
        const edge = Math.min(z, depth - 1 - z);
        if (depth > 2 && edge === 0) color.multiplyScalar(0.82);
        voxels.push({ x: c - grid / 2, y: grid - 1 - r, z: z - depth / 2, color });
      }
    }
  }
  return voxels;
}

/** A plain coloured box of w×h×d cubes (walls, trees, the ground's props). */
export function boxVoxels(w: number, h: number, d: number, color: (x: number, y: number, z: number) => Color): Voxel[] {
  const voxels: Voxel[] = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < d; z++) voxels.push({ x: x - w / 2, y, z: z - d / 2, color: color(x, y, z) });
  return voxels;
}
