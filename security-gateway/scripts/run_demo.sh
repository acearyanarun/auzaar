#!/usr/bin/env bash
#
# MCP Security Gateway — PoC Demo Runner
#
# Boots all services in the correct order:
#   1. Redis          (docker-compose)
#   2. LLM server     (mlx-lm, Qwen3.5-9B)
#   3. Gateway        (FastAPI :8001)
#   4. MCP Server     (FastAPI :8002, auto-registers tools)
#   5. Dashboard      (Next.js :3000)
#   6. Agent          (runs once, processes tickets)
#
# Usage:
#   ./scripts/run_demo.sh          # full demo (all services)
#   ./scripts/run_demo.sh --no-llm # skip LLM server (uses mock/fallback)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_LLM=false
if [[ "${1:-}" == "--no-llm" ]]; then
  SKIP_LLM=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${CYAN}[demo]${NC} $1"; }
ok()   { echo -e "${GREEN}[demo]${NC} $1"; }
warn() { echo -e "${YELLOW}[demo]${NC} $1"; }
err()  { echo -e "${RED}[demo]${NC} $1"; }

export PYTHONDONTWRITEBYTECODE=1

kill_port() {
  local port=$1
  local pid
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [[ -n "$pid" ]]; then
    warn "Killing stale process on port $port (pid $pid)"
    kill -9 $pid 2>/dev/null || true
    sleep 1
  fi
}

wait_for_port() {
  local port=$1 name=$2 max=${3:-30}
  for i in $(seq 1 "$max"); do
    if curl -sf "http://localhost:$port/" >/dev/null 2>&1 || lsof -ti :"$port" >/dev/null 2>&1; then
      ok "$name ready on :$port"
      return 0
    fi
    sleep 1
  done
  err "$name failed to start on :$port"
  return 1
}

PIDS=()
cleanup() {
  log "Shutting down all services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  docker compose down 2>/dev/null || true
  ok "All services stopped."
}
trap cleanup EXIT INT TERM

# ── 1. Redis ─────────────────────────────────────────────────────────────
log "Starting Redis..."
if command -v docker &>/dev/null; then
  docker compose up -d 2>/dev/null || warn "Docker not available — using fakeredis fallback"
  ok "Redis ready on :6379"
else
  warn "Docker not found — Redis will fall back to fakeredis (in-memory)"
fi

# ── 2. LLM Server ────────────────────────────────────────────────────────
if [[ "$SKIP_LLM" == false ]]; then
  log "Starting LLM server (mlx-lm)..."
  if python3 -c "import mlx_lm" 2>/dev/null; then
    python3 -m mlx_lm.server \
      --model mlx-community/Qwen3.5-9B-MLX-4bit \
      --port 8080 &
    PIDS+=($!)
    log "Waiting for LLM server to load model..."
    for i in $(seq 1 60); do
      if curl -sf http://localhost:8080/v1/models >/dev/null 2>&1; then
        ok "LLM server ready on :8080"
        break
      fi
      sleep 2
    done
  else
    warn "mlx-lm not installed — SLM scoring will use fallback"
    warn "Install with: pip install mlx-lm"
  fi
else
  warn "Skipping LLM server (--no-llm flag)"
fi

# ── 3. Gateway ────────────────────────────────────────────────────────────
kill_port 8001
kill_port 8002
kill_port 3000
log "Starting Gateway on :8001..."
if [[ -f .venv/bin/activate ]]; then
  source .venv/bin/activate
else
  log "Creating venv and installing dependencies..."
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -q -r requirements.txt
fi
find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
uvicorn gateway.main:app --host 0.0.0.0 --port 8001 --log-level info &
PIDS+=($!)
wait_for_port 8001 "Gateway"

# ── 4. MCP Server ─────────────────────────────────────────────────────────
log "Starting MCP Server on :8002 (registers tools in background)..."
uvicorn mcp_server.server:app --host 0.0.0.0 --port 8002 --log-level info &
PIDS+=($!)
wait_for_port 8002 "MCP Server"

# ── 5. Dashboard ──────────────────────────────────────────────────────────
log "Starting Dashboard on :3000..."
cd dashboard
npm run dev -- --port 3000 &
PIDS+=($!)
cd "$ROOT"
wait_for_port 3000 "Dashboard"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  MCP Security Gateway PoC — All Systems Running  ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Gateway:   ${CYAN}http://localhost:8001${NC}"
echo -e "  MCP Server: ${CYAN}http://localhost:8002${NC}"
echo -e "  Dashboard: ${CYAN}http://localhost:3000${NC}"
echo -e "  LLM:       ${CYAN}http://localhost:8080${NC}"
echo ""
echo -e "  Run the agent to start the demo:"
echo -e "  ${YELLOW}cd $(basename "$ROOT") && python -m agent.agent${NC}"
echo ""
echo -e "  Press Ctrl+C to shut down all services."
echo ""

# Keep script alive
wait
