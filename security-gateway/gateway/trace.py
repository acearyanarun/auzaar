"""Structured trace collector for development visibility.

Captures every internal gateway operation with full input/output payloads,
stores in Redis, and broadcasts via WebSocket for the dashboard dev pane.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from gateway import store
from gateway.ws_manager import manager as ws

logger = logging.getLogger("gateway.trace")

_traces: list[dict[str, Any]] = []
MAX_TRACES = 200


async def emit(
    op: str,
    *,
    tool: str = "",
    status: str = "ok",
    duration_ms: float = 0.0,
    input_data: Any = None,
    output_data: Any = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Record and broadcast a single trace entry."""
    from datetime import datetime, timezone

    entry: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "op": op,
        "tool": tool,
        "status": status,
        "duration_ms": round(duration_ms, 2),
    }
    if input_data is not None:
        entry["input"] = _safe_serialize(input_data)
    if output_data is not None:
        entry["output"] = _safe_serialize(output_data)
    if meta:
        entry["meta"] = meta

    _traces.insert(0, entry)
    if len(_traces) > MAX_TRACES:
        _traces.pop()

    # Also persist to Redis for GET /traces across restarts
    try:
        r = await store._get_redis()
        await r.lpush("traces", json.dumps(entry))
        await r.ltrim("traces", 0, MAX_TRACES - 1)
    except Exception:
        pass

    await ws.broadcast({"event": "trace", "data": entry})
    return entry


async def get_traces(count: int = 100) -> list[dict[str, Any]]:
    """Retrieve recent traces from Redis (or in-memory fallback)."""
    try:
        r = await store._get_redis()
        raw_list = await r.lrange("traces", 0, count - 1)
        return [json.loads(x) for x in raw_list]
    except Exception:
        return _traces[:count]


def _safe_serialize(data: Any, max_len: int = 4000) -> Any:
    """Ensure data is JSON-serializable and not excessively large."""
    if data is None:
        return None
    if isinstance(data, (str, int, float, bool)):
        if isinstance(data, str) and len(data) > max_len:
            return data[:max_len] + f"... ({len(data)} chars)"
        return data
    try:
        serialized = json.dumps(data, default=str)
        if len(serialized) > max_len:
            return json.loads(serialized[:max_len] + "}")
    except Exception:
        pass
    return data


class TraceTimer:
    """Context manager that auto-emits a trace entry on exit."""

    def __init__(self, op: str, **kwargs: Any) -> None:
        self.op = op
        self.kwargs = kwargs
        self._t0 = 0.0
        self.output_data: Any = None
        self.status: str = "ok"
        self.meta: dict[str, Any] = {}

    async def __aenter__(self) -> "TraceTimer":
        self._t0 = time.perf_counter_ns()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        duration_ms = (time.perf_counter_ns() - self._t0) / 1_000_000
        if exc_val:
            self.status = "error"
            self.meta["error"] = str(exc_val)
        await emit(
            self.op,
            duration_ms=duration_ms,
            status=self.status,
            output_data=self.output_data,
            meta={**self.kwargs.get("meta", {}), **self.meta},
            **{k: v for k, v in self.kwargs.items() if k != "meta"},
        )
