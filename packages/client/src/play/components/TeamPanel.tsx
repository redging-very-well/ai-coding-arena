// "My team": in team mode, each teammate's
// picked unit types as small cards, live, with ✓ submitted / picked / ready
// ticks, their zone and how much they spent. Read-only: teammates see each
// other's picks and placements but can't change them. Data comes only from
// this player's own `private.team` block (never source code).

import { groupOf, isNonCombatBuilding, sizeOf, type Phase, type TeamMemberPrivateDTO } from '@pixel-clash/shared';
import { arenaFor, zoneLabel } from '../../common/maps.js';
import { resolveSprite } from '../../common/render/sprites.js';
import { seatStyle, teamLook } from '../../common/seats.js';
import { cx, formatMoney } from '../../common/ui.js';
import { typeTitle } from '../logic.js';
import { useStore } from '../store.js';
import { SpriteView } from './SpriteView.js';
import { specKeyOf } from './UnitCard.js';

/** The team chip: team colour + ring pattern + name (header, results). */
export function TeamChip({ teamId, name, mine }: { teamId: number; name?: string; mine?: boolean }) {
  const look = teamLook(teamId);
  if (!look) return null;
  return (
    <span class={cx('team-chip', `pat-${look.pattern}`)} style={{ '--team': look.color }} title={`${name ?? look.name} (${look.pattern} ring)`}>
      {mine ? `My team: ${name ?? look.name}` : (name ?? look.name)}
    </span>
  );
}

function Tick({ on, label }: { on: boolean; label: string }) {
  return (
    <span class={cx('tm-tick', on && 'on')}>
      <span class="tm-box">{on ? '✓' : ''}</span>
      {label}
    </span>
  );
}

function Member({ m, phase, me, submitted, arena }: { m: TeamMemberPrivateDTO; phase: Phase; me: boolean; submitted: boolean; arena: number }) {
  const seat = seatStyle(m.seat);
  return (
    <li class={cx('tm-member', `seat-${m.seat}`, me && 'me')}>
      <div class="tm-head">
        <span class="seat-num">{seat.symbol}</span>
        <strong>{me ? `${m.name} (you)` : m.name}</strong>
        {phase === 'PLAN' && <Tick on={submitted} label="new unit" />}
        <Tick on={m.selection.length > 0} label="picked" />
        {(phase === 'PLAN' || phase === 'PLACEMENT') && <Tick on={m.ready} label="ready" />}
      </div>
      {m.zone && phase === 'PLACEMENT' && (
        <div class="dim small">
          In {zoneLabel(m.zone, arena)} · {m.placement.length} unit{m.placement.length === 1 ? '' : 's'} placed · {formatMoney(m.spent)} spent
        </div>
      )}
      <div class="tm-cards">
        {m.selection.length === 0 && <span class="dim small">No units picked yet.</span>}
        {/* Units first, then buildings, each titled with its type. */}
        {[...m.selection].sort((a, b) => Number(groupOf(a.stats.type) === 'building') - Number(groupOf(b.stats.type) === 'building')).map((u) => (
          <span
            key={u.unitId}
            class={`tm-card type-${u.stats.type}`}
            title={
              isNonCombatBuilding(u.stats.type)
                ? `${u.name} (${typeTitle(u.stats)}): ${u.stats.maxHealth} HP`
                : `${u.name} (${typeTitle(u.stats)}): ${u.stats.maxHealth} HP, ${u.stats.damage} damage, range ${u.stats.range}`
            }
          >
            <SpriteView spec={resolveSprite(u)} specKey={`tm-${m.playerId}-${specKeyOf(u)}`} outline={seat.color} width={Math.max(18, sizeOf(u.stats) * 2)} />
            <span class="tm-name">{u.name}</span>
            <span class="tm-cost">{formatMoney(u.cost)}</span>
          </span>
        ))}
      </div>
    </li>
  );
}

export function TeamPanel({ phase }: { phase: Phase }) {
  const st = useStore();
  const team = st.priv?.team;
  if (!team) return null;
  const meId = st.player?.id;
  const status = new Map((st.game?.players ?? []).map((p) => [p.id, p]));
  const map = st.game?.match?.map ?? null;
  return (
    <section class="panel team-panel" style={{ '--team': team.color }}>
      <div class="panel-head">
        <h2>My team</h2>
        <TeamChip teamId={team.teamId} name={team.name} />
      </div>
      <p class="dim small">
        {phase === 'PLACEMENT'
          ? 'Your teammates are the see-through units on the little map. Plan your attack together!'
          : 'You can see what your teammates pick, live. Talk about who builds what!'}
      </p>
      <ul class="tm-list">
        {team.members.map((m) => (
          <Member
            key={m.playerId}
            m={m}
            phase={phase}
            me={m.playerId === meId}
            submitted={status.get(m.playerId)?.submitted ?? false}
            arena={m.zone ? arenaFor(m.zone, map) : 800}
          />
        ))}
      </ul>
    </section>
  );
}
