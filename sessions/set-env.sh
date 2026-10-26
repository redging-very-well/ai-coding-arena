#!/bin/sh
# Write PIXEL_CLASH_URL, SEAT_SECRET and/or AGENT into sessions/.env (plan §11.1).
#
#   PIXEL_CLASH_URL=http://192.168.8.10:8080 SEAT_SECRET=otter-lamp-quartz-ninety \
#     sh sessions/set-env.sh sessions/.env PIXEL_CLASH_URL SEAT_SECRET
#
# The arguments after the file are the NAMES to set; their values come from the
# environment (never from the command line, so make never pastes a value into a
# shell command). The repo Makefile runs it for `make seats PIXEL_CLASH_URL=…
# SEAT_SECRET=… [AGENT=codex]` (the command /admin → AI seats → AI session host setup
# shows; the /admin setup wizard adds AGENT=… for the agent picked there).
#
# - Creates the file from .env.example next to it if it is missing.
# - Replaces every `NAME=…` line, or appends one; all other lines are kept.
# - Validates the values first (nothing is written if one is bad):
#   PIXEL_CLASH_URL  http(s)://host[:port], no path (a trailing / is dropped)
#   SEAT_SECRET      12-64 of A-Z a-z 0-9 . _ ~ - (what ttyd's -c can take)
#   AGENT            claude or codex (SEAT_AGENT_N overrides stay as they are)
# - The file ends up owner-only (0600): it holds the seat password.
#
# POSIX sh + awk only (macOS BSD tools and Linux), no sed -i.

set -eu

die() {
  echo "set-env: $*" >&2
  exit 1
}

[ $# -ge 2 ] || die "usage: set-env.sh ENV_FILE NAME... (values come from the environment)"
file=$1
shift

for name in "$@"; do
  case $name in
    PIXEL_CLASH_URL | SEAT_SECRET | AGENT) ;;
    *) die "unknown setting '$name' (only PIXEL_CLASH_URL, SEAT_SECRET and AGENT)" ;;
  esac
done

# Validate (and normalise the URL) in awk: ENVIRON passes values untouched.
names=$*
checked=$(PC_NAMES=$names awk 'BEGIN {
  n = split(ENVIRON["PC_NAMES"], names, " ")
  for (i = 1; i <= n; i++) {
    k = names[i]; v = ENVIRON[k]
    if (k == "PIXEL_CLASH_URL") {
      sub(/\/$/, "", v)
      if (length(v) > 270 || v !~ /^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?$/) {
        print "PIXEL_CLASH_URL must look like http://192.168.8.10:8080 (the game server LAN address, no path)" > "/dev/stderr"; bad = 1
      }
    } else if (k == "SEAT_SECRET") {
      if (length(v) < 12 || length(v) > 64 || v !~ /^[A-Za-z0-9._~-]+$/) {
        print "SEAT_SECRET must be 12-64 characters of A-Z a-z 0-9 . _ ~ - (copy it from /admin -> AI seats)" > "/dev/stderr"; bad = 1
      }
    } else if (k == "AGENT") {
      if (v != "claude" && v != "codex") {
        print "AGENT must be claude or codex" > "/dev/stderr"; bad = 1
      }
    }
    out = out k "=" v "\n"
  }
  if (bad) exit 1
  printf "%s", out
}') || die "nothing was written to $file"

dir=$(dirname "$file")
if [ ! -f "$file" ]; then
  [ -f "$dir/.env.example" ] || die "$file and $dir/.env.example are both missing"
  src=$dir/.env.example
  created=1
else
  src=$file
  created=0
fi

umask 077
tmp=$(mktemp "$dir/.env.XXXXXX") || die "can't create a temporary file in $dir"
trap 'rm -f "$tmp"' EXIT HUP INT TERM

# The validated NAME=value lines arrive on stdin (values never reach argv).
printf '%s\n' "$checked" | awk '
  NR == FNR { if ($0 != "") { i = index($0, "="); want[substr($0, 1, i - 1)] = $0; order[++n] = substr($0, 1, i - 1) } next }
  {
    line = $0; sub(/\r$/, "", line)
    i = index(line, "=")
    k = i > 0 ? substr(line, 1, i - 1) : ""
    if (k in want) { print want[k]; done[k] = 1; next }
    print $0
  }
  END { for (j = 1; j <= n; j++) if (!(order[j] in done)) print want[order[j]] }
' - "$src" >"$tmp"

chmod 600 "$tmp"
mv -f "$tmp" "$file"
trap - EXIT HUP INT TERM

if [ "$created" = 1 ]; then
  echo "Created $file from .env.example and set: $names"
else
  echo "Updated $file: $names"
fi
