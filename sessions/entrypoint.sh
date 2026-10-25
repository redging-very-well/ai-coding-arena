#!/usr/bin/env bash
# Pixel Clash seat entrypoint (plan §11.1).
#
#   pixel-clash-seat [serve]     render /kit, then exec ttyd (the default)
#   pixel-clash-seat agent-loop [token]
#                                the program ttyd runs: claude or codex, restarted if it exits
#                                (claude-loop is an old name for it). token = the seat's player
#                                (from the game server's proxy, via ttyd -a; see seat_start_mode)
#   pixel-clash-seat render      render /kit and exit
#   pixel-clash-seat check       print versions, kit state and game-server reachability
#   pixel-clash-seat new-player     forget the seat's player (empties /kit, chat history, approvals)
#   pixel-clash-seat first-prompt   print the message a new player's agent starts with
#   pixel-clash-seat <cmd...>    render /kit, then exec <cmd> (e.g. `claude` or `codex login` for the adult login)
#
# Environment:
#   PIXEL_CLASH_URL   game server base URL, e.g. http://192.168.8.10:8080 (required)
#   TTYD_PASS         the shared seat password (SEAT_SECRET in sessions/.env, the
#                     same value as /admin -> Claude seats); required for serve
#   TTYD_USER         basic-auth user (default: player)
#   SEAT              seat number 1-8: ttyd base path /terminal/$SEAT and the title
#   AGENT             claude (default) or codex: which coding agent this seat runs (§11.3)
#   SEAT_AGENT        optional per-seat override of AGENT (SEAT_AGENT_N in sessions/.env)
#   CODEX_SANDBOX     codex only: danger-full-access (default; the container is the
#                     boundary, see README) or workspace-write (needs user namespaces)
#   CODEX_APPROVAL    codex only: never (default) | on-request | untrusted
#   OPENAI_API_KEY    codex only, optional: log this seat's Codex in with an API key
#                     on start (if it isn't logged in yet); never passed to codex
#   CLAUDE_PERMISSION_MODE  optional: default | acceptEdits | plan (M0 spike decides)
#   CLAUDE_CONTINUE   1 (default) = reopen the seat's last conversation after a
#                     restart or page reload; 0 = always start fresh. A NEW player
#                     always starts fresh, with FIRST_PROMPT.md as the first message
#   PC_KIT_DIR, PC_TEMPLATE_DIR  paths (set in the Dockerfile; overridable for local tests)
set -euo pipefail

KIT_DIR="${PC_KIT_DIR:-/kit}"
TEMPLATE_DIR="${PC_TEMPLATE_DIR:-/opt/pixel-clash/starter-kit}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-/home/player}/.claude}"
CODEX_DIR="${CODEX_HOME:-${HOME:-/home/player}/.codex}"
SEAT="${SEAT:-?}"
AGENT="${SEAT_AGENT:-${AGENT:-claude}}"
AGENT="${AGENT,,}"

log() { printf '[seat %s] %s\n' "$SEAT" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

case "$AGENT" in
  claude) AGENT_NAME=Claude; INSTRUCTIONS=CLAUDE.md ;;
  codex) AGENT_NAME=Codex; INSTRUCTIONS=AGENTS.md ;;
  *) die "AGENT must be claude or codex (got '$AGENT'); set AGENT or SEAT_AGENT_$SEAT in sessions/.env" ;;
esac

# Which agent a kit file belongs to (path after .tmpl is removed): claude,
# codex or both. CLAUDE.md is the instructions for both (AGENTS.md for Codex).
# Same rule as kitFileAgent() in packages/server/src/services/kit.ts.
kit_file_agent() {
  case "$1" in
    CLAUDE.md | .mcp.json | .claude/*) echo claude ;;
    .codex/*) echo codex ;;
    *) echo both ;;
  esac
}

# Claude Code keeps per-folder history under projects/<path with / -> ->.
project_history_dir() { printf '%s/projects/%s' "$CONFIG_DIR" "${KIT_DIR//[^A-Za-z0-9]/-}"; }

# PIXEL_CLASH_URL -> host[:port] for {{HOST}} (the kit adds http:// and /mcp).
kit_host() {
  local url="${PIXEL_CLASH_URL:-}"
  [ -n "$url" ] || die "PIXEL_CLASH_URL is not set. Put it in sessions/.env, e.g. PIXEL_CLASH_URL=http://192.168.8.10:8080"
  case "$url" in
    https://*) die "PIXEL_CLASH_URL must be http:// (the game server is plain HTTP on the LAN): $url" ;;
    http://*) url="${url#http://}" ;;
    *://*) die "PIXEL_CLASH_URL must start with http://: $url" ;;
  esac
  url="${url%%/*}" # drop any path such as /play or a trailing slash
  [[ "$url" =~ ^[A-Za-z0-9.-]+(:[0-9]{1,5})?$ || "$url" =~ ^\[[0-9A-Fa-f:.]+\](:[0-9]{1,5})?$ ]] \
    || die "PIXEL_CLASH_URL has an unexpected host part '$url' (want e.g. http://192.168.8.10:8080)"
  printf '%s' "$url"
}

# Fill placeholders. HOST is validated above, so it is safe in a sed replacement.
render_file() { # <src> <dest> <host>
  local src="$1" dest="$2" host="$3" tmp
  tmp="$(mktemp "${dest}.XXXXXX")"
  sed -e "s|{{HOST}}|${host}|g" \
      -e "s|{{PLAYER_NAME}}|(not logged in yet: see below)|g" \
      -e "s|{{AGENT_NAME}}|${AGENT_NAME}|g" \
      "$src" >"$tmp"
  if grep -q '{{[A-Z_]*}}' "$tmp"; then
    log "warning: unfilled placeholder in ${dest#"$KIT_DIR"/}: $(grep -o '{{[A-Z_]*}}' "$tmp" | sort -u | tr '\n' ' ')"
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
}

# Copy the starter kit into /kit for this seat's agent. Kit files (CLAUDE.md
# or AGENTS.md, .mcp.json + .claude/settings.json or .codex/config.toml,
# PROMPTS.md) are re-rendered on every start so a new PIXEL_CLASH_URL takes
# effect, and the other agent's files are removed (a seat can switch agent).
# .claude/settings.local.json ("don't ask again" approvals) is deleted so the
# rendered settings.json is the only allowlist. Never touched:
# .pixel-clash/player.json and anything already in units/.
render_kit() {
  local host rel src dest owner
  [ -d "$TEMPLATE_DIR" ] || die "starter-kit templates not found at $TEMPLATE_DIR"
  [ -w "$KIT_DIR" ] || die "$KIT_DIR is not writable by $(id -un 2>/dev/null || id -u)"
  host="$(kit_host)"
  mkdir -p "$KIT_DIR/.pixel-clash" "$KIT_DIR/units"
  rm -f "$KIT_DIR/.claude/settings.local.json"
  if [ "$AGENT" = codex ]; then
    rm -rf "$KIT_DIR/.claude" "$KIT_DIR/.mcp.json" "$KIT_DIR/CLAUDE.md"
  else
    rm -rf "$KIT_DIR/.codex" "$KIT_DIR/AGENTS.md"
  fi

  while IFS= read -r -d '' src; do
    rel="${src#"$TEMPLATE_DIR"/}"
    case "$rel" in
      .pixel-clash/*) continue ;; # Claude writes player.json here after login
      FIRST_PROMPT.md.tmpl) continue ;; # seat-only: sent by agent-loop, not a kit file
      units/*)
        dest="$KIT_DIR/$rel"
        if [ ! -e "$dest" ]; then
          mkdir -p "$(dirname "$dest")"
          cp "$src" "$dest" && chmod 0644 "$dest"
        fi
        continue
        ;;
    esac
    rel="${rel%.tmpl}"
    owner="$(kit_file_agent "$rel")"
    if [ "$rel" = CLAUDE.md ]; then
      rel="$INSTRUCTIONS"
    elif [ "$owner" != both ] && [ "$owner" != "$AGENT" ]; then
      continue
    fi
    dest="$KIT_DIR/$rel"
    mkdir -p "$(dirname "$dest")"
    render_file "$src" "$dest" "$host"
  done < <(find "$TEMPLATE_DIR" -type f -print0)

  log "kit for $AGENT_NAME rendered in $KIT_DIR for http://$host"
}

serve() {
  [[ "$SEAT" =~ ^[1-8]$ ]] || die "SEAT must be 1-8 (got '$SEAT'); it sets the base path /terminal/\$SEAT"
  [ -n "${TTYD_PASS:-}" ] || die "TTYD_PASS is not set. Put SEAT_SECRET=<password> in sessions/.env (compose passes it as TTYD_PASS)."
  [[ "${TTYD_PASS}" =~ ^[A-Za-z0-9._~-]{12,64}$ ]] \
    || die "SEAT_SECRET must be 12-64 characters of A-Z a-z 0-9 . _ ~ - (no spaces or ':'), e.g. otter-lamp-quartz-ninety"
  local user="${TTYD_USER:-player}" base="/terminal/${SEAT}"
  render_kit
  [ "$AGENT" = codex ] && codex_api_key_login
  # The API key is only for the login above: the player's agent never sees it.
  unset OPENAI_API_KEY
  log "ttyd on :7781${base}/ (user '$user'); $AGENT starts in $KIT_DIR"
  # -W writable, -O same-origin websockets only (the game server's proxy
  # rewrites Origin/Host to pass it), -b base path so the page, token and ws
  # all live under /terminal/N/ (behind the proxy and directly), -c basic auth,
  # -w start dir. Each browser connection gets its own agent-loop (and so its
  # own claude or codex); the proxy keeps one live terminal per seat (plan §11.2).
  # -a: a `?arg=<token>` on the WebSocket URL becomes agent-loop's argument
  # (argv, no shell). Only the proxy sets it, for the seat's player; agent-loop
  # accepts nothing but 32 hex digits (seat_start_mode).
  exec ttyd -W -O -a -p 7781 -b "$base" -w "$KIT_DIR" \
    -c "${user}:${TTYD_PASS}" \
    -t fontSize=18 \
    -t "titleFixed=Pixel Clash · ${AGENT_NAME} · seat ${SEAT}" \
    -t disableLeaveAlert=true \
    /usr/local/bin/pixel-clash-seat agent-loop
}

# Optional: OPENAI_API_KEY in sessions/.env logs a not-yet-logged-in Codex
# seat in with that key (stored in the seat's codexN volume). An existing
# login (ChatGPT or key) is kept.
codex_api_key_login() {
  [ -n "${OPENAI_API_KEY:-}" ] || return 0
  if codex login status >/dev/null 2>&1; then return 0; fi
  if printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1; then
    log "codex logged in with OPENAI_API_KEY"
  else
    log "warning: codex login --with-api-key failed (check OPENAI_API_KEY)"
  fi
}

# Codex keeps its chats under $CODEX_HOME/sessions.
codex_has_history() { [ -n "$(find "$CODEX_DIR/sessions" -type f -name '*.jsonl' -print -quit 2>/dev/null)" ]; }
claude_has_history() { compgen -G "$(project_history_dir)/*.jsonl" >/dev/null; }
agent_has_history() { if [ "$AGENT" = codex ]; then codex_has_history; else claude_has_history; fi; }

# --- Which player the seat serves (plan §11.2 e) ------------------------------
# The game server's proxy adds ?arg=<token> to the ttyd WebSocket only for the
# seat's assigned player (never for an admin rescue). ttyd -a passes it to
# `agent-loop <token>`. The token is opaque: 32 hex digits, a hash of the seat
# and the player's id. It is only compared and written to a file, never put in
# a command; anything else is ignored (as if there were no token).
PLAYER_TOKEN_RE='^[a-f0-9]{32}$'
last_player_file() { printf '%s/.pixel-clash/last-player' "$KIT_DIR"; }

# How this terminal's agent starts. Prints one word:
#   new-player  token differs from the last one (or none stored yet): forget the
#               previous player, fresh conversation with FIRST_PROMPT.md
#   prompt      same player, but no conversation exists: fresh with FIRST_PROMPT.md
#   resume      reopen the last conversation (CLAUDE_CONTINUE=1 and one exists)
#   fresh       new conversation, no prompt
# No token (admin rescue, a direct box:778N tab, the restart after the agent
# exits) never prompts: resume or fresh as before.
seat_start_mode() { # [token]
  local token="${1:-}" last='' file
  file="$(last_player_file)"
  if [ -n "$token" ] && ! [[ "$token" =~ $PLAYER_TOKEN_RE ]]; then
    log "ignoring a malformed player token"
    token=''
  fi
  if [ -n "$token" ]; then
    [ -f "$file" ] && last="$(head -c 64 "$file" | tr -cd 'a-f0-9')"
    if [ "$token" != "$last" ]; then echo new-player; return; fi
    if ! agent_has_history; then echo prompt; return; fi
  fi
  if [ "${CLAUDE_CONTINUE:-1}" = 1 ] && agent_has_history; then echo resume; else echo fresh; fi
}

# Forget the seat's chats, for both agents (a seat can switch agent): Claude's
# project history, typed-prompt history (it holds the PIN the player typed),
# file-history and todos; Codex's sessions and prompt history. Logins are kept.
forget_chats() {
  rm -rf "$(project_history_dir)" "$CONFIG_DIR/file-history" "$CONFIG_DIR/todos"
  rm -f "$CONFIG_DIR/history.jsonl"
  rm -rf "$CODEX_DIR/sessions" "$CODEX_DIR/archived_sessions"
  rm -f "$CODEX_DIR/history.jsonl"
}

# A different player took the seat: the previous player's key
# (.pixel-clash/player.json) and chats must not reach them. Their unit files in
# units/ stay (`new-player` clears everything).
switch_player() { # <validated token>
  local file tmp
  file="$(last_player_file)"
  mkdir -p "$(dirname "$file")"
  rm -f "$KIT_DIR/.pixel-clash/player.json"
  forget_chats
  tmp="$(mktemp "${file}.XXXXXX")"
  printf '%s\n' "$1" >"$tmp"
  mv -f "$tmp" "$file"
  log "a new player sat down: previous login and chats cleared, sending the first prompt"
}

# The first message for a new player (packages/starter-kit/FIRST_PROMPT.md.tmpl,
# read from the root-owned templates, not /kit). Empty if it is missing.
first_prompt() {
  local src="$TEMPLATE_DIR/FIRST_PROMPT.md.tmpl"
  [ -f "$src" ] || { log "warning: $src is missing; starting without a first prompt"; return 0; }
  sed -e "s|{{AGENT_NAME}}|${AGENT_NAME}|g" "$src"
}

# Start mode for this connection, after acting on a new player. Sets MODE and PROMPT.
begin_agent() { # [token]
  MODE="$(seat_start_mode "${1:-}")"
  PROMPT=''
  if [ "$MODE" = new-player ]; then switch_player "$1"; fi
  if [ "$MODE" = new-player ] || [ "$MODE" = prompt ]; then
    PROMPT="$(first_prompt)"
    [ -n "$PROMPT" ] || MODE=fresh
  fi
}

# What the player's terminal runs on a Codex seat: codex in /kit, forever.
# The kit's .codex/config.toml pre-approves the pixel-clash tools; the flags
# here set the seat's sandbox and approval policy (they win over the kit file).
codex_loop() { # [token]
  local sandbox="${CODEX_SANDBOX:-danger-full-access}" approval="${CODEX_APPROVAL:-never}"
  case "$sandbox" in
    danger-full-access | workspace-write) ;;
    *) log "ignoring CODEX_SANDBOX='$sandbox' (allowed: danger-full-access, workspace-write)"; sandbox=danger-full-access ;;
  esac
  case "$approval" in
    never | on-request | untrusted) ;;
    *) log "ignoring CODEX_APPROVAL='$approval' (allowed: never, on-request, untrusted)"; approval=never ;;
  esac
  local -a args=(--sandbox "$sandbox" --ask-for-approval "$approval")
  trap ':' INT QUIT
  cd "$KIT_DIR"
  begin_agent "${1:-}"
  while true; do
    case "$MODE" in
      # The prompt is one argv entry: codex [OPTIONS] [PROMPT].
      new-player | prompt) codex "${args[@]}" "$PROMPT" || true ;;
      # Reopen the last conversation (page reload, ttyd reconnect, restart).
      resume) codex resume --last "${args[@]}" || codex "${args[@]}" || true ;;
      *) codex "${args[@]}" || true ;;
    esac
    printf '\r\nCodex stopped. Starting it again...\r\n'
    sleep 1
    MODE="$(seat_start_mode)"
  done
}

# What the player's terminal runs: claude, forever. This is not a security
# boundary (Claude Code's `!` prefix runs commands); the container is.
claude_loop() { # [token]
  local -a args=()
  case "${CLAUDE_PERMISSION_MODE:-}" in
    '' | default) ;;
    acceptEdits | plan) args+=(--permission-mode "$CLAUDE_PERMISSION_MODE") ;;
    *) log "ignoring CLAUDE_PERMISSION_MODE='${CLAUDE_PERMISSION_MODE}' (allowed: default, acceptEdits, plan)" ;;
  esac
  # A handler (not "ignore") so Ctrl+C between runs can't kill the loop, while
  # claude itself still gets default signal handling.
  trap ':' INT QUIT
  cd "$KIT_DIR"
  begin_agent "${1:-}"
  while true; do
    case "$MODE" in
      # The prompt is one argv entry: `claude [options] [prompt]` starts an
      # interactive session with it as the first message.
      new-player | prompt) claude "${args[@]}" "$PROMPT" || true ;;
      # Reopen the last conversation (page reload, ttyd reconnect, restart).
      resume) claude --continue "${args[@]}" || claude "${args[@]}" || true ;;
      *) claude "${args[@]}" || true ;;
    esac
    printf '\r\nClaude stopped. Starting it again...\r\n'
    sleep 1
    MODE="$(seat_start_mode)"
  done
}

check() {
  local host status
  echo "seat:            $SEAT"
  echo "agent:           $AGENT"
  echo "claude:          $(claude --version 2>/dev/null || echo MISSING)"
  echo "codex:           $(codex --version 2>/dev/null || echo MISSING)"
  echo "ttyd:            $(ttyd --version 2>/dev/null || echo MISSING)"
  host="$(kit_host)"
  echo "game server:     http://$host"
  local mcp_file="$KIT_DIR/.mcp.json"
  [ "$AGENT" = codex ] && mcp_file="$KIT_DIR/.codex/config.toml"
  if [ -f "$KIT_DIR/$INSTRUCTIONS" ] && [ -f "$mcp_file" ]; then
    echo "kit:             rendered for $AGENT_NAME ($(grep -o 'http://[^"]*/mcp' "$mcp_file" | head -n1))"
  else
    echo "kit:             NOT rendered yet for $AGENT_NAME"
  fi
  if [ -f "$KIT_DIR/.pixel-clash/player.json" ]; then
    echo "player:          logged in (.pixel-clash/player.json exists)"
  else
    echo "player:          none yet (the player tells $AGENT_NAME their name + PIN)"
  fi
  if [ "$AGENT" = codex ]; then
    check_codex
  else
    check_claude
  fi
  if status="$(curl -fsS --max-time 5 "http://$host/api/health" 2>&1)"; then
    echo "game server:     reachable: $status"
  else
    echo "game server:     NOT reachable from this container: $status"
  fi
}

check_codex() {
  local status
  if status="$(codex login status 2>&1)"; then
    echo "codex login:     $status"
  else
    echo "codex login:     NOT logged in (docker compose run --rm seat$SEAT codex login --device-auth, or OPENAI_API_KEY; README)"
  fi
  if grep -qs '^\[projects\."/kit"\]' /etc/codex/config.toml; then
    echo "folder trust:    /kit trusted by the image (/etc/codex/config.toml)"
  else
    echo "folder trust:    /kit NOT trusted (rebuild the image: docker compose build)"
  fi
  echo "codex policy:    sandbox ${CODEX_SANDBOX:-danger-full-access}, approvals ${CODEX_APPROVAL:-never}"
  if (cd "$KIT_DIR" && codex sandbox -- true) >/dev/null 2>&1; then
    echo "codex sandbox:   works here (CODEX_SANDBOX=workspace-write is possible)"
  else
    echo "codex sandbox:   not available in this container (keep CODEX_SANDBOX=danger-full-access)"
  fi
  if curl -sS -o /dev/null --max-time 5 https://api.openai.com/ 2>/dev/null; then
    echo "openai api:      reachable"
  else
    echo "openai api:      NOT reachable (check the Claude box's internet)"
  fi
}

check_claude() {
  if [ -f "$CONFIG_DIR/.credentials.json" ] || grep -qs '"oauthAccount"' "$CONFIG_DIR/.claude.json"; then
    echo "claude login:    looks logged in"
  else
    echo "claude login:    NOT logged in (docker compose run --rm seat$SEAT claude, then /login)"
  fi
  if grep -qs '"hasTrustDialogAccepted": *true' "$CONFIG_DIR/.claude.json"; then
    echo "folder trust:    accepted for some folder (should be $KIT_DIR)"
  else
    echo "folder trust:    NOT accepted yet (accept it during the adult login)"
  fi
  if curl -sS -o /dev/null --max-time 5 https://api.anthropic.com/ 2>/dev/null; then
    echo "anthropic api:   reachable"
  else
    echo "anthropic api:   NOT reachable (check the Claude box's internet)"
  fi
}

# Forget the previous player on this seat. Keeps the Claude / Codex login and folder trust.
new_player() {
  # Everything in /kit is re-rendered below: the old key (.pixel-clash/), their
  # unit files (the designs stay on the game server), saved approvals
  # (.claude/settings.local.json) and anything else Claude created.
  # This also removes .pixel-clash/last-player, so the next player to open the
  # terminal through /play gets a fresh conversation and the first prompt.
  find "${KIT_DIR:?}" -mindepth 1 -delete
  rm -rf "$(project_history_dir)" "$CONFIG_DIR/file-history" "$CONFIG_DIR/todos"
  rm -f "$CONFIG_DIR/history.jsonl"
  # Codex: everything but the login (auth.json) and the user config.
  if [ -d "$CODEX_DIR" ]; then
    find "$CODEX_DIR" -mindepth 1 -maxdepth 1 ! -name auth.json ! -name config.toml -exec rm -rf {} +
  fi
  render_kit
  log "seat cleared for a new player. Now run: docker compose restart seat${SEAT}"
}

cmd="${1:-serve}"
case "$cmd" in
  serve) serve ;;
  agent-loop | claude-loop)
    # ttyd -a may add more than one ?arg=: only a single token is accepted.
    token=''
    [ "$#" -eq 2 ] && token="$2"
    if [ "$AGENT" = codex ]; then codex_loop "$token"; else claude_loop "$token"; fi
    ;;
  first-prompt) first_prompt ;;
  render) render_kit ;;
  check) check ;;
  new-player) new_player ;;
  *)
    render_kit
    cd "$KIT_DIR"
    exec "$@"
    ;;
esac
