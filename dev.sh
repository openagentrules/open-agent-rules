#!/usr/bin/env bash
# Local dev — mirrors ../paintedwolf-www: Docker Compose by default, optional
# native Node. Both modes run the same scripts/serve.mjs, which applies
# site/_headers, so what you see locally is what Cloudflare Pages serves.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.dev.yml"
ACTION="${1:-start}"
DEV_PORT=8788

port_listeners() {
  lsof -nP -iTCP:"$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true
}

require_port_free() {
  local listeners
  listeners="$(port_listeners)"
  if [[ -n "$listeners" ]]; then
    echo "Port $DEV_PORT is already in use:"
    echo "$listeners"
    echo ""
    echo "Stop the other dev server first, e.g.:"
    echo "  ./dev.sh stop && ./dev.sh remove   # Docker"
    echo "  lsof -ti :$DEV_PORT | xargs kill   # native node or other process"
    exit 1
  fi
}

warn_port_conflict() {
  local listeners
  listeners="$(port_listeners)"
  if [[ -n "$listeners" ]]; then
    echo "WARNING: something is already listening on port $DEV_PORT:"
    echo "$listeners"
    echo ""
    echo "Browsers may hit the stale server instead of Docker. Free the port first."
    echo ""
  fi
}

ensure_site_built() {
  if [[ ! -d "site" || ! -f "site/_headers" || ! -f "site/index.html" ]]; then
    echo "site/ not found or incomplete — building site/ first..."
    node scripts/build-site.mjs
  fi
}

case "$ACTION" in
  start)
    ensure_site_built
    warn_port_conflict
    echo "Starting openagentrules.org dev (static site/ in Docker)…"
    echo "→ http://127.0.0.1:$DEV_PORT"
    echo ""
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
    docker compose -f "$COMPOSE_FILE" up
    ;;

  start-d)
    ensure_site_built
    warn_port_conflict
    echo "Starting openagentrules.org dev in the background…"
    echo "→ http://127.0.0.1:$DEV_PORT"
    echo "Logs: ./dev.sh logs"
    echo ""
    docker compose -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
    docker compose -f "$COMPOSE_FILE" up -d
    echo "Done."
    ;;

  local|native)
    ensure_site_built
    require_port_free
    echo "Starting native node static server (no Docker)…"
    echo ""
    exec node scripts/serve.mjs --host 127.0.0.1 --port "$DEV_PORT"
    ;;

  stop)
    echo "Stopping containers…"
    docker compose -f "$COMPOSE_FILE" stop
    ;;

  remove|down)
    echo "Stopping and removing containers…"
    docker compose -f "$COMPOSE_FILE" down --remove-orphans
    ;;

  logs)
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;

  rebuild)
    echo "Fully bouncing dev stack (down + volumes, pull, fresh containers)…"
    docker compose -f "$COMPOSE_FILE" down --remove-orphans -v
    docker compose -f "$COMPOSE_FILE" pull
    docker compose -f "$COMPOSE_FILE" up -d --force-recreate --renew-anon-volumes
    echo ""
    echo "→ http://127.0.0.1:$DEV_PORT"
    echo "Done."
    ;;

  *)
    echo "Usage: ./dev.sh [start|start-d|local|stop|remove|logs|rebuild]"
    echo ""
    echo "  start    — foreground static server in Docker (default; Ctrl+C stops)"
    echo "  start-d  — same stack detached (use ./dev.sh logs / ./dev.sh stop)"
    echo "  local    — run node scripts/serve.mjs on the host (no Docker)"
    echo "  stop     — stop containers"
    echo "  remove   — docker compose down"
    echo "  logs     — follow container logs (after start-d)"
    echo "  rebuild  — compose down -v, pull, up --force-recreate --renew-anon-volumes"
    exit 1
    ;;
esac
