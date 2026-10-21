// Small isometric map (plan §12.1 PLACEMENT): shows the whole map as the
// projector draws it, where my zone sits in it, and my placed units standing
// in it. In team mode the teammates' zones and live placements are drawn too,
// as see-through ghosts (read-only, §9.2 Team privacy). Uses the shared
// ArenaRenderer with a reveal built from data this player may see; nothing
// about opponents is known before START, so their zones stay neutral.

import { useEffect, useRef } from 'preact/hooks';
import {
  cellCenter,
  instanceIdFor,
  isValidCell,
  mapZoneDTO,
  type BattleRevealDTO,
  type MapDTO,
  type MapZone,
  type PlacementDTO,
  type TeamDTO,
  type TeamMemberPrivateDTO,
  type UnitCardDTO,
} from '@pixel-clash/shared';
import { ArenaRenderer, revealZones, type ArenaZone } from '../../common/render/arena.js';
import { toMapZone } from '../../common/maps.js';

/** Redraw interval for the props' idle animation (2 fps is plenty). */
const PROP_REDRAW_MS = 500;

export interface MiniMapProps {
  zone: MapZone;
  /** The round's map (null: just my zone on an arena of its size). */
  map: MapDTO | null;
  seat: number;
  teamId?: number | null;
  teams?: TeamDTO[] | null;
  playerId: string;
  name: string;
  placements: readonly PlacementDTO[];
  units: readonly UnitCardDTO[];
  /** Team mode: the other members' live zones and placements. */
  teammates?: readonly TeamMemberPrivateDTO[];
}

type RevealPlayer = BattleRevealDTO['players'][number];

function previewPlayer(
  who: { playerId: string; name: string; seat: number; teamId: number | null | undefined },
  zone: MapZone,
  placements: readonly PlacementDTO[],
  cards: readonly UnitCardDTO[],
): RevealPlayer {
  const byId = new Map(cards.map((u) => [u.unitId, u]));
  const used = placements.filter((x) => byId.has(x.unitId) && isValidCell(x.col, x.row));
  const ids = new Set(used.map((x) => x.unitId));
  return {
    playerId: who.playerId,
    name: who.name,
    seat: who.seat,
    zone: null,
    mapZone: mapZoneDTO(zone),
    ...(who.teamId !== null && who.teamId !== undefined ? { teamId: who.teamId } : {}),
    units: cards
      .filter((u) => ids.has(u.unitId))
      .map((u) => ({ unitId: u.unitId, name: u.name, stats: u.stats, cost: u.cost, sprite: u.sprite, spriteHidden: u.spriteHidden })),
    instances: used.map((x) => {
      const c = cellCenter(zone, x.col, x.row);
      return { instanceId: instanceIdFor(who.seat, x.row, x.col), unitId: x.unitId, x: c.x, y: c.y };
    }),
  };
}

/** The mini-map's reveal: my placement, plus my teammates' (team mode), on the round's map. */
export function buildPreviewReveal(p: MiniMapProps): BattleRevealDTO {
  const S = p.zone.arena;
  const map: MapDTO = p.map ?? { style: 'corners', players: 1, width: S, height: S, zones: [mapZoneDTO(p.zone)] };
  const players: RevealPlayer[] = [previewPlayer({ playerId: p.playerId, name: p.name, seat: p.seat, teamId: p.teamId }, p.zone, p.placements, p.units)];
  for (const m of p.teammates ?? []) {
    if (!m.zone || m.playerId === p.playerId) continue;
    players.push(previewPlayer({ playerId: m.playerId, name: m.name, seat: m.seat, teamId: p.teamId }, toMapZone(m.zone, map.width), m.placement, m.selection));
  }
  const teams = p.teamId !== null && p.teamId !== undefined ? (p.teams ?? null) : null;
  return { round: 0, totalTicks: 0, map, ...(teams ? { teams } : {}), players };
}

/** Owned zones tinted, every other zone of the map neutral (no owners known). */
export function previewZones(reveal: BattleRevealDTO): ArenaZone[] {
  const owned = revealZones(reveal);
  const taken = new Set(owned.map((z) => `${z.rect?.x},${z.rect?.y}`));
  const neutral: ArenaZone[] = (reveal.map?.zones ?? []).filter((z) => !taken.has(`${z.x},${z.y}`)).map((z) => ({ rect: z, seat: -1 }));
  return [...neutral, ...owned];
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
    const reveal = buildPreviewReveal(props);
    const ghosts = new Set((props.teammates ?? []).map((m) => m.playerId));
    ghosts.delete(props.playerId);
    a.setReveal(reveal, { ghosts });
    a.setZones(previewZones(reveal));
    a.render();
  }, [props.zone, props.map, props.seat, props.teamId, props.teams, props.placements, props.units, props.teammates]);

  return <canvas ref={ref} class="minimap pixelated" aria-label="Map of the arena showing your zone" />;
}
