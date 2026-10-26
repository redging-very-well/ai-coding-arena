# Pixel Clash

A LAN auto-battler for 2-8 players, built for a Kids Coding Day. Players design
their own units (soldiers, towers, walls, factories) by **prompting an AI helper**
(Claude Code, or the OpenAI Codex CLI) in their browser. The helper writes the
unit's JavaScript and submits it to the game server, which checks it, prices it
and runs it in a sandbox. Players pick and place their army, and the battle
plays on the projector. Players only describe what they want; they never write
or paste code by hand.

## How a round plays

A match is several rounds (free-for-all or teams, on a map that fits the player
count). Each round goes through four phases, run by a facilitator from /admin:

1. **PLAN**: players talk to their AI helper to design new units or improve old
   ones, then pick which unit and building types to field and press "I'm ready!".
2. **PLACEMENT**: each player places copies of their picks in their zone of the
   arena, within a budget.
3. **BATTLE**: the units fight on their own, running the code the AI helper
   wrote. The battle is shown live on the projector (/screen) and on each /play.
4. **RESULTS**: ranking, points and a per-unit report (including errors to hand
   back to the AI helper). Then the next PLAN starts.

After the last round comes an awards ceremony on the projector.

## Architecture at a glance

```
  Player laptops (2-8, browser only)          Projector / facilitator
  ┌──────────────────────────────┐            ┌──────────────────────┐
  │ /play: game + AI helper pane │            │ /screen     /admin   │
  └──────────────┬───────────────┘            └──────────┬───────────┘
                 │  HTTP + WebSocket (LAN)               │
                 ▼                                       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Game server (facilitator's laptop, Node, 0.0.0.0:8080)          │
  │ web pages, REST /api, MCP /mcp, WebSocket /ws, battle sim,      │
  │ isolated-vm sandbox, data/ on disk,                             │
  │ seat proxy /terminal/N/ (adds the seat password itself)         │
  └──────────────┬──────────────────────────────────▲──────────────┘
                 │ terminal traffic (ttyd, :778N)    │ MCP tools (submit_unit, ...)
                 ▼                                   │
  ┌─────────────────────────────────────────────────────────────────┐
  │ AI session host (Docker): one container per seat 1-8                 │
  │ ttyd -> Claude Code or Codex in that seat's kit folder /kit     │
  └──────────────┬──────────────────────────────────────────────────┘
                 ▼ internet
          Anthropic / OpenAI API
```

- Player laptops only need a browser and the LAN. The AI helper's terminal is
  shown inside /play through the game server's proxy, so players never see a
  seat password.
- The game server needs no internet. Only the AI session host does.
- The server, the AI session host and the player laptops are usually separate
  machines on a router you bring. For a try-out everything can run on one.

The full design is in [plan.md](plan.md) (§2 architecture, §3 game flow).

## Repo layout

| Path | What it is |
|---|---|
| `packages/shared/` | Types, config schema, unit cost formula, maps and teams, shared by server and client |
| `packages/server/` | Game server: Express, REST + MCP + WebSocket, validator, sandbox (isolated-vm), battle sim, seat proxy |
| `packages/client/` | Web pages (Vite + Preact, Canvas 2D arena): `play`, `screen`, `admin`, `setup`, `guide` |
| `packages/starter-kit/` | Templates for each seat's kit folder: the AI helper's instructions, MCP config, starter units, first prompt |
| `sessions/` | The AI session host: Dockerfile, `docker-compose.yml` (seats 1-8), `entrypoint.sh` |
| `config/default.json` | All game tunables (costs, caps, budget, timers, points); also editable live in /admin |
| `scripts/` | Dev/start launchers, bots, balance tools |
| `tests/` | Vitest suites, fixtures, load test |
| `docs/` | Balance, load, visual QA and dry-run notes |
| `data/` | Runtime state (gitignored): players, units, replays |

## Prerequisites

- **Game server:** Node **24 LTS** (22.13+ also works; other versions are
  refused by `engines` and a preflight check, e.g. Node 26 has no isolated-vm build). A C++ toolchain (Xcode
  Command Line Tools / VS Build Tools) is good insurance for isolated-vm. Run it
  on the host OS, not in a dev container (its ports only forward to localhost).
- **AI session host:** Docker with Compose v2 and BuildKit. About 1 core and 2 GB RAM
  per seat (8 cores / 16 GB for all 8). Internet access, plus a Claude account
  for the event (and/or an OpenAI login for Codex seats).
- **Player laptops:** a browser.
- `make` (GNU make 3.81+, as shipped with macOS) for the shortcuts below. Every
  target is a thin wrapper, so the npm or `docker compose` command works too.

Run `make` to list every target.

## Quick start: try it on one machine

```sh
make install        # npm ci
make build
make start          # prints the LAN URLs, a /play QR and the admin password
```

Open `http://localhost:8080/admin` (password from the start output, or set
`ADMIN_PASSWORD`), `/screen` in another window and `/play` in a third. Without
the AI session host, /play still works (join, pick, place, battle) with the starter
units and the built-in code editor; `make bots PLAYERS=3` adds bot players so
you can start a match alone.

To add AI seats on the same machine, follow the event-day steps below with
`PIXEL_CLASH_URL` set to the machine's **LAN IP** (containers can't reach the
server through `localhost`) and the AI session host address `127.0.0.1` in /admin.

For development, `make dev` runs the server under `tsx watch` with the Vite dev
server (hot reload).

## Event-day setup (two machines)

Full details, sizing, firewall rules and troubleshooting:
[sessions/README.md](sessions/README.md) and [plan.md §15](plan.md).

**Game server laptop:**

```sh
make install && make build
make start          # note the LAN URL and the admin password
```

Allow Node through the OS firewall (TCP 8080) and turn off sleep.

**AI session host (the day before):**

```sh
# Copy the command from the game server's /admin -> AI seats -> AI session host setup:
make seats PIXEL_CLASH_URL=http://<game-server-LAN-IP>:8080 SEAT_SECRET=<from /admin>
#   writes both into sessions/.env and starts all 8 seats (add N=4 for seats 1-4);
#   later runs need only: make seats
make seats-ps                 # all "running (healthy)" after ~30 s
# Optional: only if you did NOT paste a shared agent login into
# /admin -> AI seats -> Agent login. Logs one seat in by hand:
# make seat-login SEAT=1      # /login with the event account, trust /kit, /exit
#                             # repeat per seat (Codex: make seat-login-codex SEAT=n)
# make seats-restart          # then restart so every terminal starts logged in
make seat-check SEAT=1        # versions, login, game server + API reachable
```

**Connect them:** in /admin → AI seats enter the AI session host's address (IP only).
The seat password is already shared (the game server made it up and the setup
command carried it). Every running seat should turn green.

**Seat cards:** print one per laptop from **/setup** (seat number + `/play?seat=N`
QR). Players scan it, join with a name and a 4-digit PIN, and their AI helper is
ready and already logged in as them.

**During the event:** `make new-player SEAT=n` clears a seat for a different
player; `make seats-restart SEAT=n` unsticks a terminal; `make seats-logs SEAT=n`
shows what a seat is doing.

**After the event:** `make wipe` on the game server (or Wipe in /admin) and
`make seats-wipe` on the AI session host (deletes all seat volumes, including the
logins). Then sign the event account out of all sessions (and revoke any OpenAI
key): any seat could read its own login.

## Pages and who uses them

| Page | Who | What |
|---|---|---|
| `/play` | Players | Join, the AI helper terminal side by side with the game: roster, picks, placement, live battle, results, unit guide, code editor |
| `/screen` | Projector | Arena, timers, join QR, ready ticks, battles, scoreboard, awards ceremony |
| `/admin` | Facilitator | Run the match and manage players and AI seats (password protected) |
| `/setup` | Facilitator | LAN URLs, join QR, printable seat cards (`/play?seat=N`), kit download |
| `/guide` | Anyone | The unit guide: the rules for units, built from the live config |

## Admin features (brief)

- **Match setup:** rounds, map style (with a preview), team mode, per-team
  budgets, drag players between teams, and options such as Open Armory, showing
  enemy names to units and whether walls are allowed.
- **Phase controls:** Next, Skip, START / Force start, pause, 1x/2x, timer
  changes, replay, New match.
- **Players:** kick, reset PIN, validate or submit a unit on a player's behalf
  (the fallback when the AI helper is down).
- **AI seats:** AI session host address and seat password, live status per seat,
  turn seats on/off, reassign players, open a seat's terminal to help out.
- **Config editor** for costs, caps, budget, timers and points (units are
  re-priced on save), server info with LAN URLs and QR codes, and Wipe.

See [plan.md §12.3](plan.md) for the full list.

## Testing and balance tooling

| Command | Does |
|---|---|
| `make test` (`npm test`) | Vitest suites plus a performance check |
| `make typecheck` | TypeScript checks for all packages |
| `make balance` (`npm run balance`) | Fast round-robin balance report; `ARGS="--config patch.json"` to try a config change |
| `npm run balance:exploit` | Search for overly strong legal armies (pre-event check after a retune) |
| `npm run balance:sweep` | Compare several values of one config setting |
| `npm run loadtest` | Drive a full 8-player match against a running server |
| `make bots PLAYERS=n` | Fake players for rehearsals |

Notes and results: [docs/balance.md](docs/balance.md),
[docs/load.md](docs/load.md), [docs/visual-qa.md](docs/visual-qa.md),
[docs/dryrun-report.md](docs/dryrun-report.md), and [plan.md §14](plan.md)
(tests and the dress-rehearsal checklist).

## More reading

- [plan.md](plan.md): the full spec (unit contract §5, economy §6, sandbox §8,
  simulation §9, API and MCP §10, starter kit and AI session host §11, UI §12,
  ops and event day §15, decisions log §17).
- [sessions/README.md](sessions/README.md): the AI session host in depth.
- [docs/](docs/): balance, load and QA reports.
