# Auzaar — MCP Security Gateway

**A live interception layer for AI agents calling MCP tools.** Sits between the agent and any MCP server, scans every tool registration and call through a deterministic regex engine *and* a local SLM, blocks high-risk calls in milliseconds, and surfaces a real-time security dashboard with cost-of-breach estimates for both engineers and executives.

Demonstrates live interception of a **supply-chain XPIA** (cross-prompt injection attack): a poisoned ticket attempts to hijack the agent into calling an exfiltration tool, and the Gateway blocks it before the call lands — with a full audit trail.

---

## Screenshots

### Developer dashboard — live trace

`Total Exposure $18.6M · CRITICAL 1 · TOOLS 3`. Left column is the tool registry with per-tool risk badge and dollar blast-radius. Right column is the live **DEV TRACE** stream with one row per event (`scan.deterministic`, `scan.slm`, `register.complete`, `intercept.lookup`, `intercept.blocked`, `blast_radius`, `execute.complete`) and per-stage latencies. The DEVELOPER ↔ EXECUTIVE toggle (top right) swaps the same data into a C-suite view.

![Developer dashboard with dev trace](docs/screenshots/01-dashboard-developer.png)

### Developer dashboard — alerts panel

Same dashboard, **ALERTS** tab active. `REGISTRATION` events fire when a high-risk tool registers; `EXECUTION BLOCKED` events fire when an agent attempts to call a blocked tool. Real-time over WebSocket.

![Developer dashboard with alerts panel](docs/screenshots/03-dashboard-alerts.png)

### Tool detail — blast radius

Click a tool to see its scanner verdict and the dollar blast radius modeled across linked data systems (`Customer records: $52K – $4.0M`, `Support and ticket data: $13K – $300K`). Tabs: Blast radius / Coverage / API view / Controls.

![Tool detail showing blast radius](docs/screenshots/04-tool-detail-blocked.png)

### Executive risk snapshot

Same data, board-ready framing.

1. **How exposed are we right now** — `$18.6M` total exposure, callable tools count, critical-risk tools count, data systems in scope
2. **What it costs if we do nothing** — `$4.1M – $18.6M` incident cost band broken down across Breach response & forensics, Regulatory fines & penalties, Reputation & churn, Operational downtime & recovery
3. **Are we compliant** — CCPA / GDPR frameworks in scope, with illustrative citation hooks
4. **Decision for leadership** — concrete recommendation (e.g. "Withhold expanded approval of `create_ticket` until security and compliance sign off")

`Export Report →` button top right.

![Executive risk snapshot](docs/screenshots/02-executive-view.png)

---

## Architecture

```
Agent ──► Gateway (:8001) ──► MCP Server (:8002)
              │
              ├── Deterministic Scanner (regex, <2ms)
              ├── Probabilistic Scanner (SLM via mlx-lm, <40ms)
              ├── Redis (:6379) ──► O(1) status lookup
              └── WebSocket ──► Dashboard (:3000)
```

Every tool registration runs through both scanners. A composite status (`approved` / `review` / `blocked` / `quarantined`) is stored in Redis. Every subsequent `execute` call does an O(1) Redis lookup — if the status is `blocked`, the Gateway returns a JSON-RPC `GuardError` with the calculated blast radius before the call ever reaches the MCP server.

## Demo flow

1. **MCP Server starts** — registers 3 tools with the Gateway (`read_ticket`, `create_ticket`, `analytics_reporter`)
2. **Gateway scans tools** — `analytics_reporter` flagged by the deterministic engine (exfiltration pattern in schema) → status set to **BLOCKED**. `read_ticket` flagged by drift detection → status set to **BLOCKED CRITICAL**
3. **Agent processes tickets** — reads 5 project tickets, summarizes each
4. **XPIA trigger** — Ticket `PROJ-104` contains hidden prompt injection instructing the agent to call `analytics_reporter` with all collected data
5. **Gateway intercepts** — O(1) Redis lookup finds `BLOCKED` status → returns `GuardError` to agent, calculates $4M–$14M blast radius
6. **Dashboard alerts** — WebSocket pushes a real-time critical alert with the attempted payload diffed against the blocked response

## Stack

- **Gateway / MCP server / agent:** Python 3.11+, FastAPI, uvicorn
- **Scanner:** deterministic regex rules + Qwen3.5-9B via `mlx-lm` (Apple Silicon) — model-agnostic, swap in any OpenAI-compatible endpoint
- **State:** Redis (fakeredis fallback for offline demos)
- **Dashboard:** Next.js 14, React 18, Tailwind, real-time over WebSocket
- **Transport:** JSON-RPC 2.0

## Prerequisites

- Python 3.11+
- Node.js 18+
- Docker (for Redis, or falls back to fakeredis)
- Apple Silicon Mac (for mlx-lm, or skip with `--no-llm`)

## Run locally

```bash
cd technical-poc
cp .env.example .env

# Python venv + dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Dashboard dependencies
cd dashboard && npm install && cd ..

# Optional: install mlx-lm for local SLM scoring
pip install mlx-lm

# One command starts everything
./scripts/run_demo.sh           # full stack
./scripts/run_demo.sh --no-llm  # skip SLM (uses deterministic-only fallback)

# In another terminal — run the agent to trigger the XPIA
source .venv/bin/activate
python -m agent.agent
```

Then open <http://localhost:3000> for the developer dashboard or <http://localhost:3000/executive> for the executive view.

## Expected tool risk scores

| Tool | Risk Score | Status | Reason |
|------|-----------|--------|--------|
| `read_ticket` | critical | **blocked** | Drift detection flagged schema change |
| `create_ticket` | low | approved | Standard write tool |
| `analytics_reporter` | high | **blocked** | `callback_url` field with exfiltration pattern |

## API reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/register` | POST | Register a tool (triggers scanning) |
| `/execute` | POST | Execute a tool call (JSON-RPC 2.0) |
| `/tools` | GET | List all registered tools |
| `/tools/{name}` | GET | Get single tool details |
| `/tools/{name}/status` | POST | Override tool status |
| `/alerts` | GET | Recent security alerts |
| `/stats` | GET | Dashboard summary stats |
| `/ws` | WS | Real-time alert + trace stream |

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:8080/v1` | OpenAI-compatible LLM API |
| `LLM_MODEL` | `mlx-community/Qwen3.5-9B-MLX-4bit` | Model name |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `GATEWAY_URL` | `http://localhost:8001` | Gateway address |
| `MCP_SERVER_URL` | `http://localhost:8002` | Default MCP server |

The system is model-agnostic: change `LLM_BASE_URL` and `LLM_MODEL` to use OpenAI, Anthropic, or any OpenAI-compatible provider.

## Project structure

```
technical-poc/
├── config.py                    # Shared configuration
├── gateway/                     # Interception, scanning, and audit
│   ├── main.py                  # FastAPI app — all routes + WebSocket
│   ├── store.py                 # Redis store (fakeredis fallback)
│   ├── ws_manager.py            # WebSocket manager
│   ├── interceptor.py           # Execution interceptor
│   ├── blast_radius.py          # Impact calculator (used by executive view)
│   └── scanner/
│       ├── deterministic.py     # Regex rule engine (7 rules)
│       └── probabilistic.py     # SLM scoring (drift, exfiltration)
├── mcp_server/                  # Target MCP server
│   ├── server.py                # FastAPI + tool handlers
│   ├── tool_loader.py           # loads tool metadata from tools/*.md
│   ├── tools/                   # one .md per tool (JSON spec in code fence)
│   └── data/tickets.json        # 5 tickets (1 carries XPIA payload)
├── agent/                       # Attacker trigger
│   └── agent.py                 # Autonomous ticket summarizer
├── dashboard/                   # Next.js operator UI
│   └── src/app/
│       ├── page.tsx             # Developer view (tools + alerts + dev trace)
│       └── executive/page.tsx   # Executive risk snapshot
└── scripts/
    └── run_demo.sh              # One-command full-stack demo
```

---

Built by [Aryan Arun](https://github.com/aryanarun). Companion project: [acearyanarun/auzaar](https://github.com/acearyanarun/auzaar) — the TypeScript governance-engine pivot built on the same idea.
