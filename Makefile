# Pixel Clash: shortcuts for the game server and the AI seats.
#
# The game server (npm scripts in package.json) and the AI seats (Docker
# Compose in sessions/) usually run on DIFFERENT machines: run the server
# targets on the game server laptop and the seats-* / seat-* targets on the
# Claude box. See README.md and sessions/README.md.
#
# Works with GNU make 3.81 (macOS) and newer (Linux). `make` alone lists the
# targets.

.DEFAULT_GOAL := help

COMPOSE := cd sessions && docker compose

# Which seats a seats-* target acts on (default: all eight):
#   SEAT=3          one seat
#   N=6             seats 1..6
#   SEATS="1 2 5"   a list
ifdef SEAT
SEAT_SERVICES := seat$(SEAT)
else
ifdef SEATS
SEAT_SERVICES := $(addprefix seat,$(SEATS))
else
ifdef N
SEAT_SERVICES := $(addprefix seat,$(shell seq 1 $(N)))
endif
endif
endif

# Per-seat targets need SEAT=n.
need_seat = $(if $(SEAT),,$(error Set SEAT=n, e.g. make $@ SEAT=3))

.PHONY: help install build start dev test typecheck wipe bots balance \
        seats-env seats-build seats seats-up seats-stop seats-restart seats-down \
        seats-logs seats-ps seats-wipe seat-login seat-login-codex seat-check \
        new-player

help: ## Show this list
	@echo "Pixel Clash make targets"
	@echo ""
	@echo "Game server (run on the game server laptop):"
	@awk 'BEGIN {FS = ":.*## "} /^[a-z][a-zA-Z0-9_-]*:.*## / && !/^(seat|new-player)/ {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "AI seats (run on the Claude box; wraps docker compose in sessions/):"
	@awk 'BEGIN {FS = ":.*## "} /^(seat|new-player)[a-zA-Z0-9_-]*:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Pick seats with SEAT=3 (one), N=6 (seats 1-6) or SEATS=\"1 2 5\"; default all 8."
	@echo "Examples: make seats N=4   make seat-login SEAT=2   make new-player SEAT=5"

# ---------------------------------------------------------------- game server

install: ## Install dependencies exactly from package-lock.json (npm ci)
	npm ci

build: ## Build shared, server and client (npm run build)
	npm run build

start: ## Start the built server on 0.0.0.0:8080 (npm start; PORT, ADMIN_PASSWORD env)
	npm start

dev: ## Dev mode: server under tsx watch + Vite dev server (npm run dev)
	npm run dev

test: ## Run the test suite and the perf check (npm test)
	npm test

typecheck: ## Type-check server, shared and client (npm run typecheck)
	npm run typecheck

wipe: ## Delete data/ (players, units, replays) on the game server (npm run wipe)
	npm run wipe

bots: ## Join template bot players for a rehearsal (PLAYERS=3)
	npm run bots -- --players $(or $(PLAYERS),3)

balance: ## Fast balance report (npm run balance; ARGS="--fast" etc.)
	npm run balance -- $(ARGS)

# ------------------------------------------------------------------- AI seats

seats-env: ## Create sessions/.env from .env.example (then edit it)
	@if [ -f sessions/.env ]; then echo "sessions/.env already exists"; \
	else cp sessions/.env.example sessions/.env && \
	echo "Created sessions/.env: set PIXEL_CLASH_URL and SEAT_SECRET in it"; fi

seats-build: ## Build the seat image (docker compose build)
	$(COMPOSE) build

seats: seats-up ## Same as seats-up

seats-up: ## Build if needed and start seats (all, or N=6 / SEATS="1 2" / SEAT=3)
	@[ -f sessions/.env ] || { echo "sessions/.env is missing: run 'make seats-env' and edit it"; exit 1; }
	$(COMPOSE) up -d --build $(SEAT_SERVICES)

seats-stop: ## Stop seats, keeping containers and volumes (docker compose stop)
	$(COMPOSE) stop $(SEAT_SERVICES)

seats-restart: ## Restart seats, e.g. after logging in (docker compose restart)
	$(COMPOSE) restart $(SEAT_SERVICES)

seats-down: ## Remove the seat containers; logins and kits stay in the volumes
	$(COMPOSE) down

seats-logs: ## Follow seat logs (all, or SEAT=3)
	$(COMPOSE) logs -f --tail=100 $(SEAT_SERVICES)

seats-ps: ## List the seat containers and their health
	$(COMPOSE) ps

seats-wipe: ## After the event: remove containers AND all volumes (logins, kits, chats)
	$(COMPOSE) down -v

seat-login: ## Log in Claude Code on one seat (SEAT=n): /login, trust /kit, /exit
	$(need_seat)
	$(COMPOSE) run --rm seat$(SEAT) claude
	@echo "Now restart the running seat: make seats-restart SEAT=$(SEAT)"

seat-login-codex: ## Log in Codex on one Codex seat (SEAT=n), device code flow
	$(need_seat)
	$(COMPOSE) run --rm seat$(SEAT) codex login --device-auth
	@echo "Now restart the running seat: make seats-restart SEAT=$(SEAT)"

seat-check: ## Check one seat (SEAT=n): versions, login, kit, reachability
	$(need_seat)
	$(COMPOSE) run --rm seat$(SEAT) check

new-player: ## Clear a seat for a new player (SEAT=n): empty /kit + chats, restart
	$(need_seat)
	$(COMPOSE) run --rm seat$(SEAT) new-player
	$(COMPOSE) restart seat$(SEAT)
