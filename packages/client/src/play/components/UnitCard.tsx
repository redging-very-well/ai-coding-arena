// A roster card (plan §12.1): animated sprite (idle, walk on hover), name,
// size, stat bars, cost (a plain label; a separate "How much?" button opens
// the breakdown), version, "new!" badge,
// warnings, the invalid-unit error with an "Ask Claude" prompt, and the code
// editor buttons ("✏️ Edit code" on own units, "Copy to a new unit" on starters).
// M8.5 (§12.5): a type tag (⚔️ soldier, 🏹 tower, 🧱 wall, 🏭 factory); wall
// cards show HP only, factory cards HP, "1 minion every 15 s", "makes 5
// minions" and the minion's mini sprite in the factory's colour, and the
// price breakdown its production line. M8.6 (§12.5): a minion-kind chip
// (icon, name, that kind's mini sprite), its burst and the orders its code gives.
// M8.8: element / splash / support chips (a factory: its minions' element), a
// "support only" tag for damage-0 helpers, an "old $1,000 numbers" tag on
// designs from before the ×5 economy, and the new price lines (tough + strong,
// splash, element, heal, aura) under the breakdown.

import { useState } from 'preact/hooks';
import { isNonCombatBuilding, playerHintFor, playerHintForIssue, sizeOf, type StatBounds, type UnitCardDTO } from '@pixel-clash/shared';
import { minionLook } from '../../common/render/buildings.js';
import { resolveSprite } from '../../common/render/sprites.js';
import { seatStyle } from '../../common/seats.js';
import { cx, formatMoney } from '../../common/ui.js';
import { breakdownNotes, breakdownRows, combatChips, isSupportOnly, typeTitle, burstText, factoryKindChip, factoryLines, ordersText, statBars } from '../logic.js';
import { CopyButton } from './CopyButton.js';
import { SpriteView } from './SpriteView.js';

export interface UnitCardProps {
  unit: UnitCardDTO;
  seat: number;
  bounds: StatBounds;
  selected?: boolean;
  /** Tapping the card toggles selection (PLAN). */
  onTap?: () => void;
  shake?: boolean;
  isNew?: boolean;
  onSeen?: () => void;
  /** PLAN only: retire (delete) this design. */
  onRetire?: () => void;
  /** A borrowed Open Armory unit (§9.1): the round it was added (it can't be changed). */
  borrowedRound?: number;
  /** Own units: open the code editor. */
  onEdit?: () => void;
  /** Starter templates: open the editor on a copy that becomes a new unit. */
  onCopy?: () => void;
}

export function specKeyOf(u: Pick<UnitCardDTO, 'unitId' | 'version' | 'spriteHidden' | 'sprite'>): string {
  return `${u.unitId}@${u.version}/${u.spriteHidden || !u.sprite ? 'fallback' : 'own'}`;
}

export function UnitCard(props: UnitCardProps) {
  const { unit: u, seat } = props;
  const [hover, setHover] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [showWarn, setShowWarn] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const size = sizeOf(u.stats);
  const invalid = u.status !== 'valid';
  const building = isNonCombatBuilding(u.stats.type);
  const factory = u.stats.type === 'factory';
  const chip = factory ? factoryKindChip(u.stats) : null;
  const minion = chip ? minionLook(u.stats.color, chip.kind) : null;
  const chips = combatChips(u.stats);
  const seen = () => props.onSeen?.();

  const stop = (fn: () => void) => (e: Event) => {
    e.stopPropagation();
    fn();
  };

  return (
    <article
      class={cx('unit-card', `seat-${seat}`, props.selected && 'selected', invalid && 'invalid', props.onTap && 'tappable', props.shake && 'shake')}
      onMouseEnter={() => {
        setHover(true);
        seen();
      }}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        seen();
        props.onTap?.();
      }}
      role={props.onTap ? 'button' : undefined}
      aria-pressed={props.onTap ? !!props.selected : undefined}
      tabIndex={props.onTap ? 0 : undefined}
      onKeyDown={(e) => {
        if (props.onTap && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          props.onTap();
        }
      }}
    >
      {props.selected && <span class="pick-mark" aria-label="picked">✓</span>}
      <div class="card-top">
        <div class="sprite-box">
          <SpriteView
            spec={resolveSprite(u)}
            specKey={specKeyOf(u)}
            outline={seatStyle(seat).color}
            width={size * 4}
            state={hover ? 'walk' : 'idle'}
          />
        </div>
        <div class="card-title">
          <h3 class="unit-name" title={u.name}>
            {u.name}
          </h3>
          <div class="card-tags">
            <span class={cx('tag', `type-${u.stats.type}`)}>{typeTitle(u.stats)}</span>
            {!building && <span class="tag">size {size}</span>}
            <span class="tag dim">v{u.version}</span>
            {u.isTemplate && <span class="tag dim">starter</span>}
            {props.borrowedRound !== undefined && (
              <span class="tag armory" title="A borrowed Armory unit: it can't be changed">
                💡 round {props.borrowedRound}
              </span>
            )}
            {props.isNew && <span class="tag new">new!</span>}
            {isSupportOnly(u.stats) && (
              <span class="tag support-only" title="Damage 0: it helps, it can't win on its own">
                support only
              </span>
            )}
            {u.warnings.length > 0 && (
              <button class="tag warn" onClick={stop(() => setShowWarn((v) => !v))} aria-expanded={showWarn} title="Tips for this unit">
                ⚠️ {u.warnings.length}
              </button>
            )}
          </div>
        </div>
      </div>

      <ul class="stat-bars">
        {statBars(u.stats, props.bounds).map((b) => (
          <li key={b.key}>
            <span class="stat-label">{b.label}</span>
            <span class="bar">
              <span class={`fill stat-${b.key}`} style={{ width: `${Math.round(b.frac * 100)}%` }} />
            </span>
            <span class="stat-val">{b.display}</span>
          </li>
        ))}
      </ul>

      {chips.length > 0 && (
        <ul class="combat-chips" aria-label="Element, splash and support">
          {chips.map((c) => (
            <li key={c.key} class={cx('combat-chip', c.tone)} title={c.title}>
              <span aria-hidden="true">{c.icon}</span> {c.label}
            </li>
          ))}
        </ul>
      )}

      {factory && minion && chip && (
        <div class="factory-info">
          <span class={`kind-chip kind-${chip.kind}`} title={`It builds ${chip.label.toLowerCase()}`}>
            <SpriteView spec={minion.spec} specKey={minion.key} outline={seatStyle(seat).color} width={24} state={hover ? 'walk' : 'idle'} title={`Its ${chip.label.toLowerCase()}`} />
            {chip.icon} {chip.label}
          </span>
          <span>{[...factoryLines(u.stats, u.breakdown.production?.expected), burstText(u.stats), ordersText(u.orders)].join(' · ')}</span>
        </div>
      )}

      {showWarn && (
        <ul class="warnings">
          {u.warnings.map((w, i) => (
            <li key={i} title={w.message}>
              {playerHintFor(w.code, w.field)}
            </li>
          ))}
        </ul>
      )}

      {invalid && u.error && (
        <div class="unit-error">
          <p>
            <strong>Can't use this one right now.</strong> {playerHintForIssue(u.error)}
          </p>
          {props.borrowedRound === undefined && (
            <CopyButton text={`My unit ${u.name} is invalid: ${u.error.message} Please fix it.`} label="Copy “Ask your AI helper”" />
          )}
        </div>
      )}

      <div class="card-foot">
        {/* The price is just a label: tapping it picks the card like the rest of
            it. The breakdown has its own small button so it isn't mistaken for
            the picker. */}
        <span class="cost">{formatMoney(u.cost)}</span>
        <button
          class={cx('cost-info', showCost && 'open')}
          onClick={stop(() => setShowCost((v) => !v))}
          aria-expanded={showCost}
          title="How the price is worked out"
        >
          {showCost ? '▾ Hide price' : 'ⓘ How much?'}
        </button>
        {u.lastBattle && (
          <span class="last-battle dim" title={`Round ${u.lastBattle.round}`}>
            last fight: {u.lastBattle.kills} KO · {Math.round(u.lastBattle.damageDealt).toLocaleString('en-US')} dmg
            {(u.lastBattle.healing ?? 0) >= 1 ? ` · ${Math.round(u.lastBattle.healing!).toLocaleString('en-US')} healed` : ''}
          </span>
        )}
        {props.onRetire &&
          !u.isTemplate &&
          (confirmRetire ? (
            <span class="retire-confirm" onClick={(e) => e.stopPropagation()}>
              Remove?{' '}
              <button class="mini bad" onClick={stop(() => props.onRetire?.())}>
                Yes
              </button>{' '}
              <button class="mini" onClick={stop(() => setConfirmRetire(false))}>
                No
              </button>
            </span>
          ) : (
            <button class="mini ghost" title="Remove this unit" onClick={stop(() => setConfirmRetire(true))}>
              🗑
            </button>
          ))}
      </div>

      {(props.onEdit || props.onCopy) && props.borrowedRound === undefined && (
        <div class="card-actions">
          {u.isTemplate
            ? props.onCopy && (
                <button class="mini edit-btn" onClick={stop(() => props.onCopy?.())} title="Start a new unit from this starter's code">
                  📄 Copy to a new unit
                </button>
              )
            : props.onEdit && (
                <button class="mini edit-btn" onClick={stop(() => props.onEdit?.())} title="Change this unit's stats and moves yourself">
                  ✏️ Edit code
                </button>
              )}
        </div>
      )}

      {showCost && (
        <table class="breakdown" onClick={(e) => e.stopPropagation()}>
          <tbody>
            {breakdownRows(u.breakdown).map((r) => (
              <tr key={r.label} class={r.label === 'Cost' || r.label === 'Sum' ? 'total' : ''}>
                <th>{r.label}</th>
                <td>{r.value}</td>
              </tr>
            ))}
          </tbody>
          {breakdownNotes(u.breakdown).length > 0 && (
            <tfoot>
              {breakdownNotes(u.breakdown).map((line) => (
                <tr key={line}>
                  <td colSpan={2} class="dim small">
                    {line}
                  </td>
                </tr>
              ))}
            </tfoot>
          )}
        </table>
      )}
    </article>
  );
}
