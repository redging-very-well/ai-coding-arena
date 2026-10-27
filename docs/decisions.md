# Pixel Clash decisions

The decisions behind the current design, one line each: what was decided and why.
Superseded decisions are folded into the one that stands. Numbers are the
defaults in `config/default.json`; the host can change most of them in /admin.
How the system works is in [architecture.md](architecture.md).

## Audience and player-facing text

- Players are about 9-13 and design units by **prompting an AI helper**; the in-browser code editor is an optional extra (2026-10-23).
- **No strategy hints** (2026-10-24). User: "I want players to discover strategies like this themselves. What is okay is for players to see the various runtime attributes their units can see." CLAUDE.md/AGENTS.md, PROMPTS.md, starter units, /guide, `get_rules`, MCP instructions and error hints state facts, numbers and every readable attribute; never what to build or what beats what. Guarded by `tests/no-strategy-hints.test.ts`.
- **"Player", never "kid"**, in UI, docs and code.
- The machine running the seats is the **"AI session host"** (2026-10-26; user: "Rename \"Claude box\" to AI session host"); players see "AI helper" / "AI seat N" because a seat can run Claude Code or Codex.
- Error texts are written for the AI helper first (a concrete `fix`), with a short player hint.

## Game flow and timers

- Rounds: LOBBY → PLAN (the only submit window) → PLACEMENT → BATTLE → RESULTS, × N (default 3), then MATCH_RESULTS and the awards ceremony.
- PLAN 15 min in round 1, 8 min later; PLACEMENT 3 min; battle 120 s (7,200 ticks at 60 Hz) (2026-10-24: longer fights for mixed armies).
- **Timer up = phase over** (2026-10-26; "planning should stop once the timer is done"): PLAN moves straight to PLACEMENT; at the PLACEMENT time-up placement closes, empty zones are auto-placed and START works without everyone Ready.
- **The battle never starts by itself**: START is the facilitator's show moment. A paused timer never runs out; adding time reopens placement.
- Ready is one flag per phase ("army picked" / "army placed"), cleared when the army changes; it never blocks Next. Auto-advance when all are Ready is an option, off by default.
- Host countdowns (3 s, cancellable) for "Start placement" and "START battle", from /admin or /screen with an admin session.
- Results are released only when playback reaches the last frame (or Skip, which ranks at the shown tick), so nobody sees the outcome early.
- Empty selections are auto-picked at the lock (previous round, then the 3 newest valid designs, then the starter templates incl. the Basic Factory and, with walls on, the Basic Wall) (2026-10-26; user: "please auto pick factories if nothing is picked").
- A kick during BATTLE takes effect after the battle.

## Scoring and awards

- Round points = place points (P − 1 … 0) + damage bonus (0-2) + value-destroyed bonus (0-1), bonus maxima scaled × P/4: reward damage as well as survival.
- Timeout ranking by living army value; walls count $0 and spent factories only their body, so turtling with buildings can't win.
- Badges and 15 match awards are titles only, no points; ties share (2026-10-24).
- Top damage units per round and Past battles with replays on /play (2026-10-23).

## Economy and balance

- **$10,000 per army, ≤ $3,000 per unit** (2026-10-24): a single unit stays ≤ 30% of an army; at $3,500+ two maxed bricks beat everything.
- **≤ 12 fighters** (soldiers, towers, factories) of which ≤ 5 factories, plus ≤ 16 walls; ≤ 4 unit types + ≤ 4 building types per round; ≤ 8 saved designs.
- **Copy ramp**: from the 4th copy of one design each copy costs 15% more per step; walls exempt. Without it padded one-design armies won 78-84%.
- Convex stat curve with **k = 1** (a maxed stat costs 2×) plus a **power factor** (q = 2) for units that are tough and strong at once (2026-10-23: "don't penalise extremes so heavily").
- Scale: HP 80-4,000, damage 0-240 (twice the time-to-kill of the previous game; readable damage numbers).
- **Soldier range ≤ 160**, towers ≤ 300 ("make it a tower"): mobile long-range splash soldiers dominated at any price.
- Element prices fire and lightning ×1.3, **ice ×1.75** (it drives two combos); splash factor 0.8; speed priced 90 (fast runners dominated at 66).
- Sudden death from 75 s at **10% max HP/s**: at 7%/s the turtle won every Ring 8 free-for-all.
- Balance gate: in the 48-archetype round robin no archetype wins more than 70% (recorded exceptions only). Explore with `npm run balance -- --fast`, confirm with `--full`.
- The "tanks in front, fragile hitter behind" family stays as healthy mixed play; backline-diver bots were added to the pool instead of a price change (user: "Accept it as healthy + add backline divers").
- `balance:exploit` builds above 70% are a pre-event watch list, not a failure.
- Stored units are never migrated or deleted automatically; the facilitator wipes data (user: "Don't silently wipe units on server restart").
- An admin config change re-prices every unit at once; units that no longer fit become invalid.

## Units, elements and support

- Four types: soldier, tower, wall, factory (2026-10-23); minions are engine-made, never submitted.
- Stats are snapshotted at validation; `sprite()` runs once at validation; size 6-20 is hitbox and drawn size.
- One element per unit: fire burns (+50% over 3 s), ice slows 35% for 2 s, lightning zaps a neighbour (35%). Combos: shatter ×1.4, overload +2 hops, kindle and brittle +25% (2026-10-24: stronger synergies).
- Optional splash (≤ 80 px, 50% damage); one support per unit: `heal` (an action sharing the attack cooldown, limited heal room per second) or haste/might/shield auras.
- Damage-0 units and medic-only factories are not fighters: a side needs something that attacks.
- Ranged shots at fast movers can miss (up to 20%); melee never misses ("Keep it, but tune against scouts").
- Units route round walls and buildings automatically; a walled-off unit heads for the cheapest wall to break (2026-10-23/24: "Buildings should be treated like walls").
- Walls block everyone (own units too) and are optional per match.

## Factories and minions

- Factories make minions (grunt, archer, runner, brute, medic), give squad orders (attack, defend, swarm, guard) and can store a burst of 1-4 (2026-10-23); burst is free (it costs time and risk).
- **Brittle factories**: HP 120-1,200 at unchanged prices (2026-10-25; user: "it should be really easy to destroy them to prevent players from just building a factory and camping by it").
- Factory price = body + expected minions × half a minion's price (they arrive during the battle).
- Alive caps: 4 per factory, 12 per player, 40 per battle.
- **Optional `updateMinion()`** lets a factory steer each of its minions; returning nothing uses the built-in logic; bad minion code switches only the minion code off (2026-10-26; "players should be allowed to change the behaviour of factory generated units"). Control only, no price change.
- **Factory sudden-death options all exist but are off by default**: "factories stop at sudden death", "minions die with their factory" (crumble radius 120 px) and "factories die at sudden death" each broke balance rules when on (user on the last one: "turn it off by default") (2026-10-25).

## Match settings

- 2-8 players; the map follows the player count (Duel, Triangle, Corners, Ring; Lanes and Islands for teams) and the host can override it. Arena 800 / 1040 / 1200 px; zones are 6×6 cells and rotate each round.
- Teams optional (2-4 teams), snake auto-balance, host can swap and move players; unequal teams allowed (2026-10-26); teams are fixed for the match and late joiners are benched.
- Per-team budgets for uneven teams (2026-10-26; "we need to be able to set per-team spend too").
- Teammates see each other's picks, zones and placements live; opponents and the projector see nothing until START; source code is never shared.
- Open Armory (off by default): fielded designs become borrowable, frozen, run in their own isolate.
- "Show enemy names to units" (off by default) and "Walls allowed" (on by default; 2026-10-25: "So I can disable walls for a match") are fixed per match.

## Sandbox and determinism

- Player code runs only on the server, in isolated-vm, one isolate per player per battle in its own child process (no secrets in its env, a V8 abort kills only the child).
- Per-tick deadlines; a throw idles the unit; repeated strikes disable it with a friendly "taking a nap" message; one stall is forgiven.
- The sim is deterministic: seeded PRNG streams, fixed order, `Math.random` and `Date` replaced in the sandbox, so battles replay exactly and balance results are reproducible.

## AI seats and helpers

- Player laptops need only a browser: the AI helper is a ttyd terminal on the AI session host, shown inside /play through the game server's same-origin proxy (2026-10-23).
- One Docker container per seat: the container is the security boundary.
- One shared seat password, made up by the game server and shown in /admin; the proxy injects it, so players never see it (2026-10-26: no required `sessions/.env` settings).
- AI seats are auto-assigned on join (own seat → this laptop's last seat → lowest free) and the helper starts logged in as the player via seat login (2026-10-26; "it should auto pick a seat and auto login"). No seat cards and no kit download.
- Seats can be turned on/off in /admin; turning off a held seat moves its player.
- One shared agent login pasted in /admin (Claude Code token, Anthropic or OpenAI key), write-only, handed only to the seats (2026-10-26).
- A new player on a seat gets a fresh conversation started by FIRST_PROMPT.md and the previous player's key and chats are cleared; the same player resumes (2026-10-25).
- Codex is supported per seat (2026-10-24), over MCP by URL; one instructions source (`CLAUDE.md.tmpl` → CLAUDE.md / AGENTS.md).
- MCP is stateless (a server restart is invisible to the agents); the player's key is saved in the seat's kit folder.
- **Helpers check the phase themselves** (2026-10-26; "Right now, I need to tell them the game is in plan mode"): validate/submit results end with the current phase, and the helper waits with `wait_for_phase` (≤ 50 s per call, under the clients' 60 s tool timeout) and submits when PLAN starts.

## Admin and projector

- /admin: phase controls always on top; tabs Match, Players, Game rules, AI seats, Server. Details such as rosters and the seat password are behind a toggle because the page may be on the projector.
- A "Set up AI seats" wizard until the seats work, with a ready-to-copy `make seats …` command (2026-10-26).
- The facilitator can submit or validate on a player's behalf (the fallback when a helper is down) and hide any sprite.
- /screen shows the battle and results; an admin session there can START and control replays.
- The battle has an optional 3D voxel (three.js) view on /screen and /play, the default view (2026-10-27). It is another renderer for the same arena: the sim, protocol and server are unchanged. The choice is per device (the 3D/2D button, D on /screen, `?view=2d|3d`) and a browser without WebGL stays on 2D.
- In 3D, click a unit to follow it: V cycles orbit / follow / chase, N (or Tab on /screen) picks the next unit, Esc lets go. On /screen the keys work anywhere on the page; on /play only while the 3D canvas has focus (a click), so typing in the code editor is never touched (2026-10-27).
- On /screen during BATTLE the arena fills the stage and the army values are a small overlay in its corner; there is no side column (2026-10-27).

## Ops and repo

- LAN only: the game server binds 0.0.0.0:8080 and needs no internet; bring your own router. Run it on the host OS, not in a dev container.
- Node 24 LTS (or 22.13+) for isolated-vm prebuilt binaries.
- Bots exist only for rehearsals and load tests.
- `config/default.json` mirrors `DEFAULT_CONFIG`; a test keeps them equal.
- After the event: wipe the game server and the seat volumes, and revoke the event account's tokens and keys (any seat can read its own login).
