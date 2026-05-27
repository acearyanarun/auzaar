# CLAUDE.md — Auzaar Implementation Guide

## What is Auzaar?

Auzaar is a **buyer-side agent governance layer** for agentic commerce. It sits between AI agents (acting on behalf of users/enterprises) and merchant-side commerce protocols (ACP, UCP, AP2). It intercepts, validates, and governs every outbound commerce action an agent takes.

Think of it as a firewall for AI agent purchases — verifying intent, enforcing policy, detecting threats, and maintaining an audit trail.

## Project Structure

```
auzaar/
├── CLAUDE.md                    # This file
├── packages/
│   ├── core/                    # Shared types, schemas, utilities
│   │   ├── src/
│   │   │   ├── types/           # TypeScript types for mandates, transactions, agents, events
│   │   │   ├── schemas/         # Zod schemas for validation
│   │   │   ├── errors/          # Custom error classes
│   │   │   └── utils/           # Crypto (Ed25519 signing), hashing, ID generation
│   │   └── package.json
│   │
│   ├── mandate-service/         # Mandate capture, storage, versioning
│   │   ├── src/
│   │   │   ├── service.ts       # MandateService class
│   │   │   ├── store.ts         # Storage adapter interface + implementations
│   │   │   └── parser.ts        # Natural language intent → structured mandate
│   │   └── package.json
│   │
│   ├── agent-registry/          # Agent identity, auth, delegation chains
│   │   ├── src/
│   │   │   ├── registry.ts      # AgentRegistry class
│   │   │   ├── delegation.ts    # Delegation chain verification
│   │   │   └── trust.ts         # Trust score computation
│   │   └── package.json
│   │
│   ├── governance-engine/       # The core pipeline
│   │   ├── src/
│   │   │   ├── engine.ts        # GovernanceEngine orchestrator
│   │   │   ├── pipeline.ts      # Sequential pipeline runner
│   │   │   ├── stages/
│   │   │   │   ├── rules-engine.ts        # Deterministic policy enforcement
│   │   │   │   ├── threat-detection.ts    # ML threat classifier
│   │   │   │   ├── intent-alignment.ts    # Mandate-vs-transaction semantic comparison
│   │   │   │   └── spending-graph.ts      # Behavioral baseline anomaly scoring
│   │   │   ├── scoring.ts       # Composite risk score calculation
│   │   │   └── triage.ts        # SLM triage routing layer
│   │   └── package.json
│   │
│   ├── ingestion/               # MCP server + API proxy
│   │   ├── src/
│   │   │   ├── mcp-server.ts    # MCP server implementation (primary ingestion)
│   │   │   ├── api-proxy.ts     # HTTP reverse proxy (enterprise ingestion)
│   │   │   ├── router.ts        # Routes incoming requests to governance engine
│   │   │   └── middleware/      # Auth, rate limiting, request parsing
│   │   └── package.json
│   │
│   ├── protocol-release/        # Forwards approved transactions downstream
│   │   ├── src/
│   │   │   ├── router.ts        # Protocol selection logic
│   │   │   ├── formatters/
│   │   │   │   ├── acp.ts       # ACP payload formatter
│   │   │   │   ├── ucp.ts       # UCP payload formatter
│   │   │   │   └── ap2.ts       # AP2 mandate + receipt formatter
│   │   │   └── attestation.ts   # Attaches mandate attestation to outbound payload
│   │   └── package.json
│   │
│   ├── event-log/               # Immutable audit trail
│   │   ├── src/
│   │   │   ├── logger.ts        # EventLogger class (append-only, hash-chained)
│   │   │   ├── store.ts         # Storage adapter (SQLite local, S3/cloud for prod)
│   │   │   └── query.ts         # Query interface for dashboard
│   │   └── package.json
│   │
│   ├── feedback-pipeline/       # Operator decisions → model + graph updates
│   │   ├── src/
│   │   │   ├── collector.ts     # Collects operator approve/reject decisions
│   │   │   ├── trainer.ts       # Formats training data for model fine-tuning
│   │   │   └── graph-updater.ts # Updates spending graph baselines
│   │   └── package.json
│   │
│   └── dashboard/               # Operator web dashboard
│       ├── src/
│       │   ├── app/             # Next.js app router
│       │   ├── components/      # React components
│       │   │   ├── review-queue/ 
│       │   │   ├── policy-editor/
│       │   │   ├── spending-graph/
│       │   │   ├── audit-log/
│       │   │   ├── agent-registry/
│       │   │   └── analytics/
│       │   └── lib/             # API client, auth, state management
│       └── package.json
│
├── models/                      # ML model artifacts and training
│   ├── threat-detection/
│   │   ├── train/               # Training scripts
│   │   ├── eval/                # Evaluation scripts
│   │   └── serve/               # Inference server (ONNX runtime)
│   ├── intent-alignment/
│   │   ├── train/
│   │   ├── eval/
│   │   └── serve/
│   └── slm-triage/
│       ├── finetune/
│       └── serve/
│
├── policies/                    # Example policy-as-code templates
│   ├── enterprise-default.yaml
│   ├── consumer-default.yaml
│   └── schemas/
│       └── policy.schema.json   # JSON Schema for policy validation
│
├── docker/
│   ├── Dockerfile               # Multi-stage build for full Auzaar
│   ├── Dockerfile.dashboard     # Dashboard-only build
│   └── docker-compose.yml       # Local development stack
│
└── docs/
    ├── architecture.md
    ├── integration-guide.md
    ├── api-reference.md
    └── security.md
```

## Technology Decisions

### Language: TypeScript (Node.js)
- Entire backend is TypeScript. Agents in the ecosystem are predominantly TypeScript/Python; TypeScript gives us MCP SDK compatibility, fast iteration, and a single language across backend + dashboard.
- Use strict TypeScript (`strict: true`, no `any`).

### Runtime: Node.js with Bun as build tool
- Bun for fast installs, builds, and test runs.
- Node.js 22+ for production runtime (broader compatibility with MCP SDK and ONNX).

### Monorepo: Turborepo
- `packages/` structure with shared `core` package.
- Each package is independently buildable and testable.

### Database: SQLite (local/dev) → PostgreSQL (production)
- Mandate service, agent registry, spending graph, event log all use a storage adapter pattern.
- Local development uses SQLite via `better-sqlite3` (zero config, fast).
- Production uses PostgreSQL via `pg` or Drizzle ORM.
- Event log is append-only with hash chaining regardless of backend.

### ML Inference: ONNX Runtime (Node.js bindings)
- Threat detection model: DistilBERT fine-tuned classifier, exported to ONNX, runs on CPU.
- Intent alignment model: Cross-encoder (sentence-transformers) or small LM, exported to ONNX.
- SLM triage: Llama-3.2-1B or Phi-3-mini via llama.cpp with Node.js bindings (or ONNX if feasible).
- All inference is local. No external API calls for governance decisions.

### Dashboard: Next.js 15 + shadcn/ui + Tailwind
- Server-side rendering for the operator dashboard.
- Real-time review queue updates via WebSocket.
- shadcn/ui for consistent, accessible components.

### MCP Server: `@modelcontextprotocol/sdk`
- Use the official MCP TypeScript SDK.
- Expose tools: `submit_mandate`, `submit_transaction`, `check_status`, `amend_mandate`.

### API Proxy: Hono
- Lightweight HTTP framework for the reverse proxy mode.
- Intercepts outbound requests matching ACP/UCP patterns.
- Runs as a standalone process or sidecar container.

## Key Architectural Rules

### 1. Deterministic First
The rules engine ALWAYS runs before any ML model. If a deterministic rule blocks a transaction, ML models are never invoked. This guarantees:
- Predictable behavior for auditors
- Sub-millisecond enforcement for policy violations
- No wasted compute on already-blocked transactions

### 2. Pipeline Is Sequential, Scoring Is Composite
Stages run in order: Rules → Threat Detection → Intent Alignment → Spending Graph. Each stage can independently block (hard fail) or flag (soft signal). Flags accumulate into a composite risk score. The composite score determines routing: auto-approve, triage, or block.

### 3. SLM Has Routing Authority, Not Decision Authority
The SLM triage layer can:
- Route obvious false positives to auto-approve (only if amount < configurable ceiling AND composite score < configurable threshold)
- Route obvious violations to auto-block (with deterministic backstop)
- Route everything else to human operator with a recommendation

The SLM NEVER unilaterally approves a transaction above the dollar ceiling. This is enforced at the code level, not by the model.

### 4. Every Decision Is Logged
Every transaction that enters the governance pipeline produces an event log entry, regardless of outcome. The entry includes: all input data (mandate, transaction, agent context), all stage outputs (scores, matched rules), the final decision, and a hash linking it to the previous entry.

### 5. Feedback Closes the Loop
When a human operator approves or rejects a flagged transaction, that decision is:
- Written to the event log
- Sent to the feedback pipeline
- Used to update the spending graph baseline
- Queued as a training example for the next model fine-tuning cycle

### 6. Protocol-Agnostic Core
The governance engine operates on a normalized `GovernanceRequest` type. It does not know or care whether the downstream target is ACP, UCP, AP2, or a direct merchant API. Protocol-specific formatting happens only in the `protocol-release` package.

### 7. Storage Adapter Pattern
Every stateful component (mandate service, agent registry, event log, spending graph) uses an interface for storage. Local dev uses SQLite. Tests use in-memory. Production uses PostgreSQL. The governance logic never imports a specific database driver.

## Implementation Order (Phase 1)

Build in this order. Each step should be shippable and testable before moving to the next.

### Step 1: Core types and schemas
Define the foundational types in `packages/core`:
- `Mandate` — id, user_id, agent_id, intent_text, structured_intent, constraints, signature, version, timestamps
- `GovernanceRequest` — the normalized input to the governance engine
- `GovernanceDecision` — approved/flagged/blocked, scores, matched rules, explanation
- `Agent` — id, name, framework, authorization_scope, delegation_chain, trust_score
- `EventLogEntry` — timestamp, event_type, request, decision, hash
- `Policy` — structured rule definitions (spending limits, vendor controls, etc.)

Use Zod for runtime validation. Export TypeScript types inferred from Zod schemas.

### Step 2: Mandate service
Build `packages/mandate-service`:
- `createMandate(userId, agentId, intentText)` → parses intent, creates structured mandate, signs it, stores it
- `getMandate(mandateId)` → retrieves active mandate
- `amendMandate(mandateId, changes)` → creates new version, preserves history
- Intent parsing: For Phase 1, use a structured template (user fills in product, budget, vendor preferences, timing). ML-powered NL parsing is Phase 2.
- Storage: SQLite adapter for dev, interface for production swap.

### Step 3: Rules engine
Build `packages/governance-engine/src/stages/rules-engine.ts`:
- Load policies from YAML/JSON files
- Compile into an in-memory decision tree at startup
- Evaluate a `GovernanceRequest` against all applicable rules
- Return pass/fail with list of matched rules
- Support hot reload (watch policy files for changes)
- Policy categories: spending_limit, vendor_allowlist, vendor_blocklist, category_restriction, quantity_limit, temporal_rule

### Step 4: Event log
Build `packages/event-log`:
- Append-only writes
- Each entry includes a SHA-256 hash of (previous_hash + entry_content)
- Query interface: filter by time range, agent_id, user_id, decision type
- SQLite adapter with WAL mode for concurrent read/write

### Step 5: Governance engine orchestrator
Build `packages/governance-engine/src/engine.ts`:
- Accepts a `GovernanceRequest`
- Runs the rules engine (Phase 1 only — ML stages are stubs that return neutral scores)
- Calculates composite risk score
- Returns `GovernanceDecision`
- Writes to event log

### Step 6: MCP server
Build `packages/ingestion/src/mcp-server.ts`:
- Uses `@modelcontextprotocol/sdk`
- Exposes tools:
  - `submit_mandate` — creates a new mandate
  - `submit_transaction` — submits a purchase for governance
  - `check_status` — queries a pending/completed governance decision
  - `amend_mandate` — modifies an active mandate
- Each tool call routes through the governance engine
- Returns the governance decision to the calling agent

### Step 7: Basic dashboard
Build `packages/dashboard`:
- Next.js app with these views:
  - **Review Queue** — list of flagged transactions, approve/reject actions
  - **Policy Editor** — YAML editor with validation
  - **Audit Log** — searchable event log viewer
- API routes that query the event log and mandate service
- WebSocket for real-time review queue updates

### Step 8: Protocol release (pass-through)
Build `packages/protocol-release`:
- For Phase 1, this is a simple pass-through that forwards the approved transaction payload to its original destination
- Attaches a `X-Auzaar-Attestation` header with the mandate reference and governance decision hash
- ACP/UCP-specific formatting is Phase 2

## Coding Standards

### Error Handling
- Use typed custom errors from `packages/core/src/errors/`
- Every governance decision must produce a result, never throw. Use a `Result<T, E>` pattern.
- Network failures in protocol release should fail-closed (block the transaction) unless the policy explicitly says fail-open.

### Testing
- Unit tests for every governance stage (rules engine, scoring)
- Integration tests for the full pipeline (mandate → governance → decision → log)
- Property-based tests for the rules engine (no policy combination should crash)
- E2E tests using a mock MCP client that submits transactions
- Use Vitest as the test runner.
- Target >90% coverage on `governance-engine` and `rules-engine`.

### Logging
- Structured JSON logs via `pino`.
- Every governance decision logs: request_id, agent_id, user_id, mandate_id, decision, latency_ms, matched_rules.
- Never log PII (payment card numbers, full addresses). Redact before logging.

### Performance
- Rules engine evaluation: <1ms (benchmark on startup, fail build if >5ms)
- Full governance pipeline (Phase 1, rules-only): <50ms
- Full governance pipeline (Phase 2, with ML): <300ms
- Event log write: <10ms (async, non-blocking for the governance decision)

## Environment Variables

```bash
# Core
AUZAAR_ENV=development|staging|production
AUZAAR_PORT=3100
AUZAAR_LOG_LEVEL=debug|info|warn|error

# Database
AUZAAR_DB_TYPE=sqlite|postgresql
AUZAAR_DB_URL=./data/auzaar.db  # SQLite path or PostgreSQL connection string

# MCP Server
AUZAAR_MCP_TRANSPORT=stdio|sse
AUZAAR_MCP_PORT=3101

# API Proxy
AUZAAR_PROXY_ENABLED=true|false
AUZAAR_PROXY_PORT=3102
AUZAAR_PROXY_TARGET_PATTERNS=*.openai.com/acp/*,*.ucp.dev/*

# Models (Phase 2)
AUZAAR_THREAT_MODEL_PATH=./models/threat-detection/model.onnx
AUZAAR_INTENT_MODEL_PATH=./models/intent-alignment/model.onnx
AUZAAR_SLM_MODEL_PATH=./models/slm-triage/model.gguf

# Dashboard
AUZAAR_DASHBOARD_PORT=3200
AUZAAR_DASHBOARD_AUTH=none|basic|oauth

# Notifications
AUZAAR_SLACK_WEBHOOK_URL=
AUZAAR_TEAMS_WEBHOOK_URL=
```

## Development Setup

```bash
# Clone and install
git clone <repo>
cd auzaar
bun install

# Start local dev (all services)
bun run dev

# Run tests
bun run test

# Build all packages
bun run build

# Start MCP server only (for agent integration testing)
bun run --filter @auzaar/ingestion dev:mcp

# Start dashboard only
bun run --filter @auzaar/dashboard dev
```

## Phase 2 Implementation Notes (for later reference)

When adding ML models in Phase 2:
- Threat detection: Fine-tune DistilBERT on synthetic adversarial commerce data. Export to ONNX. Inference via `onnxruntime-node`. Input: transaction context + agent reasoning. Output: threat probability [0,1].
- Intent alignment: Fine-tune a cross-encoder (e.g., `cross-encoder/ms-marco-MiniLM-L-6-v2`) on commerce intent pairs. Input: (mandate_text, transaction_description). Output: alignment score [0,1].
- SLM triage: Fine-tune Llama-3.2-1B or Phi-3-mini on labeled governance decisions. Serve via `node-llama-cpp`. Input: full governance context. Output: recommended action + explanation.
- All models run locally. No external API calls during governance.
- The spending graph uses simple statistical methods (rolling mean, z-score) in Phase 1. Phase 2 adds time-series anomaly detection if needed.

## Important Reminders

- **Auzaar is NOT a payment processor.** It governs agent behavior. Payment credentials and settlement are handled by downstream systems (Stripe, Visa, Mastercard, etc.).
- **Auzaar is NOT an agent framework.** It does not build or run agents. It governs agents built by others.
- **The mandate is sacred.** Every governance decision references a mandate. If there is no mandate, the transaction is blocked by default.
- **Deterministic rules cannot be overridden by ML.** If a hard rule says block, the ML models are irrelevant. This is by design.
- **The SLM is a router, not a judge.** It accelerates triage. It does not have authority to approve high-value transactions.
- **Latency is a feature.** If governance adds >300ms to a transaction, developers will bypass it. Optimize relentlessly.
