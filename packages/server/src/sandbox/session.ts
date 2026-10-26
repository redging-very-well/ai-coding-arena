// A low-level sandbox session: one isolate (or vm context) with the harness
// installed. Every sandbox mode implements this small interface, and both the
// battle runner (below) and the validator are written against it.
//
//   ivmCore.ts      IvmSession: isolated-vm in this process
//   ivmRunner.ts    ChildIvmSession: an IvmSession inside a child process (default)
//   inprocRunner.ts VmSession: node:vm (tests/dev only, unsafe)
//
// Only strings cross the boundary. Harness functions always return strings.

import type { SelfView } from '@pixel-clash/shared';
import { MAX_ACTION_JSON, MAX_ERROR_MESSAGE, unitFilename } from './harness.js';
import type {
  MinionOutput,
  PlayerRunner,
  RunnerLimits,
  RunnerPlayer,
  RunnerUnitDesign,
  SpawnResult,
  TickInput,
  TickResult,
  UnitOutput,
} from './runner.js';
import { LineMapper, findUnitFrame, splitInlineSourceMap } from './sourcemap.js';

/** What happened to one call into the sandbox. */
export type CallOutcome =
  /** The harness function returned this string. */
  | { kind: 'ok'; value: string; elapsedMs: number }
  /**
   * The per-call timeout fired; `culprit` is `__current` read right after (if
   * asked for). `stalledMs`: how long the sandbox process itself was frozen
   * (not scheduled) during the call, if at all.
   */
  | { kind: 'timeout'; elapsedMs: number; culprit?: string; stalledMs?: number }
  /** The call failed without killing the sandbox (should not happen with an intact harness). */
  | { kind: 'error'; message: string; elapsedMs: number }
  /** The sandbox is gone: out of memory, crashed, missed its deadline, or disposed. */
  | { kind: 'crashed'; detail: string };

/** Harness API functions the hosts call with string arguments (`load` has its own method). */
export type HarnessFn = 'seal' | 'spawn' | 'stats' | 'sprite' | 'tick';

export interface CallOptions {
  /** After a timeout, read `__current` with this (short) timeout. */
  probeCulpritMs?: number;
  /**
   * Wall-clock deadline measured from the moment of the call, enforced by the
   * process that runs the isolate. If no answer arrives by then the session is
   * disposed and the call resolves 'crashed' (e.g. a microtask loop the
   * timeout didn't stop, §8). A child-process host adds its own, more generous
   * backstop on top (HOST_BACKSTOP_MS).
   */
  deadlineMs?: number;
}

export interface SandboxSession {
  readonly disposed: boolean;
  /** Evaluate a design's compiled CJS (wrapped) and register its default export via the harness `load`. */
  load(unitId: string, filename: string, compiledJs: string, timeoutMs: number, opts?: CallOptions): Promise<CallOutcome>;
  /** Call a harness API function with string arguments. */
  call(fn: HarnessFn, args: readonly string[], timeoutMs: number, opts?: CallOptions): Promise<CallOutcome>;
  /** Release everything. Idempotent. */
  dispose(): void;
}

export interface SessionOptions {
  memoryLimitMb: number;
  /** Seed of the in-sandbox Math.random. */
  seed: number;
}

export type SessionOpener = (opts: SessionOptions) => Promise<SandboxSession>;

/**
 * Default extra time over a call's own timeout before the host gives up on
 * it. isolated-vm normally stops a script within a few ms of its timeout; a
 * call that is still running long after that is usually stuck in a huge
 * allocation (memory blowing up), so don't wait long.
 */
export const DEFAULT_DEADLINE_SLACK_MS = 500;

/**
 * Extra time the SERVER process waits beyond a call's deadline before it kills
 * a child sandbox process itself. The deadline is enforced inside the child;
 * this backstop only catches a hung child, so a busy server event loop (GC, a
 * big JSON.stringify) never kills an innocent player's sandbox.
 */
export const HOST_BACKSTOP_MS = 500;

/** Bound an error string that came out of a sandbox (§7 bounded messages). */
export function capMessage(message: string, max = MAX_ERROR_MESSAGE): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

/** Crash detail used when a call misses its deadline. */
export function deadlineDetail(ms: number): string {
  return `did not stop within ${ms} ms (stuck: an endless chain of promises, or a huge allocation)`;
}

// ---------------------------------------------------------------------------
// Harness reply shapes (parsed defensively)
// ---------------------------------------------------------------------------

export interface HarnessError {
  message: string;
  stack?: string;
}

export function asHarnessError(v: unknown): HarnessError {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return {
      message: typeof o.message === 'string' ? capMessage(o.message) : 'unknown error',
      ...(typeof o.stack === 'string' && o.stack ? { stack: o.stack.slice(0, 2000) } : {}),
    };
  }
  return { message: 'unknown error' };
}

/**
 * The wire format of a tick input (what the harness `tick` parses). Enemies,
 * world and each ally are sent as ready-made JSON strings, so the harness only
 * ever JSON.parse()s them and never re-serializes an object outside a unit's
 * try/catch (a player-planted Object.prototype.toJSON can't run there).
 */
export function encodeTickInput(input: Pick<TickInput, 'nowMs' | 'selves' | 'enemies' | 'allies' | 'world' | 'minions'>): string {
  return JSON.stringify({
    nowMs: input.nowMs,
    selves: input.selves,
    enemiesJson: enemiesJsonOf(input.enemies),
    worldJson: worldJsonOf(input.world),
    allyIds: input.allies.map((a) => a.id),
    alliesJson: alliesJsonOf(input.allies),
    // §5.3: only when some factory runs updateMinion() this tick.
    ...(input.minions && input.minions.length > 0 ? { minions: input.minions } : {}),
  });
}

// The engine shares one enemies/allies array per side and tick between that
// side's players, so each is serialised once per side, not once per player
// (§9.2 Performance). Keyed by array identity; entries die with the arrays.
const enemiesJsonCache = new WeakMap<readonly unknown[], string>();
const alliesJsonCache = new WeakMap<readonly unknown[], string[]>();

function enemiesJsonOf(enemies: TickInput['enemies']): string {
  let json = enemiesJsonCache.get(enemies);
  if (json === undefined) {
    json = JSON.stringify(enemies);
    enemiesJsonCache.set(enemies, json);
  }
  return json;
}

// `world.players` ("Show enemy names to units") is one array per battle: its
// JSON is made once and spliced in, so names add no per-tick stringify work.
const playersJsonCache = new WeakMap<readonly unknown[], string>();

function worldJsonOf(world: TickInput['world']): string {
  const players = world.players;
  if (!players) return JSON.stringify(world);
  let pj = playersJsonCache.get(players);
  if (pj === undefined) {
    pj = JSON.stringify(players);
    playersJsonCache.set(players, pj);
  }
  const { players: _p, ...rest } = world;
  return JSON.stringify(rest).slice(0, -1) + ',"players":' + pj + '}';
}

function alliesJsonOf(allies: TickInput['allies']): string[] {
  let json = alliesJsonCache.get(allies);
  if (json === undefined) {
    json = allies.map((a) => JSON.stringify(a));
    alliesJsonCache.set(allies, json);
  }
  return json;
}

/** Parse a harness reply that should be a JSON object; undefined if it isn't. */
export function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(value);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Is this crash an out-of-memory condition? Used for friendlier messages. */
export function isMemoryCrash(detail: string): boolean {
  return /memory|heap|allocation failed/i.test(detail);
}

// ---------------------------------------------------------------------------
// Defensive parsing of __tick output (§8 hardening rules)
// ---------------------------------------------------------------------------

export interface ParsedTick {
  ok: boolean;
  outputs: UnitOutput[];
  forged: number;
  /** Entries per instance with their raw extra flags (dry-run uses `promise`). */
  promises: Set<string>;
  /** Raw error stacks by instanceId, for line mapping (minions' updateMinion() errors too). */
  stacks: Map<string, string>;
  /** §5.3: the factories' updateMinion() results, sorted by instanceId (empty when none ran). */
  minions: MinionOutput[];
  /** Minions whose updateMinion() returned a Promise (the dry run reports it). */
  minionPromises: Set<string>;
  detail?: string;
}

/**
 * Parse the JSON string returned by `__tick`. Non-JSON or a non-array means
 * the whole tick idles (ok=false). Otherwise at most one entry per instanceId
 * is accepted, and only for ids in `selves`; everything else is dropped and
 * counted in `forged`. Outputs are sorted by instanceId.
 */
export function parseTickOutput(
  raw: string,
  selves: readonly Pick<SelfView, 'id'>[],
  minionViews: readonly Pick<SelfView, 'id' | 'minion'>[] = [],
): ParsedTick {
  const empty = (detail: string): ParsedTick => ({
    ok: false,
    outputs: [],
    forged: 0,
    promises: new Set(),
    stacks: new Map(),
    minions: [],
    minionPromises: new Set(),
    detail,
  });
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty('tick output is not JSON');
  }
  if (!Array.isArray(data)) return empty('tick output is not an array');

  const allowed = new Set(selves.map((s) => s.id));
  const seen = new Set<string>();
  const outputs: UnitOutput[] = [];
  const promises = new Set<string>();
  const stacks = new Map<string, string>();
  // §5.3: minion id → its factory id, for the minions listed in the input.
  const minionFactory = new Map<string, string>();
  for (const m of minionViews) if (m.minion) minionFactory.set(m.id, m.minion.factoryId);
  const minionSeen = new Set<string>();
  const minions: MinionOutput[] = [];
  const minionPromises = new Set<string>();
  let forged = 0;
  for (const entry of data as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      forged++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = e.instanceId;
    if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) {
      forged++;
      continue;
    }
    seen.add(id);
    const ms = typeof e.ms === 'number' && Number.isFinite(e.ms) && e.ms >= 0 ? e.ms : undefined;
    const mms = typeof e.mms === 'number' && Number.isFinite(e.mms) && e.mms >= 0 ? e.mms : undefined;
    const msPart = { ...(ms === undefined ? {} : { ms }), ...(mms === undefined ? {} : { mms }) };
    if (Array.isArray(e.minions)) {
      for (const me of e.minions as unknown[]) {
        const m = me && typeof me === 'object' && !Array.isArray(me) ? (me as Record<string, unknown>) : undefined;
        const mid = m?.instanceId;
        // Only a minion of THIS factory that is in the input, once.
        if (!m || typeof mid !== 'string' || minionFactory.get(mid) !== id || minionSeen.has(mid)) {
          forged++;
          continue;
        }
        minionSeen.add(mid);
        if ('error' in m) {
          const err = asHarnessError(m.error);
          if (err.stack) stacks.set(mid, err.stack);
          minions.push({ instanceId: mid, factoryId: id, error: { message: err.message } });
        } else {
          if (m.promise === true) minionPromises.add(mid);
          // A Promise or an oversized value: the built-in logic (undefined).
          const action = m.promise === true || m.action === 'too-big' ? undefined : m.action;
          minions.push({ instanceId: mid, factoryId: id, action });
        }
      }
    }
    if ('error' in e) {
      const err = asHarnessError(e.error);
      if (err.stack) stacks.set(id, err.stack);
      outputs.push({ instanceId: id, error: { message: err.message }, ...msPart });
    } else {
      if (e.promise === true) promises.add(id);
      // A returned Promise or an oversized value becomes an explicit idle.
      const action = e.promise === true || e.action === 'too-big' ? { action: 'idle' } : e.action;
      outputs.push({ instanceId: id, action, ...msPart });
    }
  }
  const byId = (a: { instanceId: string }, b: { instanceId: string }) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0);
  outputs.sort(byId);
  minions.sort(byId);
  return { ok: true, outputs, forged, promises, stacks, minions, minionPromises };
}

/** Sum of the per-unit times the harness measured inside the isolate (updateMinion() calls included). */
export function unitMsTotal(outputs: readonly UnitOutput[]): number {
  let total = 0;
  for (const o of outputs) total += (o.ms ?? 0) + (o.mms ?? 0);
  return total;
}

/**
 * The slowest code in a slow tick: the instance with the largest update()
 * time, or (§5.3) a factory whose updateMinion() calls took longer still
 * (`minionCode`). Undefined when no timings are available.
 */
export function slowestCode(outputs: readonly UnitOutput[]): { instanceId: string; minionCode: boolean } | undefined {
  let best = 0;
  let out: { instanceId: string; minionCode: boolean } | undefined;
  for (const o of outputs) {
    if ((o.ms ?? 0) > best) {
      best = o.ms ?? 0;
      out = { instanceId: o.instanceId, minionCode: false };
    }
    if ((o.mms ?? 0) > best) {
      best = o.mms ?? 0;
      out = { instanceId: o.instanceId, minionCode: true };
    }
  }
  return out;
}

// Exported for tests / the validator.
export { MAX_ACTION_JSON };

// ---------------------------------------------------------------------------
// PlayerRunner over a session (shared by every mode)
// ---------------------------------------------------------------------------

/** Default time budget for evaluating one design at battle start. */
export const DEFAULT_LOAD_TIMEOUT_MS = 1000;

interface LoadedDesign {
  index: number;
  mapper: LineMapper;
}

export class SessionPlayerRunner implements PlayerRunner {
  readonly loadErrors = new Map<string, { message: string; line?: number }>();
  private readonly designs = new Map<string, LoadedDesign>();
  private readonly mappers: LineMapper[] = [];
  private crashed: string | undefined;

  private constructor(
    readonly player: RunnerPlayer,
    private readonly session: SandboxSession,
    private readonly limits: RunnerLimits,
  ) {}

  /** Open a session for `player` and load all of its designs. */
  static async create(
    open: SessionOpener,
    player: RunnerPlayer,
    units: readonly RunnerUnitDesign[],
    limits: RunnerLimits,
  ): Promise<SessionPlayerRunner> {
    const session = await open({ memoryLimitMb: limits.memoryLimitMb, seed: player.seed });
    const runner = new SessionPlayerRunner(player, session, limits);
    try {
      await runner.loadAll(units);
    } catch (err) {
      session.dispose();
      throw err;
    }
    return runner;
  }

  get disposed(): boolean {
    return this.session.disposed || this.crashed !== undefined;
  }

  private async loadAll(units: readonly RunnerUnitDesign[]): Promise<void> {
    const timeout = this.limits.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    for (const [index, unit] of units.entries()) {
      const { mappings } = splitInlineSourceMap(unit.compiledJs);
      const mapper = new LineMapper(mappings);
      this.mappers[index] = mapper;
      if (this.disposed) {
        this.loadErrors.set(unit.unitId, { message: `sandbox crashed: ${this.crashed ?? 'disposed'}` });
        continue;
      }
      const out = await this.session.load(unit.unitId, unitFilename(index), unit.compiledJs, timeout, {
        deadlineMs: timeout + DEFAULT_DEADLINE_SLACK_MS,
      });
      const failure = this.describeLoadFailure(out);
      if (failure) this.loadErrors.set(unit.unitId, failure);
      else this.designs.set(unit.unitId, { index, mapper });
    }
    // No design may be (re)loaded once the battle's designs are in.
    if (!this.disposed) {
      const sealed = await this.session.call('seal', [], timeout, { deadlineMs: timeout + DEFAULT_DEADLINE_SLACK_MS });
      if (sealed.kind === 'crashed') this.markCrashed(sealed.detail);
    }
  }

  private describeLoadFailure(out: CallOutcome): { message: string; line?: number } | undefined {
    switch (out.kind) {
      case 'timeout':
        return { message: 'loading the unit took too long (endless loop at the top of the file?)' };
      case 'error':
        return { message: capMessage(out.message) };
      case 'crashed':
        this.markCrashed(out.detail);
        return { message: `sandbox crashed while loading: ${capMessage(out.detail)}` };
      case 'ok': {
        const r = parseObject(out.value);
        if (r?.ok === true) return undefined;
        if (r?.kind === 'threw') return this.errorWithLine(asHarnessError(r.error));
        if (r?.kind === 'no-default') return { message: 'the file has no default export' };
        if (r?.kind === 'not-a-class') return { message: 'the default export is not a class' };
        return { message: 'the unit could not be loaded' };
      }
    }
  }

  /** Map a harness error's stack to a line in the player's original source. */
  private errorWithLine(err: HarnessError): { message: string; line?: number } {
    const frame = findUnitFrame(err.stack);
    const mapper = frame ? this.mappers[frame.index] : undefined;
    if (!frame || !mapper) return { message: err.message };
    return { message: err.message, line: mapper.map(frame.pos).line };
  }

  private markCrashed(detail: string): void {
    this.crashed ??= detail;
    this.session.dispose();
  }

  async spawn(instanceId: string, unitId: string): Promise<SpawnResult> {
    if (this.disposed) return { ok: false, error: { message: `sandbox crashed: ${this.crashed ?? 'disposed'}` } };
    const loadError = this.loadErrors.get(unitId);
    if (loadError) return { ok: false, error: loadError };
    if (!this.designs.has(unitId)) return { ok: false, error: { message: `unknown design "${unitId}"` } };
    const t = this.limits.constructTimeoutMs;
    const out = await this.session.call('spawn', [instanceId, unitId], t, {
      deadlineMs: t + DEFAULT_DEADLINE_SLACK_MS,
    });
    switch (out.kind) {
      case 'timeout':
        return { ok: false, error: { message: `the constructor took longer than ${t} ms` } };
      case 'error':
        return { ok: false, error: { message: capMessage(out.message) } };
      case 'crashed':
        this.markCrashed(out.detail);
        return { ok: false, error: { message: `sandbox crashed: ${capMessage(out.detail)}` } };
      case 'ok': {
        const r = parseObject(out.value);
        if (r?.ok === true) return r.hasMinion === true ? { ok: true, hasMinion: true } : { ok: true };
        if (r?.kind === 'threw') return { ok: false, error: this.errorWithLine(asHarnessError(r.error)) };
        return { ok: false, error: { message: `could not spawn "${unitId}" (${String(r?.kind ?? 'bad reply')})` } };
      }
    }
  }

  async tick(input: TickInput): Promise<TickResult> {
    const crashed = (detail: string, elapsedMs = 0): TickResult => ({
      status: 'crashed',
      outputs: [],
      elapsedMs,
      slow: false,
      forged: 0,
      detail: capMessage(detail),
    });
    if (this.disposed) return crashed(this.crashed ?? 'sandbox disposed');

    const { hardTimeoutMs, softTimeoutMs, disposeGraceMs, culpritProbeTimeoutMs } = this.limits;
    let json: string;
    try {
      json = encodeTickInput(input);
    } catch (err) {
      return { status: 'bad-output', outputs: [], elapsedMs: 0, slow: false, forged: 0, detail: capMessage(`bad input: ${String(err)}`) };
    }
    const out = await this.session.call('tick', [json], hardTimeoutMs, {
      probeCulpritMs: culpritProbeTimeoutMs,
      deadlineMs: hardTimeoutMs + disposeGraceMs,
    });

    switch (out.kind) {
      case 'crashed':
        this.markCrashed(out.detail);
        return crashed(out.detail);
      case 'timeout': {
        // A minion's id names its factory's updateMinion() (§5.3).
        const selfIds = new Set([...input.selves.map((s) => s.id), ...(input.minions ?? []).map((m) => m.id)]);
        // The sandbox process was frozen for at least half the budget, and
        // without the freeze the tick would have finished in time: the host's
        // fault. A real endless loop on a healthy host runs its whole budget
        // unfrozen (a little event-loop lag under load is far below half of
        // it), so it is still blamed; one that happened to be frozen is
        // blamed on its next tick.
        const stalledMs = out.stalledMs ?? 0;
        const hostStall = stalledMs >= hardTimeoutMs / 2 && out.elapsedMs - stalledMs < hardTimeoutMs;
        return {
          status: 'timeout',
          outputs: [],
          elapsedMs: out.elapsedMs,
          slow: false,
          forged: 0,
          // Only trust a culprit that is one of this player's acting instances.
          ...(out.culprit && selfIds.has(out.culprit) ? { culprit: out.culprit } : {}),
          ...(hostStall ? { hostStall: true } : {}),
        };
      }
      case 'error':
        return { status: 'bad-output', outputs: [], elapsedMs: out.elapsedMs, slow: false, forged: 0, detail: capMessage(out.message) };
      case 'ok': {
        const parsed = parseTickOutput(out.value, input.selves, input.minions);
        // A slow strike needs the player code ITSELF to be slow: the wall time
        // around the async call (thread hops, IPC, a busy host) AND the time
        // the harness measured around the update() calls inside the isolate
        // must both be over the soft limit. A host hiccup alone is not the
        // player's fault (only wall time would be inflated, not the units' own).
        const slow = out.elapsedMs > softTimeoutMs && unitMsTotal(parsed.outputs) > softTimeoutMs;
        if (!parsed.ok) {
          return {
            status: 'bad-output',
            outputs: [],
            elapsedMs: out.elapsedMs,
            slow,
            forged: 0,
            ...(parsed.detail ? { detail: parsed.detail } : {}),
          };
        }
        // Map error lines back to the player's source.
        const outputs = parsed.outputs.map((o): UnitOutput => {
          if (!('error' in o)) return o;
          const stack = parsed.stacks.get(o.instanceId);
          const mapped = this.errorWithLine({ message: o.error.message, ...(stack ? { stack } : {}) });
          return { ...o, error: mapped };
        });
        const minions = parsed.minions.map((m): MinionOutput => {
          if (!('error' in m)) return m;
          const stack = parsed.stacks.get(m.instanceId);
          return { ...m, error: this.errorWithLine({ message: m.error.message, ...(stack ? { stack } : {}) }) };
        });
        const slowest = slow ? slowestCode(outputs) : undefined;
        return {
          status: 'ok',
          outputs,
          elapsedMs: out.elapsedMs,
          slow,
          ...(slowest ? { slowestInstanceId: slowest.instanceId } : {}),
          ...(slowest?.minionCode ? { slowestIsMinionCode: true as const } : {}),
          forged: parsed.forged,
          ...(minions.length > 0 ? { minions } : {}),
        };
      }
    }
  }

  dispose(): void {
    this.session.dispose();
  }
}
