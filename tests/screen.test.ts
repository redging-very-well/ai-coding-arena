// /screen (plan §12.2): GET /api/join gives the projector its join URL and a
// QR code (no auth, no player data), plus the DOM-free view model.

import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyBadgeCounts, type BadgeId, type BattleRevealDTO, type JoinInfoDTO, type PlayerStatusDTO, type ScoreboardEntryDTO } from '@pixel-clash/shared';
import {
  REVEAL_DROP_AT_MS,
  REVEAL_STEP_MS,
  REVEAL_TOTAL_MS,
  armyValues,
  badgeCounts,
  battleSecondsLeft,
  countUp,
  isUrgent,
  liveSecondsLeft,
  podiumOrder,
  rankRows,
  revealStep,
  standings,
  statusTicks,
} from '../packages/client/src/screen/model.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, bootServer, removeDir, tempDataDir } from './helpers/server.js';

describe('GET /api/join', () => {
  let srv: RunningServer;
  let dir: string;
  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
  }, 60_000);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('returns a /play join URL and an SVG QR code without auth', async () => {
    const r = await new Client(srv.url).get<JoinInfoDTO>('/join');
    expect(r.status).toBe(200);
    expect(r.body.joinUrl).toMatch(/^http:\/\/[^/]+\/play$/);
    expect(Array.isArray(r.body.lanUrls)).toBe(true);
    // Opened via localhost: prefer a LAN address when the machine has one.
    if (r.body.lanUrls.length) expect(r.body.joinUrl).toBe(`${r.body.lanUrls[0]}/play`);
    expect(r.body.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });

  it('uses the Host header when the page was opened by a LAN address', async () => {
    // fetch() can't set Host, so use node:http.
    const body = await new Promise<JoinInfoDTO>((resolve, reject) => {
      const req = request(`${srv.url}/api/join`, { headers: { host: '192.168.7.20:8080' } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve(JSON.parse(text) as JoinInfoDTO));
      });
      req.on('error', reject);
      req.end();
    });
    expect(body.joinUrl).toBe('http://192.168.7.20:8080/play');
  });
});

describe('/screen view model', () => {
  const reveal: BattleRevealDTO = {
    round: 1,
    totalTicks: 5400,
    players: [
      {
        playerId: 'a',
        name: 'Ann',
        seat: 0,
        zone: 'TL',
        units: [{ unitId: 'tank', name: 'Tank', cost: 200, stats: {} as never, sprite: null, spriteHidden: false }],
        instances: [
          { instanceId: '0-0-0', unitId: 'tank', x: 1, y: 1 },
          { instanceId: '0-0-1', unitId: 'tank', x: 2, y: 2 },
        ],
      },
      {
        playerId: 'b',
        name: 'Bo',
        seat: 1,
        zone: 'BR',
        units: [{ unitId: 'sol', name: 'Sol', cost: 104, stats: {} as never, sprite: null, spriteHidden: false }],
        instances: [{ instanceId: '1-0-0', unitId: 'sol', x: 700, y: 700 }],
      },
    ],
  };

  it('sums the living army value per player', () => {
    const v = armyValues(reveal, new Set(['0-0-1']));
    expect(v).toEqual([
      expect.objectContaining({ playerId: 'a', start: 400, living: 200, aliveCount: 1, fieldedCount: 2 }),
      expect.objectContaining({ playerId: 'b', start: 104, living: 0, aliveCount: 0, fieldedCount: 1 }),
    ]);
    expect(armyValues(reveal, null)[0]).toMatchObject({ living: 400, aliveCount: 2 });
  });

  it('runs the 3-2-1 CLASH! reveal and the timers', () => {
    expect(revealStep(0)).toBe('3');
    expect(revealStep(REVEAL_STEP_MS)).toBe('2');
    expect(revealStep(REVEAL_STEP_MS * 2)).toBe('1');
    expect(revealStep(REVEAL_STEP_MS * 3 + 10)).toBe('CLASH!');
    expect(revealStep(REVEAL_TOTAL_MS)).toBeNull();
    expect(REVEAL_DROP_AT_MS).toBeLessThan(REVEAL_TOTAL_MS);
    expect(battleSecondsLeft(0, 5400)).toBe(90);
    expect(battleSecondsLeft(4800, 5400)).toBe(10);
    expect(isUrgent(10)).toBe(true);
    expect(isUrgent(10.5)).toBe(false);
    expect(liveSecondsLeft(30, 1000, false, 3500)).toBe(27.5);
    expect(liveSecondsLeft(30, 1000, true, 3500)).toBe(30);
    expect(liveSecondsLeft(null, 0, false, 1)).toBeNull();
  });

  it('shows only status ticks on player tiles', () => {
    const p: PlayerStatusDTO = { id: 'a', name: 'Ann', seat: 0, connected: true, submitted: true, selected: false, ready: false, points: 0, active: true };
    expect(statusTicks(p, 'PLAN')).toEqual([
      { label: 'New unit', done: true },
      { label: 'Army picked', done: false },
      { label: 'Ready', done: false },
    ]);
    expect(statusTicks({ ...p, ready: true, selected: true }, 'PLACEMENT').every((t) => t.done)).toBe(true);
    expect(statusTicks({ ...p, active: false }, 'PLAN')).toEqual([{ label: 'Joins next round', done: false }]);
  });

  const score = (
    playerId: string,
    place: number,
    placePoints: number,
    damage: number,
    damageBonus: number,
    valueDestroyed: number,
    valueBonus: number,
    badges: BadgeId[] = [],
  ) => ({ playerId, place, placePoints, damage, damageBonus, valueDestroyed, valueBonus, pointsGained: placePoints + damageBonus + valueBonus, kills: 0, badges });
  const board = (playerId: string, name: string, seat: number, points: number, damage: number, place = 0): ScoreboardEntryDTO => ({
    playerId,
    name,
    seat,
    points,
    damage,
    place,
    badges: emptyBadgeCounts(),
  });

  it('builds the ranking, standings with ties, and the podium order', () => {
    const rows = rankRows({
      players: [],
      scoreboard: [],
      lastBattle: {
        round: 1,
        endTick: 100,
        reason: 'elimination',
        ranking: [
          { ...score('b', 2, 2, 120, 1, 0, 0), livingCost: 0, eliminatedAtTick: 90 },
          { ...score('a', 1, 3, 240, 2, 104, 1, ['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall']), livingCost: 200, eliminatedAtTick: null },
        ],
        scoreboard: [
          board('a', 'Ann', 0, 6, 240, 1),
          board('b', 'Bo', 1, 3, 120, 2),
        ],
      },
    });
    expect(rows.map((r) => [r.name, r.place, r.placePoints, r.damageBonus, r.valueBonus, r.pointsGained, r.total])).toEqual([
      ['Ann', 1, 3, 2, 1, 6, 6],
      ['Bo', 2, 2, 1, 0, 3, 3],
    ]);
    expect(rows[0]!.badges).toEqual(['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall']);
    // Standings: points, then match damage, then a shared place.
    const st = standings([
      board('a', 'A', 0, 5, 300),
      board('b', 'B', 1, 7, 10),
      board('c', 'C', 2, 5, 300),
      board('d', 'D', 3, 1, 999),
      board('e', 'E', 4, 5, 400),
    ]);
    expect(st.map((s) => [s.name, s.place])).toEqual([
      ['B', 1],
      ['E', 2],
      ['A', 3],
      ['C', 3],
      ['D', 5],
    ]);
    expect(badgeCounts({ badges: { ...emptyBadgeCounts(), ironWall: 2, lastStanding: 1 } }).map((b) => [b.emoji, b.count])).toEqual([
      ['🏆', 1],
      ['🛡️', 2],
    ]);
    expect(podiumOrder(['1st', '2nd', '3rd'])).toEqual(['2nd', '1st', '3rd']);
    expect(podiumOrder(['1st', '2nd'])).toEqual(['2nd', '1st']);
    expect(countUp(3, 0)).toBe(0);
    expect(countUp(3, 5000)).toBe(3);
  });
});
