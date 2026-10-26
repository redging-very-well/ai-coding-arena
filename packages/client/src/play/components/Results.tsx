// RESULTS / MATCH_RESULTS: my place (my team's place in team
// mode), my points breakdown (place + damage bonus + value bonus) and badges,
// the team table (team mode), the scoreboard,
// my units' battle stats (kills, damage) and "Ask Claude" prompts with Copy
// buttons for units with errors. Also a replay of the last battle.

import { useEffect, useState } from 'preact/hooks';
import { BADGES, BADGE_IDS, DEFAULT_CONFIG, type BattleReportDTO, type GameStateDTO, type TeamTableRowDTO } from '@pixel-clash/shared';
import { ApiError, api } from '../../common/api.js';
import { teamOfPlayer } from '../../common/maps.js';
import { seatStyle } from '../../common/seats.js';
import { PLACE_MEDALS, cx, formatMoney, ordinal } from '../../common/ui.js';
import { BADGE_PLAYER_TEXT, effectReportLines, groupErrors, scoreLines, scoreParts, factoryReportLines, stuckPrompts, unitPrompts } from '../logic.js';
import { getStore, useStore } from '../store.js';
import { ArenaView } from './Battle.js';
import { CopyButton } from './CopyButton.js';
import { MatchAwards } from './MatchAwards.js';
import { TeamChip } from './TeamPanel.js';
import { TopUnits } from './TopUnits.js';

/** Team table: average member total, then place points; my team highlighted. */
function TeamTable({ rows, game, myTeamId }: { rows: readonly TeamTableRowDTO[]; game: GameStateDTO; myTeamId: number | undefined }) {
  const names = new Map(game.players.map((p) => [p.id, p.name]));
  return (
    <ol class="team-table">
      {rows.map((t) => (
        <li key={t.teamId} class={cx(t.teamId === myTeamId && 'me')} style={{ '--team': t.color }}>
          <span class="sb-rank">{PLACE_MEDALS[t.place - 1] ?? t.place}</span>
          <span class="tt-name">
            <TeamChip teamId={t.teamId} name={t.name} />
            <span class="dim small">{t.members.map((id) => names.get(id) ?? '?').join(', ')}</span>
          </span>
          <span class="sb-pts" title="Average of the members' points">
            {t.points} pts
          </span>
        </li>
      ))}
    </ol>
  );
}

function Scoreboard({ game, meId }: { game: GameStateDTO; meId: string | undefined }) {
  return (
    <ol class="scoreboard">
      {game.scoreboard.map((s, i) => {
        const seat = seatStyle(s.seat);
        const badges = BADGE_IDS.filter((b) => (s.badges?.[b] ?? 0) > 0);
        return (
          <li key={s.playerId} class={cx(`seat-${s.seat}`, s.playerId === meId && 'me')}>
            <span class="sb-rank">{s.place ?? i + 1}</span>
            <span class="seat-num" style={{ '--seat': seat.color }}>
              {seat.symbol}
            </span>
            <span class="sb-name">
              {s.name}
              {badges.length > 0 && (
                <span class="sb-badges">
                  {badges.map((b) => (
                    <span key={b} title={BADGES[b].title}>
                      {BADGES[b].emoji}
                      {s.badges[b] > 1 ? `×${s.badges[b]}` : ''}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span class="sb-dmg" title="Damage this game (breaks ties)">
              💥 {Math.round(s.damage ?? 0).toLocaleString('en-US')}
            </span>
            <span class="sb-pts">{s.points} pts</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Results() {
  const st = useStore();
  const store = getStore();
  const game = st.game;
  const last = game?.lastBattle;
  const meId = st.player?.id;
  const [report, setReport] = useState<BattleReportDTO | null>(null);
  const [reportErr, setReportErr] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    if (!last) return;
    let cancelled = false;
    setReport(null);
    setReportErr(null);
    api.report(last.round).then(
      (r) => !cancelled && setReport(r),
      (err) => !cancelled && setReportErr(err instanceof ApiError && err.code === 'NOT_FOUND' ? null : "Couldn't load your battle report. Try again in a moment."),
    );
    return () => {
      cancelled = true;
    };
  }, [last?.round, meId]);

  if (!game) return null;
  const final = game.phase === 'MATCH_RESULTS';
  const found = last?.ranking.find((r) => r.playerId === meId);
  const mine = found ? scoreParts(found) : undefined;
  const roster = st.priv?.roster ?? [];
  // Borrowed Open Armory units fought for me too.
  const fieldedCards = last ? [...roster, ...(st.priv?.armory ?? [])].filter((u) => u.lastBattle?.round === last.round) : [];
  const myInvention = last?.inventors?.find((i) => i.playerId === meId);
  const groups = report ? groupErrors(report.errors) : [];
  const extra = last ? [...unitPrompts(roster, last.round, report), ...stuckPrompts(report, st.reveal?.totalTicks ?? DEFAULT_CONFIG.timers.battleTicks)] : [];
  const factoryLinesOfReport = factoryReportLines(report);
  const effectLinesOfReport = effectReportLines(report);
  const myBoard = game.scoreboard.findIndex((s) => s.playerId === meId);
  const myEntry = myBoard >= 0 ? game.scoreboard[myBoard]! : undefined;
  const myPlace = myEntry?.place ?? myBoard + 1;
  const teamTable = last?.teamTable ?? game.match?.teamTable ?? null;
  const myTeam = teamOfPlayer(game.match?.teams, meId);
  const teamMode = !!teamTable && teamTable.length > 0;
  const myTeamRow = teamTable?.find((t) => t.teamId === myTeam?.teamId);

  const watchReplay = async () => {
    if (!last) return;
    try {
      const replay = await api.replay(last.round);
      setReplaying(true);
      store.arena.loadReplay(replay);
    } catch (err) {
      store.toast(err instanceof ApiError ? err.playerMessage : 'No replay yet.', 'warn');
    }
  };

  return (
    <section class="panel results">
      <div class="panel-head">
        <h2>{final ? 'Game over!' : `Round ${last?.round ?? game.round} results`}</h2>
      </div>

      {final && teamMode && myTeamRow && (
        <div class="big-result">
          <span class="medal">{PLACE_MEDALS[Math.min(3, myTeamRow.place - 1)]}</span>
          <div>
            <div class="pixel big">Your team finished {ordinal(myTeamRow.place)}!</div>
            <div class="dim">{myTeamRow.name}: {myTeamRow.points} points on average.</div>
          </div>
        </div>
      )}
      {final && myEntry && (
        <div class="big-result">
          <span class="medal">{PLACE_MEDALS[Math.min(3, myPlace - 1)]}</span>
          <div>
            <div class="pixel big">{teamMode ? `On your own you finished ${ordinal(myPlace)}!` : `You finished ${ordinal(myPlace)}!`}</div>
            <div class="dim">
              {myEntry.points} points and {Math.round(myEntry.damage ?? 0).toLocaleString('en-US')} damage in total. Great battles!
            </div>
          </div>
        </div>
      )}

      {final && <MatchAwards game={game} meId={meId} />}

      {!final && mine && (
        <>
          <div class="big-result">
            <span class="medal">{PLACE_MEDALS[Math.min(3, mine.place - 1)]}</span>
            <div>
              <div class="pixel big">{teamMode ? `Your team came ${ordinal(mine.place)}!` : `You came ${ordinal(mine.place)}!`}</div>
              <div class="points-gained">+{mine.pointsGained} points this round</div>
            </div>
          </div>
          <ul class="score-lines">
            {scoreLines(mine, { team: teamMode }).map((l) => (
              <li key={l.icon} class={cx(l.points > 0 && 'got')}>
                <span class="sl-icon">{l.icon}</span>
                <span>{l.text}</span>
              </li>
            ))}
            <li class="sl-total">
              <span class="sl-icon">⭐</span>
              <span>
                Total: {mine.placePoints} + {mine.damageBonus} + {mine.valueBonus} = <strong>{mine.pointsGained} points</strong>
              </span>
            </li>
          </ul>
          {mine.badges.length > 0 && (
            <div class="my-badges">
              {mine.badges.map((b, i) => (
                <div key={b} class="player-badge" style={{ animationDelay: `${400 + i * 300}ms` }}>
                  <span class="kb-emoji">{BADGES[b].emoji}</span>
                  <span>
                    <strong>{BADGES[b].title}</strong>
                    <br />
                    <span class="dim small">
                      {BADGE_PLAYER_TEXT[b]}
                      {b === 'inventor' && mine.inventorUsedBy ? ` Used by ${mine.inventorUsedBy} player${mine.inventorUsedBy === 1 ? '' : 's'}.` : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {!final && last && !mine && <p class="dim">You sat this round out. You're in next round!</p>}
      {!final && myInvention && !mine && (
        <p class="good-news">
          {BADGES.inventor.emoji} {BADGES.inventor.title}: {myInvention.units.join(', ')} used by {myInvention.usedBy} player
          {myInvention.usedBy === 1 ? '' : 's'}!
        </p>
      )}
      {last?.reason === 'timeout' && !final && <p class="dim small">Time ran out, so the army with the most $ still standing won.</p>}
      {last && <TopUnits top={last.topUnits} round={last.round} meId={meId} />}

      <div class="results-layout">
        <div>
          {teamMode && teamTable && (
            <>
              <h3>Teams</h3>
              <TeamTable rows={teamTable} game={game} myTeamId={myTeam?.teamId} />
            </>
          )}
          <h3>{teamMode ? 'Everyone' : 'Scoreboard'}</h3>
          <Scoreboard game={game} meId={meId} />
          {last && (
            <button class="btn" onClick={() => void watchReplay()}>
              ▶ Watch the battle again
            </button>
          )}
        </div>

        {fieldedCards.length > 0 && (
          <div>
            <h3>My units last battle</h3>
            <table class="unit-stats">
              <thead>
                <tr>
                  <th>Unit</th>
                  <th title="still standing at the end">Alive</th>
                  <th>KOs</th>
                  <th>Damage</th>
                  <th title="value of the enemy units it knocked out">KO value</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {fieldedCards.map((u) => {
                  const lb = u.lastBattle!;
                  return (
                    <tr key={u.unitId}>
                      {/* The name it fought under: a later Armory replacement may rename the card. */}
                      <td>{lb.name ?? u.name}</td>
                      <td>
                        {lb.survived}/{lb.fielded}
                      </td>
                      <td>{lb.kills}</td>
                      <td>{Math.round(lb.damageDealt).toLocaleString('en-US')}</td>
                      <td>{formatMoney(lb.valueDestroyed ?? 0)}</td>
                      <td>{lb.disabled > 0 ? `💤 ${lb.disabled}` : lb.strikes > 0 ? `⚠️ ${lb.strikes}` : '✓'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {factoryLinesOfReport.map((l) => (
              <p key={l} class="small factory-line">
                {l}
              </p>
            ))}
            {effectLinesOfReport.map((l) => (
              <p key={l} class="small factory-line effect-line">
                {l}
              </p>
            ))}
          </div>
        )}
      </div>

      {replaying && (
        <div class="replay-box">
          <ArenaView />
          <button class="btn" onClick={() => setReplaying(false)}>
            Close replay
          </button>
        </div>
      )}

      {(groups.length > 0 || extra.length > 0) && (
        <div class="ask-claude">
          <h3>Ask your AI helper to fix it</h3>
          <p class="dim small">Copy a message and paste it to your AI helper in your terminal.</p>
          <ul>
            {groups.map((g, i) => (
              <li key={`e${i}`}>
                <blockquote>
                  {g.prompt}
                  {g.count > 1 && <span class="dim"> (happened {g.count}×)</span>}
                </blockquote>
                <CopyButton text={g.prompt} />
              </li>
            ))}
            {extra.map((p, i) => (
              <li key={`x${i}`}>
                <blockquote>{p}</blockquote>
                <CopyButton text={p} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {report && groups.length === 0 && extra.length === 0 && (
        <p class="good-news">✓ No errors in your units this battle. Nice coding!</p>
      )}
      {mine && !final && (
        <div class="ask-claude">
          <ul>
            <li>
              <blockquote>{`We came ${ordinal(mine.place)} last battle. Call get_battle_report and tell me what happened to my units.`}</blockquote>
              <CopyButton text={`We came ${ordinal(mine.place)} last battle. Call get_battle_report and tell me what happened to my units.`} />
            </li>
          </ul>
        </div>
      )}
      {reportErr && <p class="note bad">{reportErr}</p>}
    </section>
  );
}
