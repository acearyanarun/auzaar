"""Synchronous Execution Interceptor.

Sits on the critical path between agent and MCP server.
Performs an O(1) Redis lookup for tool status, then either:
  - APPROVED  -> forwards the JSON-RPC call to the tool's origin MCP server
  - BLOCKED   -> returns a GuardError, triggers blast-radius alert

Uses proper JSON-RPC 2.0 so the same endpoint works with real MCP clients.
Target overhead: <10 ms for the lookup + routing decision.
"""

from __future__ import annotations

import logging
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

import httpx

from gateway import store
from gateway.blast_radius import infer_blast_radius
from gateway.scanner.deterministic import scan_output
from gateway.ws_manager import manager as ws

logger = logging.getLogger("gateway.interceptor")

_http: httpx.AsyncClient | None = None


async def _client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=30.0)
    return _http


class GuardError(Exception):
    """Raised when a tool call is blocked by the gateway."""

    def __init__(self, tool_name: str, status: str, message: str) -> None:
        self.tool_name = tool_name
        self.status = status
        self.message = message
        super().__init__(message)


async def intercept(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    rpc_id: Any = None,
    fallback_server_url: str | None = None,
) -> dict[str, Any]:
    """Core interception logic.

    Returns a JSON-RPC 2.0 result envelope on success, or a
    JSON-RPC 2.0 error envelope if the tool is blocked.
    """
    from gateway import trace

    t0 = time.perf_counter_ns()

    # O(1) status lookup
    status = await store.get_tool_status(tool_name)
    lookup_ms = (time.perf_counter_ns() - t0) / 1_000_000

    if status is None:
        status = "unknown"

    await trace.emit(
        "intercept.lookup",
        tool=tool_name,
        duration_ms=lookup_ms,
        input_data={"redis_key": f"tool:{tool_name}:status"},
        output_data={"status": status},
        meta={"lookup_ms": round(lookup_ms, 3)},
    )

    logger.info(
        "[intercept] tool=%s status=%s lookup=%.2fms",
        tool_name,
        status,
        lookup_ms,
    )

    if status in ("blocked", "quarantined"):
        return await _handle_blocked(tool_name, status, arguments, rpc_id, lookup_ms)

    if status == "unknown":
        logger.warning("[intercept] tool=%s is UNREGISTERED — blocking by default", tool_name)
        await trace.emit(
            "intercept.unknown",
            tool=tool_name,
            status="blocked",
            output_data={"reason": "Tool not registered with gateway"},
        )
        return _rpc_error(
            rpc_id,
            -32001,
            f"GuardError: Tool '{tool_name}' is not registered. Execution denied by MCP Guard.",
            data={"guard_status": "unregistered"},
        )

    # Approved / review -> forward to the tool's origin MCP server
    tool_data = await store.get_tool(tool_name)
    server_url = (
        (tool_data or {}).get("server_url")
        or fallback_server_url
    )

    if not server_url:
        return _rpc_error(
            rpc_id,
            -32002,
            f"No server_url registered for tool '{tool_name}'",
        )

    return await _forward_and_scan(
        tool_name, arguments, server_url, rpc_id, tool_data
    )


async def _handle_blocked(
    tool_name: str,
    status: str,
    arguments: dict[str, Any],
    rpc_id: Any,
    lookup_ms: float,
) -> dict[str, Any]:
    """Build GuardError response, compute blast radius, emit WS alert."""
    from gateway import trace

    tool_data = await store.get_tool(tool_name) or {}
    blast = infer_blast_radius(tool_data)

    await trace.emit(
        "intercept.blocked",
        tool=tool_name,
        status="blocked",
        input_data={"tool": tool_name, "arguments": arguments},
        output_data={
            "guard_status": status,
            "blast_score": blast.blast_score,
            "cost_max": blast.cost_max,
            "linked_count": len(blast.linked),
        },
        meta={"lookup_ms": round(lookup_ms, 3)},
    )

    await trace.emit(
        "blast_radius",
        tool=tool_name,
        output_data={
            "blast_score": blast.blast_score,
            "cost_min": blast.cost_min,
            "cost_max": blast.cost_max,
            "linked": [{"id": l.id, "label": l.label, "severity": l.severity} for l in blast.linked],
        },
    )

    alert = {
        "type": "execution-blocked",
        "tool_name": tool_name,
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "severity": "critical",
        "message": f"Blocked call to '{tool_name}' (status={status})",
        "lookup_ms": round(lookup_ms, 2),
        "blast_radius": blast.to_dict(),
        "attempted_payload": {
            "tool": tool_name,
            "arguments": arguments,
        },
        "guard_response": {
            "error": "GuardError",
            "message": f"Tool '{tool_name}' is {status}. Execution denied by MCP Guard.",
        },
    }

    await store.add_alert(alert)
    await ws.broadcast({"event": "alert", "data": alert})

    logger.warning(
        "[BLOCKED] tool=%s blast_score=%s cost_max=$%s",
        tool_name,
        blast.blast_score,
        f"{blast.cost_max:,}",
    )

    return _rpc_error(
        rpc_id,
        -32001,
        f"GuardError: Tool '{tool_name}' is {status}. Execution denied by MCP Guard.",
        data={
            "guard_status": status,
            "blast_radius": blast.to_dict(),
        },
    )


async def _forward_and_scan(
    tool_name: str,
    arguments: dict[str, Any],
    server_url: str,
    rpc_id: Any,
    tool_data: dict[str, Any] | None,
) -> dict[str, Any]:
    """Forward approved call to MCP server, then scan the output."""
    from gateway import trace

    client = await _client()

    # Build a JSON-RPC 2.0 request to the origin server's /execute endpoint
    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
        "id": rpc_id,
    }

    await trace.emit(
        "intercept.forward",
        tool=tool_name,
        input_data={"server_url": server_url, "payload": payload},
    )

    t0 = time.perf_counter_ns()
    try:
        resp = await client.post(f"{server_url}/execute", json=payload)
        result = resp.json()
    except Exception as exc:
        fwd_ms = (time.perf_counter_ns() - t0) / 1_000_000
        logger.error("Failed to forward to %s: %s", server_url, exc)
        await trace.emit("intercept.forward.error", tool=tool_name, status="error", duration_ms=fwd_ms, output_data={"error": str(exc)})
        return _rpc_error(rpc_id, -32003, f"Upstream MCP server error: {exc}")

    fwd_ms = (time.perf_counter_ns() - t0) / 1_000_000
    await trace.emit(
        "intercept.response",
        tool=tool_name,
        duration_ms=fwd_ms,
        output_data=result,
        meta={"server_url": server_url, "forward_ms": round(fwd_ms, 2)},
    )

    # Scan the output for injection / credential leaks
    output_content = result.get("result", result)
    output_findings = scan_output(output_content)

    if output_findings and tool_data:
        was_safe = tool_data.get("status") == "approved"
        new_status = "quarantined" if any(f.severity == "critical" for f in output_findings) else "review"
        if was_safe:
            await store.set_tool_status(tool_name, new_status)
            await ws.broadcast(
                {
                    "event": "status_change",
                    "data": {
                        "tool_name": tool_name,
                        "status": new_status,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "source": "output_scan",
                    },
                }
            )

        alert = {
            "type": "output-threat",
            "tool_name": tool_name,
            "status": new_status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "severity": output_findings[0].severity,
            "message": f"Malicious output detected: {', '.join(f.label for f in output_findings)}",
            "findings": [asdict(f) for f in output_findings],
        }
        await store.add_alert(alert)
        await ws.broadcast({"event": "alert", "data": alert})

    return result


def _rpc_error(
    rpc_id: Any,
    code: int,
    message: str,
    data: dict | None = None,
) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data:
        err["data"] = data
    return {"jsonrpc": "2.0", "error": err, "id": rpc_id}
