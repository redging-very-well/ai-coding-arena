# Visual QA in a real browser

Date: 2026-10-21, branch `pixel-clash-dev`. Playwright 1.63 with headless Chromium (kept outside the repo)
against the **built production server** (`packages/server/dist/index.js`, temp `DATA_DIR`,
`ADMIN_PASSWORD` set, isolated-vm sandbox).

## How it was run

The harness (`scratchpad/visual/harness.cjs`, not part of the repo) boots the built server on a free
port and wipes it before each scenario. It shortens the battle to 30 s (`battleTicks 1800`, sudden death
from tick 900). It then plays one full match per scenario:

- **Bots (REST):** every player joins. Player 1 submits the custom sprite unit `Pixel Bat`, which is the
  privacy canary. Player 2 submits `Big Tank`. Everyone else uses templates. Selection and placement
  are set over REST (OVER_BUDGET layouts are trimmed), half the players press Ready, and the last
  player places nothing so auto-place runs.
- **Admin (REST):** the admin saves the match-setup draft, starts the match with the chosen map style,
  team mode and Open Armory setting, then presses Next, Force START and Next to MATCH_RESULTS.
- **Pages:** `/screen` at 1920×1080 and `/admin` at 1440×900. `/play` for players 1 and 2 at
  1366×768 (laptop) and 820×1180 (tablet; both players in the Duel run). In PLACEMENT, every other
  player's `/play` is also captured at 1366×768, so every zone orientation is covered.
- **Phases captured:** LOBBY, PLAN, PLACEMENT, BATTLE (the 3-2-1 reveal and drop-in, early, mid, sudden
  death and late, plus two bursts of 6-16 frames for hit flashes, muzzle flashes and deaths), RESULTS
  and MATCH_RESULTS.

| Scenario | Map | Players | Teams | Open Armory |
|---|---|---|---|---|
| `duel2` | Duel | 2 | free-for-all | off |
| `triangle3` | Triangle | 3 | free-for-all | **on** |
| `corners4` | Corners | 4 | free-for-all | off |
| `ring5` | Ring | 5 | free-for-all | off |
| `ring8` | Ring | 8 | free-for-all | off |
| `lanes8t2` | Lanes | 8 | `teams2` (4v4) | off |
| `islands8t4` | Islands | 8 | `teams4` (2v2v2v2) | **on** |
| `projectiles` | Duel | 2 | 4 towers vs 8 soldiers, for tower fire and deaths | off |

### Automatic checks on every capture

- **Console:** page console errors and warnings, `pageerror` and failed requests.
- **Text:** `undefined`, `NaN`, `null` and `[object Object]` in the page text, plus any horizontal
  scrollbar.
- **`/screen` layout:** every panel, the header, the side column and the podium must stay inside the
  1920×1080 stage, and none may have content that overflows its own box.
- **Privacy before START:** the HTML of `/screen` and of opponents' `/play` pages must not contain
  `Pixel Bat`, `pixel-bat` or its colour `#33CC66`. In team mode, teammates are allowed to see it.
- **Server log:** no `ERROR`, `WARN` or `Unhandled` lines.

The final run is clean on all of these: 433 screenshots in
`/tmp/claude-1000/-workspaces-kidscodingday/9c9e875f-8be6-4b5a-93eb-d016b9d3d229/scratchpad/visual/final/`,
with an empty `console.txt` and an empty `server.txt`.
Files are named `<scenario>-<step>-<view>.png`, for example `ring8-4d-sudden-death-screen.png`.

### Looked at by eye

- **Isometric arena:**
  - The floor tiles render, and Lanes shows its no-man's-land band and Islands its cluster pads.
  - Zone tints use the seat colour in free-for-all and the team colour in team mode.
  - Seat badges show on zones and HP bars.
  - Sprites are drawn at true size, with their feet on the ground ring.
  - Depth order is correct (towers in front of the soldiers behind them).
  - HP bars, muzzle flashes, hit flashes and the death fade show (`projectiles-4c-burst*`).
  - The sudden-death ellipse sits on the ground plane, with the area outside it tinted red.
  - Team rings are drawn solid, dashed, double or dotted.
  - See `duel2-4b-burst*`, `lanes8t2-4b-battle-early-screen.png` and `islands8t4-4d-sudden-death-screen.png`.
- **Placement grid orientation:**
  - Every zone of Duel, Triangle, Corners, Ring 5, Ring 8, Lanes 8 and Islands 8 was checked against
    plan §9.2.
  - Row 0 is the front row and (0,0) is the front cell nearest the centre. For diag, N/S and E/W
    zones, `col` runs away from the centre line.
  - The arrow points at the centre in every case.
  - See `*-3-placement-play*-laptop.png`, for example `ring5-3-placement-play0-laptop.png` (a
    W-facing zone) and `lanes8t2-3-placement-play0-laptop.png` (an N-facing zone).
- **Seat colours:** all 8 are distinct, and every tile, zone and unit also carries its number badge
  (`ring8-*`).
- **Privacy:** before START, the projector shows empty zone outlines and status ticks only. In team
  mode, `/play` shows teammates' picks and placements and nothing from opponents
  (`islands8t4-2-plan-play0-laptop.png`, `lanes8t2-3-placement-play0-laptop.png`).

## Bugs found and fixed

| # | Where | Bug | Fix | Evidence (final) |
|---|---|---|---|---|
| 1 | /admin Match setup | The Map dropdown was **blank** when the draft override equalled the default style (e.g. `mapStyle: 'duel'` with 2 players), because the default is only offered as "auto". | `selectedStyleOption()` in `admin/mapPreview.ts` maps such an override to the "auto" entry. Test added in `tests/maps-client.test.ts`. | `duel2-1-lobby-admin.png` |
| 2 | /play | Every phase change showed **duplicate toasts**: the server's "Round 1: Plan time! …" and the client's own "Plan time! …", and "Place your army!" twice. Up to 4 piled up **over the placement grid and the READY button**, and last phase's toasts were still on screen. | The client no longer adds its own PLAN/PLACEMENT toasts. A toast with the same text replaces the old one, at most 3 show, and a phase change drops toasts older than 1 s. Toasts moved to the top right, under the header. | `duel2-3-placement-play0-laptop.png`, `lanes8t2-3-placement-play0-tablet.png` |
| 3 | /screen header | "Place your army!" **wrapped to two lines** and pushed the arena down by 40 px. | The logo column is narrower, the title doesn't wrap, the header height is fixed and the timer is a little smaller. | `corners4-3-placement-screen.png` |
| 4 | /screen join card | The LAN URL **broke mid-number** ("192.168.2 / 15.20:403 / 69/play") in a narrow column. | The URL now spans the card's full width. It can only wrap at `:` or `/`, and the font is a little smaller. "4-digit" no longer splits. | `duel2-1-lobby-screen.png` |
| 5 | /screen LOBBY/PLAN | With **5-8 players** the player tiles **ran off the bottom of the projector** (in team mode, Team 2 couldn't be seen). | 5-7 players get a compact join card (smaller QR). With all 8 seats taken nobody can join, so the join card is hidden and the tiles use the whole column. | `lanes8t2-1-lobby-screen.png`, `ring5-1-lobby-screen.png` |
| 6 | /screen LOBBY/PLAN | Toasts covered the "The arena awaits…" caption. | The caption hides while a toast is showing. | `duel2-2-plan-screen.png` |
| 7 | /screen BATTLE | With **7-8 players** the army value bars **overflowed** the side panel (the last player's bar was cut off). | A dense layout: the "x/y units" count moves into the name row, with thinner bars. | `ring8-4d-sudden-death-screen.png` |
| 8 | /screen RESULTS | When a battle ended just as sudden death started, the **"SUDDEN DEATH!" banner stayed over the results**. | The banner shows only in BATTLE or while a replay is playing. | `duel2-5-results-screen.png` |
| 9 | /screen RESULTS | The ranking and scoreboard **overflowed the stage** with 4 players (badges on a second line) and with 8 players (Replay off screen). | Compact rows from 4 players. From 7 players, a dense layout: one line per player, badges as emoji (full name in a tooltip), no sub-lines. | `corners4-5-results-screen.png`, `ring8-5-results-screen.png`, `islands8t4-5-results-screen.png` |
| 10 | /screen MATCH_RESULTS | With 8 players the final table and the "Great battles" line **ran off the bottom**. In the team podium, the 3rd-place block **clipped the member names**. Team chips in the final table were glued to the names. | A lower podium for 5-8 players. Podium blocks use `min-height`, so text can grow them. The team chip has a left margin. | `ring8-6-match-results-screen.png`, `islands8t4-6-match-results-screen.png` |
| 11 | /screen | The skull in the "☠ Sudden death" chip rendered as a tiny, unreadable glyph in the pixel font. | Emoji ☠️ in the body font at 1.5em. | `islands8t4-4d-sudden-death-screen.png` |
| 12 | /play BATTLE (tablet) | On an 820 px portrait tablet, the battle view was a 450 px arena beside the unit list, with half the screen empty. | Portrait tablets stack: the arena takes the full width and the list goes below it. | `duel2-4d-sudden-death-play1-tablet.png` |
| 13 | /play RESULTS (team) | Team chips in the Teams table **stretched across the whole row**, and the medals were tiny. | The chip keeps its own width and the medal is 1.6rem. | `islands8t4-5-results-play0-tablet.png` |
| 14 | /play PLACEMENT | The "middle" arrow was small and hung over the panel edge. | Bigger and bolder, and moved in from the edge. | `ring8-3-placement-play3-laptop.png` |
| 15 | /admin RESULTS | The round ranking was a numbered list (1., 2., 3.), so in team mode members of the **same team** looked like 1st, 2nd, 3rd… | It shows each row's actual place ("1st Ava, 1st Dev, …"). | `lanes8t2-5-results-admin.png` |
| 16 | All pages | The browser logged "WebSocket is closed before the connection is established" when `/play` replaced its anonymous socket at login. | `common/ws.ts` closes a socket that is still connecting only once it opens (its handlers are already detached). | `console.txt` is empty |

All the fixes are client-side, in `packages/client` and `tests/maps-client.test.ts`. No server change
was needed.

## Remaining cosmetic notes (not fixed)

- **Unit size on the projector.** Sprites use true size (plan §12: 2·size·zoom). On the 1200 px
  arena (7-8 players) a size-10 soldier is about 15 px tall, readable but small from the back of a room.
  HP bars and badges keep their minimum size. Drawing billboards about 1.3× larger than their hitbox
  would help, but it changes the "true size" rule, so it's left for a decision
  (`ring8-4c-battle-mid-screen.png`).
- **Badge pile-ups.** In a tight melee, the HP-bar seat badges of several units overlap
  (`projectiles-4c-burst*`, `lanes8t2-4b-battle-early-screen.png`). It is still readable.
- **Zone words vs the projector view.** The placement text says "zone 2 (top right)" in top-down
  terms, as the plan specifies. On the isometric projector the same zone sits at the **right** corner.
  The mini-map next to the grid shows where it is.
- **Admin toasts** last 6 s. In the fast harness they stack two or three deep, but at real event pace
  they don't.
- The `/screen` hint during PLACEMENT ("Tap a unit, then tap a square…") is meant for players. It is
  harmless on the projector.
- **Not visual, worth knowing for M6:** once, the trivial `pixel_bat.js` fixture was rejected with
  `UPDATE_TIMEOUT` (the validator's 20 ms practice battle). That was while 6 Chromium pages were
  rendering and another load test was running on the same host. Under heavy CPU load the dry-run
  deadline can reject a valid unit.
