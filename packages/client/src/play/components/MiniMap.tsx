// Small isometric map (plan §12.1 PLACEMENT): shows where my zone sits in the
// arena as the projector draws it, with my placed units standing in it. Uses
// the shared ArenaRenderer with a reveal built from my own placement only
// (nothing about other players is known before START).

import { useEffect, useRef } from 'preact/hooks';
import {
  cellCenter,
  instanceIdFor,
  type BattleRevealDTO,
  type Corner,
  type PlacementDTO,
  type UnitCardDTO,
} from '@pixel-clash/shared';
import { ArenaRenderer } from '../../common/render/arena.js';

/** Redraw interval for the props' idle animation (2 fps is plenty). */
const PROP_REDRAW_MS = 500;

export interface MiniMapProps {
  zone: Corner;
  seat: number;
  playerId: string;
  name: string;
  placements: readonly PlacementDTO[];
  units: readonly UnitCardDTO[];
}

export function buildPreviewReveal(p: MiniMapProps): BattleRevealDTO {
  const used = new Set(p.placements.map((x) => x.unitId));
  const units = p.units.filter((u) => used.has(u.unitId));
  return {
    round: 0,
    totalTicks: 0,
    players: [
      {
        playerId: p.playerId,
        name: p.name,
        seat: p.seat,
        zone: p.zone,
        units: units.map((u) => ({
          unitId: u.unitId,
          name: u.name,
          stats: u.stats,
          cost: u.cost,
          sprite: u.sprite,
          spriteHidden: u.spriteHidden,
        })),
        instances: p.placements
          .filter((x) => used.has(x.unitId))
          .map((x) => {
            const c = cellCenter(p.zone, x.col, x.row);
            return { instanceId: instanceIdFor(p.seat, x.row, x.col), unitId: x.unitId, x: c.x, y: c.y };
          }),
      },
    ],
  };
}

export function MiniMap(props: MiniMapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const arena = useRef<ArenaRenderer | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const canvas = ref.current;
    const a = new ArenaRenderer(canvas, { dropIn: false, hpBars: false, highlightSeat: null, fit: { margin: 2, pad: 16, top: 40 } });
    arena.current = a;
    // A static picture: no 60 fps loop. Redraw on resize, on placement
    // changes (below) and at 2 fps for the props' idle animation.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => a.render()) : null;
    ro?.observe(canvas);
    const timer = setInterval(() => a.render(), PROP_REDRAW_MS);
    a.render();
    return () => {
      ro?.disconnect();
      clearInterval(timer);
      arena.current = null;
    };
  }, []);

  useEffect(() => {
    const a = arena.current;
    if (!a) return;
    a.setReveal(buildPreviewReveal(props));
    a.render();
  }, [props.zone, props.seat, props.placements, props.units]);

  return <canvas ref={ref} class="minimap pixelated" aria-label="Map of the arena showing your corner" />;
}
