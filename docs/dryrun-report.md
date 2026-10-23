# Real-Claude dry run (M4, plan §14)

Date: 2026-10-21. Claude Code 2.1.304 (headless `claude -p`, default model, logged in with a claude.ai account). Server: the production build (`node scripts/start.mjs`, `PORT=18431 HOST=127.0.0.1`, temp `DATA_DIR`, `ADMIN_PASSWORD` set), 8 players created over REST, match started from admin (8-player FFA), PLAN timer paused.

Each scenario used a **fresh copy of the generic kit** (`GET /api/setup/kit.zip` with `Host: 127.0.0.1:18431`), unzipped outside the repo so the repo's CLAUDE.md wasn't loaded, and ran

```sh
cd pixel-clash-kit
claude -p "<what the player says>" --output-format stream-json --verbose --settings .claude/settings.json
# 2-turn exchanges: the same, plus --resume <session_id>
```

No `--dangerously-skip-permissions`, no `--permission-mode`, no `--mcp-config`. 23 runs in total, about $11.40.

## Results

"Validates" = `validate_unit` calls before the first successful `submit_unit` (target ≤ 3). "Calls" = all tool calls in that turn, including ToolSearch, file reads and writes and login.

| # | Player says | Calls | Validates | Outcome | Notes |
|---|---|---|---|---|---|
| s00 | "I'm Hana, PIN 1234. Make me a bouncy frog soldier and send it right now!" (LOBBY) | 9 | 1 | Validated, **no submit attempted** | It saw `submissionsOpen: false` and said "It's ready! When the Plan phase starts, tell me". Sprite ✓ |
| s00 t2 | "The Plan phase started! Send my frog" (`--resume`) | 2 | 0 (validated in t1) | Submitted $120 | `get_game_state` then `submit_unit` |
| s01 | PROMPTS: fast green ninja | 9 | 1 | Submitted $132 | Sprite ✓. 1 **denied Bash** (`python3` to JSON-check the file): fixed, see below |
| s01b | same prompt, re-run after tuning | 8 | 1 | Submitted $139 | No denials |
| s02 | PROMPTS: far, slow purple tower | 9 | 1 | Submitted $280 (cd 90) | `W_SLOW_NO_DISCOUNT` + `W_STAT_NEAR_MAX` warnings: kept "slowly" as asked and offered cd 60 to the player. 1 denied python3 Bash |
| s03 | PROMPTS: soldiers wait near my towers | 11 | 1 | Submitted $112 | 1 denied python3 Bash |
| s03b | same prompt, re-run after tuning (another player) | 10 | 1 | Submitted $128 | Revised the player's existing Bouncy Frog, passing `unitId` (from `get_unit_source`, since there was no local file). No denials |
| s04 | PROMPTS: healer… can units heal? | 11 | 1 | Submitted $199 "Guardian" | Said there's no healing and built a bodyguard. The answer was too long and technical ("each tick", "allies"). 1 denied python3 Bash |
| s04b | same prompt, re-run after tuning | 9 | 1 | Submitted $175 "Bodyguard" | Short, simple answer. No denials |
| s05 | PROMPTS: give my tower a wizard hat and a glowing crystal | 11 | 1 | Submitted $198 "Wizard Tower" | Correctly made a NEW unit (templates are protected), no `unitId`. 1 denied python3 Bash |
| s06 | "Make a tiny robot that's hard to block" | 12 | 1 | Submitted $120 (size 6) | 1 denied python3/awk Bash |
| s06b | same prompt, re-run after tuning | 9 | 1 | Submitted $129 | Same name in a fresh folder: the server revised `zip-bot` by slug (v2), as specified. No denials |
| s07 | "Draw my ninja with a red headband and make it bigger" (`--resume` s01) | 6 | 1 | Submitted v2 $136 | **Passed `unitId: "ninja"`** on validate and submit. Size 8→12 |
| s08 | "My unit costs too much. Make it cheaper but still strong" (`--resume` s02) | 4 | 1 | Submitted v2 $225 (was $280) | **Passed `unitId: "sky-sniper"`**. Lowered range 260→200 and set cooldown 90→60 (from the warning) |
| s09 | "Strongest unit EVER! Max everything" | 9 | 1 | Submitted $483 | It priced the unit under $500 itself from CLAUDE.md §5 and explained the cap kindly |
| s10 | "Really detailed 32×32 dragon with walk and fire animations" | 9 | 1 | Submitted $172, grid 32 | All 32-wide rows right first time |
| s11 | "The game says my Golden Blaster is broken" (after an admin retune pushed it to $531, status invalid) | 11 | 1 | Submitted v2 $500 | `list_my_units` → applied the `UNIT_TOO_EXPENSIVE` fix exactly (maxHealth 380→350) → `unitId` passed |
| s12 | "Why did my units stand still last battle? Fix them. And send it in!" (RESULTS) | 13 | 1 | Fixed + validated, not submitted | `get_battle_report` (TypeError on line 18, disabled) → `get_unit_source` → fix → validate. Explained that submit is closed until Plan |
| s12 t2 | "no please try sending it anyway right now" | 2 | 0 | `PHASE_CLOSED` | Friendly: "I tried, but the game said no… only takes new units in the Plan phase… tell me and I'll send it" |
| s12 t3 | "ok the plan phase started now! send it" (round 2 PLAN) | 2 | 0 | Submitted v2 $106 | `unitId: "marcher"` |
| s13 | "My name is Gus, PIN 1234. Are you connected?" | 5 | 0 | Logged in, game state read | Phase, time, place and badge in 4 lines |

Every scenario reached a valid submit (or the right "not yet") in **≤ 1 validate attempt**. Every new unit had a `sprite()`. Claude never asked the player to type, paste or edit code, or to run a command. With CLAUDE.md as it is now, there were **no permission denials**.

## Settings and flags that work (M0(b) "freeze the settings syntax")

The kit's `.claude/settings.json` is unchanged and confirmed:

- `"enableAllProjectMcpServers": true` + `"enabledMcpjsonServers": ["pixel-clash"]` connect the `.mcp.json` server with no approval prompt (stream-json `init`: `pixel-clash` `connected`, source `project`, 10 tools; they are deferred and loaded through ToolSearch).
- `"mcp__pixel-clash"` (the bare server name) approves **every** tool of that server, so no per-tool or `__*` entries are needed.
- `"Edit(./units/**)"` and `"Edit(./.pixel-clash/**)"` also cover the **Write** tool (Claude creates `units/<name>.js` and `.pixel-clash/player.json` with Write). Read-only Bash like `ls` and `cat` is auto-allowed.
- **The allowlist is ignored until the folder is trusted.** The first run, in an untrusted folder, denied `login` and `Write`. stderr said: `Ignoring 7 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.` This applies to `-p` too. The MCP server still connected. On the Claude box this is the one-time adult trust step (§11.1, sessions/README step 2), and it is **required**. For a headless or untrusted copy, the minimal flag is `--settings .claude/settings.json`. That is what this dry run used, because it was not allowed to edit the user's `~/.claude/.claude.json` trust list.
- `--permission-mode acceptEdits` is not needed.

## Changes made

- `packages/starter-kit/CLAUDE.md.tmpl`
  - §3 Workflow: **"Don't check the file yourself with commands"** (no python/node/awk/wc). `validate_unit` checks everything, including sprite rows, and any command that isn't pre-approved pops up a permission question on the player's screen. Before this, 6 of 7 first-round runs tried `python3 -c "json.dumps(open(...))"` or awk to count sprite rows. That was denied headless, and would be a prompt in a seat. After the change: 0 of 12 runs.
  - §1: keep answers to the player to about 4-6 short lines, without code words. The healer answer was a long technical essay before the change and a short one after.
  - The §5 contract block is unchanged (`starterkit.test.ts`).
- `packages/server/src/mcp.ts` `MCP_INSTRUCTIONS`: the validate line now also says that `validate_unit` checks everything (sprite rows included), so Claude should never run scripts or shell commands to check a unit file.
- `packages/starter-kit/PROMPTS.md`: a "Remember" tip: if Claude says it can't send yet, tell it "The Plan phase started!". Claude isn't told when PLAN opens, and in s00 and s12 the player had to say it.
- `plan.md` §11: the settings block is marked as frozen, with the verified semantics and the trust requirement.
- `sessions/README.md` troubleshooting: a new row, "Claude asks for permission to use the pixel-clash tools or to write `units/…`" → the folder isn't trusted.

The dry run itself changed no fix texts in `packages/shared/src/errors.ts`: no scenario hit a validation error on its own. The player-hint rewrites in `errors.ts` and `packages/server/src/mcp.ts` (M7 polish: `PLAYER_HINTS`, the number-bearing hints from `playerHintForIssue`, `SUCCESS_PLAYER_HINT`, `playerHintForService`) came later and were **not** exercised in these runs. The one fix text that was exercised (`UNIT_TOO_EXPENSIVE` after a retune, s11) was applied word for word.

## Remaining issues

- **Fix texts got little real-Claude coverage.** Claude computes costs from CLAUDE.md §5 and gets sprite rows right first time, so `SPRITE_BAD_FRAME`, `STAT_OUT_OF_RANGE` and the cooldown-factor branch of `UNIT_TOO_EXPENSIVE` never fired. They are covered by unit tests only.
- **The `UNIT_TOO_EXPENSIVE` fix aims at exactly the cap** (s11 ended at $500.00). The next small upward retune makes the unit invalid again. A suggestion with some headroom (for example ≤ $490) would be kinder. Not changed, because the existing tests pin the suggested values.
- **First-call noise:** the generic zip has no `.pixel-clash/` folder, so the first `Read .pixel-clash/player.json` or `ls` returns an error. It's harmless (Claude then logs in), but it shows as an error in the transcript.
- **"Plan started" is player-driven:** Claude can't know when PLAN opens. The PROMPTS.md tip covers it, and a facilitator announcement on the projector would help.
- **Not run in a real seat container (ttyd + trust dialog).** This run emulated the trusted state with `--settings`. The M8 dress rehearsal should confirm that a trusted seat shows no prompt for the first `login` and `Write`.
- **The user's claude.ai connectors** (Gmail, Drive and others) appeared as pending MCP servers in some runs. A seat's fresh event account won't have them, but if the event account has connectors, disconnect them from that account (they add noise and tool choices the player's Claude should never use).

## Walls and factories (M8.5)

Date: 2026-10-23. Claude Code 2.1.304, the same setup as above:
- **Server:** the production build on :18140, with players Cara, Dev, Eli and Fay created over REST
  (PIN 1234) and the match in PLAN with the timer paused.
- **Kit:** a fresh copy of the generic kit (`GET /api/setup/kit.zip`, `Host: 127.0.0.1:18140`)
  per player, unzipped outside the repo.
- **Command:** `claude -p "<prompt>" --output-format stream-json --verbose --settings
  .claude/settings.json`.

5 runs, about $2.84.

| # | Player says | Calls | Validates | Outcome | Notes |
|---|---|---|---|---|---|
| w1 | "I'm Cara, PIN 1234. Build me a strong wall to protect my towers" | 11 | 1 | Submitted "Castle Wall" wall, 1000 HP, $118 | Read `basic_wall.js` first. 16×16 stone-and-iron sprite. Told the player to put it in front of the towers ("their shots fly right over it") and to leave a gap for their own fighters. No warnings |
| w2 | "I'm Dev, PIN 1234. Make a factory that sends minions to the middle" | 12 | 1 | Submitted "Middle Maker" factory, 300 HP, interval 900, $193 | `update()` returns `{ action: 'rally', destination: world.center }`. Blue workshop sprite with chimney smoke and a door that lights up (2 idle smoke frames + a door-lit `attack` frame, as in the template). Explained "a minion every 15 seconds, up to 5 in each battle" |
| w3 | "I'm Eli, PIN 1234. Make me a cheap wall and a fast soldier" | 14 | 1 + 1 | Submitted "Plank Wall" (200 HP, $17) and "Speedy Runner" (speed 3.5, $138) | Two units, each validated once. The runner is wall-aware: it skips `type === 'wall'` targets and smashes the wall in `self.blockedBy` after 120 blocked ticks, like the template |
| w4 | "I'm Fay, PIN 1234. Make the biggest, toughest factory EVER that makes minions super super fast! Max everything!" | 14 | 1 | Submitted "Mega Factory", 870 HP, interval 600 (8 minions), $497 | It priced the unit under $500 from CLAUDE.md before validating, and told the kid kindly: "Maxing everything would cost $594, and no unit can cost more than $500". Purple fortress sprite with two chimneys |
| w5 | "My runners might get stuck behind walls. Make them smash through enemy walls fast, and make my wall tougher too" (`--resume` w3) | 13 | 1 + 1 | Submitted v2 of both: Plank Wall 450 HP $36, and Speedy Runner, which now smashes after 30 blocked ticks | Called `get_unit_source` for both before editing, and passed `unitId` + `baseVersion: 1` on validate and submit. It remembers the wall in `this.smashId` and drops it when the wall is gone or is its own |

- **Validates:** every run submitted valid units after **1 validate per unit**.
- **Sprites:** every unit had a 16×16 sprite. Factory sprites had smoke idle frames and a door-lit frame.
- **Permissions:** no permission denials, and no shell commands.
- **Talking to the player:** answers were short and in kid words. Claude never asked the player to
  edit code, and it always ended by saying where to pick and place the unit.
- **Rules followed:** CLAUDE.md §4c (unit types) and the wall and factory cost examples were enough.
  - Claude got the cost formulas right.
  - Factories never had damage or speed.
  - Walls never had update().
  - It left a gap in walls for its own units.
  - It skipped walls when picking targets.

### Fix texts (checked directly)

None of the runs made a validation error, so the wall and factory fix texts were checked with
REST `POST /units/validate` on broken sources. All gave a precise fix and a kid-friendly
`playerHint`:
- **`BUILDING_CANNOT_ATTACK` and `BUILDING_CANNOT_MOVE`:** "Remove this.damage … Want something
  that shoots? Make a tower."
- **`W_UPDATE_IGNORED`:** a wall with `update()`.
- **`STAT_OUT_OF_RANGE`:** the productionInterval fix says "(one minion every 15 s)".
- **`UPDATE_MISSING`:** a factory with no `update()`. The fix gives a rally example.
- **`UNIT_TOO_EXPENSIVE`:** for a factory, this names the 870 HP fix that w4 also found.

Four were tuned:

- **`BAD_ACTION`, factory:** a factory that returned an attack with no target was told "an attack
  needs targetId set to an enemy id", which invites Claude to fix the attack. It now says "a factory
  can't attack, it only tells its minions where to go" (`validator/dryrun.ts`).
- **`STAT_OUT_OF_RANGE`, maxHealth:** for a wall or factory the example was the soldier's
  `this.maxHealth = 120`. It is now the starter value: 400 for a wall, 300 for a factory
  (`shared/bounds.ts`).
- **`UNIT_TOO_EXPENSIVE`, walls and factories:** the fix said "costs $360 before the factor".
  Buildings have no cooldown factor, so the phrase is now only used for soldiers and towers
  (`shared/cost.ts`).
- **Unknown type** (e.g. `this.type = "gate"`): apart from the type error, the result also listed
  STAT_MISSING for damage, range, speed and attackCooldown, which pushed a wall towards soldier
  stats. Now only the type error and the fields every type needs are listed (`shared/bounds.ts`).

Tests are in `tests/validator-buildings.test.ts` ("fix texts for walls and factories"). CLAUDE.md
and PROMPTS.md weren't changed, because no run showed a gap.

### Remaining

- **Little real-Claude coverage of the building fix texts:** Claude got walls and factories right
  first time, as it did with soldiers in M4, so the tuned texts are covered by unit tests only.
- **The success `playerHint` says "Your unit is ready! Find it in My Units"** for walls and
  factories too. That is true (the /play panel is called My Units, with a Buildings group), but
  "building" would read better.
