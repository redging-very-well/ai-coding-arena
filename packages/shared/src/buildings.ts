// Buildings on the placement grid (plan §5.2, §9.3 Placement check) and the
// built-in minion's look.
//
// `trappedCells`: walls block everyone, own units included, so a soldier or
// factory boxed in by its owner's walls can never get out (a factory's
// minions can't either). A 4-neighbour flood fill over the zone's 6×6 cells,
// walls blocking, starts from every wall-free cell on the zone's border whose
// outside neighbour is inside the arena (the arena edge is not an exit).
// Every soldier or factory cell it doesn't reach gets the non-fatal
// W_TRAPPED warning on /play. Towers don't move and are never warned.

import type { MinionKind, SpriteSpec, UnitType } from './contract.js';
import { CELL_SIZE, GRID_SIZE, type Cell } from './geometry.js';
import { cellCenter, cornerZone, type ZoneRef } from './maps.js';

export interface TrappedPlacement extends Cell {
  unitId: string;
}

/**
 * The placements (soldiers and factories) that walls box in (§9.3).
 * `typeOf` gives each placed design's type; `arena` is the arena side (the
 * zone's own when it is a map zone).
 */
export function trappedCells(
  zone: ZoneRef,
  placements: ReadonlyArray<TrappedPlacement>,
  typeOf: (unitId: string) => UnitType | undefined,
  arena: number = typeof zone === 'string' ? 800 : zone.arena,
): TrappedPlacement[] {
  const n = GRID_SIZE;
  const wall = new Array<boolean>(n * n).fill(false);
  for (const p of placements) if (typeOf(p.unitId) === 'wall') wall[p.row * n + p.col] = true;
  const reached = new Array<boolean>(n * n).fill(false);
  const queue: Cell[] = [];
  const inArena = (x: number, y: number) => x > 0 && y > 0 && x < arena && y < arena;
  const z = typeof zone === 'string' ? cornerZone(zone) : zone;
  // Seeds: wall-free border cells with an exit outside the zone that is inside the arena.
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (row !== 0 && row !== n - 1 && col !== 0 && col !== n - 1) continue;
      if (wall[row * n + col]) continue;
      const c = cellCenter(zone, col, row);
      const exits = [
        [c.x - CELL_SIZE, c.y],
        [c.x + CELL_SIZE, c.y],
        [c.x, c.y - CELL_SIZE],
        [c.x, c.y + CELL_SIZE],
      ];
      // An exit is a neighbour outside the zone's rectangle.
      const self = (x: number, y: number) => x > z.x && y > z.y && x < z.x + z.width && y < z.y + z.height;
      if (exits.some(([x, y]) => !self(x!, y!) && inArena(x!, y!))) {
        reached[row * n + col] = true;
        queue.push({ col, row });
      }
    }
  }
  while (queue.length > 0) {
    const { col, row } = queue.shift()!;
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const cc = col + dc;
      const rr = row + dr;
      if (cc < 0 || rr < 0 || cc >= n || rr >= n) continue;
      const i = rr * n + cc;
      if (reached[i] || wall[i]) continue;
      reached[i] = true;
      queue.push({ col: cc, row: rr });
    }
  }
  return placements.filter((p) => {
    const t = typeOf(p.unitId);
    return (t === 'soldier' || t === 'factory') && !reached[p.row * n + p.col];
  });
}

/** Palette key of the minion sprite's body pixels, recoloured with the factory's colour. */
export const MINION_BODY_KEY = 'b';

/**
 * The built-in minion look (§5.2): 12×12, idle, 2 walk frames, 1 attack frame,
 * drawn facing right. Use `minionSprite(color)` for a factory's tint.
 */
export const MINION_SPRITE: SpriteSpec = {
  grid: 12,
  palette: { o: '#1E1A16', b: '#C0A060', d: '#7A6038', w: '#FFFFFF', k: '#000000' },
  frames: {
    idle: [
      [
        '............',
        '....oooo....',
        '...obbbbo...',
        '..obbbbbbo..',
        '..obbwkbwko.',
        '..obbbbbbo..',
        '..obddddbo..',
        '...obbbbo...',
        '...obddbo...',
        '...oo..oo...',
        '...oo..oo...',
        '............',
      ],
    ],
    walk: [
      [
        '............',
        '....oooo....',
        '...obbbbo...',
        '..obbbbbbo..',
        '..obbwkbwko.',
        '..obbbbbbo..',
        '..obddddbo..',
        '...obbbbo...',
        '...obddbo...',
        '..oo....oo..',
        '..o......o..',
        '............',
      ],
      [
        '............',
        '............',
        '....oooo....',
        '...obbbbo...',
        '..obbbbbbo..',
        '..obbwkbwko.',
        '..obbbbbbo..',
        '..obddddbo..',
        '...obbbbo...',
        '...obddbo...',
        '....oooo....',
        '............',
      ],
    ],
    attack: [
      [
        '............',
        '....oooo....',
        '...obbbbo...',
        '..obbbbbbo..',
        '..obbwkbwkoo',
        '..obbbbbbobo',
        '..obddddbooo',
        '...obbbbo...',
        '...obddbo...',
        '...oo..oo...',
        '...oo..oo...',
        '............',
      ],
    ],
  },
};

/** Shared palette of the M8.6 kinds: outline, body (tinted), dark (tinted), eyes, wood, string, headband. */
const KIND_PALETTE = { o: '#1E1A16', b: '#C0A060', d: '#7A6038', w: '#FFFFFF', k: '#000000', n: '#8B5A2B', s: '#E8E8E8', r: '#D23C3C' };

/** Archer (§5.3): a hooded figure with a bow, facing right; the attack frame looses an arrow. */
const ARCHER_SPRITE: SpriteSpec = {
  grid: 12,
  palette: KIND_PALETTE,
  frames: {
    idle: [
      [
        '............',
        '....oooo....',
        '...odddo.n..',
        '...obwkbo.n.',
        '...obbbbo.sn',
        '..obbbbbbosn',
        '..obddddbosn',
        '...obbbbo.n.',
        '...obddbon..',
        '...oo..oo...',
        '...oo..oo...',
        '............',
      ],
    ],
    walk: [
      [
        '............',
        '....oooo....',
        '...odddo.n..',
        '...obwkbo.n.',
        '...obbbbo.sn',
        '..obbbbbbosn',
        '..obddddbosn',
        '...obbbbo.n.',
        '...obddbon..',
        '..oo....oo..',
        '..o......o..',
        '............',
      ],
      [
        '............',
        '............',
        '....oooo....',
        '...odddo.n..',
        '...obwkbo.n.',
        '...obbbbo.sn',
        '..obbbbbbosn',
        '..obddddbosn',
        '...obbbbo.n.',
        '...obddbon..',
        '....oooo....',
        '............',
      ],
    ],
    attack: [
      [
        '............',
        '....oooo....',
        '...odddo..n.',
        '...obwkbo..n',
        '...obbbbos.n',
        '..obbbbbbwww',
        '..obddddbs.n',
        '...obbbbo..n',
        '...obddbo.n.',
        '...oo..oo...',
        '...oo..oo...',
        '............',
      ],
    ],
  },
};

/** Runner (§5.3): small and lean with a red headband and speed lines. */
const RUNNER_SPRITE: SpriteSpec = {
  grid: 12,
  palette: KIND_PALETTE,
  frames: {
    idle: [
      [
        '............',
        '.....oooo...',
        '....orrrro..',
        '....obbwko..',
        '....obbbbo..',
        '.ww.obddbo..',
        '...obbbbbo..',
        '.ww.obbbo...',
        '....obddo...',
        '...oo..oo...',
        '..oo....oo..',
        '............',
      ],
    ],
    walk: [
      [
        '............',
        '.....oooo...',
        '....orrrro..',
        '....obbwko..',
        '....obbbbo..',
        '.ww.obddbo..',
        '...obbbbbo..',
        '.ww.obbbo...',
        '....obddo...',
        '..oo....oo..',
        '.oo......oo.',
        '............',
      ],
      [
        '............',
        '.....oooo...',
        '....orrrro..',
        '....obbwko..',
        '....obbbbo..',
        'ww..obddbo..',
        '...obbbbbo..',
        'ww..obbbo...',
        '....obddo...',
        '....oooo....',
        '...oo..oo...',
        '............',
      ],
    ],
    attack: [
      [
        '............',
        '.....oooo...',
        '....orrrro..',
        '....obbwko..',
        '....obbbbo..',
        '.ww.obddbo..',
        '...obbbbbooo',
        '.ww.obbbo...',
        '....obddo...',
        '...oo..oo...',
        '..oo....oo..',
        '............',
      ],
    ],
  },
};

/** Brute (§5.3): bulky, with a wooden club over its shoulder; the attack frame swings it down. */
const BRUTE_SPRITE: SpriteSpec = {
  grid: 12,
  palette: KIND_PALETTE,
  frames: {
    idle: [
      [
        '..oooooo....',
        '.obbbbbbo.nn',
        '.obwkbwkonnn',
        '.obbbbbbo.nn',
        'obbddddbbon.',
        'obbbbbbbbon.',
        'obdbbbbdbon.',
        'obbbbbbbbo..',
        '.obddddbo...',
        '.obbo.obbo..',
        '.ooo..ooo...',
        '............',
      ],
    ],
    walk: [
      [
        '..oooooo....',
        '.obbbbbbo.nn',
        '.obwkbwkonnn',
        '.obbbbbbo.nn',
        'obbddddbbon.',
        'obbbbbbbbon.',
        'obdbbbbdbon.',
        'obbbbbbbbo..',
        '.obddddbo...',
        '.obbo..obbo.',
        '.ooo....ooo.',
        '............',
      ],
      [
        '............',
        '..oooooo....',
        '.obbbbbbo.nn',
        '.obwkbwkonnn',
        '.obbbbbbo.nn',
        'obbddddbbon.',
        'obbbbbbbbon.',
        'obdbbbbdbon.',
        'obbbbbbbbo..',
        '.obddddbo...',
        '..oooooo....',
        '............',
      ],
    ],
    attack: [
      [
        '..oooooo....',
        '.obbbbbbo...',
        '.obwkbwko...',
        '.obbbbbbo...',
        'obbddddbbo..',
        'obbbbbbbbonn',
        'obdbbbbdbonn',
        'obbbbbbbbonn',
        '.obddddbo.nn',
        '.obbo.obbo..',
        '.ooo..ooo...',
        '............',
      ],
    ],
  },
};

/** The built-in look of every minion kind (§5.3); the grunt is the M8.5 minion. */
export const MINION_SPRITES: Readonly<Record<MinionKind, SpriteSpec>> = {
  grunt: MINION_SPRITE,
  archer: ARCHER_SPRITE,
  runner: RUNNER_SPRITE,
  brute: BRUTE_SPRITE,
};

/** A minion kind's sprite with its body in a factory's colour (and a darker shade). */
export function minionSprite(color: string, kind: MinionKind = 'grunt'): SpriteSpec {
  const dark = shade(color, 0.6);
  const base = MINION_SPRITES[kind] ?? MINION_SPRITE;
  return { ...base, palette: { ...base.palette, [MINION_BODY_KEY]: color, d: dark } };
}

function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`.toUpperCase();
}
