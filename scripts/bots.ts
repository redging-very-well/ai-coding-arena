// `npm run bots -- --players 3 [--url http://host:8080] [--strategy mixed]`
//
// Bot players for rehearsals and load tests ONLY (plan §14 dress rehearsal,
// §15 "fill the rest with npm run bots"); never offered in real games. Each
// bot joins over REST like a player's browser would (POST /players, then its
// Bearer key), and plays until MATCH_RESULTS:
//   PLAN       submits 3 home-made designs (once per match; varied stats and
//              update() logic: chase, focus the weakest, kite, turrets,
//              factories rallying on the nearest enemy, walls with no code;
//              soldiers sudden-death aware and wall-aware) and picks ≤ 4 unit
//              types + ≤ 4 building types for the round (own designs and the
//              templates, varying by round);
//   PLACEMENT  places the selection in its zone within budget and the copy
//              caps (soldiers in front, then a line of walls, towers and
//              factories behind it), then readies up;
//   BATTLE / RESULTS  waits; the facilitator (or the load test) drives phases.
//
// Strategies: mixed (default: each bot a different personality), brawl,
// turtle, rush, swarm (3 cheap types × 12 copies, the §14 load shape),
// fortress (walls shielding turrets and archers) and factory (a workshop
// making minions behind brawlers and darts) (M8.5).
// Options: --prefix Bot  --pin 4242  --poll 400 (ms)  --quiet

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameStateDTO, MapZoneDTO, PlacementDTO, UnitCardDTO } from '@pixel-clash/shared';
import { frontCells } from '../packages/server/src/sim/autoPlace.js';

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

type Behaviour = 'nearest' | 'weakest' | 'kite' | 'tower' | 'rally' | 'none';
type BotType = 'soldier' | 'tower' | 'wall' | 'factory';

interface BotDesign {
  role: string;
  type: BotType;
  maxHealth: number;
  damage: number;
  range: number;
  speed: number;
  attackCooldown: number;
  size: number;
  color: string;
  shape: 'circle' | 'square' | 'triangle' | 'diamond';
  behaviour: Behaviour;
  /** Factories only (§5.2): ticks between two minions. */
  productionInterval?: number;
}

const D = (role: string, type: BotDesign['type'], s: Omit<BotDesign, 'role' | 'type' | 'speed'> & { speed?: number }): BotDesign => ({
  role,
  type,
  speed: type === 'soldier' ? 1.5 : 0,
  ...s,
});

/** A wall or a factory (§5.2): no attack, no move, fixed size. */
const B = (role: string, type: 'wall' | 'factory', s: Pick<BotDesign, 'maxHealth' | 'color'> & { productionInterval?: number }): BotDesign => ({
  role,
  type,
  damage: 0,
  range: 0,
  speed: 0,
  attackCooldown: 0,
  size: type === 'wall' ? 20 : 18,
  shape: 'square',
  behaviour: type === 'wall' ? 'none' : 'rally',
  ...s,
});

/** Fighters all around $60-$190, so a bot always fields 4-12 copies (walls $24 on top). */
export const DESIGNS = {
  brawler: D('Brawler', 'soldier', { maxHealth: 150, damage: 14, range: 30, speed: 1.6, attackCooldown: 60, size: 11, color: '#E8413C', shape: 'square', behaviour: 'weakest' }),
  archer: D('Archer', 'soldier', { maxHealth: 80, damage: 12, range: 120, speed: 1.4, attackCooldown: 60, size: 9, color: '#3CB371', shape: 'triangle', behaviour: 'kite' }),
  turret: D('Turret', 'tower', { maxHealth: 180, damage: 18, range: 160, attackCooldown: 60, size: 14, color: '#FF9933', shape: 'square', behaviour: 'tower' }),
  runner: D('Runner', 'soldier', { maxHealth: 70, damage: 8, range: 25, speed: 2.6, attackCooldown: 45, size: 7, color: '#FFD23C', shape: 'diamond', behaviour: 'nearest' }),
  bastion: D('Bastion', 'tower', { maxHealth: 300, damage: 8, range: 100, attackCooldown: 60, size: 16, color: '#8C98AC', shape: 'square', behaviour: 'tower' }),
  gnat: D('Gnat', 'soldier', { maxHealth: 50, damage: 7, range: 25, speed: 1.8, attackCooldown: 60, size: 7, color: '#B04CFF', shape: 'circle', behaviour: 'nearest' }),
  dart: D('Dart', 'tower', { maxHealth: 50, damage: 8, range: 140, attackCooldown: 60, size: 8, color: '#3CD6FF', shape: 'diamond', behaviour: 'tower' }),
  pebble: D('Pebble', 'soldier', { maxHealth: 70, damage: 6, range: 35, speed: 1.2, attackCooldown: 60, size: 8, color: '#9BEA3C', shape: 'circle', behaviour: 'weakest' }),
  // M8.5 buildings: a 300 HP wall ($24) and a factory making 5 minions ($184).
  stone: B('Stone Wall', 'wall', { maxHealth: 300, color: '#8A8F98' }),
  workshop: B('Workshop', 'factory', { maxHealth: 250, productionInterval: 900, color: '#C0A060' }),
} satisfies Record<string, BotDesign>;
type DesignKey = keyof typeof DESIGNS;

/** Personalities: the 3 designs a bot submits (selection mixes in the templates on some rounds). */
export const STRATEGIES: Record<string, DesignKey[]> = {
  brawl: ['brawler', 'archer', 'turret'],
  turtle: ['turret', 'bastion', 'archer'],
  rush: ['runner', 'brawler', 'pebble'],
  swarm: ['gnat', 'dart', 'pebble'],
  fortress: ['stone', 'turret', 'archer'],
  factory: ['workshop', 'brawler', 'dart'],
};
const MIXED_ORDER = ['brawl', 'rush', 'turtle', 'swarm', 'fortress', 'factory'];

/**
 * update() bodies. Every one loops over all enemies (the §14 load shape); soldiers step into the
 * safe circle late on and smash an enemy wall that has blocked them for 2 s (M8.5).
 */
const BEHAVIOURS: Record<Behaviour, string> = {
  nearest: `
    const near = nearest(self, enemies);
    if (!near) return { action: 'move', destination: world.center };
    if (near.gap <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: near.e.id } : { action: 'idle' };
    return { action: 'move', destination: { x: near.e.x, y: near.e.y } };`,
  weakest: `
    let target = null;
    for (const e of enemies) {
      if (gap(self, e) <= self.range + 60 && (!target || e.hp < target.hp)) target = e;
    }
    const near = nearest(self, enemies);
    if (!near) return { action: 'move', destination: world.center };
    if (!target) target = near.e;
    if (gap(self, target) <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: target.id } : { action: 'idle' };
    return { action: 'move', destination: { x: target.x, y: target.y } };`,
  kite: `
    const near = nearest(self, enemies);
    if (!near) return { action: 'move', destination: world.center };
    if (near.gap < self.range * 0.5 && near.e.range < self.range) {
      // Too close: step back, away from it.
      return { action: 'move', destination: { x: self.x * 2 - near.e.x, y: self.y * 2 - near.e.y } };
    }
    if (near.gap <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: near.e.id } : { action: 'idle' };
    return { action: 'move', destination: { x: near.e.x, y: near.e.y } };`,
  tower: `
    if (self.cooldownRemaining > 0) return { action: 'idle' };
    let target = null;
    for (const e of enemies) {
      if (gap(self, e) <= self.range && (!target || e.hp < target.hp)) target = e;
    }
    return target ? { action: 'attack', targetId: target.id } : { action: 'idle' };`,
  rally: `
    let spot = world.center;
    let best = Infinity;
    for (const e of enemies) {
      if (e.type === 'wall') continue;
      const d = Math.hypot(e.x - self.x, e.y - self.y);
      if (d < best) { best = d; spot = { x: e.x, y: e.y }; }
    }
    return { action: 'rally', destination: spot };`,
  none: '',
};

const SPRITE_ROWS = ['..oooo..', '.occcco.', 'occwwcco', 'occwwcco', 'occccdco', 'ocdccdco', '.occcco.', '..oooo..'];

/** The JS source a bot submits (what Claude would write for a player, minus the comments). */
export function botSource(name: string, d: BotDesign): string {
  const safe = d.type === 'soldier'
    ? `
    // Sudden death (the circle has started shrinking): get back inside it.
    const sz = world.safeZone;
    if (sz.radius < Math.hypot(world.width, world.height) / 2 && Math.hypot(self.x - sz.x, self.y - sz.y) > sz.radius - self.radius - 10) {
      return { action: 'move', destination: world.center };
    }
    // Stuck behind an enemy wall for 2 s: smash it.
    if (self.blockedTicks >= 120) {
      const w = enemies.find((e) => e.id === self.blockedBy);
      if (w) {
        if (gap(self, w) <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: w.id } : { action: 'idle' };
        return { action: 'move', destination: { x: w.x, y: w.y } };
      }
    }
    // Walls can't fight back: go for the rest while there is any.
    if (enemies.some((e) => e.type !== 'wall')) enemies = enemies.filter((e) => e.type !== 'wall');`
    : '';
  const stats =
    d.type === 'wall' || d.type === 'factory'
      ? `    this.maxHealth = ${d.maxHealth};${d.type === 'factory' ? `\n    this.productionInterval = ${d.productionInterval ?? 900};` : ''}
    this.color = ${JSON.stringify(d.color)};`
      : `    this.maxHealth = ${d.maxHealth};
    this.damage = ${d.damage};
    this.range = ${d.range};
    this.speed = ${d.speed};
    this.attackCooldown = ${d.attackCooldown};
    this.color = ${JSON.stringify(d.color)};
    this.size = ${d.size};
    this.shape = ${JSON.stringify(d.shape)};`;
  // Walls have no update() (§5.2: they never run code).
  const update = d.type === 'wall' ? '' : `
  update(self, enemies, allies, world) {${safe}${BEHAVIOURS[d.behaviour]}
  }
`;
  return `// ${name}: a Pixel Clash rehearsal bot unit (scripts/bots.ts).
function gap(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;
}
function nearest(self, enemies) {
  let best = null;
  for (const e of enemies) {
    const g = gap(self, e);
    if (!best || g < best.gap) best = { e, gap: g };
  }
  return best;
}

export default class BotUnit {
  constructor() {
    this.name = ${JSON.stringify(name)};
    this.type = ${JSON.stringify(d.type)};
${stats}
  }
${update}
  sprite() {
    return {
      grid: 8,
      palette: { o: '#1A1428', c: ${JSON.stringify(d.color)}, w: '#F4F8FF', d: '#2A2238' },
      frames: { idle: [${JSON.stringify(SPRITE_ROWS)}] },
    };
  }
}
`;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export class Api {
  bearer: string | undefined;
  constructor(readonly base: string) {}

  async req<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await fetch(`${this.base}/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed as T };
  }

  /** Retries 429s after the server's retryAfterMs (validate/submit rate limits, §10). */
  async call<T = any>(method: string, path: string, body?: unknown, tries = 6): Promise<ApiResult<T>> {
    for (let i = 0; ; i++) {
      const r = await this.req<T>(method, path, body);
      if (r.status !== 429 || i >= tries) return r;
      const wait = Number((r.body as any)?.error?.details?.retryAfterMs) || 1000;
      await sleep(Math.min(wait + 50, 10_000));
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// One bot
// ---------------------------------------------------------------------------

export interface BotOptions {
  url: string;
  name: string;
  pin: string;
  /** Personality: a key of STRATEGIES. */
  strategy: string;
  /** Copy cap for placement (default: the server's caps.maxCopies). */
  maxCopies?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export interface BotSummary {
  name: string;
  strategy: string;
  seat: number | null;
  roundsPlayed: number;
  submitted: string[];
  errors: string[];
}

export class Bot {
  readonly api: Api;
  readonly summary: BotSummary;
  playerId: string | undefined;
  private designsDone = false;
  /** The last round this bot picked its selection / placed and readied (the load test waits on these). */
  selectedRound = -1;
  placedRound = -1;
  private stopped = false;
  private seenMatch = false;
  private caps = { budget: 1000, maxCopies: 12, maxUnitTypes: 4, maxBuildingTypes: 4, maxFactoryCopies: 2, maxWallCopies: 12 };

  constructor(readonly opts: BotOptions) {
    this.api = new Api(opts.url.replace(/\/+$/, ''));
    this.summary = { name: opts.name, strategy: opts.strategy, seat: null, roundsPlayed: 0, submitted: [], errors: [] };
  }

  private log(msg: string): void {
    this.opts.log?.(`[${this.opts.name}] ${msg}`);
  }

  private error(msg: string): void {
    this.summary.errors.push(msg);
    this.log(`! ${msg}`);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Join (or log back in with the same name + PIN) and read the caps. */
  async join(): Promise<void> {
    let r = await this.api.call('POST', '/players', { name: this.opts.name, pin: this.opts.pin });
    if (r.status === 409 && r.body?.error?.code === 'NAME_TAKEN') r = await this.api.call('POST', '/login', { name: this.opts.name, pin: this.opts.pin });
    if (r.status !== 200) throw new Error(`${this.opts.name} could not join: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    this.api.bearer = r.body.apiKey;
    this.playerId = r.body.player.id;
    this.summary.seat = r.body.player.seat ?? null;
    const rules = await this.api.call('GET', '/rules');
    if (rules.status === 200 && rules.body?.caps) this.caps = { ...this.caps, ...rules.body.caps };
    this.log(`joined (seat ${this.summary.seat})`);
  }

  /** Play until MATCH_RESULTS (or stop()). */
  async run(): Promise<BotSummary> {
    if (!this.api.bearer) await this.join();
    const poll = this.opts.pollMs ?? 400;
    while (!this.stopped) {
      let state: GameStateDTO;
      try {
        const r = await this.api.req<GameStateDTO>('GET', '/state');
        if (r.status !== 200) throw new Error(`GET /state ${r.status}`);
        state = r.body;
      } catch (err) {
        this.error(`state: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
        continue;
      }
      try {
        if (await this.step(state)) break;
      } catch (err) {
        this.error(`${state.phase} round ${state.round}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(poll);
    }
    return this.summary;
  }

  /** One look at the state. Returns true when the match is over. */
  private async step(s: GameStateDTO): Promise<boolean> {
    const me = s.me;
    if (s.phase !== 'LOBBY' && s.phase !== 'MATCH_RESULTS') this.seenMatch = true;
    if (s.phase === 'MATCH_RESULTS' && this.seenMatch) {
      this.log('match over');
      return true;
    }
    if (!me || me.active === false || me.benched) return false;
    if (s.phase === 'PLAN' && me.submissionsOpen) {
      if (!this.designsDone) await this.submitDesigns();
      if (this.selectedRound !== s.round) await this.select(s.round);
    } else if (s.phase === 'PLACEMENT' && this.placedRound !== s.round && me.myZone) {
      await this.place(s.round, me.myZone, me.selection);
    }
    return false;
  }

  private designKeys(): DesignKey[] {
    return STRATEGIES[this.opts.strategy] ?? STRATEGIES.brawl!;
  }

  private async submitDesigns(): Promise<void> {
    const existing = await this.units();
    for (const key of this.designKeys()) {
      const d = DESIGNS[key];
      const name = `${this.opts.name} ${d.role}`.slice(0, 24);
      if (existing.some((u) => u.name === name && u.status === 'valid')) continue;
      const r = await this.api.call('POST', '/units', { source: botSource(name, d) });
      if (r.status === 200) {
        this.summary.submitted.push(name);
        this.log(`submitted ${name} ($${r.body.unit.cost})`);
      } else if (r.body?.error?.code === 'PHASE_CLOSED') {
        return;
      } else {
        this.error(`submit ${name}: ${r.status} ${JSON.stringify(r.body?.errors ?? r.body?.error).slice(0, 300)}`);
      }
    }
    this.designsDone = true;
  }

  private async units(): Promise<UnitCardDTO[]> {
    const r = await this.api.call<UnitCardDTO[]>('GET', '/units');
    return r.status === 200 && Array.isArray(r.body) ? r.body : [];
  }

  /**
   * ≤ 4 unit + ≤ 4 building types (§5.2): the bot's own designs, plus a soldier or tower
   * template on every other round. Walls alone can't fight, so a pick always has a fighter.
   */
  private async select(round: number): Promise<void> {
    const units = (await this.units()).filter((u) => u.status === 'valid');
    const own = units.filter((u) => !u.isTemplate);
    const templates = units.filter((u) => u.isTemplate && (u.stats.type === 'soldier' || u.stats.type === 'tower'));
    let pick = [...own];
    if (round % 2 === 0 && templates.length > 0 && pick.length > 0) pick.push(templates[(round / 2) % templates.length]!);
    if (!pick.some((u) => u.stats.type !== 'wall')) pick = [...pick, ...templates];
    const isUnit = (u: UnitCardDTO) => (u.stats.type ?? 'soldier') === 'soldier';
    pick = [...pick.filter(isUnit).slice(0, this.caps.maxUnitTypes), ...pick.filter((u) => !isUnit(u)).slice(0, this.caps.maxBuildingTypes)];
    const r = await this.api.call('PUT', '/round/selection', { unitIds: pick.map((u) => u.unitId) });
    if (r.status !== 200) {
      if (r.body?.error?.code === 'PHASE_CLOSED') return;
      this.error(`selection: ${r.status} ${JSON.stringify(r.body?.error).slice(0, 200)}`);
    } else {
      this.log(`round ${round}: selected ${pick.map((u) => u.name).join(', ')}`);
    }
    this.selectedRound = round;
  }

  private async place(round: number, zone: MapZoneDTO, selection: string[]): Promise<void> {
    const units = (await this.units()).filter((u) => selection.includes(u.unitId) && u.status === 'valid');
    const placements = planPlacement(
      units.map((u) => ({ unitId: u.unitId, cost: u.cost, type: u.stats.type ?? 'soldier' })),
      zone.facing,
      this.caps.budget,
      Math.min(this.caps.maxCopies, this.opts.maxCopies ?? Infinity),
      { maxFactoryCopies: this.caps.maxFactoryCopies, maxWallCopies: this.caps.maxWallCopies },
    );
    const r = await this.api.call('PUT', '/round/placement', { placements });
    if (r.status !== 200) {
      if (r.body?.error?.code === 'PHASE_CLOSED') return;
      this.error(`placement: ${r.status} ${JSON.stringify(r.body?.error).slice(0, 200)}`);
      this.placedRound = round;
      return;
    }
    const ready = await this.api.call('POST', '/round/ready', { ready: true });
    if (ready.status !== 200) this.error(`ready: ${ready.status}`);
    this.placedRound = round;
    this.summary.roundsPlayed++;
    this.log(`round ${round}: placed ${placements.length} units ($${r.body.spent}) and ready`);
  }
}

/** How much of the budget a bot puts into walls at most, and how many walls (M8.5). */
const WALL_BUDGET_SHARE = 0.25;
const BOT_MAX_WALLS = 6;

/**
 * Walls first (≤ 6 and ≤ 25% of the budget, M8.5), then round-robin over the
 * fighter types (cheapest first, ≤ maxFactoryCopies factories) until the
 * budget or the copy cap runs out. Soldiers take the front cells, the walls
 * the next ones (a shield line the soldiers stand outside of), towers and
 * factories the cells behind it. Walls are dropped if no fighter fits.
 */
export function planPlacement(
  units: Array<{ unitId: string; cost: number; type: BotType }>,
  facing: MapZoneDTO['facing'],
  budget: number,
  maxCopies: number,
  caps: { maxFactoryCopies?: number; maxWallCopies?: number } = {},
): PlacementDTO[] {
  const wallType = [...units].filter((u) => u.type === 'wall').sort((a, b) => a.cost - b.cost)[0];
  const fighters = units.filter((u) => u.type !== 'wall');
  const plan = (walls: number) => {
    const picked: typeof units = [];
    let spent = walls * (wallType?.cost ?? 0);
    let factories = 0;
    const types = [...fighters].sort((a, b) => a.cost - b.cost);
    let added = true;
    while (added && picked.length < maxCopies) {
      added = false;
      for (const t of types) {
        if (picked.length >= maxCopies || spent + t.cost > budget) continue;
        if (t.type === 'factory' && factories >= (caps.maxFactoryCopies ?? 2)) continue;
        picked.push(t);
        spent += t.cost;
        if (t.type === 'factory') factories++;
        added = true;
      }
    }
    return picked;
  };
  let walls = wallType ? Math.min(BOT_MAX_WALLS, caps.maxWallCopies ?? 12, Math.floor((budget * WALL_BUDGET_SHARE) / wallType.cost)) : 0;
  let picked = plan(walls);
  if (picked.length === 0 && walls > 0) {
    walls = 0;
    picked = plan(0);
  }
  if (picked.length === 0) return [];
  const ordered = [
    ...picked.filter((u) => u.type === 'soldier'),
    ...Array.from({ length: walls }, () => wallType!),
    ...picked.filter((u) => u.type === 'tower'),
    ...picked.filter((u) => u.type === 'factory'),
  ];
  const cells = frontCells(facing);
  return ordered.map((u, i) => ({ unitId: u.unitId, col: cells[i]!.col, row: cells[i]!.row }));
}

// ---------------------------------------------------------------------------
// Many bots
// ---------------------------------------------------------------------------

export interface BotsOptions {
  url: string;
  players: number;
  strategy: string;
  prefix?: string;
  pin?: string;
  maxCopies?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export function strategyFor(strategy: string, i: number): string {
  return strategy === 'mixed' ? MIXED_ORDER[i % MIXED_ORDER.length]! : strategy;
}

/** Create and join the bots (in order, so seats follow bot numbers). */
export async function joinBots(o: BotsOptions): Promise<Bot[]> {
  if (o.strategy !== 'mixed' && !STRATEGIES[o.strategy]) {
    throw new Error(`unknown strategy "${o.strategy}" (mixed, ${Object.keys(STRATEGIES).join(', ')})`);
  }
  const bots: Bot[] = [];
  for (let i = 0; i < o.players; i++) {
    const bot = new Bot({
      url: o.url,
      name: `${o.prefix ?? 'Bot'} ${i + 1}`,
      pin: o.pin ?? '4242',
      strategy: strategyFor(o.strategy, i),
      ...(o.maxCopies !== undefined ? { maxCopies: o.maxCopies } : {}),
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
    await bot.join();
    bots.push(bot);
  }
  return bots;
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out[k] = argv[++i]!;
    else out[k] = true;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('npm run bots -- --players 3 [--url http://localhost:8080] [--strategy mixed|brawl|turtle|rush|swarm|fortress|factory] [--prefix Bot] [--pin 4242] [--quiet]');
    return;
  }
  const players = Number(args.players ?? 3);
  if (!Number.isInteger(players) || players < 1 || players > 8) throw new Error('--players must be 1-8');
  const url = String(args.url ?? process.env.PIXEL_CLASH_URL ?? 'http://localhost:8080');
  const quiet = args.quiet === true;
  console.log(`Pixel Clash bots (rehearsal/load only): ${players} × ${String(args.strategy ?? 'mixed')} → ${url}`);
  const bots = await joinBots({
    url,
    players,
    strategy: String(args.strategy ?? 'mixed'),
    ...(typeof args.prefix === 'string' ? { prefix: args.prefix } : {}),
    ...(typeof args.pin === 'string' ? { pin: args.pin } : {}),
    ...(typeof args.poll === 'string' ? { pollMs: Number(args.poll) } : {}),
    log: quiet ? undefined : (line) => console.log(line),
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => bots.forEach((b) => b.stop()));
  console.log('Joined. Waiting for the facilitator to start the match (bots play until MATCH_RESULTS; Ctrl+C to stop).');
  const summaries = await Promise.all(bots.map((b) => b.run()));
  for (const s of summaries) {
    console.log(`${s.name} (${s.strategy}, seat ${s.seat}): ${s.roundsPlayed} rounds, ${s.submitted.length} units submitted${s.errors.length ? `, ${s.errors.length} errors` : ''}`);
  }
  if (summaries.some((s) => s.errors.length > 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
