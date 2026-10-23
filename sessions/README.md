# Pixel Clash Claude box (`sessions/`)

One Docker container per seat (plan §11.1). Each container runs **ttyd**, which runs **Claude Code** straight inside that seat's kit folder `/kit`. Players open `http://<claude-box>:778N` in a browser and type to Claude; the terminal opens straight into Claude, and if Claude exits it starts again.

**The container is the security boundary, not the ttyd loop.** Claude Code's `!` prefix runs any typed command in the container as user `player`, and a player can accept any approval prompt Claude raises. So treat each seat as "a player with a shell inside this container": they can reach `/kit`, the seat's own Claude state, and whatever the network allows, but not other seats, the host or the game server's files. In particular, **each seat can read its own Claude login** (`/home/player/.claude/.credentials.json`): use a dedicated event account and sign it out of all sessions after the event (§5). The image ships a root-owned `/etc/claude-code/managed-settings.json` that player-writable settings can't override: it turns off `bypassPermissions` mode and denies Claude reading the credentials file (the `!` prefix still can).

| Seat | Terminal URL | Basic auth | Volumes |
|---|---|---|---|
| 1 | `http://<claude-box>:7781` | `player` / `TTYD_PASS_1` | `kit1`, `claude1` |
| 2 | `http://<claude-box>:7782` | `player` / `TTYD_PASS_2` | `kit2`, `claude2` |
| 3 | `http://<claude-box>:7783` | `player` / `TTYD_PASS_3` | `kit3`, `claude3` |
| 4 | `http://<claude-box>:7784` | `player` / `TTYD_PASS_4` | `kit4`, `claude4` |
| 5 | `http://<claude-box>:7785` | `player` / `TTYD_PASS_5` | `kit5`, `claude5` |
| 6 | `http://<claude-box>:7786` | `player` / `TTYD_PASS_6` | `kit6`, `claude6` |
| 7 | `http://<claude-box>:7787` | `player` / `TTYD_PASS_7` | `kit7`, `claude7` |
| 8 | `http://<claude-box>:7788` | `player` / `TTYD_PASS_8` | `kit8`, `claude8` |

- `kitN` → `/kit`: the rendered starter kit (CLAUDE.md, `.mcp.json`, `.claude/settings.json`, `units/`) plus `.pixel-clash/player.json` (the player's apiKey, written by Claude after login).
- `claudeN` → `/home/player/.claude`: all Claude Code state (`CLAUDE_CONFIG_DIR`): the login, folder trust, `.claude.json` and chat history.
- No host folders, no Docker socket, `cap_drop: ALL`, `no-new-privileges`, at most 1.5 GB RAM and 1 CPU per seat, runs as user `player`.

Pinned versions (change the `ARG`s in `Dockerfile`): `node:22.23.3-slim`, Claude Code `2.1.290`, ttyd `1.7.7` (SHA-256 checked, amd64 and arm64).

All commands below run in this `sessions/` folder.

## 1. Set up (day before)

Needs Docker with Compose v2 and BuildKit (any current Docker Engine or Docker Desktop).

**Sizing.** Each seat runs one Claude Code process (more if a player opens extra tabs). For all 8 seats plan on about **8 cores and 16 GB RAM**; 4 seats need about 4 cores / 8 GB, 2 seats about 2 cores / 4 GB. Each container is capped at 1.5 GB RAM and 1 CPU (limits, not reservations: a seat typically uses well under 1 GB and under 1 core), so 8 seats at their cap still leave ~4 GB for the host on a 16 GB box. On Docker Desktop, give the Docker VM that much memory and CPU in its settings.

```sh
cp .env.example .env
# Edit .env: PIXEL_CLASH_URL = the game server's LAN address (not localhost),
# and one short word per seat for TTYD_PASS_1..8 (print them on the seat cards).
# Set all 8 words even if you run fewer seats: compose checks every service.
docker compose up -d --build
docker compose ps        # all eight seats "running (healthy)" after ~30 s
```

Allow inbound TCP 7781-7788 on the Claude box firewall. Turn off sleep.

### Running fewer seats (games are 2-8 players)

Name the seats you want; the others are never created and use no memory:

```sh
docker compose up -d --build seat1 seat2 seat3 seat4   # a 4-player game
docker compose up -d seat5 seat6                        # add two seats later
docker compose stop seat5 seat6                         # park them again (volumes, login and kit are kept)
```

A shortcut for "seats 1 to N" (here N = 6): `docker compose up -d $(seq -f seat%g 1 6)`. `docker compose ps` lists only the seats that exist. Seat numbers match game seats, so for a 3-player game use seats 1-3 and give those three laptops seat cards 1-3. You only need to log in (step 2) the seats you'll use, but logging in all 8 the day before means any seat can be started on the day.

On start, each seat renders `/kit` from `packages/starter-kit/` with `{{HOST}}` taken from `PIXEL_CLASH_URL`. CLAUDE.md, `.mcp.json`, `.claude/settings.json` and PROMPTS.md are re-rendered on every start, and `.claude/settings.local.json` (where Claude Code saves "Yes, and don't ask again" approvals) is deleted, so the rendered template is the only allowlist; `.pixel-clash/player.json` and existing files in `units/` are never overwritten.

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

## 3. Check

```sh
docker compose run --rm seatN check
```

prints the Claude Code and ttyd versions, the game server URL, whether the kit is rendered, whether a player is saved, whether Claude looks logged in and trusted, and whether the container can reach the game server (`/api/health`) and Anthropic.

Then, from a player laptop: open `http://<claude-box>:778N`, enter `player` + the seat word, and ask "Are you connected to Pixel Clash?". There must be **no approval prompts**.

Isolation check (dress rehearsal), so facilitators know what a player can reach from a seat:

- Ask Claude in a seat to list `/`, read another seat's files, and read the game server's `data/`. It must find nothing beyond its own `/kit` and the container's system files.
- Type `! ls /` and `! cat ~/.claude/.credentials.json` directly (the `!` prefix runs a command without Claude). The first works and the second prints this seat's login token: that is expected (see the box above), which is why the event account must be a dedicated one.

## 4. During the event

- **A seat's terminal is stuck:** `docker compose restart seatN`. This keeps the Claude login, the kit and the player's key; the conversation reopens (see `CLAUDE_CONTINUE`).
- **New player on the same seat:**
  ```sh
  docker compose run --rm seatN new-player
  docker compose restart seatN
  ```
  `new-player` empties `/kit` completely (the old player's key in `.pixel-clash/`, their unit files, any other files Claude created, and `.claude/settings.local.json` with any "don't ask again" approvals), deletes this seat's chat history, file-history backups and todos, and re-renders the kit from the templates. The old player's designs stay on the game server. The Claude login and folder trust are kept. (Minimal version from the plan: `docker compose run --rm seatN rm -f /kit/.pixel-clash/player.json`.)
- **Game server IP changed:** edit `PIXEL_CLASH_URL` in `.env`, then `docker compose up -d` (the seats restart and re-render `.mcp.json` and CLAUDE.md).
- **Reloading the browser tab** starts a new `claude` process; with `CLAUDE_CONTINUE=1` (default) it reopens the seat's last conversation. Each open tab gets its own Claude process, so keep one tab per seat.

## 5. Wipe after the event

```sh
docker compose down -v
```

Removes all 16 volumes (`kit1`..`kit8`, `claude1`..`claude8`): kit folders, apiKeys, chat history and the Claude logins. Player laptops hold nothing. Deleting the volumes does **not** revoke the event account's login token on Anthropic's side (any seat could have read it): sign the event account out of all sessions (or change its password) after the event. Also run `npm run wipe` (or admin Wipe) on the game server. Optionally `docker image rm pixel-clash-seat:local`.

## 6. Options (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PIXEL_CLASH_URL` | (required) | Game server base URL, `http://<ip>:<port>` |
| `TTYD_PASS_1`..`8` | (required, all 8) | Basic-auth word per seat (user `player`). Compose checks all 8 even when only some seats run. |
| `CLAUDE_PERMISSION_MODE` | empty | `acceptEdits` or `plan` passes `--permission-mode` to claude. Decided in the M0 spike; `bypassPermissions` is refused. |
| `CLAUDE_CONTINUE` | `1` | Reopen the last conversation after a restart or reload (`claude --continue`); `0` = always fresh |

## 7. Optional: egress firewall (Linux Docker hosts)

Containers need the game server (LAN) and the internet (Anthropic). Nothing else is required. To stop seats from reaching the rest of the LAN (player laptops, the router admin page), add rules to Docker's `DOCKER-USER` chain for the seats' bridge `pcseats` (fixed in `docker-compose.yml`). Example with the game server at `192.168.8.10:8080`:

```sh
# Run after `docker compose up` (the bridge must exist). -I 1 inserts at the top,
# so the LAST rule below ends up FIRST. DOCKER-USER runs before Docker's own
# ESTABLISHED/RELATED accept, so the final rule (replies to connections that
# player laptops opened to the published 778N ports) is required: without it the
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

Check with `docker compose run --rm seat1 check` (game server and Anthropic must still be reachable). That only tests outbound traffic, so also check inbound: from a player laptop, open `http://<claude-box>:7781`, log in with the seat word and type to Claude. `sudo iptables -L DOCKER-USER -n --line-numbers` must show the `ESTABLISHED,RELATED` rule as line 1. The rules disappear on reboot unless saved (`iptables-save`/`netfilter-persistent`). Allowing only `api.anthropic.com` and `claude.ai` by name needs an HTTPS proxy; port 443 to the internet is the practical middle ground. On Docker Desktop (macOS/Windows) these rules don't apply; rely on the router instead.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose` says `set PIXEL_CLASH_URL` / `set TTYD_PASS_N` | Create `.env` from `.env.example` in this folder. |
| A seat keeps restarting | `docker compose logs seatN`. The entrypoint prints a clear `ERROR:` (bad `PIXEL_CLASH_URL`, missing or bad `TTYD_PASS`). |
| Browser shows 401 / asks again for a password | Wrong seat word. User is `player`. |
| Terminal opens but Claude asks to log in, or shows the trust dialog | That seat wasn't logged in or trusted: do step 2 for it, then `docker compose restart seatN`. |
| Claude asks for permission to use the pixel-clash tools or to write `units/…` | The folder isn't trusted: Claude Code ignores the kit's `.claude/settings.json` allowlist in an untrusted folder. Do step 2 (accept the trust dialog) for that seat, then `docker compose restart seatN`. |
| Claude says the pixel-clash tools are missing | `docker compose run --rm seatN check`: is the game server reachable? Is `.mcp.json` pointing at the right IP? In the seat, Claude can type `/mcp` to see the server status. Meanwhile Claude falls back to the `curl` commands in CLAUDE.md §9. They are not pre-approved (a prefix rule can't limit curl to the game API), so each one prompts and Claude asks the player to fetch an adult: check the command is one of the §9 commands to the game server before approving it. |
| Player sees an approval prompt | Note which tool it was. Add the rule to `packages/starter-kit/.claude/settings.json.tmpl` (or set `CLAUDE_PERMISSION_MODE=acceptEdits`), `docker compose up -d --build`. |
| `anthropic api: NOT reachable` | The Claude box or router has no internet uplink (venue Wi-Fi with captive portal?). |
| `game server: NOT reachable` | Wrong IP in `.env`, the game server isn't running on `0.0.0.0`, or its firewall blocks 8080. Containers can't reach a game server that only listens on `localhost`. |
| Build fails at `sha256sum` | The ttyd download changed or was corrupted: don't skip the check; retry, or re-pin `TTYD_VERSION` with the new release's `SHA256SUMS`. |
| Build fails with `Unsupported TARGETARCH` | Use BuildKit (default in current Docker; or `DOCKER_BUILDKIT=1`). Only amd64 and arm64 are supported. |
| Seat is slow / killed | `docker stats`: each seat is capped at 1.5 GB RAM and 1 CPU. If one seat really needs more, raise `mem_limit`/`memswap_limit`/`cpus` in `x-seat` (all seats share it) and make sure the box still has room: seats running × limit, plus ~4 GB for the host. Also check the box isn't swapping (`free -h`) with all seats running; if it is, run fewer seats. Close extra tabs on that seat (each tab runs its own Claude). |
