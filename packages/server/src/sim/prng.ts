// Seeded PRNG for the engine. The engine never calls
// Math.random; the only randomness it needs (a push direction for two bodies
// at exactly the same spot) comes from here, so equal seeds give equal battles.

/** A deterministic random source returning floats in [0, 1). */
export type Rng = () => number;

/** mulberry32: tiny, fast, good enough for gameplay. `seed` is any number. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent sub-seed (e.g. engine vs. per-player sandbox seeds). */
export function deriveSeed(seed: number, salt: number): number {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(salt >>> 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
