// Client-side map and team helpers: turning the public DTOs
// back into shared/maps.ts zones, plain words for where a zone sits, map names,
// and team lookups. DOM-free (imported by tests).

import {
  ARENA,
  MAP_STYLE_INFO,
  arenaSizeFor,
  type MapDTO,
  type MapStyle,
  type MapZone,
  type MapZoneDTO,
  type TeamDTO,
} from '@pixel-clash/shared';

/** A public zone DTO as a shared/maps.ts zone of an S arena (the cell mapping needs S). */
export function toMapZone(zone: MapZoneDTO, arena: number): MapZone {
  return { index: zone.index, x: zone.x, y: zone.y, width: zone.width, height: zone.height, facing: zone.facing, arena };
}

/**
 * The arena side for a zone: the map's width when known, else the smallest
 * arena (by player count) the zone fits in.
 */
export function arenaFor(zone: MapZoneDTO, map?: Pick<MapDTO, 'width' | 'zones'> | null): number {
  if (map && map.zones.some((z) => z.x === zone.x && z.y === zone.y)) return map.width;
  for (const players of [4, 6, 8]) {
    const S = arenaSizeFor(players);
    if (zone.x + zone.width <= S && zone.y + zone.height <= S) return S;
  }
  return ARENA.width;
}

/**
 * Where a zone sits on the map, in plain words seen top-down (as /screen and
 * the placement grid draw it): "top", "top right", "left", "bottom left", or
 * "middle".
 */
export function zoneWords(zone: Pick<MapZoneDTO, 'x' | 'y' | 'width' | 'height'>, arena: number): string {
  const u = (zone.x + zone.width / 2) / arena;
  const v = (zone.y + zone.height / 2) / arena;
  const third = (t: number, lo: string, hi: string) => (t < 0.4 ? lo : t > 0.6 ? hi : '');
  const words = [third(v, 'top', 'bottom'), third(u, 'left', 'right')].filter(Boolean);
  return words.length ? words.join(' ') : 'middle';
}

/** "zone 3 (top right)": the zone number is index + 1. */
export function zoneLabel(zone: MapZoneDTO, arena: number): string {
  return `zone ${zone.index + 1} (${zoneWords(zone, arena)})`;
}

/** The style's display name ("Ring"). */
export function mapStyleLabel(style: MapStyle): string {
  return MAP_STYLE_INFO[style].label;
}

/** "Ring · 8 players" for a map. */
export function mapName(map: Pick<MapDTO, 'style' | 'players'>): string {
  return `${mapStyleLabel(map.style)} · ${map.players} player${map.players === 1 ? '' : 's'}`;
}

/** The team a player is on (public teams), or undefined. */
export function teamOfPlayer(teams: readonly TeamDTO[] | null | undefined, playerId: string | null | undefined): TeamDTO | undefined {
  if (!playerId) return undefined;
  return teams?.find((t) => t.members.includes(playerId));
}

/**
 * Players grouped by team, in team order and member (join) order; players
 * not on any team (benched, or free-for-all) come last as `team: null`.
 */
export function groupByTeam<T extends { id: string }>(
  players: readonly T[],
  teams: readonly TeamDTO[] | null | undefined,
): Array<{ team: TeamDTO | null; players: T[] }> {
  if (!teams || teams.length === 0) return [{ team: null, players: [...players] }];
  const byId = new Map(players.map((p) => [p.id, p]));
  const placed = new Set<string>();
  const out: Array<{ team: TeamDTO | null; players: T[] }> = teams.map((team) => {
    const members = team.members.map((id) => byId.get(id)).filter((p): p is T => !!p);
    members.forEach((p) => placed.add(p.id));
    return { team, players: members };
  });
  const rest = players.filter((p) => !placed.has(p.id));
  // A team whose members were all kicked has no group (it left the table).
  const groups = out.filter((g) => g.players.length > 0);
  if (rest.length) groups.push({ team: null, players: rest });
  return groups;
}
