# syntax=docker/dockerfile:1
#
# Pixel Clash "AI session host" seat image.
#
# One container per seat runs ttyd, which starts the seat's coding agent
# (Claude Code, or OpenAI Codex CLI with AGENT=codex) straight in the seat's
# kit folder (/kit). The terminal opens straight into the agent, but that is
# not a shell barrier (both agents can run commands): the container is the
# boundary.
#
# Build context is the REPO ROOT (see docker-compose.yml) so the starter-kit
# templates in packages/starter-kit can be copied in. Only the files allowed by
# Dockerfile.dockerignore (next to this file) are sent to the builder.
#
# Everything is pinned. To bump a version, change the ARG and rebuild:
#   docker compose build --no-cache

# Node 22 LTS, pinned by exact version tag (released 2026-09-23).
# For a fully reproducible build, also pin the digest: node:22.23.3-slim@sha256:...
FROM node:22.23.3-slim

# Claude Code from npm, pinned (2.1.290, released 2026-10-05: >= 2 weeks old on
# 2026-10-20). The npm package installs a native per-platform binary.
ARG CLAUDE_CODE_VERSION=2.1.290

# OpenAI Codex CLI from npm, pinned (0.162.1, released 2026-10-09: >= 2 weeks
# old on 2026-10-24). The npm package pulls a native per-platform binary.
ARG CODEX_VERSION=0.162.1

# ttyd static binary from the official GitHub release, verified by SHA-256
# (values from the release's SHA256SUMS file).
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

# Set automatically by BuildKit (amd64 or arm64).
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# curl: health check, the CLAUDE.md curl fallback, and the ttyd download.
# ca-certificates: HTTPS to Anthropic and GitHub.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "${TARGETARCH:-}" in \
      amd64) ttyd_arch=x86_64;  ttyd_sha="${TTYD_SHA256_AMD64}" ;; \
      arm64) ttyd_arch=aarch64; ttyd_sha="${TTYD_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH '${TARGETARCH:-}' (need amd64 or arm64; build with BuildKit)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}"; \
    echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && claude --version \
 && codex --version

# Non-root user. /kit and the Claude and Codex config dirs are created here and
# owned by "player" so the named volumes mounted on them start with the right owner.
RUN useradd --create-home --uid 10001 --user-group --shell /bin/bash player \
 && mkdir -p /kit /home/player/.claude /home/player/.codex \
 && chown player:player /kit /home/player/.claude /home/player/.codex

# Managed settings (root-owned, so player-writable user/project settings can't
# widen them): no bypassPermissions mode, and Claude may not read the login.
RUN mkdir -p /etc/claude-code \
 && printf '%s\n' '{' \
      '  "permissions": {' \
      '    "disableBypassPermissionsMode": "disable",' \
      '    "deny": ["Read(//home/player/.claude/.credentials.json)", "Edit(//home/player/.claude/**)", "Edit(//kit/.claude/**)"]' \
      '  }' \
      '}' >/etc/claude-code/managed-settings.json \
 && chmod 0644 /etc/claude-code/managed-settings.json

# Codex system config (root-owned): /kit is a trusted project, so Codex loads
# the kit's .codex/config.toml (MCP server, pre-approved game tools) with no
# trust question, and the pinned version never offers an update. The seat's
# sandbox and approval policy are command-line flags (entrypoint.sh codex_loop).
RUN mkdir -p /etc/codex \
 && printf '%s\n' \
      'check_for_update_on_startup = false' \
      '' \
      '[projects."/kit"]' \
      'trust_level = "trusted"' >/etc/codex/config.toml \
 && chmod 0644 /etc/codex/config.toml

# Kit templates (read-only, owned by root) and the entrypoint.
COPY packages/starter-kit/ /opt/pixel-clash/starter-kit/
COPY sessions/entrypoint.sh /usr/local/bin/pixel-clash-seat
RUN chmod -R a+rX,go-w /opt/pixel-clash \
 && chmod 0755 /usr/local/bin/pixel-clash-seat

# CLAUDE_CONFIG_DIR keeps ALL Claude Code state (login, trust, .claude.json,
# chat history) inside the claudeN volume, CODEX_HOME all Codex state (login,
# chats) inside the codexN volume. DISABLE_AUTOUPDATER keeps the pinned version.
ENV HOME=/home/player \
    SHELL=/bin/bash \
    CLAUDE_CONFIG_DIR=/home/player/.claude \
    CODEX_HOME=/home/player/.codex \
    DISABLE_AUTOUPDATER=1 \
    PC_KIT_DIR=/kit \
    PC_TEMPLATE_DIR=/opt/pixel-clash/starter-kit

USER player
WORKDIR /kit
EXPOSE 7781

# ttyd serves under its base path /terminal/$SEAT/ and answers 401 there
# without the seat password; 200 or 401 means it is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:7781/terminal/${SEAT}/")" && { [ "$code" = 200 ] || [ "$code" = 401 ]; }

ENTRYPOINT ["/usr/local/bin/pixel-clash-seat"]
CMD ["serve"]
