// "Show details" (plan §12.3, §3 privacy): rosters, sources, selections,
// placements and sprites, OFF by default because the admin panel may be on the
// projector. Each unit has a Hide sprite button (§5.1 moderation).

import { useState } from 'preact/hooks';
import type { AdminArmoryEntryDTO, AdminOverviewDTO, PlacementDTO } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { seatStyle } from '../common/seats.js';
import { cx, formatMoney } from '../common/ui.js';
import { useAdmin } from './context.js';
import { SpriteThumb } from './SpriteThumb.js';

type OverviewPlayer = AdminOverviewDTO['players'][number];
type OverviewUnit = OverviewPlayer['units'][number];

export function Details() {
  const { overview } = useAdmin();
  const [show, setShow] = useState(false);
  const players = overview?.players ?? [];
  const armory = overview?.armory ?? [];
  return (
    <section class="panel details">
      <div class="panel-head">
        <h2>Details</h2>
        <label class="toggle">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.currentTarget.checked)} />
          Show details (rosters, sprites, sources, placements)
        </label>
      </div>
      {!show ? (
        <p class="dim">Hidden, so nothing secret shows if this screen is on the projector.</p>
      ) : players.length === 0 ? (
        <p class="dim">No players yet.</p>
      ) : (
        <>
          {players.map((p) => (
            <PlayerDetails key={p.id} player={p} armory={armory} />
          ))}
          {armory.length > 0 && <ArmoryDetails armory={armory} />}
        </>
      )}
    </section>
  );
}

function PlayerDetails({ player, armory }: { player: OverviewPlayer; armory: AdminArmoryEntryDTO[] }) {
  const seat = seatStyle(player.seat);
  // Borrowed types show as "Ogre (Ninja Sam)", never the raw armory id (§9.1).
  const nameOf = (id: string) =>
    player.units.find((u) => u.unitId === id)?.name ?? armory.find((e) => e.unitId === id)?.displayName ?? id;
  return (
    <div class="player-details" style={{ borderColor: seat.color }}>
      <h3>
        <span class="seat-chip" style={{ background: seat.color, color: seat.ink }}>
          {seat.symbol}
        </span>{' '}
        {player.name}
      </h3>
      <div class="dim small">
        Selection: {player.selection.length ? player.selection.map(nameOf).join(', ') : '(none)'} · Placement:{' '}
        {placementText(player.placement, nameOf)}
      </div>
      <div class="unit-grid">
        {player.units.map((u) => (
          <UnitDetails key={u.unitId} playerId={player.id} unit={u} selected={player.selection.includes(u.unitId)} />
        ))}
      </div>
    </div>
  );
}

function placementText(placement: PlacementDTO[], nameOf: (id: string) => string): string {
  if (!placement.length) return '(none)';
  const counts = new Map<string, number>();
  for (const pl of placement) counts.set(pl.unitId, (counts.get(pl.unitId) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${n}× ${nameOf(id)}`).join(', ');
}

/** Open Armory entries (§9.1 Moderation): Hide sprite works even if the design was retired or deleted. */
function ArmoryDetails({ armory }: { armory: AdminArmoryEntryDTO[] }) {
  const { act, busy } = useAdmin();
  return (
    <div class="player-details">
      <h3>Open Armory</h3>
      <div class="unit-grid">
        {armory.map((e) => (
          <div key={e.unitId} class={cx('unit-card', e.status === 'invalid' && 'invalid')}>
            <div class="unit-top">
              <div class="sprites">
                <SpriteThumb sprite={e.sprite} stats={e.stats} title="The kid's sprite" />
                {e.spriteHidden && <SpriteThumb sprite={e.sprite} stats={e.stats} showFallback size={32} title="What everyone sees (fallback)" />}
              </div>
              <div>
                <b>{e.displayName}</b> <span class="dim">v{e.version} · round {e.roundAdded}</span>
                {e.status === 'invalid' && <span class="tag bad">invalid</span>}
                <div class="small">
                  {e.stats.type} · {formatMoney(e.cost)}
                </div>
              </div>
            </div>
            <div class="btn-row">
              {e.sprite ? (
                <button
                  class={cx('btn small', e.spriteHidden ? 'on' : 'warn')}
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.admin.hideSprite(e.creatorId, e.sourceUnitId, !e.spriteHidden),
                      e.spriteHidden ? `${e.displayName}'s sprite is visible again` : `${e.displayName}'s sprite is hidden`,
                    )
                  }
                >
                  {e.spriteHidden ? 'Show sprite' : 'Hide sprite'}
                </button>
              ) : (
                <span class="dim small">no sprite (fallback)</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UnitDetails({ playerId, unit, selected }: { playerId: string; unit: OverviewUnit; selected: boolean }) {
  const { act, busy } = useAdmin();
  const [showSource, setShowSource] = useState(false);
  const st = unit.stats;
  return (
    <div class={cx('unit-card', unit.status === 'invalid' && 'invalid', selected && 'selected')}>
      <div class="unit-top">
        <div class="sprites">
          <SpriteThumb sprite={unit.sprite} stats={st} title="The kid's sprite" />
          {unit.spriteHidden && <SpriteThumb sprite={unit.sprite} stats={st} showFallback size={32} title="What everyone sees (fallback)" />}
        </div>
        <div>
          <b>{unit.name}</b> <span class="dim">v{unit.version}</span>
          {unit.isTemplate && <span class="tag">template</span>}
          {selected && <span class="tag sel">selected</span>}
          {unit.status === 'invalid' && <span class="tag bad">invalid</span>}
          <div class="small">
            {st.type} · {formatMoney(unit.cost)} · hp {st.maxHealth} · dmg {st.damage} · rng {st.range} · spd {st.speed} · cd {st.attackCooldown} · size {st.size}
          </div>
          {unit.error && <div class="small error">{unit.error.message}</div>}
          {unit.warnings.length > 0 && <div class="small warn-text">{unit.warnings.map((w) => w.code).join(', ')}</div>}
        </div>
      </div>
      <div class="btn-row">
        {unit.sprite ? (
          <button
            class={cx('btn small', unit.spriteHidden ? 'on' : 'warn')}
            disabled={busy}
            onClick={() =>
              act(
                () => api.admin.hideSprite(playerId, unit.unitId, !unit.spriteHidden),
                unit.spriteHidden ? `${unit.name}'s sprite is visible again` : `${unit.name}'s sprite is hidden`,
              )
            }
          >
            {unit.spriteHidden ? 'Show sprite' : 'Hide sprite'}
          </button>
        ) : (
          <span class="dim small">no sprite (fallback)</span>
        )}
        <button class="btn small" onClick={() => setShowSource(!showSource)}>
          {showSource ? 'Hide source' : 'Source'}
        </button>
      </div>
      {showSource && <pre class="code">{unit.source}</pre>}
    </div>
  );
}
