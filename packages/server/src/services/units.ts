// Units (plan §7, §6 re-pricing, §10): validate (dry run), submit (stores),
// list, source, retire, re-price after a config change, sprite moderation.
// Every player has the two templates pre-registered (never persisted; built
// from packages/starter-kit at boot).
//
// `private` is pushed to all the owner's sockets after every submit, retire,
// re-price and invalidation (§10.3), so a unit Claude submits shows up on the
// kid's open /play page within a second.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  armoryDisplayName,
  checkStats,
  computeCost,
  fail,
  isArmoryUnitId,
  ok,
  tooExpensiveError,
  type GameConfig,
  type Result,
  type SpriteSpec,
  type UnitCardDTO,
  type UnitSourceDTO,
  type ValidationError,
  type ValidationResult,
  type ValidationSuccess,
} from '@pixel-clash/shared';
import { validateDetailed, slugify } from '../validator/validate.js';
import { repoPath } from '../util/paths.js';
import { RateLimiter, Semaphore } from '../util/ratelimit.js';
import type { Game } from './game.js';
import type { DesignRecord, PlayerRecord, UnitVersionRecord } from './store.js';

export const TEMPLATE_FILES = { basic_soldier: 'basic_soldier.js', basic_tower: 'basic_tower.js' } as const;

export function templateSource(key: keyof typeof TEMPLATE_FILES): string {
  return readFileSync(repoPath('packages', 'starter-kit', 'units', TEMPLATE_FILES[key]), 'utf8');
}

/** Template validation results, cached per (source, pricing config) across Game instances. */
const templateCache = new Map<string, UnitVersionRecord & { unitId: string }>();

/** The sprite the validator attached to the result, if any (validator step 8b). */
function spriteOf(result: ValidationSuccess): SpriteSpec | null {
  const s = (result.unit as { sprite?: SpriteSpec | null }).sprite;
  return s && typeof s === 'object' ? s : null;
}

export type SubmitResult = ValidationResult & { unitId?: string; version?: number };

export class UnitsService {
  private templates: Array<UnitVersionRecord & { unitId: string }> = [];
  private readonly validateLimiter = new RateLimiter(1, 1000);
  private readonly submitLimiter = new RateLimiter(1, 3000);
  private readonly sandboxes = new Semaphore(4);

  constructor(private readonly game: Game) {}

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    this.templates = [];
    for (const key of Object.keys(TEMPLATE_FILES) as Array<keyof typeof TEMPLATE_FILES>) {
      this.templates.push(await this.validateTemplate(templateSource(key), this.game.config));
    }
    for (const p of this.game.store.players.values()) this.addTemplates(p.id);
    // Re-check stored units against the (possibly changed) config.
    this.repriceAll(this.game.config);
  }

  private async validateTemplate(source: string, config: GameConfig) {
    const key = createHash('sha256')
      .update(source)
      .update(JSON.stringify([config.cost, config.stats, config.caps, config.sandbox.validation]))
      .digest('hex');
    const hit = templateCache.get(key);
    if (hit) return hit;
    const d = await validateDetailed(source, this.validateOptions({}), config);
    if (!d.result.ok || !d.compiledJs) {
      throw new Error(`a starter-kit template does not validate: ${JSON.stringify(d.result)}`);
    }
    const r = d.result;
    const rec = {
      unitId: r.unit.unitId,
      version: 1,
      status: 'valid' as const,
      source: d.source ?? source,
      compiledJs: d.compiledJs,
      stats: r.unit.stats,
      sprite: spriteOf(r),
      cost: r.unit.cost,
      breakdown: r.unit.breakdown,
      warnings: r.warnings,
      sha256: d.sha256 ?? '',
      createdAt: 0,
    };
    templateCache.set(key, rec);
    return rec;
  }

  templateIds(): string[] {
    return this.templates.map((t) => t.unitId);
  }

  /** Pre-register both templates for a player (idempotent). */
  addTemplates(playerId: string): void {
    const designs = this.game.store.designsOf(playerId);
    for (const t of this.templates) {
      if (designs.get(t.unitId)?.isTemplate) continue;
      const { unitId, ...version } = t;
      designs.set(unitId, {
        unitId,
        ownerId: playerId,
        isTemplate: true,
        retired: false,
        spriteHidden: false,
        createdAt: 0,
        updatedAt: 0,
        versions: [{ ...version }],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** Active (not retired) designs of a player, newest first, templates last. */
  designs(playerId: string): DesignRecord[] {
    return [...this.game.store.designsOf(playerId).values()]
      .filter((d) => !d.retired)
      .sort((a, b) => Number(a.isTemplate) - Number(b.isTemplate) || b.updatedAt - a.updatedAt || (a.unitId < b.unitId ? -1 : 1));
  }

  design(playerId: string, unitId: string): DesignRecord | undefined {
    const d = this.game.store.designsOf(playerId).get(unitId);
    return d && !d.retired ? d : undefined;
  }

  static latest(d: DesignRecord): UnitVersionRecord {
    return d.versions[d.versions.length - 1]!;
  }

  static latestValid(d: DesignRecord): UnitVersionRecord | undefined {
    for (let i = d.versions.length - 1; i >= 0; i--) if (d.versions[i]!.status === 'valid') return d.versions[i];
    return undefined;
  }

  versionOf(playerId: string, unitId: string, version: number): UnitVersionRecord | undefined {
    return this.game.store.designsOf(playerId).get(unitId)?.versions.find((v) => v.version === version);
  }

  card(d: DesignRecord): UnitCardDTO {
    const v = UnitsService.latest(d);
    const rs = this.game.store.match.perPlayer[d.ownerId];
    const last = this.game.store.match.results[this.game.store.match.results.length - 1];
    const summary = last?.unitSummaries[d.ownerId]?.[d.unitId];
    return {
      unitId: d.unitId,
      name: v.stats.name,
      version: v.version,
      stats: v.stats,
      cost: v.cost,
      breakdown: v.breakdown,
      status: v.status,
      ...(v.error ? { error: v.error } : {}),
      warnings: v.warnings,
      isTemplate: d.isTemplate,
      sprite: d.spriteHidden ? null : v.sprite,
      spriteHidden: d.spriteHidden,
      selected: rs?.selection.includes(d.unitId) ?? false,
      updatedAt: d.updatedAt,
      ...(summary ? { lastBattle: summary } : {}),
    };
  }

  list(playerId: string): UnitCardDTO[] {
    return this.designs(playerId).map((d) => this.card(d));
  }

  getSource(playerId: string, unitId: unknown): Result<UnitSourceDTO> {
    // Borrowed Armory units: the source is never shared (§9.1).
    if (typeof unitId === 'string' && isArmoryUnitId(unitId)) return borrowedNotFound(unitId);
    const d = typeof unitId === 'string' ? this.design(playerId, unitId) : undefined;
    if (!d) return notFoundUnit(unitId);
    return ok({ ...this.card(d), source: UnitsService.latest(d).source });
  }

  // -------------------------------------------------------------------------
  // Validate / submit
  // -------------------------------------------------------------------------

  private validateOptions(extra: { unitId?: string; version?: number }) {
    const opener = this.game.options.validationOpener;
    return { ...extra, ...(opener ? { openSession: opener } : {}) };
  }

  private async runValidator(source: unknown, config: GameConfig) {
    return this.sandboxes.run(() => validateDetailed(source, this.validateOptions({}), config));
  }

  /** Where a submission of `name` (with optional explicit unitId) goes. */
  private resolveTarget(
    playerId: string,
    name: string,
    unitId: string | undefined,
  ): Result<{ unitId: string; version: number; isNew: boolean }> {
    const designs = this.game.store.designsOf(playerId);
    if (unitId !== undefined) {
      const d = designs.get(unitId);
      if (!d || d.retired) return notFoundUnit(unitId);
      if (d.isTemplate) return templateProtected(unitId);
      return ok({ unitId, version: UnitsService.latest(d).version + 1, isNew: false });
    }
    const slug = slugify(name);
    const same = designs.get(slug);
    if (same && !same.retired && !same.isTemplate) {
      return ok({ unitId: slug, version: UnitsService.latest(same).version + 1, isNew: false });
    }
    let id = slug;
    for (let n = 2; designs.has(id); n++) id = `${slug}-${n}`;
    const count = [...designs.values()].filter((d) => !d.retired && !d.isTemplate).length;
    if (count >= this.game.config.caps.maxDesigns) {
      return fail('TOO_MANY_DESIGNS', `You already have ${count} designs (the max is ${this.game.config.caps.maxDesigns}).`, {
        hint: 'Revise an existing unit instead: pass its unitId (from list_my_units). Or retire one on the Pixel Clash page.',
        details: { max: this.game.config.caps.maxDesigns },
      });
    }
    return ok({ unitId: id, version: 1, isNew: true });
  }

  /** Check that an explicit unitId exists before spending a sandbox on it. */
  private checkUnitId(playerId: string, unitId: unknown): Result<string | undefined> {
    if (unitId === undefined || unitId === null || unitId === '') return ok(undefined);
    if (typeof unitId !== 'string') return fail('BAD_REQUEST', 'unitId must be a string.');
    if (isArmoryUnitId(unitId)) return borrowedNotFound(unitId);
    if (!this.design(playerId, unitId)) return notFoundUnit(unitId);
    return ok(unitId);
  }

  private rateLimit(limiter: RateLimiter, key: string, max: number, windowMs: number, what: string): Result<never> | null {
    limiter.configure(max, windowMs);
    const wait = limiter.hit(key);
    if (wait === 0) return null;
    return fail('RATE_LIMITED', `Too many ${what} requests. Wait ${Math.ceil(wait / 100) / 10} s and try again.`, {
      hint: `Wait ${wait} ms, then retry.`,
      details: { retryAfterMs: wait },
    });
  }

  /** Dry-run validation (any phase). `rateLimited` is false for admin on-behalf calls. */
  async validate(player: PlayerRecord, source: unknown, unitIdIn: unknown, rateLimited = true): Promise<Result<ValidationResult>> {
    const id = this.checkUnitId(player.id, unitIdIn);
    if (!id.ok) return id;
    if (rateLimited) {
      const rl = this.rateLimit(this.validateLimiter, player.id, this.game.config.rateLimits.validatePerSecond, 1000, 'validate');
      if (rl) return rl;
    }
    const d = await this.runValidator(source, this.game.config);
    const result = d.result;
    if (result.ok) {
      // Predict the submit: TEMPLATE_PROTECTED / TOO_MANY_DESIGNS fail here too.
      const target = this.resolveTarget(player.id, result.unit.stats.name, id.data);
      if (!target.ok) return target;
      result.unit.unitId = target.data.unitId;
      result.unit.version = target.data.version;
    }
    return ok(result);
  }

  /** Submit (PLAN only, §10.2). Stores on success and pushes `private` to the owner. */
  async submit(
    player: PlayerRecord,
    source: unknown,
    unitIdIn: unknown,
    opts: { onBehalf?: boolean } = {},
  ): Promise<Result<SubmitResult>> {
    const gate = this.game.match.gate('submit');
    if (gate) return gate;
    const id = this.checkUnitId(player.id, unitIdIn);
    if (!id.ok) return id;
    if (id.data !== undefined && this.design(player.id, id.data)?.isTemplate) return templateProtected(id.data);
    if (!opts.onBehalf) {
      const rl = this.rateLimit(this.submitLimiter, player.id, 1, this.game.config.rateLimits.submitMinIntervalMs, 'submit');
      if (rl) return rl;
    }
    const d = await this.runValidator(source, this.game.config);
    const result = d.result;
    if (!result.ok) return ok(result);

    // The phase may have closed while the sandbox ran.
    const gate2 = this.game.match.gate('submit');
    if (gate2) return gate2;
    if (!this.game.store.players.get(player.id) || player.kicked) return fail('KEY_INVALID', 'This player was removed.');
    const target = this.resolveTarget(player.id, result.unit.stats.name, id.data);
    if (!target.ok) return target;
    const { unitId, version, isNew } = target.data;

    const now = Date.now();
    const rec: UnitVersionRecord = {
      version,
      status: 'valid',
      source: d.source ?? String(source),
      compiledJs: d.compiledJs!,
      stats: result.unit.stats,
      sprite: spriteOf(result),
      cost: result.unit.cost,
      breakdown: result.unit.breakdown,
      warnings: result.warnings,
      sha256: d.sha256 ?? '',
      createdAt: now,
    };
    this.game.store.writeUnitFiles(player.id, unitId, version, rec.source, rec.compiledJs);
    const designs = this.game.store.designsOf(player.id);
    if (isNew) {
      designs.set(unitId, {
        unitId,
        ownerId: player.id,
        isTemplate: false,
        retired: false,
        spriteHidden: false,
        createdAt: now,
        updatedAt: now,
        versions: [rec],
      });
    } else {
      const design = designs.get(unitId)!;
      design.versions.push(rec);
      design.updatedAt = now;
    }
    const rs = this.game.round.stateOf(player.id);
    rs.submittedThisPlan = true;
    this.game.store.save();
    this.game.notifier.privateChanged(player.id);
    this.game.notifier.stateChanged();

    result.unit.unitId = unitId;
    result.unit.version = version;
    return ok({ ...result, unitId, version });
  }

  /** Retire a design (PLAN only; templates can't be deleted). */
  retire(playerId: string, unitId: string): Result<{ ok: true }> {
    const gate = this.game.match.gate('retire');
    if (gate) return gate;
    const d = this.design(playerId, unitId);
    if (!d) return notFoundUnit(unitId);
    if (d.isTemplate) return templateProtected(unitId);
    d.retired = true;
    const rs = this.game.round.stateOf(playerId);
    rs.selection = rs.selection.filter((id) => id !== unitId);
    this.game.store.save();
    this.game.notifier.privateChanged(playerId);
    this.game.notifier.stateChanged();
    return ok({ ok: true });
  }

  setSpriteHidden(playerId: string, unitId: string, hidden: boolean): Result<{ ok: true }> {
    // Retired designs count too, and so do Armory entries whose design is gone
    // (kick + delete): the entry may still be borrowable (§9.1 Moderation).
    const d = this.game.store.designs.get(playerId)?.get(unitId);
    // The design's Armory entry hides (or shows) its sprite too.
    const entry = this.game.armory.setSpriteHidden(playerId, unitId, hidden);
    if (!d && !entry) return notFoundUnit(unitId);
    if (d) d.spriteHidden = hidden;
    if (entry) {
      for (const p of this.game.players.list()) if (p.id !== playerId) this.game.notifier.privateChanged(p.id);
    }
    this.game.store.save();
    this.game.notifier.privateChanged(playerId);
    return ok({ ok: true });
  }

  // -------------------------------------------------------------------------
  // Re-pricing (§6)
  // -------------------------------------------------------------------------

  /** Errors a version would have under `config` (empty = valid). */
  static checkVersion(v: Pick<UnitVersionRecord, 'stats'>, config: GameConfig): { error?: ValidationError; cost: ReturnType<typeof computeCost> } {
    const priced = computeCost(v.stats, config.cost);
    const checked = checkStats({ ...v.stats }, config.stats.bounds);
    if (!checked.ok) return { error: checked.errors[0]!, cost: priced };
    if (!Number.isFinite(priced.raw) || priced.cost > config.caps.unitCost) {
      return { error: tooExpensiveError(v.stats, priced, config.caps.unitCost, config.cost, config.stats.bounds), cost: priced };
    }
    return { cost: priced };
  }

  /** Would any template become invalid under `config`? */
  templateBreaks(config: GameConfig): string | null {
    for (const t of this.templates) {
      const r = UnitsService.checkVersion(t, config);
      if (r.error) return `${t.stats.name}: ${r.error.message}`;
    }
    return null;
  }

  /**
   * Re-price every stored unit under `config`. Units that now break the cap or
   * a bound become `invalid` and are dropped from selections (toast to owner).
   */
  repriceAll(config: GameConfig): { repriced: string[]; invalidated: string[] } {
    const repriced: string[] = [];
    const invalidated: string[] = [];
    const touched = new Set<string>();
    for (const [playerId, designs] of this.game.store.designs) {
      for (const d of designs.values()) {
        for (const v of d.versions) {
          const r = UnitsService.checkVersion(v, config);
          const wasValid = v.status === 'valid';
          // Always refresh the breakdown (it explains the curve per stat).
          v.breakdown = r.cost.breakdown;
          if (r.cost.cost !== v.cost) {
            v.cost = r.cost.cost;
            if (v === UnitsService.latest(d)) repriced.push(`${playerId}/${d.unitId}`);
            touched.add(playerId);
          }
          if (r.error) {
            v.status = 'invalid';
            v.error = r.error;
            if (wasValid && v === UnitsService.latest(d)) invalidated.push(`${playerId}/${d.unitId}`);
            touched.add(playerId);
          } else if (!wasValid) {
            v.status = 'valid';
            delete v.error;
            touched.add(playerId);
          }
        }
      }
    }
    // Open Armory entries are re-priced too (§9.1 Cost).
    const armory = this.game.armory.reprice(config);
    if (armory.repriced.length > 0 || armory.invalidated.length > 0) {
      repriced.push(...armory.repriced);
      invalidated.push(...armory.invalidated);
      for (const p of this.game.players.list()) touched.add(p.id);
    }
    // Drop designs without any valid version from current selections.
    for (const [playerId, rs] of Object.entries(this.game.store.match.perPlayer)) {
      const before = rs.selection.length;
      const dropped: string[] = [];
      const droppedBorrowed: string[] = [];
      rs.selection = rs.selection.filter((unitId) => {
        if (isArmoryUnitId(unitId)) {
          const e = this.game.armory.forUnitId(unitId);
          const keep = !!e && e.status === 'valid';
          if (!keep) droppedBorrowed.push(e ? armoryDisplayName(e.name, e.creatorName) : unitId);
          return keep;
        }
        const d = this.design(playerId, unitId);
        const keep = !!d && !!UnitsService.latestValid(d);
        if (!keep) dropped.push(d ? UnitsService.latest(d).stats.name : unitId);
        return keep;
      });
      if (rs.selection.length !== before) {
        touched.add(playerId);
        if (dropped.length > 0) {
          this.game.notifier.toast(
            { playerId },
            'warn',
            `${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} removed from your selection because the rules changed. Ask Claude to fix ${dropped.length === 1 ? 'it' : 'them'}!`,
          );
        }
        if (droppedBorrowed.length > 0) {
          // A borrowed unit can't be changed (§9.1 Source), so don't suggest fixing it.
          this.game.notifier.toast(
            { playerId },
            'warn',
            `${droppedBorrowed.join(', ')} ${droppedBorrowed.length === 1 ? 'was' : 'were'} removed from your selection because the rules changed. Borrowed units can't be changed: pick another unit or ask Claude for your own version.`,
          );
        }
      }
    }
    if (touched.size > 0) this.game.store.save();
    for (const id of touched) this.game.notifier.privateChanged(id);
    return { repriced, invalidated };
  }
}

function notFoundUnit(unitId: unknown): Result<never> {
  return fail('NOT_FOUND', `You have no unit with unitId "${String(unitId)}".`, {
    hint: 'Call list_my_units to see your unitIds. To make a brand-new unit, leave unitId out.',
  });
}

function borrowedNotFound(unitId: string): Result<never> {
  return fail('NOT_FOUND', `"${unitId}" is a borrowed Armory unit: its code is never shared and it can't be changed.`, {
    hint: "Borrowed units can't be changed. Build your own counter or improved version instead (a NEW unit, submitted WITHOUT unitId).",
  });
}

function templateProtected(unitId: string): Result<never> {
  return fail('TEMPLATE_PROTECTED', `"${unitId}" is a starter template and can't be changed or deleted.`, {
    hint: 'To build on it, give the unit a NEW name and submit it WITHOUT unitId; that creates your own design.',
  });
}
