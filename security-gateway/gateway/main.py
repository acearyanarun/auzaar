"""MCP Security Gateway — FastAPI entry point.

Routes:
  POST /register          Registration proxy (scan + store)
  POST /execute           Execution interceptor (JSON-RPC 2.0)
  GET  /tools             List registered tools
  GET  /tools/{name}      Get single tool
  POST /tools/{name}/status   Manual status override
  GET  /alerts            Recent alerts
  GET  /stats             Dashboard summary stats
  WS   /ws                Real-time WebSocket for dashboard

Designed for the PoC demo but structured to support real MCP server
routing in production (each tool tracks its origin server_url).
"""

from __future__ import annotations

import logging
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Ensure config is importable from the project root
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, MCP_SERVER_URL

from gateway import store, trace
from gateway.blast_radius import infer_blast_radius
from gateway.fingerprint import normalized_registration_dict, registration_sha256
from gateway.interceptor import intercept
from gateway.scanner.deterministic import default_status, scan_metadata
from gateway.scanner.probabilistic import score_tool_schema
from gateway.ws_manager import manager as ws

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("gateway")

app = FastAPI(title="MCP Security Gateway", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── LLM client (lazy, model-agnostic) ─────────────────────────────────────────

_llm_client = None


def _get_llm_client():
    global _llm_client
    if _llm_client is None:
        from openai import AsyncOpenAI

        _llm_client = AsyncOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)
    return _llm_client


# ── Request / response models ─────────────────────────────────────────────────


class ToolRegistration(BaseModel):
    name: str
    description: str = ""
    inputSchema: dict[str, Any] = Field(default_factory=dict)
    annotations: dict[str, Any] = Field(default_factory=dict)
    source: str = ""
    server_url: str = ""


class ExecuteRequest(BaseModel):
    """JSON-RPC 2.0 envelope for MCP tools/call."""

    jsonrpc: str = "2.0"
    method: str = "tools/call"
    params: dict[str, Any] = Field(default_factory=dict)
    id: Any = None


class StatusUpdate(BaseModel):
    status: str
    environments: list[str] = Field(default_factory=list)


# ── POST /register ────────────────────────────────────────────────────────────


@app.post("/register")
async def register_tool(reg: ToolRegistration):
    """Registration Proxy: deterministic + SLM scan, then persist."""
    t0 = time.perf_counter_ns()

    await trace.emit(
        "register.start",
        tool=reg.name,
        input_data={
            "name": reg.name,
            "description": reg.description,
            "inputSchema": reg.inputSchema,
            "annotations": reg.annotations,
            "source": reg.source,
            "server_url": reg.server_url,
        },
    )

    existing = await store.get_tool(reg.name)

    # Deterministic scan
    det_result = scan_metadata(reg.model_dump())
    det_ms = (time.perf_counter_ns() - t0) / 1_000_000

    await trace.emit(
        "scan.deterministic",
        tool=reg.name,
        duration_ms=det_ms,
        input_data={
            "description": reg.description,
            "schema_properties": (reg.inputSchema or {}).get("properties", {}),
            "annotations": reg.annotations,
        },
        output_data={
            "score": det_result.score,
            "finding_count": len(det_result.findings),
            "findings": [
                {"id": f.id, "label": f.label, "severity": f.severity, "phrase": f.phrase, "location": f.location}
                for f in det_result.findings
            ],
        },
    )

    # Probabilistic (SLM) scan — best-effort
    t1 = time.perf_counter_ns()
    slm_result = await score_tool_schema(
        reg.model_dump(), _get_llm_client(), LLM_MODEL
    )
    slm_ms = (time.perf_counter_ns() - t1) / 1_000_000

    # Merge scores: deterministic takes priority for blocking
    final_score = det_result.score
    if slm_result.risk_score >= 0.8 and final_score == "low":
        final_score = "high"
    elif slm_result.risk_score >= 0.5 and final_score == "low":
        final_score = "medium"

    status = default_status(final_score)
    blast = infer_blast_radius(reg.model_dump())

    norm_reg = normalized_registration_dict(
        name=reg.name,
        description=reg.description,
        inputSchema=reg.inputSchema,
        annotations=reg.annotations,
        source=reg.source,
        server_url=reg.server_url,
        default_server_url=MCP_SERVER_URL,
    )
    new_fp = registration_sha256(norm_reg)
    prev_fp = existing.get("registrationFingerprint") if existing else None
    fingerprint_drift = prev_fp is not None and prev_fp != new_fp
    if fingerprint_drift and status != "blocked":
        status = "quarantined"

    now = datetime.now(timezone.utc).isoformat()
    hist: list[Any] = []
    if existing:
        hist = list(existing.get("history", []))
    if fingerprint_drift:
        hist.append(
            {
                "type": "fingerprint_drift",
                "timestamp": now,
                "previous_fingerprint": prev_fp,
                "new_fingerprint": new_fp,
            }
        )

    tool_record: dict[str, Any] = {
        "name": reg.name,
        "description": reg.description,
        "inputSchema": reg.inputSchema,
        "annotations": reg.annotations,
        "source": reg.source,
        "server_url": reg.server_url or MCP_SERVER_URL,
        "registeredAt": now,
        "updatedAt": now,
        "version": 1,
        "riskScore": final_score,
        "findings": [asdict(f) for f in det_result.findings],
        "slm": {
            "risk_score": slm_result.risk_score,
            "reason": slm_result.reason,
            "flags": slm_result.flags,
            "error": slm_result.error,
        },
        "outputFindings": [],
        "blastRadius": blast.to_dict(),
        "status": status,
        "environments": [],
        "history": hist,
        "executions": 0,
        "lastOutput": None,
        "lastExecutedAt": None,
        "registrationFingerprint": new_fp,
    }

    if existing:
        tool_record["version"] = existing.get("version", 1) + 1
        tool_record["registeredAt"] = existing.get("registeredAt", now)
        tool_record["executions"] = existing.get("executions", 0)

    if fingerprint_drift:
        await trace.emit(
            "register.fingerprint_drift",
            tool=reg.name,
            status=status,
            input_data={
                "previous_fingerprint": prev_fp,
                "new_fingerprint": new_fp,
            },
            output_data={
                "final_status": status,
                "blocked_by_scan": status == "blocked",
            },
        )
        drift_alert = {
            "type": "fingerprint_drift",
            "tool_name": reg.name,
            "status": status,
            "timestamp": now,
            "severity": "high",
            "message": (
                f"Registration content changed since last registration for '{reg.name}' "
                f"(SHA256 mismatch) — tool set to '{status}' pending review."
            ),
            "previous_fingerprint": prev_fp,
            "new_fingerprint": new_fp,
        }
        await store.add_alert(drift_alert)
        await ws.broadcast({"event": "alert", "data": drift_alert})
        logger.warning(
            "[register] %s fingerprint drift prev=%s new=%s status=%s",
            reg.name,
            prev_fp,
            new_fp,
            status,
        )

    await store.set_tool(reg.name, tool_record)
    await store.set_tool_status(reg.name, status)

    # Dashboards (e.g. executive) refetch /tools on this event
    await ws.broadcast(
        {
            "event": "status_change",
            "data": {
                "tool_name": reg.name,
                "status": status,
                "timestamp": now,
                "source": "registration",
            },
        }
    )

    total_ms = (time.perf_counter_ns() - t0) / 1_000_000

    await trace.emit(
        "register.complete",
        tool=reg.name,
        duration_ms=total_ms,
        output_data={
            "risk_score": final_score,
            "status": status,
            "blast_score": blast.blast_score,
            "cost_max": blast.cost_max,
            "version": tool_record["version"],
            "registrationFingerprint": new_fp,
            "fingerprint_drift": fingerprint_drift,
        },
        meta={
            "deterministic_ms": round(det_ms, 2),
            "slm_ms": round(slm_ms, 2),
            "total_ms": round(total_ms, 2),
            "registrationFingerprint": new_fp,
            "fingerprint_drift": fingerprint_drift,
        },
    )

    logger.info(
        "[register] %s  risk=%s status=%s drift=%s  det=%.1fms slm=%.1fms total=%.1fms",
        reg.name,
        final_score,
        status,
        fingerprint_drift,
        det_ms,
        slm_ms,
        total_ms,
    )

    # Alert on high-risk registrations
    if final_score in ("critical", "high"):
        alert = {
            "type": "registration",
            "tool_name": reg.name,
            "status": status,
            "timestamp": now,
            "severity": final_score,
            "message": f"High-risk tool registered: {reg.name} (risk={final_score})",
            "blast_radius": blast.to_dict(),
        }
        await store.add_alert(alert)
        await ws.broadcast({"event": "alert", "data": alert})

    return {
        "ok": True,
        "tool": tool_record,
        "fingerprint_drift": fingerprint_drift,
        "registrationFingerprint": new_fp,
        "timing": {
            "deterministic_ms": round(det_ms, 2),
            "slm_ms": round(slm_ms, 2),
            "total_ms": round(total_ms, 2),
        },
    }


# ── POST /execute ──────────────────────────────────────────────────────────────


@app.post("/execute")
async def execute_tool(req: ExecuteRequest):
    """Execution Interceptor: O(1) lookup, then forward or block.

    Accepts JSON-RPC 2.0 for MCP protocol compatibility.
    """
    tool_name = req.params.get("name", "")
    arguments = req.params.get("arguments", {})

    if not tool_name:
        return {
            "jsonrpc": "2.0",
            "error": {"code": -32602, "message": "Missing params.name"},
            "id": req.id,
        }

    t0 = time.perf_counter_ns()

    await trace.emit(
        "execute.start",
        tool=tool_name,
        input_data={"method": req.method, "params": req.params, "rpc_id": req.id},
    )

    result = await intercept(
        tool_name,
        arguments,
        rpc_id=req.id,
        fallback_server_url=MCP_SERVER_URL,
    )

    exec_ms = (time.perf_counter_ns() - t0) / 1_000_000
    has_error = "error" in result
    await trace.emit(
        "execute.complete",
        tool=tool_name,
        duration_ms=exec_ms,
        status="blocked" if has_error else "ok",
        output_data=result,
        meta={"total_ms": round(exec_ms, 2)},
    )

    return result


# ── GET /tools ──────────────────────────────────────────────────────────────────


@app.get("/tools")
async def list_tools():
    return await store.list_tools()


@app.get("/tools/{name}")
async def get_tool(name: str):
    tool = await store.get_tool(name)
    if not tool:
        return {"error": "Not found"}, 404
    return tool


# ── POST /tools/{name}/status ──────────────────────────────────────────────────


@app.post("/tools/{name}/status")
async def update_status(name: str, body: StatusUpdate):
    valid = {"approved", "review", "blocked", "quarantined", "env-scoped"}
    if body.status not in valid:
        return {"error": f"Invalid status. Must be one of: {valid}"}, 400

    tool = await store.get_tool(name)
    if not tool:
        return {"error": "Not found"}, 404

    tool["status"] = body.status
    if body.status == "env-scoped":
        tool["environments"] = body.environments
    await store.set_tool(name, tool)
    await store.set_tool_status(name, body.status)

    logger.info("[status] %s -> %s", name, body.status)

    await ws.broadcast(
        {
            "event": "status_change",
            "data": {
                "tool_name": name,
                "status": body.status,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        }
    )

    await trace.emit(
        "status_change",
        tool=name,
        input_data={"new_status": body.status},
        output_data={"old_status": tool.get("status"), "new_status": body.status},
    )

    return {"ok": True, "tool": tool}


# ── GET /alerts ────────────────────────────────────────────────────────────────


@app.get("/alerts")
async def get_alerts():
    return await store.get_alerts()


# ── GET /traces ────────────────────────────────────────────────────────────────


@app.get("/traces")
async def get_traces(count: int = 100):
    return await trace.get_traces(count)


# ── GET /stats ─────────────────────────────────────────────────────────────────


@app.get("/stats")
async def get_stats():
    tools = await store.list_tools()
    return {
        "total": len(tools),
        "approved": sum(1 for t in tools if t.get("status") == "approved"),
        "review": sum(1 for t in tools if t.get("status") == "review"),
        "blocked": sum(1 for t in tools if t.get("status") == "blocked"),
        "quarantined": sum(1 for t in tools if t.get("status") == "quarantined"),
        "envScoped": sum(1 for t in tools if t.get("status") == "env-scoped"),
        "alertCount": len(await store.get_alerts()),
        "critical": sum(1 for t in tools if t.get("riskScore") == "critical"),
    }


# ── WS /ws ─────────────────────────────────────────────────────────────────────


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws.disconnect(websocket)
