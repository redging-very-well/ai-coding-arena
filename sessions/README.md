# Pixel Clash Claude box (`sessions/`)

One Docker container per seat (plan §11.1). Each container runs **ttyd**, which runs the seat's coding agent straight inside that seat's kit folder `/kit`: **Claude Code** by default, or the **OpenAI Codex CLI** on seats set to `AGENT=codex` (plan §11.3, section 2b). The terminal opens straight into the agent, and if it exits it starts again. Both agents get the same kit instructions (CLAUDE.md for Claude, the same text as AGENTS.md for Codex) and the same game tools over MCP.

**Players never open the Claude box directly.** The game server reverse-proxies each seat at `http://<game-server>:8080/terminal/N/` (plan §11.2) and shows it inside `/play`, next to the game (or as an "AI helper" tab on small screens). A player can only reach the AI seat assigned to them (picked once on /play, or set by the seat card's `/play?seat=N` QR), and an "Open in new tab" button opens the same terminal as its own browser tab. The proxy adds the seat password itself, so **players never see or type it**. Each ttyd runs with the base path `-b /terminal/N` so the same paths work behind the proxy and directly.

**The container is the security boundary, not the ttyd loop.** Claude Code's `!` prefix runs any typed command in the container as user `player`, and a player can accept any approval prompt Claude raises. So treat each seat as "a player with a shell inside this container": they can reach `/kit`, the seat's own Claude state, and whatever the network allows, but not other seats, the host or the game server's files. In particular, **each seat can read its own Claude login** (`/home/player/.claude/.credentials.json`): use a dedicated event account and sign it out of all sessions after the event (§5). The image ships a root-owned `/etc/claude-code/managed-settings.json` that player-writable settings can't override: it turns off `bypassPermissions` mode and denies Claude reading the credentials file (the `!` prefix still can).

| Seat | Host port | Direct URL (adults' fallback, user `player` / `SEAT_SECRET`) | Volumes |
|---|---|---|---|
| 1 | 7781 | `http://<claude-box>:7781/terminal/1/` | `kit1`, `claude1`, `codex1` |
| 2 | 7782 | `http://<claude-box>:7782/terminal/2/` | `kit2`, `claude2`, `codex2` |
| 3 | 7783 | `http://<claude-box>:7783/terminal/3/` | `kit3`, `claude3`, `codex3` |
| 4 | 7784 | `http://<claude-box>:7784/terminal/4/` | `kit4`, `claude4`, `codex4` |
| 5 | 7785 | `http://<claude-box>:7785/terminal/5/` | `kit5`, `claude5`, `codex5` |
| 6 | 7786 | `http://<claude-box>:7786/terminal/6/` | `kit6`, `claude6`, `codex6` |
| 7 | 7787 | `http://<claude-box>:7787/terminal/7/` | `kit7`, `claude7`, `codex7` |
| 8 | 7788 | `http://<claude-box>:7788/terminal/8/` | `kit8`, `claude8`, `codex8` |

- `kitN` → `/kit`: the rendered starter kit (CLAUDE.md, `.mcp.json`, `.claude/settings.json`, `units/`) plus `.pixel-clash/player.json` (the player's apiKey, written by Claude after login) and `.pixel-clash/last-player` (which player the seat last served, see "A new player sits down").
- `claudeN` → `/home/player/.claude`: all Claude Code state (`CLAUDE_CONFIG_DIR`): the login, folder trust, `.claude.json` and chat history.
- `codexN` → `/home/player/.codex`: all Codex state (`CODEX_HOME`): the login (`auth.json`) and chat history. Only used on Codex seats.
- On a Codex seat `/kit` has AGENTS.md and `.codex/config.toml` instead of CLAUDE.md, `.mcp.json` and `.claude/`.
- No host folders, no Docker socket, `cap_drop: ALL`, `no-new-privileges`, at most 1.5 GB RAM and 1 CPU per seat, runs as user `player`.

Pinned versions (change the `ARG`s in `Dockerfile`): `node:22.23.3-slim`, Claude Code `2.1.290`, OpenAI Codex CLI `0.162.1`, ttyd `1.7.7` (SHA-256 checked, amd64 and arm64). Both agents are installed in the one image; `AGENT` picks which one a seat runs.

Inside every container ttyd listens on 7781; compose publishes seat N on host port 778N.

All commands below run in this `sessions/` folder.

## 1. Set up (day before)

Needs Docker with Compose v2 and BuildKit (any current Docker Engine or Docker Desktop).

**Sizing.** Each seat runs one Claude Code process (more if a player opens extra tabs). For all 8 seats plan on about **8 cores and 16 GB RAM**; 4 seats need about 4 cores / 8 GB, 2 seats about 2 cores / 4 GB. Each container is capped at 1.5 GB RAM and 1 CPU (limits, not reservations: a seat typically uses well under 1 GB and under 1 core), so 8 seats at their cap still leave ~4 GB for the host on a 16 GB box. On Docker Desktop, give the Docker VM that much memory and CPU in its settings.

```sh
cp .env.example .env
# Edit .env: PIXEL_CLASH_URL = the game server's LAN address (not localhost),
# and SEAT_SECRET = one made-up seat password for all seats, 12-64 characters
# of A-Z a-z 0-9 . _ ~ - (e.g. four random words: otter-lamp-quartz-ninety).
docker compose up -d --build
docker compose ps        # all eight seats "running (healthy)" after ~30 s
```

Allow inbound TCP 7781-7788 on the Claude box firewall (at least from the game server; to allow **only** the game server, see section 8). Turn off sleep.

### Give the game server the seat password

On the game server, open **/admin → AI seats** (turn on **Show details** first; keep it off while /admin is on the projector):

1. **Claude box address**: the Claude box's LAN IP or name, e.g. `192.168.8.20` (no port: the proxy uses 778N per seat).
2. **Seat password**: exactly the `SEAT_SECRET` from `sessions/.env`. It is saved in the game server's `data/state.json` (it survives a game wipe) and is shown only with "Show details" on.
3. Every running seat should go **up** (green) within a few seconds; press **Check now** to re-test. **Wrong password** means the two values differ; **down** means the seat isn't running or the box address is wrong.

To change the password later: edit `SEAT_SECRET` in `.env`, `docker compose up -d` (the seats restart; conversations reopen), then enter the same value in /admin.

### Seat cards

Print one card per laptop from the game server's **/setup** page: the big Claude seat number and the `/play?seat=N` URL + QR. Cards carry **no terminal URL and no password**: scanning the QR opens /play, which remembers that the laptop is Claude seat N and shows that seat's terminal once the player has joined.

### Upgrading from per-seat passwords (`TTYD_PASS_1..8`)

The compose file now needs `SEAT_SECRET` and ignores `TTYD_PASS_N`, so an old `.env` stops with `set SEAT_SECRET in sessions/.env` instead of half-working. Add a `SEAT_SECRET=…` line (delete the 8 `TTYD_PASS_N` lines; leftovers are harmless), run `docker compose up -d` (it rebuilds: `pull_policy: build`; the new entrypoint adds the base path `-b /terminal/N`), enter the same value in /admin, and reprint the seat cards (QR only).

### Running fewer seats (games are 2-8 players)

Name the seats you want; the others are never created and use no memory:

```sh
docker compose up -d --build seat1 seat2 seat3 seat4   # a 4-player game
docker compose up -d seat5 seat6                        # add two seats later
docker compose stop seat5 seat6                         # park them again (volumes, login and kit are kept)
```

A shortcut for "seats 1 to N" (here N = 6): `docker compose up -d $(seq -f seat%g 1 6)`. `docker compose ps` lists only the seats that exist. For a 3-player game run seats 1-3 and put seat cards 1-3 on those three laptops. The Claude seat number (laptop, card, container) is separate from the player's game seat (colour, zone): /play links them when the player scans the card or picks the number. You only need to log in (step 2) the seats you'll use, but logging in all 8 the day before means any seat can be started on the day.

On start, each seat renders `/kit` from `packages/starter-kit/` with `{{HOST}}` taken from `PIXEL_CLASH_URL`. CLAUDE.md, `.mcp.json`, `.claude/settings.json` and PROMPTS.md are re-rendered on every start, and `.claude/settings.local.json` (where Claude Code saves "Yes, and don't ask again" approvals) is deleted, so the rendered template is the only allowlist; `.pixel-clash/player.json` and existing files in `units/` are never overwritten (except that a new player sitting down removes the previous player's `player.json`, see below). `packages/starter-kit/FIRST_PROMPT.md.tmpl` is not copied into `/kit`: it is the seat's first message for a new player.

### A new player sits down: the first prompt

When a player picks a seat on /play and its terminal opens for a **new** player, the seat's agent starts a **fresh** conversation whose first message is `packages/starter-kit/FIRST_PROMPT.md.tmpl` (the same text for Claude and Codex): load the latest rules, unit contract and game state from the pixel-clash MCP server, then greet the player and ask for their player name and 4-digit PIN, call `login` and save the result to `.pixel-clash/player.json`.

How it works: the game server's proxy adds `?arg=<token>` to the ttyd WebSocket it opens for the seat's assigned player (never for an admin, never anything from the browser). The token is 32 hex digits, a hash of the seat and the player's id, so it is the same every time that player opens that seat. ttyd runs with `-a`, which passes it to `pixel-clash-seat agent-loop <token>` as a plain argument (no shell). The entrypoint accepts only `^[a-f0-9]{32}$`, keeps the last one in `/kit/.pixel-clash/last-player`, and compares:

| Who opens the terminal | What the agent does |
|---|---|
| A new player (different token from the last one, or none stored yet) | Removes the previous player's `.pixel-clash/player.json` and the seat's chats (Claude's project history, file-history, todos and prompt history `history.jsonl`, which holds the PIN they typed; Codex's `sessions/` and `history.jsonl`), keeps the logins and `units/`, then starts fresh with the first prompt. |
| The same player again (reload, new tab, "Use it here instead", coming back later) | Resumes their conversation (`claude --continue` / `codex resume --last`), no prompt. If their conversation is gone, it starts fresh with the prompt. |
| The agent exits and the loop restarts it | Resumes, no prompt. |
| An admin rescue from /admin | No token: resumes the player's conversation (or a plain fresh one if there is none). Never prompts, never clears anything. |
| A direct `http://<box>:778N/terminal/N/` tab (seat password) | Same as an admin rescue. To send the prompt by hand, paste it (`docker compose exec seatN pixel-clash-seat first-prompt` prints it). |
| After `docker compose run --rm seatN new-player` | `/kit` is emptied (including `last-player`), so the next player to open the terminal through /play, even the same one, gets a fresh conversation and the prompt. |

The units in `/kit/units/` stay between players on a seat (their designs are on the game server anyway); run `new-player` to clear everything.

**Edit the prompt:** change `packages/starter-kit/FIRST_PROMPT.md.tmpl` (plain text, sent as is; `{{AGENT_NAME}}` becomes Claude or Codex). Keep it facts and steps only (no tactics: `tests/no-strategy-hints.test.ts` checks it). It is baked into the image, so **rebuild**: `docker compose build && docker compose up -d`. The same rebuild is needed once to get this feature (new entrypoint, ttyd `-a`); the game server needs its update too (it sends the token).

## 2. Log in each seat (adults, before the event)

Do this for **each** seat you'll use, N = 1..8:

```sh
docker compose run --rm seatN claude
```

1. Pick a theme, then run `/login` and sign in with the **event account** (follow the link it prints; paste the code back).
2. Accept the **folder trust** dialog for `/kit` ("Yes, proceed"). If Claude asks to approve the project's MCP server `pixel-clash`, approve it.
3. Type: **"Are you connected to Pixel Clash?"** Claude should call `get_game_state` (or `get_rules`) without any approval prompt.
4. Exit with `/exit` (or Ctrl+C twice).

The login and trust are saved in the `claudeN` volume, so the running seat container picks them up. Then restart the running seats so every terminal starts logged in:

```sh
docker compose restart          # every seat that is running; or name them: docker compose restart seat1 seat2
```

## 2b. Codex seats (optional)

Any seat can run the OpenAI Codex CLI instead of Claude Code. In `.env`:

```sh
AGENT=codex            # every seat on Codex, or keep AGENT=claude and pick seats:
SEAT_AGENT_7=codex     # seat 7 only
```

then `docker compose up -d`. The seat re-renders `/kit` for Codex (AGENTS.md + `.codex/config.toml`; the Claude files are removed) and its ttyd title becomes "Pixel Clash · Codex · seat N". /play, the seat proxy and /admin work the same.

**Log in each Codex seat** (once; it is kept in `codexN`). Pick one:

- **ChatGPT account** (Plus/Pro/Business/Edu/Enterprise), with the device code flow (the browser callback can't reach a container):
  ```sh
  docker compose run --rm seatN codex login --device-auth
  ```
  Open the printed link on any device, sign in, enter the code. (If your workspace has device code login turned off, enable it in ChatGPT's security settings, or use an API key.)
- **API key**, per seat:
  ```sh
  printf '%s' 'sk-proj-…' | docker compose run --rm -T seatN codex login --with-api-key
  ```
  or once for all Codex seats: put `OPENAI_API_KEY=sk-proj-…` in `.env` and `docker compose up -d`. A Codex seat that isn't logged in yet logs itself in with that key when it starts; the entrypoint then removes the variable, so Codex never sees it in its environment.

Check with `docker compose run --rm seatN codex login status` (or `check`). Then test like a Claude seat (section 3): ask **"Are you connected to Pixel Clash?"**. Codex should call `get_game_state` with no question.

**No trust step and no approval prompts.** The image trusts `/kit` in the root-owned `/etc/codex/config.toml`, so Codex loads the kit's `.codex/config.toml` without a trust question. That file connects the `pixel-clash` MCP server by URL (Codex speaks streamable HTTP; no bridge), pre-approves its tools (`default_tools_approval_mode = "approve"`) and reads the whole AGENTS.md (`project_doc_max_bytes`). The seat starts `codex --sandbox $CODEX_SANDBOX --ask-for-approval $CODEX_APPROVAL`, by default `danger-full-access` and `never`: players never see an approval question for the game tools, edits in `/kit` or anything else.

**Why no Codex sandbox on the seats.** Codex's own sandbox on Linux needs unprivileged user namespaces (bubblewrap), which these containers don't have (`cap_drop: ALL`, `no-new-privileges`, Docker's default seccomp). In `workspace-write` mode every file edit and command then fails and Codex asks to retry without the sandbox, which would put approval prompts in front of players. So, as for Claude Code, **the container is the boundary**. `check` says whether the Codex sandbox works in your containers; only then try `CODEX_SANDBOX=workspace-write` with `CODEX_APPROVAL=on-request`.

**Credentials on Codex seats.** Codex has no equivalent of Claude Code's managed "deny reading the credentials" rule: on a Codex seat the agent itself can read `~/.codex/auth.json` if a player asks it to. Use a **dedicated** login: an OpenAI API project key with a spending limit (revoke it after the event), or a ChatGPT account used only for the event (sign it out of all sessions afterwards).

## 3. Check

```sh
docker compose run --rm seatN check
```

prints the seat's agent, the Claude Code, Codex and ttyd versions, the game server URL, whether the kit is rendered, whether a player is saved, whether the agent looks logged in and trusted (Codex: also whether its sandbox works here), and whether the container can reach the game server (`/api/health`) and Anthropic (or OpenAI on a Codex seat).

Then, from a player laptop: scan seat card N (or open `http://<game-server>:8080/play?seat=N`), join with a test name and PIN, and in the AI helper pane ask "Are you connected to Pixel Clash?". There must be **no approval prompts** and **no password box**. Press **Open in new tab**: the terminal opens as its own tab (titled "Pixel Clash · Claude · seat N", or "· Codex ·" on a Codex seat) and the pane in /play says it is open in another tab; **Use it here instead** brings it back. Without the game server, an adult can open the direct URL `http://<claude-box>:778N/terminal/N/` (user `player`, password `SEAT_SECRET`).

Isolation check (dress rehearsal), so facilitators know what a player can reach from a seat:

- Ask Claude in a seat to list `/`, read another seat's files, and read the game server's `data/`. It must find nothing beyond its own `/kit` and the container's system files.
- Type `! ls /` and `! cat ~/.claude/.credentials.json` directly (the `!` prefix runs a command without Claude). The first works and the second prints this seat's login token: that is expected (see the box above), which is why the event account must be a dedicated one.

## 4. During the event

- **A seat's terminal is stuck:** `docker compose restart seatN`. This keeps the Claude login, the kit and the player's key; the conversation reopens (see `CLAUDE_CONTINUE`) and the pane in /play reconnects by itself. Or move the player to a spare seat in /admin → AI seats. An admin can open any seat's terminal from /admin (it opens in a new tab and takes over that seat until the player presses "Use it here instead").
- **New player on the same seat:**
  ```sh
  docker compose run --rm seatN new-player
  docker compose restart seatN
  ```
  `new-player` empties `/kit` completely (the old player's key in `.pixel-clash/`, their unit files, any other files Claude created, and `.claude/settings.local.json` with any "don't ask again" approvals), deletes this seat's chat history, file-history backups and todos, and re-renders the kit from the templates. The old player's designs stay on the game server. The Claude login and folder trust are kept. On a Codex seat it also clears Codex's chats and state in `codexN`, keeping only the login (`auth.json`) and `config.toml`. (Minimal version from the plan: `docker compose run --rm seatN rm -f /kit/.pixel-clash/player.json`.)
- **Game server IP changed:** edit `PIXEL_CLASH_URL` in `.env`, then `docker compose up -d` (the seats restart and re-render `.mcp.json` and CLAUDE.md).
- **A different player takes a seat** (picks it on /play, or an admin reassigns it): their terminal starts a fresh conversation that loads the latest game config and asks for their name and PIN, and the previous player's key and chats on that seat are cleared (see "A new player sits down" above). `new-player` is still the way to clear everything, including `units/`.
- **Reloading /play or opening the terminal in a new tab** starts a new `claude` (or `codex`) process; with `CLAUDE_CONTINUE=1` (default) it reopens the seat's last conversation (`codex resume --last` on a Codex seat), so it costs a 2-3 s restart, not the chat. Through the game server only one terminal per seat is live: the newest tab wins and the older one shows "opened in another tab" until the player switches back. Direct `778N` tabs bypass that rule, so adults should close a direct tab when done.

## 5. Wipe after the event

```sh
docker compose down -v
```

Removes all 24 volumes (`kit1`..`kit8`, `claude1`..`claude8`, `codex1`..`codex8`): kit folders, apiKeys, chat history and the Claude and Codex logins. Player laptops hold nothing. Deleting the volumes does **not** revoke the event account's login token on Anthropic's side (any seat could have read it): sign the event account out of all sessions (or change its password) after the event. The same goes for Codex: revoke the OpenAI API key, or sign the ChatGPT account out of all sessions. Also run `npm run wipe` (or admin Wipe) on the game server. Optionally `docker image rm pixel-clash-seat:local`.

## 6. Options (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PIXEL_CLASH_URL` | (required) | Game server base URL, `http://<ip>:<port>` |
| `SEAT_SECRET` | (required) | One seat password for all seats (basic auth, user `player`): 12-64 characters of `A-Z a-z 0-9 . _ ~ -`. Enter the same value in /admin → AI seats. Replaces `TTYD_PASS_1..8` (ignored now). |
| `CLAUDE_PERMISSION_MODE` | empty | `acceptEdits` or `plan` passes `--permission-mode` to claude. Decided in the M0 spike; `bypassPermissions` is refused. |
| `CLAUDE_CONTINUE` | `1` | Reopen the last conversation after a restart or reload (`claude --continue`, or `codex resume --last`); `0` = always fresh. Either way a new player starts fresh with the first prompt |
| `AGENT` | `claude` | The coding agent every seat runs: `claude` (Claude Code) or `codex` (OpenAI Codex CLI, section 2b) |
| `SEAT_AGENT_1` … `SEAT_AGENT_8` | empty | Per-seat override of `AGENT`, e.g. `SEAT_AGENT_7=codex` |
| `CODEX_SANDBOX` | `danger-full-access` | Codex seats: `--sandbox`. `workspace-write` only if `check` says the Codex sandbox works in the container |
| `CODEX_APPROVAL` | `never` | Codex seats: `--ask-for-approval`. `never` = players never see an approval question; `on-request` or `untrusted` let Codex ask |
| `OPENAI_API_KEY` | empty | Codex seats: log in with this key on start if not logged in yet (then removed from the environment) |

## 7. Optional: egress firewall (Linux Docker hosts)

Containers need the game server (LAN) and the internet (Anthropic). Nothing else is required. To stop seats from reaching the rest of the LAN (player laptops, the router admin page), add rules to Docker's `DOCKER-USER` chain for the seats' bridge `pcseats` (fixed in `docker-compose.yml`). Example with the game server at `192.168.8.10:8080`:

```sh
# Run after `docker compose up` (the bridge must exist). -I 1 inserts at the top,
# so the LAST rule below ends up FIRST. DOCKER-USER runs before Docker's own
# ESTABLISHED/RELATED accept, so the final rule (replies to connections that
# the game server's proxy opened to the published 778N ports) is required: without it the
# private-net REJECTs drop ttyd's replies and every seat terminal goes dead.
sudo iptables -I DOCKER-USER 1 -i pcseats -j REJECT
sudo iptables -I DOCKER-USER 1 -i pcseats -p tcp --dport 443 -j ACCEPT        # HTTPS (Anthropic)
sudo iptables -I DOCKER-USER 1 -i pcseats -d 10.0.0.0/8 -j REJECT             # no other private nets
sudo iptables -I DOCKER-USER 1 -i pcseats -d 172.16.0.0/12 -j REJECT
sudo iptables -I DOCKER-USER 1 -i pcseats -d 192.168.0.0/16 -j REJECT
sudo iptables -I DOCKER-USER 1 -i pcseats -p udp --dport 53 -j ACCEPT          # DNS
sudo iptables -I DOCKER-USER 1 -i pcseats -p tcp --dport 53 -j ACCEPT
sudo iptables -I DOCKER-USER 1 -i pcseats -d 192.168.8.10 -p tcp --dport 8080 -j ACCEPT  # game server
sudo iptables -I DOCKER-USER 1 -i pcseats -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT  # replies (MUST end up first)
# Seats talking to the Claude box itself (e.g. another seat's ttyd port):
sudo iptables -I INPUT 1 -i pcseats -m conntrack --ctstate NEW -p tcp --dport 7781:7788 -j REJECT
```

Check with `docker compose run --rm seat1 check` (game server and Anthropic must still be reachable). That only tests outbound traffic, so also check inbound: on a player laptop, open the AI helper pane in /play for seat 1 and type to it (the game server's proxy connects to 7781 and the replies must come back). `sudo iptables -L DOCKER-USER -n --line-numbers` must show the `ESTABLISHED,RELATED` rule as line 1. The rules disappear on reboot unless saved (`iptables-save`/`netfilter-persistent`). Allowing only `api.anthropic.com` and `claude.ai` by name needs an HTTPS proxy; port 443 to the internet is the practical middle ground. On Docker Desktop (macOS/Windows) these rules don't apply; rely on the router instead.

## 8. Optional: only the game server may reach 7781-7788

With this rule the game server's proxy is the only way into a seat, so even someone who learns `SEAT_SECRET` can't use it from a player laptop. Everything works without it. The direct fallback URL then only works from the game server laptop itself (or after removing the rule).

Skip this if the game server and the Claude box are the **same machine**: then the proxy connects locally and the box address in /admin is `127.0.0.1`.

**Linux (iptables).** Docker's published ports are forwarded through the `DOCKER-USER` chain, not `INPUT`, and after Docker's port mapping every seat's destination port is 7781, so match the port the client originally dialled with `--ctorigdstport`. Example with the game server at `192.168.8.10`:

```sh
sudo iptables -I DOCKER-USER 1 -o pcseats -p tcp -m conntrack --ctstate NEW \
  --ctorigdstport 7781:7788 ! -s 192.168.8.10 -j REJECT --reject-with tcp-reset
```

It only matches NEW connections, so it can sit anywhere relative to the egress rules in section 7. Check it: in /admin → AI seats all seats stay **up**, and from a player laptop `curl -m 3 http://<claude-box>:7781/terminal/1/` fails (connection refused). Like section 7, the rule is gone after a reboot unless saved (`iptables-save`/`netfilter-persistent`). If the LAN uses IPv6, add the same rule with `ip6tables` (and the game server's IPv6 address) or keep the Claude box IPv4-only. Remove it with the same command and `-D DOCKER-USER` instead of `-I DOCKER-USER 1`.

**Linux (ufw).** `ufw deny 7781:7788` has **no effect** on Docker's published ports (Docker's iptables rules run before ufw's). Put the rule in `/etc/ufw/after.rules` instead, at the end of the file:

```text
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -o pcseats -p tcp -m conntrack --ctstate NEW --ctorigdstport 7781:7788 ! -s 192.168.8.10 -j REJECT --reject-with tcp-reset
-A DOCKER-USER -j RETURN
COMMIT
```

then `sudo ufw reload` and run the check above. `ufw reload` resets `DOCKER-USER` to just these lines, so if you also use the egress rules from section 7, run them again after each reload (or add them to this block as `-A` lines in the same order they end up in `iptables -L DOCKER-USER`).

**macOS with Docker Desktop or OrbStack (and Docker Desktop on Windows).** The published ports are served by the Docker app on the Mac itself, so rules inside Docker's VM can't see the laptop's address, and macOS's Application Firewall (System Settings → Network → Firewall) can only allow or block whole apps, not one source address. Options:

- Easiest: block 7781-7788 from everything but the game server on the **router** (if it has client firewall rules), or skip the hardening.
- macOS `pf` (resets on reboot; test it before the event):
  ```sh
  printf '%s\n' \
    'pass in quick on lo0 all' \
    'block return in quick proto tcp from ! 192.168.8.10 to any port 7781:7788' \
    | sudo pfctl -a com.apple/250.PixelClash -f -
  sudo pfctl -E          # enable pf (prints a token; harmless if already on)
  sudo pfctl -a com.apple/250.PixelClash -s rules   # shows the two rules
  ```
  Remove with `sudo pfctl -a com.apple/250.PixelClash -F rules`. Check as above (seats stay **up** in /admin; `curl` from a laptop fails).
- Windows: a Windows Defender Firewall inbound rule for TCP 7781-7788 with "Remote IP address" set to the game server only.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose` says `set PIXEL_CLASH_URL` / `set SEAT_SECRET` | Create `.env` from `.env.example` in this folder (an old `.env` with only `TTYD_PASS_1..8` needs a `SEAT_SECRET=` line now, see "Upgrading" in section 1). |
| A seat keeps restarting | `docker compose logs seatN`. The entrypoint prints a clear `ERROR:` (bad `PIXEL_CLASH_URL`, missing or too short `SEAT_SECRET`, characters other than `A-Z a-z 0-9 . _ ~ -`). |
| Seat shows `Up (healthy)` but `curl http://<claude-box>:778N/terminal/N/` is refused, and `docker compose exec seatN curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7781/terminal/N/` prints `000` | The container runs an image built from older `sessions/` files (e.g. before the port moved from 768x to 778x). `docker compose up -d --build --force-recreate`. Logins and kits are kept in the volumes. The compose file sets `pull_policy: build`, so a plain `up -d` rebuilds from now on. |
| /admin shows every seat **wrong password** (red banner) | The seat password in /admin differs from `SEAT_SECRET` in `.env`. Type it again in /admin (Show details on), or if `.env` changed, check the seats were restarted (`docker compose up -d`). |
| /admin shows a seat **down**, or the player's pane says Claude "isn't answering" | `docker compose ps`: is `seatN` running? Is the Claude box address in /admin right (IP only, no port)? From the game server: `curl -s -o /dev/null -w '%{http_code}\n' http://<claude-box>:778N/terminal/N/` must print `401`. `000` = not reachable (seat stopped, box firewall, or the section 8 rule doesn't allow the game server's current IP). |
| The direct URL `http://<claude-box>:778N/` gives 404 or a blank page | ttyd now lives under its base path: use `http://<claude-box>:778N/terminal/N/` (with the trailing `/terminal/N/`). |
| Direct URL asks again and again for a password | Wrong password: user `player`, password `SEAT_SECRET` from `.env`. (Through /play there is never a password box; if a player sees one, tell the game server's admin.) |
| The pane in /play says "open in another tab" | That seat's terminal was opened in a newer tab (the player's "Open in new tab", or an adult from /admin). Press **Use it here instead**, or close the other tab. Only one terminal per seat is live through the game server. |
| Player sees "not your seat" or someone else's AI helper | Their AI seat in /play doesn't match the laptop. Fix it in /admin → AI seats (reassign), or have them pick the number on their seat card. |
| Terminal opens but Claude asks to log in, or shows the trust dialog | That seat wasn't logged in or trusted: do step 2 for it, then `docker compose restart seatN`. |
| Claude asks for permission to use the pixel-clash tools or to write `units/…` | The folder isn't trusted: Claude Code ignores the kit's `.claude/settings.json` allowlist in an untrusted folder. Do step 2 (accept the trust dialog) for that seat, then `docker compose restart seatN`. |
| Claude says the pixel-clash tools are missing | `docker compose run --rm seatN check`: is the game server reachable? Is `.mcp.json` pointing at the right IP? In the seat, Claude can type `/mcp` to see the server status. Meanwhile Claude falls back to the `curl` commands in CLAUDE.md §9. They are not pre-approved (a prefix rule can't limit curl to the game API), so each one prompts and Claude asks the player to fetch an adult: check the command is one of the §9 commands to the game server before approving it. |
| Player sees an approval prompt | Note which tool it was. Add the rule to `packages/starter-kit/.claude/settings.json.tmpl` (or set `CLAUDE_PERMISSION_MODE=acceptEdits`), `docker compose up -d --build`. |
| Codex seat shows a sign-in screen | That seat's Codex isn't logged in: section 2b (`codex login --device-auth` or an API key), then `docker compose restart seatN`. |
| Codex asks "Do you trust this folder?" or doesn't list the pixel-clash tools | The image is older than the Codex support (no `/etc/codex/config.toml`): `docker compose up -d --build`. In the seat, `/mcp` lists Codex's MCP servers. |
| Codex asks to approve a pixel-clash tool or a file edit | Check `CODEX_SANDBOX`/`CODEX_APPROVAL` in `.env` (defaults `danger-full-access`/`never`) and that `/kit/.codex/config.toml` has `default_tools_approval_mode = "approve"` (`docker compose run --rm seatN render` re-renders it). |
| Codex says commands fail with `bwrap: No permissions to create a new namespace` | `CODEX_SANDBOX=workspace-write` is set but the container has no user namespaces: set it back to `danger-full-access` (section 2b). |
| `openai api: NOT reachable` | As for Anthropic: the Claude box needs internet to `api.openai.com` (and `chatgpt.com` for a ChatGPT login). |
| `anthropic api: NOT reachable` | The Claude box or router has no internet uplink (venue Wi-Fi with captive portal?). |
| `game server: NOT reachable` | Wrong IP in `.env`, the game server isn't running on `0.0.0.0`, or its firewall blocks 8080. Containers can't reach a game server that only listens on `localhost`. |
| Build fails at `sha256sum` | The ttyd download changed or was corrupted: don't skip the check; retry, or re-pin `TTYD_VERSION` with the new release's `SHA256SUMS`. |
| Build fails with `Unsupported TARGETARCH` | Use BuildKit (default in current Docker; or `DOCKER_BUILDKIT=1`). Only amd64 and arm64 are supported. |
| Seat is slow / killed | `docker stats`: each seat is capped at 1.5 GB RAM and 1 CPU. If one seat really needs more, raise `mem_limit`/`memswap_limit`/`cpus` in `x-seat` (all seats share it) and make sure the box still has room: seats running × limit, plus ~4 GB for the host. Also check the box isn't swapping (`free -h`) with all seats running; if it is, run fewer seats. Close extra direct `778N` tabs on that seat (each runs its own Claude; tabs through the game server are limited to one per seat). |
