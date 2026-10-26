// The Match tab (plan §12.3): in LOBBY a step-by-step "configure this match"
// flow, 1 Players & teams, 2 Map, 3 Rounds & time, 4 Armory & rules, then
// Start match. The map, teams, team budgets, enemy names and walls are the
// server's LOBBY draft (saved as clicked); rounds and Open Armory go with
// Start match; the budget and the timers are live config settings (saved as
// typed, Settings.tsx). After the start, a read-only summary of this match.

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { teamModeLabel, type GameStateDTO } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { mapName } from '../common/maps.js';
import { useAdmin } from './context.js';
import { useConfig } from './configStore.js';
import { MapStep, TeamsStep } from './MatchSetup.js';
import { ConfigNumberAt, ConfigToggleAt } from './Settings.js';

function Step({ n, title, hint, children, wide }: { n: number; title: string; hint?: string; children: ComponentChildren; wide?: boolean }) {
  return (
    <section class={wide ? 'step panel step-wide' : 'step panel'} aria-labelledby={`step-${n}`}>
      <h3 class="step-title" id={`step-${n}`}>
        <span class="step-num">{n}</span>
        {title}
      </h3>
      {hint && <p class="dim small step-hint">{hint}</p>}
      {children}
    </section>
  );
}

export function MatchTab({ onRules }: { onRules: () => void }) {
  const { state, overview, act, busy } = useAdmin();
  const { config } = useConfig();
  const s = state as GameStateDTO;
  const [rounds, setRounds] = useState(s.rounds);
  const [armory, setArmory] = useState(false);
  const revealNames = overview?.setup?.revealNames === true;
  const wallsAllowed = overview?.setup?.wallsAllowed !== false;
  const defaultRounds = config?.timers.defaultRounds;
  useEffect(() => {
    if (s.phase === 'LOBBY') setRounds(s.rounds);
  }, [s.phase, s.rounds]);
  useEffect(() => {
    if (defaultRounds !== undefined && s.phase === 'LOBBY') setRounds(defaultRounds);
  }, [defaultRounds]);

  if (s.phase !== 'LOBBY') return <MatchSummary s={s} />;

  const players = s.players.length;
  const maxPlayers = config?.match.maxPlayers;
  const roundsOk = Number.isInteger(rounds) && rounds >= 1 && rounds <= 10;
  const mode = overview?.setup?.teamMode ?? 'ffa';

  return (
    <div class="match-flow">
      <div class="flow-col">
        <Step n={1} title="Players & teams" hint="Players join from /play. Pick free-for-all or teams; drag players between team boxes.">
          <p class="step-count">
            <b>{players}</b> player{players === 1 ? '' : 's'} joined{maxPlayers ? ` (seats for ${maxPlayers})` : ''}
          </p>
          <TeamsStep rounds={roundsOk ? rounds : 1} />
          <ConfigNumberAt path="match.maxPlayers" compact />
        </Step>

        <Step n={2} title="Map" hint="Only the maps that fit this many players and this team mode are offered.">
          <MapStep rounds={roundsOk ? rounds : 1} />
        </Step>
      </div>
      <div class="flow-col">
        <Step n={3} title="Rounds & time">
          <div class="step-fields">
            <div class="qs-field qs-compact">
              <label for="match-rounds">Rounds in this match</label>
              <div class="qs-input">
                <input id="match-rounds" type="number" min={1} max={10} step={1} value={rounds} aria-invalid={!roundsOk} onInput={(e) => setRounds(Number(e.currentTarget.value))} />
              </div>
              {!roundsOk && <p class="error qs-error">Use a whole number from 1 to 10.</p>}
            </div>
            <ConfigNumberAt path="timers.planFirstRoundSec" compact />
            <ConfigNumberAt path="timers.planLaterRoundsSec" compact />
            <ConfigNumberAt path="timers.placementSec" compact />
            <ConfigNumberAt path="timers.battleTicks" compact />
          </div>
          <ConfigToggleAt path="timers.autoAdvanceWhenAllReady" />
        </Step>

        <Step n={4} title="Armory & rules for this match">
          <div class="step-fields">
            <ConfigNumberAt path="caps.budget" label="Budget per player each round ($)" compact />
          </div>
          {mode !== 'ffa' && <p class="dim small">In team mode each team box (step 1) can set its own budget per player.</p>}
          <div class="rule-checks">
            <label class="inline" title="Units that fought become available to every other player in later rounds (locked for the match)">
              <input type="checkbox" checked={armory} onChange={(e) => setArmory(e.currentTarget.checked)} />
              <span>
                <b>Open Armory</b> <span class="dim small">units that fought become available to every player in later rounds</span>
              </span>
            </label>
            <label class="inline">
              <input type="checkbox" checked={wallsAllowed} disabled={busy || !overview?.setup} onChange={(e) => void act(() => api.admin.setMatchSetup({ wallsAllowed: e.currentTarget.checked }))} />
              <span>
                <b>Walls allowed</b> <span class="dim small">players can pick and place walls</span>
              </span>
            </label>
            <label class="inline">
              <input type="checkbox" checked={revealNames} disabled={busy || !overview?.setup} onChange={(e) => void act(() => api.admin.setMatchSetup({ revealNames: e.currentTarget.checked }))} />
              <span>
                <b>Show enemy names to units</b> <span class="dim small">in battle, units also see each body's player (and team) name</span>
              </span>
            </label>
          </div>
          <p class="dim small">
            Prices, caps, factories, elements and sudden death are in{' '}
            <button class="linkish" onClick={onRules}>
              Game rules
            </button>
            .
          </p>
        </Step>
        <section class="step step-start panel">
          <div>
            <h3 class="step-title">
              <span class="step-num">▶</span>Start the match
            </h3>
            <p class="small">
              {players} players · {mode === 'ffa' ? 'free-for-all' : teamModeLabel(mode, players)} · {roundsOk ? rounds : '?'} round{rounds === 1 ? '' : 's'}
              {armory ? ' · Open Armory' : ''}
              {wallsAllowed ? '' : ' · no walls'}
              {revealNames ? ' · enemy names shown' : ''}
            </p>
            {players < 2 && <p class="warn-text small">Needs at least 2 players.</p>}
          </div>
          <button
            class="btn primary big"
            disabled={busy || players < 2 || !roundsOk}
            title={players < 2 ? 'Needs at least 2 players' : ''}
            onClick={() => act(() => api.admin.startMatch(Math.round(rounds), armory, { revealNames, wallsAllowed }), 'Match started!')}
          >
            Start match
          </button>
        </section>
      </div>
    </div>
  );
}

/** After the start: what this match was set up with (locked until New match). */
function MatchSummary({ s }: { s: GameStateDTO }) {
  const m = s.match;
  const rows: Array<[string, string]> = [
    ['Rounds', `Round ${s.round} of ${s.rounds}`],
    ['Map', m?.map ? mapName(m.map) : '–'],
    ['Teams', m && m.teamMode !== 'ffa' ? teamModeLabel(m.teamMode, m.map?.players ?? s.players.length) : 'Free-for-all'],
    ['Open Armory', s.armory?.enabled ? `On (${s.armory.entries} units)` : 'Off'],
    ['Walls', m?.wallsAllowed === false ? 'Not allowed' : 'Allowed'],
    ['Enemy names to units', m?.revealNames ? 'Shown' : 'Hidden'],
  ];
  return (
    <section class="panel match-summary">
      <h2>This match</h2>
      <dl class="summary-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p class="dim small">
        The match setup is locked until New match (in the controls above). Budget, timers and the other game rules can still change in PLAN and RESULTS
        (Game rules tab).
      </p>
    </section>
  );
}
