// AI seat auto-assignment, seats turned on/off in /admin, and the seat login
// for the AI helper (plan §11.2 c, e): the pure rule (pickClaudeSeat), /play's
// DOM-free side (claudePane.ts), and the real server's REST routes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminClaudeSeatsDTO, ClaudeSeatsDTO, LoginResponse, MeResponse } from '@pixel-clash/shared';
import { basicAuthMatches, pickClaudeSeat, seatPlayerToken } from '../packages/server/src/services/claudeSeats.js';
import { normalizeSeatList } from '../packages/server/src/services/store.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { joinSeatRequest, noFreeSeat, seatActionAfterJoin } from '../packages/client/src/play/claudePane.js';
import { Client, adminClient, bootServer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;
const SECRET = 'otter-lamp-quartz-ninety';
const basic = (secret: string) => `Basic ${Buffer.from(`player:${secret}`).toString('base64')}`;

describe('pickClaudeSeat (§11.2 c)', () => {
  const on = (off: number[] = []) => (s: number) => !off.includes(s);
  const held = (seats: number[]) => (s: number) => seats.includes(s);

  it('own seat, then the laptop seat if free and on, then the lowest free seat that is on', () => {
    expect(pickClaudeSeat({ current: 4, preferred: 2, enabled: on(), taken: held([]) })).toEqual({ seat: 4, how: 'kept' });
    expect(pickClaudeSeat({ current: null, preferred: 6, enabled: on(), taken: held([1]) })).toEqual({ seat: 6, how: 'preferred' });
    expect(pickClaudeSeat({ current: null, preferred: 6, enabled: on(), taken: held([6, 1]) })).toEqual({ seat: 2, how: 'lowest' });
    expect(pickClaudeSeat({ current: null, preferred: 6, enabled: on([6, 1]), taken: held([]) })).toEqual({ seat: 2, how: 'lowest' });
    expect(pickClaudeSeat({ current: null, preferred: null, enabled: on(), taken: held([1, 2, 3]) })).toEqual({ seat: 4, how: 'lowest' });
    // The own seat was turned off: like having none.
    expect(pickClaudeSeat({ current: 3, preferred: null, enabled: on([3]), taken: held([1]) })).toEqual({ seat: 2, how: 'lowest' });
    expect(pickClaudeSeat({ current: null, preferred: 2, enabled: on([3, 4, 5, 6, 7, 8]), taken: held([1, 2]) })).toEqual({ seat: null, how: 'none' });
  });

  it('seat-login auth and the stored list are strict', () => {
    expect(basicAuthMatches(basic(SECRET), SECRET)).toBe(true);
    for (const bad of [basic('otter-lamp-quartz-nineTY'), `Bearer ${SECRET}`, '', undefined, 42, `Basic ${Buffer.from(`admin:${SECRET}`).toString('base64')}`]) {
      expect(basicAuthMatches(bad, SECRET)).toBe(false);
    }
    expect(basicAuthMatches(basic(SECRET), null)).toBe(false);
    expect(normalizeSeatList([3, 1, 3, 9, 0, 'x', 2.5, 8])).toEqual([1, 3, 8]);
    expect(normalizeSeatList('1,2')).toEqual([]);
  });
});

describe('/play after join (DOM-free, §11.2 c)', () => {
  it('asks about the seat card only when the player kept their own seat', () => {
    expect(seatActionAfterJoin(2, 4, 'kept')).toEqual({ kind: 'ask', seat: 4, current: 2 });
    expect(seatActionAfterJoin(5, 4, 'lowest')).toEqual({ kind: 'none' });
    expect(seatActionAfterJoin(4, 4, 'preferred')).toEqual({ kind: 'none' });
    expect(seatActionAfterJoin(null, 4, 'none')).toEqual({ kind: 'none' });
    // A page load with a session (no auto-assignment): as before.
    expect(seatActionAfterJoin(null, 4, undefined)).toEqual({ kind: 'claim', seat: 4 });
    expect(seatActionAfterJoin(4, null, 'kept')).toEqual({ kind: 'none' });
  });

  it('sends the laptop seat as the preference, and spots a full picker', () => {
    expect(joinSeatRequest(3)).toBe(3);
    expect(joinSeatRequest(null)).toBe('auto');
    const dto = (takenBy: Array<string | null>): ClaudeSeatsDTO => ({
      mySeat: null,
      boxReady: true,
      seats: takenBy.map((t, i) => ({ seat: i + 1, takenBy: t, mine: false, status: 'up' })),
    });
    expect(noFreeSeat(dto(['Ava', 'Ben']))).toBe(true);
    expect(noFreeSeat(dto(['Ava', null]))).toBe(false);
    expect(noFreeSeat(dto([]))).toBe(true); // every seat turned off
    expect(noFreeSeat(null)).toBe(false); // not loaded yet
  });
});

describe('auto-assignment, seats on/off and seat login on the server', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    admin = await adminClient(srv.url);
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  const join = async (name: string, claudeSeat?: unknown) => {
    const c = new Client(srv.url);
    const r = await c.post<LoginResponse>('/players', { name, pin: '1234', ...(claudeSeat !== undefined ? { claudeSeat } : {}) });
    expect(r.status, r.text).toBe(200);
    return { client: c, res: r.body, id: r.body.player.id };
  };
  const adminSeats = async () => (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats;

  it('join and login assign a seat in one step; callers that do not ask get none', async () => {
    const ava = await join('Ava', 'auto');
    expect(ava.res.claudeSeat).toEqual({ seat: 1, how: 'lowest' });
    expect((await ava.client.get<MeResponse>('/me')).body.claudeSeat).toBe(1);
    // This laptop's seat is taken: the lowest free one.
    const ben = await join('Ben', 1);
    expect(ben.res.claudeSeat).toEqual({ seat: 2, how: 'lowest' });
    // This laptop's seat is free: that one.
    const cat = await join('Cat', 6);
    expect(cat.res.claudeSeat).toEqual({ seat: 6, how: 'preferred' });
    // A script or bot (no claudeSeat): no seat, no field.
    const bot = await join('Bot');
    expect(bot.res.claudeSeat).toBeUndefined();
    expect((await bot.client.get<MeResponse>('/me')).body.claudeSeat).toBeNull();

    // Logging in again keeps the own seat, whatever this laptop says.
    await ava.client.post('/logout');
    const back = new Client(srv.url);
    const again = await back.post<LoginResponse>('/login', { name: 'Ava', pin: '1234', claudeSeat: 4 });
    expect(again.body.claudeSeat).toEqual({ seat: 1, how: 'kept' });
    // A junk preference is just "auto".
    expect((await join('Dan', 'nine')).res.claudeSeat).toEqual({ seat: 3, how: 'lowest' });
    expect((await adminSeats()).map((s) => s.playerName)).toEqual(['Ava', 'Ben', 'Dan', null, null, 'Cat', null, null]);
    // Make room in the game (8 players at most).
    expect((await admin.post(`/admin/players/${bot.id}/kick`, { deleteData: true })).status).toBe(200);
  }, T);

  it('many players joining at once get different seats', async () => {
    const names = ['Eve', 'Fay', 'Gus', 'Hal'];
    const joined = await Promise.all(names.map((n) => join(n, 'auto')));
    const seats = joined.map((j) => j.res.claudeSeat?.seat);
    expect(new Set(seats).size).toBe(4);
    expect([...seats].sort()).toEqual([4, 5, 7, 8]);
  }, T);

  it('a seat turned off is never given out, and its player moves to a free seat that is on', async () => {
    // Free a seat to move to: kick Hal.
    const hal = (await adminSeats()).find((s) => s.playerName === 'Hal')!;
    expect((await admin.post(`/admin/players/${hal.playerId}/kick`, { deleteData: true })).status).toBe(200);
    const freed = hal.seat;

    const off = await admin.put<AdminClaudeSeatsDTO>('/admin/claude-seats/2/enabled', { enabled: false });
    expect(off.status, off.text).toBe(200);
    const row2 = off.body.seats[1]!;
    expect(row2).toMatchObject({ seat: 2, enabled: false, playerId: null });
    // Ben (seat 2) is on the seat Hal freed.
    expect(off.body.seats.find((s) => s.playerName === 'Ben')!.seat).toBe(freed);
    expect(off.body.seats.filter((s) => s.seat !== 2).every((s) => s.enabled)).toBe(true);

    // Not in the picker, can't be picked or assigned.
    const ava = new Client(srv.url);
    await ava.post('/login', { name: 'Ava', pin: '1234' });
    const picker = (await ava.get<ClaudeSeatsDTO>('/claude-seats')).body;
    expect(picker.seats.map((s) => s.seat)).toEqual([1, 3, 4, 5, 6, 7, 8]);
    const pick = await ava.put('/me/claude-seat', { seat: 2 });
    expect(pick.status).toBe(409);
    expect(pick.body.error.code).toBe('CLAUDE_SEAT_OFF');
    const avaId = (await ava.get<MeResponse>('/me')).body.player.id;
    expect((await admin.put('/admin/claude-seats/2', { playerId: avaId })).body.error.code).toBe('CLAUDE_SEAT_OFF');
    // Unassigning a seat that is off is fine (nothing to do).
    expect((await admin.put('/admin/claude-seats/2', { playerId: null })).status).toBe(200);
    // The laptop's seat is off: the lowest free one.
    expect((await join('Ivy', 2)).res.claudeSeat).toEqual({ seat: null, how: 'none' });

    // Every seat taken and the held seat turned off: the player has none (the picker says so).
    const before = await adminSeats();
    const catSeat = before.find((s) => s.playerName === 'Cat')!.seat;
    const offCat = (await admin.put<AdminClaudeSeatsDTO>(`/admin/claude-seats/${catSeat}/enabled`, { enabled: false })).body;
    expect(offCat.seats.some((s) => s.playerName === 'Cat')).toBe(false);
    const catMe = new Client(srv.url);
    await catMe.post('/login', { name: 'Cat', pin: '1234' });
    expect((await catMe.get<MeResponse>('/me')).body.claudeSeat).toBeNull();

    // Back on: nobody moves; Cat can pick it (or gets it on the next login).
    const onCat = (await admin.put<AdminClaudeSeatsDTO>(`/admin/claude-seats/${catSeat}/enabled`, { enabled: true })).body;
    expect(onCat.seats.find((s) => s.seat === catSeat)).toMatchObject({ enabled: true, playerId: null });
    const relog = await new Client(srv.url).post<LoginResponse>('/login', { name: 'Cat', pin: '1234', claudeSeat: 'auto' });
    expect(relog.body.claudeSeat).toEqual({ seat: catSeat, how: 'lowest' });

    // Bad requests.
    expect((await admin.put('/admin/claude-seats/9/enabled', { enabled: false })).body.error.code).toBe('BAD_CLAUDE_SEAT');
    expect((await admin.put('/admin/claude-seats/3/enabled', { enabled: 'no' })).status).toBe(400);
    expect((await new Client(srv.url).put('/admin/claude-seats/3/enabled', { enabled: false })).status).toBe(403);
  }, T);

  it('seats that are off are kept across a restart and a wipe', async () => {
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    admin = await adminClient(srv.url);
    expect((await adminSeats()).map((s) => s.enabled)).toEqual([true, false, true, true, true, true, true, true]);
    expect((await admin.post('/admin/wipe', { confirm: 'WIPE' })).status).toBe(200);
    expect((await adminSeats()).map((s) => s.enabled)).toEqual([true, false, true, true, true, true, true, true]);
    expect((await join('Zed', 2)).res.claudeSeat).toEqual({ seat: 1, how: 'lowest' });
    expect((await admin.put('/admin/claude-seats/2/enabled', { enabled: true })).body.seats[1].enabled).toBe(true);
  }, T);

  it("seat login: the Claude box trades the seat's player token for that player's login", async () => {
    const zed = (await adminSeats()).find((s) => s.playerName === 'Zed')!;
    const token = seatPlayerToken(zed.seat, zed.playerId!);
    const raw = (auth: string | undefined, b: unknown) =>
      new Client(srv.url).req('POST', '/api/seat-login', b, auth ? { authorization: auth } : {});

    // No seat password set yet: nothing works.
    expect((await raw(basic(SECRET), { seat: zed.seat, token })).status).toBe(401);
    await admin.put('/admin/setup', { seatSecret: SECRET });
    const okRes = await raw(basic(SECRET), { seat: zed.seat, token });
    expect(okRes.status, okRes.text).toBe(200);
    const me = (await (async () => {
      const c = new Client(srv.url);
      await c.post('/login', { name: 'Zed', pin: '1234' });
      return c.get<MeResponse>('/me');
    })()).body;
    expect(okRes.text).toBe(JSON.stringify({ name: 'Zed', apiKey: me.apiKey }));

    // Wrong password, someone else's token, another seat, junk.
    expect((await raw(basic('wrong-wrong-wrong-wrong'), { seat: zed.seat, token })).status).toBe(401);
    expect((await raw(undefined, { seat: zed.seat, token })).status).toBe(401);
    expect((await raw(basic(SECRET), { seat: zed.seat + 1, token })).status).toBe(404);
    expect((await raw(basic(SECRET), { seat: zed.seat, token: seatPlayerToken(zed.seat, 'someone-else') })).status).toBe(404);
    expect((await raw(basic(SECRET), { seat: zed.seat, token: token.toUpperCase() })).status).toBe(404);
    // A player's own session is not enough.
    const zc = new Client(srv.url);
    await zc.post('/login', { name: 'Zed', pin: '1234' });
    expect((await zc.post('/seat-login', { seat: zed.seat, token })).status).toBe(401);

    // Unassigned: the token no longer works.
    await admin.put(`/admin/claude-seats/${zed.seat}`, { playerId: null });
    expect((await raw(basic(SECRET), { seat: zed.seat, token })).status).toBe(404);
  }, T);
});
