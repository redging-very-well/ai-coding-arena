# Pixel Clash architecture

How the game is put together, for anyone (person or coding agent) changing it.
[README.md](../README.md) covers what the game is and how to run it;
[sessions/README.md](../sessions/README.md) covers the AI session host in depth;
[decisions.md](decisions.md) lists the design decisions and why they were made.
Where this file and the code disagree, the code wins.

## 1. Machines and components

```
 Player laptops (2-8)               Projector               Facilitator
 browser: /play                     browser: /screen        browser: /admin, /setup
   │  game UI + AI helper pane        │                       │
   │  (iframe /terminal/N/)           │                       │
   └──────────── HTTP + WebSocket over the LAN ───────────────┘
                              │
                              ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Game server: one Node process, one port (default 0.0.0.0:8080)       │
 │  static client build · REST /api · MCP /mcp · WebSocket /ws          │
 │  seat proxy /terminal/N/  (adds the seat password itself)            │
 │  service layer → game state machine → validator → battle sim         │
 │  sandbox: isolated-vm isolates in child processes                    │
 │  data/ (state.json, unit sources, replays)                           │
 └───────────┬───────────────────────────────────────────▲──────────────┘
             │ HTTP + WS to ttyd (host port 7780+N)      │ MCP tools over HTTP
             ▼                                           │ (+ POST /api/seat-login)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ AI session host (Docker Compose): containers seat1 … seat8           │
 │  each: ttyd -b /terminal/N → agent-loop → Claude Code or Codex CLI   │
 │  working in that seat's kit folder /kit (CLAUDE.md or AGENTS.md,     │
 │  MCP config pointing at http://<game-server>/mcp, units/)            │
 └───────────┬──────────────────────────────────────────────────────────┘
             ▼ internet
       Anthropic / OpenAI APIs
```

- **The server is authoritative.** Clients never compute results; the sim runs
  on the server and streams frames.
- **Player laptops only talk to the game server.** The AI helper terminal is
  ttyd on the AI session host, reverse-proxied by the game server at the
  same-origin path `/terminal/N/`, so players never see the seat password.
- **The game server needs no internet.** Only the AI session host does.
- **The MCP link.** Each seat's agent calls the game server's `/mcp`
  (Streamable HTTP, stateless). It identifies the player with the `apiKey`
  stored in `/kit/.pixel-clash/player.json` (passed as a tool argument, or a
  `Bearer` header). If MCP is unavailable, the kit instructions fall back to
  `curl` against the same REST API.
- **Seat isolation.** Agents can run shell commands, so each seat is its own
  container with only its own kit folder; a seat can't reach other seats,
  the host or the game server's `data/`.

## 2. Repo layout

| Path | Contents |
|---|---|
| `packages/shared/src` | Code used by server and client: `contract.ts` (the unit contract), `config.ts` (zod schema + `DEFAULT_CONFIG`), `cost.ts` / `budget.ts` (prices, copy ramp), `bounds.ts` (stat checks), `buildings.ts`, `errors.ts` (validation codes and texts), `maps.ts`, `teams.ts`, `geometry.ts`, `sprite.ts`, `awards.ts`, `guide.ts`, `protocol.ts` (every REST/WS/MCP DTO, with a route reference at the top) |
| `packages/server/src` | `index.ts` (boot), `server.ts` / `http.ts` (Express app), `routes/` (`public`, `player`, `admin`), `mcp.ts`, `ws.ts`, `services/` (the service layer), `validator/`, `sandbox/`, `sim/`, `terminal/` (seat proxy), `util/` |
| `packages/client/src` | Vite + Preact multi-page app: `play/`, `screen/`, `admin/`, `setup/`, `guide/`, and `common/` (API and WS clients, Canvas 2D isometric renderer in `common/render/`, sounds, `view3d.ts`), and `observe/` (the 3D voxel view and the /observe replay page). Builds into `packages/server/dist/public` |
| `packages/starter-kit` | Seat kit templates: `CLAUDE.md.tmpl` (agent instructions), `FIRST_PROMPT.md.tmpl` (first message for a new player), `PROMPTS.md` (prompt ideas for players), `units/basic_*.js` (starter templates) |
| `sessions/` | AI session host: `Dockerfile`, `docker-compose.yml` (seat1-8), `entrypoint.sh` (kit rendering, agent loop, seat login, `check`, `new-player`), `set-env.sh` |
| `config/default.json` | All game tunables; mirrors `DEFAULT_CONFIG` |
| `scripts/` | `start.mjs` / `dev.mjs` launchers, `check-node.mjs`, `test-perf.mjs`, `bots.ts`, balance tools, `demo-replay.ts`, `codex-mcp-check.mjs` |
| `tests/` | Vitest suites; `helpers/` (test server, fake runner, balance tooling), `fixtures/`, `e2e/`, `load/loadtest.ts` |
| `docs/images/` | Screenshots used by the README |
| `data/` | Runtime state (gitignored) |

`@pixel-clash/shared` is consumed as built `dist/` by the server at runtime, and
from TS sources (`--conditions=source`, the vitest alias) in dev, tests and scripts.

## 3. Game flow

The match state machine lives in `services/match.ts` (transitions, timers,
countdowns) and `services/round.ts` (selection, zones, placement, Ready).

```
LOBBY ──Start match (2-8 players)──▶ PLAN ──timer / Next──▶ PLACEMENT
  ▲                                   ▲                         │ START (everyone Ready,
  │                                   │ Next (round < N)        │ or timer ran out) / Force start
  │                                RESULTS ◀── playback ends ── BATTLE
  │                                   │        (or Skip)
  └──── New match ── MATCH_RESULTS ◀──┘ Next (round = N)
```

| Phase | Timer (config `timers`) | What happens |
|---|---|---|
| LOBBY | none | Players join; the facilitator sets rounds (1-10), map style, team mode, team budgets, Open Armory, "Show enemy names to units", "Walls allowed" |
| PLAN | round 1: 900 s, later: 480 s | Agents submit units; players pick ≤ 4 unit types (soldiers) and ≤ 4 building types (towers, walls, factories) and press Ready |
| PLACEMENT | 180 s | Players place copies on their zone's 6×6 grid within the budget |
| BATTLE | 7200 ticks (120 s at 60 Hz) | The sim runs; playback is shown live everywhere |
| RESULTS | none | Ranking, points, per-unit reports; the facilitator presses Next |
| MATCH_RESULTS | none | Final standings and the awards ceremony on /screen |

- **Ready** is one flag per player, reset on every phase change. In PLAN it
  means "army picked" (needs a selection with at least one fighter:
  `NOTHING_SELECTED`, `NO_FIGHTERS`, `TOO_MANY_TYPES`); in PLACEMENT "army
  placed". It is cleared when the player's army changes. Only active players
  count; `allReady` needs at least one.
- **PLAN timer runs out:** straight to PLACEMENT whether or not anyone is
  Ready. Next always works too. With `timers.autoAdvanceWhenAllReady` (default
  off) PLAN also advances after a 3 s countdown once everyone is Ready.
- **Selection lock** (start of PLACEMENT): each selection resolves to each
  design's latest valid version. Auto-pick for an empty result: the previous
  round's selection if all of it is still valid, else the 3 most recent valid
  designs, else all starter templates (the Basic Wall only when walls are on);
  if no fighter is left, the first starter fighter is added. With walls off,
  walls are dropped at the lock.
- **PLACEMENT timer runs out:** placement closes (`PHASE_CLOSED` with
  `details.timeUp`), empty zones are auto-placed, and `timer.expired` is set.
  The battle never starts by itself; START now works without everyone Ready.
  Adding time reopens placement.
- **Auto-place** (`sim/autoPlace.ts`), at the PLACEMENT time-up and at START:
  a player with no fighter placed gets their last layout if still valid, else
  the locked types greedily, cheapest first, front cells first. Walls are
  never auto-placed.
- **Pending advance:** "Start placement" / "START battle" from /admin (or
  /screen with an admin cookie) runs a cancellable 3 s countdown everyone
  sees (`state.pendingAdvance`). Countdowns are in memory only.
- **BATTLE → RESULTS follows playback, not the sim.** The sim runs ahead, but
  nothing about the outcome (phase, ranking, points, reports, `battle:end`)
  is released until playback reaches the final frame, or the host presses
  Skip (results are then computed at the shown tick).
- **Joining late / kicks:** a player who joins in LOBBY or PLAN plays this
  round; joining later plays from the next round (team mode: anyone who joins
  after Start match is benched until New match). A kick during BATTLE takes
  effect after the battle; the kicked player is left out of the ranking.

## 4. Identity and auth

| What | How (code: `services/auth.ts`, `services/players.ts`, `services/claudeSeats.ts`) |
|---|---|
| Player | Name (1-16 chars, unique case-insensitively) + 4-digit PIN, stored as an scrypt hash. Max 8 players (game seat 0-7 = colour, badge, instance-id prefix) |
| Web session | `POST /api/players` or `/api/login` sets the httpOnly cookie `pc_session` |
| API key | One `pc_<24 base32>` key per player, for the agent: `Authorization: Bearer …` on REST/MCP, or the MCP tools' `apiKey` argument. MCP `login({name, pin})` returns it. Reset PIN keeps the key; Rotate key replaces it |
| Facilitator | `ADMIN_PASSWORD` env, or 3 generated words (persisted, printed at start). `POST /api/admin/login` sets `pc_admin`; admin routes take only that cookie |
| Seat password | One shared value for all ttyd seats (`setup.seatSecret`, 12-64 chars of `A-Za-z0-9._~-`), made up by the server on first start and shown in /admin → AI seats. On the AI session host it is `SEAT_SECRET` in `sessions/.env` (passed to ttyd as `TTYD_PASS`). Never in any player, screen or public payload |
| Seat login | When a seat's terminal opens for its assigned player, the proxy adds an opaque per-(seat, player) token to ttyd's WS URL; the seat's `agent-loop` calls `POST /api/seat-login {seat, token, agent}` with Basic auth `player:<seat password>` and writes `{name, apiKey}` to `/kit/.pixel-clash/player.json`, so the helper starts logged in |
| Shared agent login | /admin → AI seats → Agent login: a Claude Code token (`claude setup-token`), an Anthropic API key and/or an OpenAI API key. Write-only (only the last 4 characters come back), stored in `setup.agentCredentials`, handed out only by seat-login. Without it, each seat uses its own stored login (`make seat-login SEAT=n`) |
| Rate limits | `config.rateLimits`: login 5/min, validate 1/s, submit one per 3 s (`RATE_LIMITED` with `retryAfterMs`) |

## 5. The unit contract

A unit is one JS module (TS syntax tolerated) with a default-exported class.
The constructor sets plain data stats on `this`; the authoritative definition is
the block between `BEGIN CONTRACT` and `END CONTRACT` in
`packages/shared/src/contract.ts`. The same block appears verbatim in
`packages/starter-kit/CLAUDE.md.tmpl` (tests keep the copies identical) and is
served by `get_unit_contract` / `GET /api/contract`. The bounds and engine rules
an agent sees are in the kit's CLAUDE.md and `get_rules`.

- **Types:** `soldier` (moves and attacks), `tower` (attacks, never moves),
  `wall` (40×40 block, no code, never attacks), `factory` (builds minions).
  Minions (`grunt`, `archer`, `runner`, `brute`, `medic`) are engine-made
  bodies; they are never submitted.
- **`update(self, enemies, allies, world)`** runs once per tick per copy
  (soldiers, towers, factories) with fresh JSON copies of the views and returns
  one action: `idle`, `move`, `attack`, `heal`, or for factories `rally`,
  `command`, `release`, `hold`. The engine validates every action; anything
  invalid is an idle. Stats are snapshotted at validation; changing them in
  `update()` does nothing.
- **`updateMinion(self, enemies, allies, world)`** (factories, optional) runs
  for each of the factory's minions on the field; `self.minion.builtIn` is the
  action the built-in minion logic would take, and returning nothing uses it.
- **`sprite()`** (optional) returns pixel art; it is called once at
  validation, never in battle.
- Friend or foe is `teamId`: the owner's seat in free-for-all, the team index
  in team mode.

## 6. Cost and economy

Prices are computed in `packages/shared/src/cost.ts` (`computeCost`, with the
breakdown and the `UNIT_TOO_EXPENSIVE` levers); the copy ramp and layout totals
are in `budget.ts`. All coefficients are in `config.cost`.

- **Soldiers and towers:** base + a convex term per stat (`c·x·(1 + k·r²)`,
  `r` = the stat over its default max, `curveK` 1), times a cooldown factor
  (`max(1, 60 / attackCooldown)`), a power factor (`1 + powerFactor · HP/HPmax ·
  damage/damageMax`), a splash factor and an element factor (fire and lightning
  ×1.3, ice ×1.75). A heal term sits inside the cooldown factor; aura costs are
  added after every factor. The curve maxima are fixed to the default bounds.
- **Walls:** `20 + 0.0375·HP·(1 + (HP/12000)²)`.
- **Factories:** a body term on HP plus production: expected minions
  `E = min(maxMinionsPerFactory, floor((productionTicks − 1) / productionInterval))`
  times the minion's value (its soldier price × element, × `minionDiscount` 0.5).
- **Key defaults** (`config/default.json`): budget $10,000 per army (team mode
  can set a per-player budget per team), $3,000 max per unit, ≤ 12 fighter
  copies of which ≤ 5 factories, ≤ 16 walls, ≤ 8 saved designs per player (templates not counted), copy ramp
  (from the 4th copy of one design each copy costs 15% more per step; walls
  never ramp).
- **Re-pricing:** saving config in /admin re-prices every stored unit; a unit
  that no longer fits is marked invalid and dropped from selections.

## 7. Validation pipeline

`packages/server/src/validator/validate.ts` runs every check in a fresh
sandbox (isolated-vm in a child process, 32 MB) and returns a
`ValidationResult` whose errors carry a `code`, `message`, a `fix` written for
the agent, and a short player hint:

1. normalize (`normalize.ts`: size cap, line endings, extract a fenced code block)
2. transpile with esbuild (`transpile.ts`; TS tolerated, CJS out, source map kept)
3. reject `import` / `require`
4. evaluate: default export must be a class
5. construct twice, read own data properties
6. stat bounds (`shared/bounds.ts` `checkStats`, per type)
7. determinism: both constructions must match
8. cost and the unit cost cap; 8b sprite checks (`sprite.ts`)
9. dry run of `update()` (and `updateMinion()`) in three synthetic worlds (`dryrun.ts`)
10. non-fatal warnings (`W_*`)

`services/units.ts` stores what passes as a new version (source + compiled
CJS + stats snapshot + cost + sprite). Revisions carry `baseVersion`; a stale
one gets `UNIT_CHANGED` (the player may have edited the unit in /play's code
editor meanwhile).

## 8. Sandbox

- **Mode** `config.sandbox.mode`: `ivm` (default) or `inproc-unsafe`
  (node:vm, tests/dev only, refused at startup without `--unsafe`).
- **Battle:** one runner per player per battle (`sandbox/ivmRunner.ts`), each
  isolate in its own child process (`ivmChild.ts`) started with an empty env
  and `--no-node-snapshot`, so a V8 abort only kills the child. A borrowed
  Open Armory design gets its own isolate (`splitRunner.ts`).
- **Harness** (`harness.ts`): installed before player code; seeded
  `Math.random`, `Date` = sim time, no timers, network, WebAssembly or
  SharedArrayBuffer. Only JSON strings cross the boundary.
- **Deadlines and strikes** (`strikes.ts`, `config.sandbox.battle`): per-tick
  hard timeout 12 ms and soft 6 ms. A throw is a strike (30 disable the unit);
  a unit that causes 2 hard timeouts is disabled; 3 timeouts in a row or 5 in
  total disable the player; 30 slow ticks disable the slowest unit; a crash or
  OOM disables the player's units. Disabled units idle; a disabled factory
  keeps producing. The runner reports facts; the engine owns the policy.

## 9. Simulation

`packages/server/src/sim/engine.ts` is the headless battle engine; the battle
service (`services/battle.ts`) runs it, paces playback (1×/2×, pause) and
releases results.

- **Deterministic:** 60 ticks per second, a seeded PRNG (`sim/prng.ts`,
  separate streams for push directions, lightning and accuracy), fixed
  processing order (seat, then instanceId). Same inputs and seed → same battle.
  The engine never calls `Math.random` or reads the clock for game logic.
- **Tick order:** (1) lower cooldowns by each body's tempo, compute auras,
  build views; (2) run every player's code in parallel, apply in seat then
  instanceId order; (3) validate actions; (4) moves, routed round walls and
  buildings (`pathing.ts`, `steering.ts`); (5) separation; (6) fire attacks;
  (7) projectiles, hits, heals and burn pulses; (8) sudden-death damage;
  (9) remove the dead, then factory production; (10) elimination check.
  Frames are recorded every `sim.frameEveryTicks` ticks.
- **End:** when at most one side has fighters, or at `battleTicks`. Survivors
  rank by living army cost, the eliminated by elimination tick
  (`sim/ranking.ts`). Round points = place points + damage bonus + value
  bonus, plus badges (`sim/scoring.ts`); match awards in `services/awards.ts`.
- **Sudden death** (`suddenDeath.ts`): from tick 4500 a safe circle shrinks
  from radius 570 to 60 (scaled to the arena size); bodies outside lose 10%
  of max HP per second.
- **Elements and support** (`effects.ts`, `support.ts`): fire burns, ice slows
  (tempo ×0.65), lightning may zap a neighbour; shatter (fire on frozen),
  kindle and brittle synergies; splash; heal action and haste/might/shield
  auras. Ranged shots at moving bodies can miss (`config.accuracy`).
- **Factories and minions** (`factory.ts`, `minion.ts`): production every
  `productionInterval` ticks within alive caps, burst storage, squad orders
  (attack/defend/swarm/guard), optional `updateMinion()`. Host options:
  factories stop at / die at sudden death, minions die with their factory.
- **Maps and teams** (`shared/maps.ts`, `services/teams.ts`): map styles
  duel, triangle, corners, ring, lanes, islands; arena 800 / 1040 / 1200 px by
  player count; zones rotate each round; team modes `ffa`, `teams2-4`.

## 10. API surface

One service layer (`services/*`, composed in `services/game.ts`); REST and MCP
are thin adapters that return the same result and error objects. The full route
list with request and response types is the comment at the top of
`packages/shared/src/protocol.ts`.

- **REST `/api`:** public (`/health`, `/players`, `/login`, `/logout`,
  `/seat-login`, `/rules`, `/contract`, `/guide`, `/state`, `/join`, `/setup`,
  `/battles/:round/results|replay`); player (`/me`, `/units` validate/submit/
  list/get/delete, `/round/selection|placement|ready`, `/battles/:round/report`,
  `/claude-seats`, `/me/claude-seat`); admin (`/admin/...`: login, match and
  team setup, phase next/skip/advance, timer, start, battle playback, player
  kick/PIN/rotate-key/submit-on-behalf, sprite hiding, config, overview,
  metrics, setup, AI seats, agent credentials, projector commands, wipe).
- **Phase gates** (`PHASE_GATES` in `services/match.ts`): submit, delete and
  selection only in PLAN; placement only in PLACEMENT; Ready in PLAN and
  PLACEMENT; validate always. A closed gate is 409 `PHASE_CLOSED`.
- **WebSocket `/ws`:** the client sends `hello` with a role (`player`,
  `screen`, `admin`; the cookie decides what is granted). The server pushes
  `state`, `private`, `battle:reveal`, `battle:frames`, `battle:end`,
  `toast`, `kicked`, `screen`, `terminal`, `terminals`. Every payload is built
  per recipient by `services/visibility.ts`: nothing about other players'
  rosters, selections or placements is sent before the battle reveal, except
  to teammates in team mode. Unit source is never sent to other players.
- **MCP `/mcp`** (`mcp.ts`, stateless Streamable HTTP; never answers 401):
  `login`, `get_rules`, `get_unit_contract`, `validate_unit`, `submit_unit`,
  `list_my_units`, `get_unit_source`, `get_game_state`, `wait_for_phase`,
  `list_armory`, `get_battle_report`. `validate_unit` and `submit_unit`
  results end with the current phase; when submissions are closed the agent
  waits with `wait_for_phase` and submits when PLAN starts.

## 11. AI seats

- **Numbering:** AI seat N (1-8) = container `seatN` = host port `7780+N` =
  proxy path `/terminal/N/`. It is separate from the game seat (0-7).
- **Assignment** (`claudeSeats.autoAssign`): on join/login from /play the
  player keeps their own seat if it is on, else gets this laptop's last seat
  if free, else the lowest free seat. The facilitator can reassign, and turn
  seats on/off (a seat turned off moves its player to the lowest free seat).
  Kept across logout, Reset PIN and New match; freed by kick and wipe.
- **Terminal proxy** (`terminal/`): only the seat's assigned player (or the
  admin) can open `/terminal/N/`; the proxy injects the seat password, strips
  cookies and auth headers, answers ttyd's `token` request itself, keeps one
  live terminal per seat (newest wins), and probes each seat's status.
- **First prompt:** a seat opened for a new player starts a fresh
  conversation with `FIRST_PROMPT.md.tmpl` (load rules, contract and state,
  greet the player) and clears the previous player's key and chats; the same
  player resumes their conversation.
- **Kit:** `CLAUDE.md.tmpl` is the single source of the agent instructions:
  rendered as `CLAUDE.md` for Claude Code and as `AGENTS.md` (same text, title
  changed) for Codex, by `services/kit.ts` and identically by
  `sessions/entrypoint.sh` (`tests/kit-agents.test.ts` compares them).
- **Setup:** /admin shows a setup wizard until the seats work, with the
  command to run on the AI session host:
  `make seats PIXEL_CLASH_URL=http://<server-ip>:8080 SEAT_SECRET=<from /admin>`
  (writes `sessions/.env`, starts the seats). See sessions/README.md.

## 12. Client pages

| Page | Contents |
|---|---|
| `/play` | Join (name + PIN), the AI helper terminal pane beside the game (split view or tabs), My Units (roster, picks, cost), Ready, placement grid, live battle, results and per-unit reports, past battles and replays, unit guide overlay, in-browser code editor |
| `/observe` | A stored battle (`?round=N`, default the latest) in the 3D voxel view with orbit, follow and chase cameras, scrubbing and sound |
| `/screen` | Projector: arena canvas (3D by default, 2D optional), timers, join QR, ready ticks, reveal and battle, scoreboard, awards ceremony. With an admin cookie it can also START and control replays |
| `/admin` | Phase controls on top; tabs Match (setup in LOBBY), Players (kick, PIN reset, submit on behalf, details toggle), Game rules (config editor), AI seats (host address, seat password, agent login, per-seat status and on/off, open a terminal), Server (LAN URLs, QR, wipe) |
| `/setup` | Join URL and QR, LAN addresses, setup checklist |
| `/guide` | The unit guide, built from the live config (`GET /api/guide`, `services/guide.ts`) |

## 13. Config

- `DEFAULT_CONFIG` in `packages/shared/src/config.ts` (zod schema) and
  `config/default.json` must be identical (`tests/config.test.ts`). Change
  both together.
- The server loads `config/default.json` over the defaults, then applies the
  admin's patch from /admin → Game rules (stored as `configPatch` in
  `data/state.json`, cleared by Wipe).

## 14. Persistence

`services/store.ts`, under `DATA_DIR` (default `./data`):

- `state.json`: players (PIN hashes, keys, AI seat), match state, config
  patch, setup settings (AI session host, seat password, agent credentials,
  seats turned off). Debounced atomic writes, owner-only permissions. Setup
  settings survive a wipe.
- `units/<player>/<unit>@v<n>.js` plus the compiled CJS; starter templates are
  not stored but re-created per player at boot from `packages/starter-kit/units`.
- `armory/` (frozen Open Armory code), `replays/round-N.json`.

Other env vars: `PORT`, `HOST`, `ADMIN_PASSWORD`.

## 15. Testing and balance tooling

- `npx vitest run`: the main pass (everything except the timing and balance
  files). `npm test` = the main pass + `npm run test:perf`
  (`scripts/test-perf.mjs`): the wall-clock files (`integration`, `sandbox`,
  `buildings-perf`) one at a time, then the balance files. Timing tests can
  fail on a loaded machine; rerun them alone before suspecting a regression.
- `npm run typecheck`, `npm run build`.
- **Balance** (archetype armies in `tests/helpers/balance.ts`, rules in
  `balanceRules.ts`, e.g. no archetype above a 70% win rate):
  `npm run balance` (exact early stopping, same verdicts as the full matrix),
  `-- --fast` (statistical early stopping, far fewer battles), `-- --full`
  (every battle), `-- --config patch.json` (try a config patch). Explore with
  `--fast`, confirm with `--full`. `npm run balance:sweep -- --param <path>=a,b`
  compares values of one knob; `npm run balance:exploit` searches for overly
  strong legal armies. Results are cached in `.balance-cache/` keyed by engine
  version and the config fields a battle can read (`BALANCE_CACHE=0` turns it
  off).
- `npm run loadtest` drives a full 8-player match against a running server;
  `npm run bots -- --players n` adds bot players.

## 16. Conventions to keep

- **Determinism.** No `Math.random`, `Date.now` or iteration-order surprises
  in the sim; draw from the engine's PRNG streams and keep the seat/instanceId
  order. A change to engine behaviour changes replays and balance results.
- **No strategy hints** in anything players or agents read (`CLAUDE.md.tmpl`,
  `PROMPTS.md`, `FIRST_PROMPT.md.tmpl`, starter units, the guide, MCP
  instructions, `get_rules`, error hints): state facts and the attributes
  units can read; players discover tactics. `tests/no-strategy-hints.test.ts`
  guards it.
- **"Player", not "kid"**, in code, UI and docs.
- **One instructions source:** edit `CLAUDE.md.tmpl` (it becomes both
  CLAUDE.md and AGENTS.md); keep its contract block identical to
  `contract.ts`.
- **Starter unit layout:** at most a short comment, then the class with the
  constructor first and `sprite()` last (`tests/unit-layout.test.ts`); agents
  copy this layout.
- **Server-side privacy:** build every outgoing payload through
  `visibility.ts`; never filter on the client.
- **Same results for REST and MCP:** add behaviour to a service, then expose
  it from both adapters.
- **Node and isolated-vm:** Node 24 LTS or 22.13+ (isolated-vm ships
  prebuilt binaries only for those; `scripts/check-node.mjs` refuses others).
  Every process that loads isolated-vm needs `--no-node-snapshot` (the
  launchers and vitest's `execArgv` pass it). Don't copy `node_modules`
  between machines or Node versions: run `npm ci` there.

## 3D view

`observe/voxelView.ts` (three.js) draws the arena in 3D: each sprite pixel becomes a cube,
elemental shots, auras, heals, splash, lightning and sudden death come from the same frame
data and events as the 2D view. It is a second renderer for `ArenaRenderer`, not a second
client: the arena runs headless (`headless` option: all state and events, no 2D drawing) and
the view reads its `currentSample`, instances, zones and event stream every frame (`onStep`),
so live battles, replays, the reveal and seeking all work with no server change.
`common/view3d.ts` attaches it to an arena on /screen and /play: three.js loads on first use
(its own chunk), 3D is the default, the choice is remembered per device, `?view=2d|3d`
overrides it for one visit, and a failure to start (no WebGL) leaves the 2D view.
