// One player's battle sandbox, split by trust.
//
// A borrowed Open Armory unit is a frozen copy of ANOTHER player's code. If it
// shared an isolate with the borrower's own designs, the borrower's code could
// read it (e.g. a setter planted on Object.prototype that captures the
// borrowed instance) or tamper with its globals. So each borrowed design gets
// its own runner (its own isolate), and the borrower's own designs share one.
// To the sim this is still ONE PlayerRunner: spawns are routed by unitId, and
// a tick runs every part in parallel and merges the results (any crash makes
// the whole tick 'crashed', any timeout makes it 'timeout' so all of the
// player's units idle, exactly like a single sandbox).
//
// Inside a borrowed part the frozen code sees the ids it saw in its creator's
// battles: `self.unitId` is the creator's unitId (never `armory:…`), and the
// borrower's and creator's player ids are swapped in every `ownerId` (and in
// `world.players` ids when names are shown).

import { slowestCode } from './session.js';
import type {
  MinionOutput,
  PlayerRunner,
  RunnerFactory,
  RunnerLimits,
  RunnerPlayer,
  RunnerUnitDesign,
  SpawnResult,
  TickInput,
  TickResult,
  UnitOutput,
} from './runner.js';

interface Part {
  runner: PlayerRunner;
  /** outer unitId (what the sim uses) → unitId loaded in this part. */
  inner: Map<string, string>;
  /** Borrowed parts: swap these two player ids in every ownerId. */
  swap?: { borrowerId: string; creatorId: string };
}

/** True when `units` needs more than one sandbox (it has a borrowed design). */
export function needsSplit(units: readonly RunnerUnitDesign[]): boolean {
  return units.some((u) => u.borrowed);
}

/**
 * Create the player's runner: one sandbox for their own designs, plus one per
 * borrowed design. If any part fails to start, the ones made are disposed.
 */
export async function createSplitRunner(
  factory: RunnerFactory,
  player: RunnerPlayer,
  units: readonly RunnerUnitDesign[],
  limits: RunnerLimits,
): Promise<PlayerRunner> {
  const own = units.filter((u) => !u.borrowed);
  const groups: Array<{ units: RunnerUnitDesign[]; part: Omit<Part, 'runner'> }> = [];
  if (own.length > 0) groups.push({ units: own, part: { inner: new Map(own.map((u) => [u.unitId, u.unitId])) } });
  for (const u of units) {
    if (!u.borrowed) continue;
    const { sourceUnitId, creatorId } = u.borrowed;
    const { borrowed: _b, ...rest } = u;
    groups.push({
      units: [{ ...rest, unitId: sourceUnitId }],
      part: { inner: new Map([[u.unitId, sourceUnitId]]), swap: { borrowerId: player.playerId, creatorId } },
    });
  }
  const settled = await Promise.allSettled(groups.map((g) => factory.create(player, g.units, limits)));
  const parts: Part[] = [];
  let failure: unknown;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') parts.push({ ...groups[i]!.part, runner: s.value });
    else failure ??= s.reason;
  });
  if (failure !== undefined) {
    for (const p of parts) p.runner.dispose();
    throw failure;
  }
  return new SplitRunner(player, parts);
}

class SplitRunner implements PlayerRunner {
  readonly loadErrors = new Map<string, { message: string; line?: number }>();
  /** instanceId → part (set at spawn). */
  private readonly partOf = new Map<string, Part>();
  private closed = false;

  constructor(
    readonly player: RunnerPlayer,
    private readonly parts: readonly Part[],
  ) {
    for (const p of parts) {
      for (const [outer, inner] of p.inner) {
        const err = p.runner.loadErrors.get(inner);
        if (err) this.loadErrors.set(outer, err);
      }
    }
  }

  get disposed(): boolean {
    return this.closed || this.parts.some((p) => p.runner.disposed);
  }

  private partFor(unitId: string): Part | undefined {
    return this.parts.find((p) => p.inner.has(unitId));
  }

  async spawn(instanceId: string, unitId: string): Promise<SpawnResult> {
    const part = this.partFor(unitId);
    if (!part) return { ok: false, error: { message: `unknown design "${unitId}"` } };
    this.partOf.set(instanceId, part);
    return part.runner.spawn(instanceId, part.inner.get(unitId)!);
  }

  async tick(input: TickInput): Promise<TickResult> {
    if (this.disposed) {
      this.dispose();
      return { status: 'crashed', outputs: [], elapsedMs: 0, slow: false, forged: 0, detail: 'sandbox disposed' };
    }
    const calls: Array<Promise<TickResult>> = [];
    for (const part of this.parts) {
      const selves = input.selves.filter((s) => this.partOf.get(s.id) === part);
      if (selves.length === 0) continue;
      // A factory's minions go to the part that runs the factory.
      const minions = input.minions?.filter((m) => m.minion !== undefined && this.partOf.get(m.minion.factoryId) === part);
      calls.push(part.runner.tick(partInput(part, input, selves, minions)));
    }
    const results = await Promise.all(calls);
    const elapsedMs = Math.max(0, ...results.map((r) => r.elapsedMs));
    const crashed = results.find((r) => r.status === 'crashed');
    if (crashed) {
      this.dispose();
      return { status: 'crashed', outputs: [], elapsedMs, slow: false, forged: 0, ...(crashed.detail ? { detail: crashed.detail } : {}) };
    }
    const timeouts = results.filter((r) => r.status === 'timeout');
    if (timeouts.length > 0) {
      const culprit = timeouts.find((r) => r.culprit !== undefined)?.culprit;
      const hostStall = timeouts.every((r) => r.hostStall === true);
      return {
        status: 'timeout',
        outputs: [],
        elapsedMs,
        slow: false,
        forged: 0,
        ...(culprit ? { culprit } : {}),
        ...(hostStall ? { hostStall: true } : {}),
      };
    }
    const bad = results.find((r) => r.status === 'bad-output');
    if (bad) return { status: 'bad-output', outputs: [], elapsedMs, slow: bad.slow, forged: 0, ...(bad.detail ? { detail: bad.detail } : {}) };

    const byId = (a: { instanceId: string }, b: { instanceId: string }) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0);
    const outputs: UnitOutput[] = results.flatMap((r) => r.outputs);
    outputs.sort(byId);
    const minions: MinionOutput[] = results.flatMap((r) => r.minions ?? []);
    minions.sort(byId);
    const slow = results.some((r) => r.slow);
    let slowest = slow ? slowestCode(outputs) : undefined;
    if (slow && !slowest) {
      const r = results.find((x) => x.slowestInstanceId);
      if (r) slowest = { instanceId: r.slowestInstanceId!, minionCode: r.slowestIsMinionCode === true };
    }
    return {
      status: 'ok',
      outputs,
      elapsedMs,
      slow,
      ...(slowest ? { slowestInstanceId: slowest.instanceId } : {}),
      ...(slowest?.minionCode ? { slowestIsMinionCode: true as const } : {}),
      forged: results.reduce((n, r) => n + r.forged, 0),
      ...(minions.length > 0 ? { minions } : {}),
    };
  }

  dispose(): void {
    this.closed = true;
    for (const p of this.parts) p.runner.dispose();
  }
}

/** The part's view of the tick: its own selves, with ids as its code expects. */
function partInput(part: Part, input: TickInput, selves: TickInput['selves'], minions: TickInput['minions']): TickInput {
  const swap = part.swap;
  const { minions: _all, ...rest } = input;
  if (!swap) return { ...rest, selves, ...(minions && minions.length > 0 ? { minions } : {}) };
  const owner = (id: string) => (id === swap.borrowerId ? swap.creatorId : id === swap.creatorId ? swap.borrowerId : id);
  const self = (s: TickInput['selves'][number]) => ({ ...s, unitId: part.inner.get(s.unitId) ?? s.unitId, ownerId: owner(s.ownerId) });
  return {
    ...rest,
    selves: selves.map(self),
    ...(minions && minions.length > 0 ? { minions: minions.map(self) } : {}),
    enemies: input.enemies.map((o) => ({ ...o, ownerId: owner(o.ownerId) })),
    allies: input.allies.map((o) => ({ ...o, ownerId: owner(o.ownerId) })),
    // "Show enemy names to units": the same id swap, so every id still matches
    // the names its bodies carry (a body's ownerName is never swapped).
    ...(input.world.players ? { world: { ...input.world, players: input.world.players.map((p) => ({ ...p, id: owner(p.id) })) } } : {}),
  };
}
