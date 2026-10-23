#!/usr/bin/env bash
# Pixel Clash seat entrypoint (plan §11.1).
#
#   pixel-clash-seat [serve]     render /kit, then exec ttyd (the default)
#   pixel-clash-seat claude-loop the program ttyd runs: claude, restarted if it exits
#   pixel-clash-seat render      render /kit and exit
#   pixel-clash-seat check       print versions, kit state and game-server reachability
#   pixel-clash-seat new-player     forget the seat's player (empties /kit, chat history, approvals)
#   pixel-clash-seat <cmd...>    render /kit, then exec <cmd> (e.g. `claude` for the adult login)
#
# Environment:
#   PIXEL_CLASH_URL   game server base URL, e.g. http://192.168.8.10:8080 (required)
#   TTYD_PASS         basic-auth word for this seat's terminal (required for serve)
#   TTYD_USER         basic-auth user (default: player)
#   SEAT              seat number, shown in the terminal title (default: ?)
#   CLAUDE_PERMISSION_MODE  optional: default | acceptEdits | plan (M0 spike decides)
#   CLAUDE_CONTINUE   1 (default) = reopen the seat's last conversation after a
#                     restart or page reload; 0 = always start fresh
#   PC_KIT_DIR, PC_TEMPLATE_DIR  paths (set in the Dockerfile; overridable for local tests)
set -euo pipefail

KIT_DIR="${PC_KIT_DIR:-/kit}"
TEMPLATE_DIR="${PC_TEMPLATE_DIR:-/opt/pixel-clash/starter-kit}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-/home/player}/.claude}"
SEAT="${SEAT:-?}"

log() { printf '[seat %s] %s\n' "$SEAT" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

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
      "$src" >"$tmp"
  if grep -q '{{[A-Z_]*}}' "$tmp"; then
    log "warning: unfilled placeholder in ${dest#"$KIT_DIR"/}: $(grep -o '{{[A-Z_]*}}' "$tmp" | sort -u | tr '\n' ' ')"
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
}

# Copy the starter kit into /kit. Kit files (CLAUDE.md, .mcp.json, settings,
# PROMPTS.md) are re-rendered on every start so a new PIXEL_CLASH_URL takes
# effect. .claude/settings.local.json ("don't ask again" approvals) is deleted
# so the rendered settings.json is the only allowlist. Never touched:
# .pixel-clash/player.json and anything already in units/.
render_kit() {
  local host rel src dest
  [ -d "$TEMPLATE_DIR" ] || die "starter-kit templates not found at $TEMPLATE_DIR"
  [ -w "$KIT_DIR" ] || die "$KIT_DIR is not writable by $(id -un 2>/dev/null || id -u)"
  host="$(kit_host)"
  mkdir -p "$KIT_DIR/.pixel-clash" "$KIT_DIR/units"
  rm -f "$KIT_DIR/.claude/settings.local.json"

  while IFS= read -r -d '' src; do
    rel="${src#"$TEMPLATE_DIR"/}"
    case "$rel" in
      .pixel-clash/*) continue ;; # Claude writes player.json here after login
      units/*)
        dest="$KIT_DIR/$rel"
        if [ ! -e "$dest" ]; then
          mkdir -p "$(dirname "$dest")"
          cp "$src" "$dest" && chmod 0644 "$dest"
        fi
        continue
        ;;
    esac
    dest="$KIT_DIR/${rel%.tmpl}"
    mkdir -p "$(dirname "$dest")"
    render_file "$src" "$dest" "$host"
  done < <(find "$TEMPLATE_DIR" -type f -print0)

  log "kit rendered in $KIT_DIR for http://$host"
}

serve() {
  [ -n "${TTYD_PASS:-}" ] || die "TTYD_PASS is not set. Put TTYD_PASS_${SEAT} in sessions/.env (a short word for the seat card)."
  [[ "${TTYD_PASS}" =~ ^[^[:space:]:]+$ ]] || die "TTYD_PASS must be one word with no spaces or ':'"
  local user="${TTYD_USER:-player}"
  render_kit
  log "ttyd on :7781 (user '$user'); claude starts in $KIT_DIR"
  # -W writable, -O same-origin websockets only, -c basic auth, -w start dir.
  # Each browser connection gets its own claude-loop (and so its own claude).
  exec ttyd -W -O -p 7781 -w "$KIT_DIR" \
    -c "${user}:${TTYD_PASS}" \
    -t fontSize=18 \
    -t "titleFixed=Pixel Clash seat ${SEAT}" \
    -t disableLeaveAlert=true \
    /usr/local/bin/pixel-clash-seat claude-loop
}

# What the player's terminal runs: claude, forever. This is not a security
# boundary (Claude Code's `!` prefix runs commands); the container is.
claude_loop() {
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
  while true; do
    if [ "${CLAUDE_CONTINUE:-1}" = 1 ] && compgen -G "$(project_history_dir)/*.jsonl" >/dev/null; then
      # Reopen the last conversation (page reload, ttyd reconnect, restart).
      claude --continue "${args[@]}" || claude "${args[@]}" || true
    else
      claude "${args[@]}" || true
    fi
    printf '\r\nClaude stopped. Starting it again...\r\n'
    sleep 1
  done
}

check() {
  local host status
  echo "seat:            $SEAT"
  echo "claude:          $(claude --version 2>/dev/null || echo MISSING)"
  echo "ttyd:            $(ttyd --version 2>/dev/null || echo MISSING)"
  host="$(kit_host)"
  echo "game server:     http://$host"
  if [ -f "$KIT_DIR/CLAUDE.md" ] && [ -f "$KIT_DIR/.mcp.json" ]; then
    echo "kit:             rendered ($(grep -o 'http://[^"]*/mcp' "$KIT_DIR/.mcp.json" | head -n1))"
  else
    echo "kit:             NOT rendered yet"
  fi
  if [ -f "$KIT_DIR/.pixel-clash/player.json" ]; then
    echo "player:          logged in (.pixel-clash/player.json exists)"
  else
    echo "player:          none yet (the player tells Claude their name + PIN)"
  fi
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
  if status="$(curl -fsS --max-time 5 "http://$host/api/health" 2>&1)"; then
    echo "game server:     reachable: $status"
  else
    echo "game server:     NOT reachable from this container: $status"
  fi
  if curl -sS -o /dev/null --max-time 5 https://api.anthropic.com/ 2>/dev/null; then
    echo "anthropic api:   reachable"
  else
    echo "anthropic api:   NOT reachable (check the Claude box's internet)"
  fi
}

# Forget the previous player on this seat. Keeps the Claude login and folder trust.
new_player() {
  # Everything in /kit is re-rendered below: the old key (.pixel-clash/), their
  # unit files (the designs stay on the game server), saved approvals
  # (.claude/settings.local.json) and anything else Claude created.
  find "${KIT_DIR:?}" -mindepth 1 -delete
  rm -rf "$(project_history_dir)" "$CONFIG_DIR/file-history" "$CONFIG_DIR/todos"
  rm -f "$CONFIG_DIR/history.jsonl"
  render_kit
  log "seat cleared for a new player. Now run: docker compose restart seat${SEAT}"
}

cmd="${1:-serve}"
case "$cmd" in
  serve) serve ;;
  claude-loop) claude_loop ;;
  render) render_kit ;;
  check) check ;;
  new-player) new_player ;;
  *)
    render_kit
    cd "$KIT_DIR"
    exec "$@"
    ;;
esac
