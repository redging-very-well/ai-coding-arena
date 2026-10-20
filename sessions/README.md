# Pixel Clash Claude box (`sessions/`)

One Docker container per seat (plan §11.1). Each container runs **ttyd**, which runs **Claude Code** straight inside that seat's kit folder `/kit`. Kids open `http://<claude-box>:768N` in a browser and type to Claude; the terminal opens straight into Claude, and if Claude exits it starts again.

**The container is the security boundary, not the ttyd loop.** Claude Code's `!` prefix runs any typed command in the container as user `kid`, and a kid can accept any approval prompt Claude raises. So treat each seat as "a kid with a shell inside this container": they can reach `/kit`, the seat's own Claude state, and whatever the network allows, but not other seats, the host or the game server's files. In particular, **each seat can read its own Claude login** (`/home/kid/.claude/.credentials.json`): use a dedicated event account and sign it out of all sessions after the event (§5). The image ships a root-owned `/etc/claude-code/managed-settings.json` that kid-writable settings can't override: it turns off `bypassPermissions` mode and denies Claude reading the credentials file (the `!` prefix still can).

| Seat | Terminal URL | Basic auth | Volumes |
|---|---|---|---|
| 1 | `http://<claude-box>:7681` | `kid` / `TTYD_PASS_1` | `kit1`, `claude1` |
| 2 | `http://<claude-box>:7682` | `kid` / `TTYD_PASS_2` | `kit2`, `claude2` |
| 3 | `http://<claude-box>:7683` | `kid` / `TTYD_PASS_3` | `kit3`, `claude3` |
| 4 | `http://<claude-box>:7684` | `kid` / `TTYD_PASS_4` | `kit4`, `claude4` |

- `kitN` → `/kit`: the rendered starter kit (CLAUDE.md, `.mcp.json`, `.claude/settings.json`, `units/`) plus `.pixel-clash/player.json` (the kid's apiKey, written by Claude after login).
- `claudeN` → `/home/kid/.claude`: all Claude Code state (`CLAUDE_CONFIG_DIR`): the login, folder trust, `.claude.json` and chat history.
- No host folders, no Docker socket, `cap_drop: ALL`, `no-new-privileges`, 2 GB RAM and 1.5 CPU per seat, runs as user `kid`.

Pinned versions (change the `ARG`s in `Dockerfile`): `node:22.23.3-slim`, Claude Code `2.1.290`, ttyd `1.7.7` (SHA-256 checked, amd64 and arm64).

All commands below run in this `sessions/` folder.

## 1. Set up (day before)

Needs Docker with Compose v2 and BuildKit (any current Docker Engine or Docker Desktop). Sizing: about 4 cores and 8 GB RAM for 4 seats.

```sh
cp .env.example .env
# Edit .env: PIXEL_CLASH_URL = the game server's LAN address (not localhost),
# and one short word per seat for TTYD_PASS_1..4 (print them on the seat cards).
docker compose up -d --build
docker compose ps        # all four seats "running (healthy)" after ~30 s
```

Allow inbound TCP 7681-7684 on the Claude box firewall. Turn off sleep.

On start, each seat renders `/kit` from `packages/starter-kit/` with `{{HOST}}` taken from `PIXEL_CLASH_URL`. CLAUDE.md, `.mcp.json`, `.claude/settings.json` and PROMPTS.md are re-rendered on every start, and `.claude/settings.local.json` (where Claude Code saves "Yes, and don't ask again" approvals) is deleted, so the rendered template is the only allowlist; `.pixel-clash/player.json` and existing files in `units/` are never overwritten.

## 2. Log in each seat (adults, before the event)

Do this for **each** seat, N = 1..4:

```sh
docker compose run --rm seatN claude
```

1. Pick a theme, then run `/login` and sign in with the **event account** (follow the link it prints; paste the code back).
2. Accept the **folder trust** dialog for `/kit` ("Yes, proceed"). If Claude asks to approve the project's MCP server `pixel-clash`, approve it.
3. Type: **"Are you connected to Pixel Clash?"** Claude should call `get_game_state` (or `get_rules`) without any approval prompt.
4. Exit with `/exit` (or Ctrl+C twice).

The login and trust are saved in the `claudeN` volume, so the running seat container picks them up. Then restart the seats so every terminal starts logged in:

```sh
docker compose restart
```

## 3. Check

```sh
docker compose run --rm seatN check
```

prints the Claude Code and ttyd versions, the game server URL, whether the kit is rendered, whether a player is saved, whether Claude looks logged in and trusted, and whether the container can reach the game server (`/api/health`) and Anthropic.

Then, from a kid laptop: open `http://<claude-box>:768N`, enter `kid` + the seat word, and ask "Are you connected to Pixel Clash?". There must be **no approval prompts**.

Isolation check (dress rehearsal), so facilitators know what a kid can reach from a seat:

- Ask Claude in a seat to list `/`, read another seat's files, and read the game server's `data/`. It must find nothing beyond its own `/kit` and the container's system files.
- Type `! ls /` and `! cat ~/.claude/.credentials.json` directly (the `!` prefix runs a command without Claude). The first works and the second prints this seat's login token: that is expected (see the box above), which is why the event account must be a dedicated one.

## 4. During the event

- **A seat's terminal is stuck:** `docker compose restart seatN`. This keeps the Claude login, the kit and the kid's key; the conversation reopens (see `CLAUDE_CONTINUE`).
- **New kid on the same seat:**
  ```sh
  docker compose run --rm seatN new-kid
  docker compose restart seatN
  ```
  `new-kid` empties `/kit` completely (the old kid's key in `.pixel-clash/`, their unit files, any other files Claude created, and `.claude/settings.local.json` with any "don't ask again" approvals), deletes this seat's chat history, file-history backups and todos, and re-renders the kit from the templates. The old kid's designs stay on the game server. The Claude login and folder trust are kept. (Minimal version from the plan: `docker compose run --rm seatN rm -f /kit/.pixel-clash/player.json`.)
- **Game server IP changed:** edit `PIXEL_CLASH_URL` in `.env`, then `docker compose up -d` (the seats restart and re-render `.mcp.json` and CLAUDE.md).
- **Reloading the browser tab** starts a new `claude` process; with `CLAUDE_CONTINUE=1` (default) it reopens the seat's last conversation. Each open tab gets its own Claude process, so keep one tab per seat.

## 5. Wipe after the event

```sh
docker compose down -v
```

Removes all 8 volumes: kit folders, apiKeys, chat history and the Claude logins. Kid laptops hold nothing. Deleting the volumes does **not** revoke the event account's login token on Anthropic's side (any seat could have read it): sign the event account out of all sessions (or change its password) after the event. Also run `npm run wipe` (or admin Wipe) on the game server. Optionally `docker image rm pixel-clash-seat:local`.

## 6. Options (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PIXEL_CLASH_URL` | (required) | Game server base URL, `http://<ip>:<port>` |
| `TTYD_PASS_1`..`4` | (required) | Basic-auth word per seat (user `kid`) |
| `CLAUDE_PERMISSION_MODE` | empty | `acceptEdits` or `plan` passes `--permission-mode` to claude. Decided in the M0 spike; `bypassPermissions` is refused. |
| `CLAUDE_CONTINUE` | `1` | Reopen the last conversation after a restart or reload (`claude --continue`); `0` = always fresh |

## 7. Optional: egress firewall (Linux Docker hosts)

Containers need the game server (LAN) and the internet (Anthropic). Nothing else is required. To stop seats from reaching the rest of the LAN (kid laptops, the router admin page), add rules to Docker's `DOCKER-USER` chain for the seats' bridge `pcseats` (fixed in `docker-compose.yml`). Example with the game server at `192.168.8.10:8080`:

```sh
# Run after `docker compose up` (the bridge must exist). -I 1 inserts at the top,
# so the LAST rule below ends up FIRST. DOCKER-USER runs before Docker's own
# ESTABLISHED/RELATED accept, so the final rule (replies to connections that
# kid laptops opened to the published 768N ports) is required: without it the
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
sudo iptables -I INPUT 1 -i pcseats -m conntrack --ctstate NEW -p tcp --dport 7681:7684 -j REJECT
```

Check with `docker compose run --rm seat1 check` (game server and Anthropic must still be reachable). That only tests outbound traffic, so also check inbound: from a kid laptop, open `http://<claude-box>:7681`, log in with the seat word and type to Claude. `sudo iptables -L DOCKER-USER -n --line-numbers` must show the `ESTABLISHED,RELATED` rule as line 1. The rules disappear on reboot unless saved (`iptables-save`/`netfilter-persistent`). Allowing only `api.anthropic.com` and `claude.ai` by name needs an HTTPS proxy; port 443 to the internet is the practical middle ground. On Docker Desktop (macOS/Windows) these rules don't apply; rely on the router instead.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose` says `set PIXEL_CLASH_URL` / `set TTYD_PASS_N` | Create `.env` from `.env.example` in this folder. |
| A seat keeps restarting | `docker compose logs seatN`. The entrypoint prints a clear `ERROR:` (bad `PIXEL_CLASH_URL`, missing or bad `TTYD_PASS`). |
| Browser shows 401 / asks again for a password | Wrong seat word. User is `kid`. |
| Terminal opens but Claude asks to log in, or shows the trust dialog | That seat wasn't logged in or trusted: do step 2 for it, then `docker compose restart seatN`. |
| Claude says the pixel-clash tools are missing | `docker compose run --rm seatN check`: is the game server reachable? Is `.mcp.json` pointing at the right IP? In the seat, Claude can type `/mcp` to see the server status. Meanwhile Claude falls back to the `curl` commands in CLAUDE.md. |
| Kid sees an approval prompt | Note which tool it was. Add the rule to `packages/starter-kit/.claude/settings.json.tmpl` (or set `CLAUDE_PERMISSION_MODE=acceptEdits`), `docker compose up -d --build`. |
| `anthropic api: NOT reachable` | The Claude box or router has no internet uplink (venue Wi-Fi with captive portal?). |
| `game server: NOT reachable` | Wrong IP in `.env`, the game server isn't running on `0.0.0.0`, or its firewall blocks 8080. Containers can't reach a game server that only listens on `localhost`. |
| Build fails at `sha256sum` | The ttyd download changed or was corrupted: don't skip the check; retry, or re-pin `TTYD_VERSION` with the new release's `SHA256SUMS`. |
| Build fails with `Unsupported TARGETARCH` | Use BuildKit (default in current Docker; or `DOCKER_BUILDKIT=1`). Only amd64 and arm64 are supported. |
| Seat is slow / killed | `docker stats`: each seat is capped at 2 GB RAM and 1.5 CPU. Close extra tabs on that seat (each tab runs its own Claude). |
