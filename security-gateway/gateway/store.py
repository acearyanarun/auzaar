"""Redis-backed tool status store with fakeredis fallback.

If a live Redis becomes unreachable after the initial connection,
the store automatically resets to an in-memory fakeredis instance
so the gateway never crashes on a storage failure.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("gateway.store")

_redis = None
_is_fake = False


async def _get_redis():
    global _redis, _is_fake
    if _redis is not None:
        return _redis

    import sys
    sys.path.insert(0, "..")
    from config import REDIS_URL

    try:
        import redis.asyncio as aioredis

        r = aioredis.from_url(REDIS_URL, decode_responses=True)
        await r.ping()
        _redis = r
        _is_fake = False
        logger.info("Connected to Redis at %s", REDIS_URL)
        return _redis
    except Exception:
        logger.warning("Redis unavailable — falling back to fakeredis")
        return _use_fakeredis()


def _use_fakeredis():
    global _redis, _is_fake
    import fakeredis.aioredis as fake

    _redis = fake.FakeRedis(decode_responses=True)
    _is_fake = True
    return _redis


async def _reset_on_error():
    """Drop a dead real-Redis connection and switch to fakeredis."""
    global _redis
    if _is_fake:
        return
    logger.warning("Redis connection lost — resetting to fakeredis")
    try:
        await _redis.aclose()
    except Exception:
        pass
    _redis = None
    _use_fakeredis()


async def _safe(coro_fn, *args, **kwargs):
    """Execute a Redis operation; on connection failure, reset and retry once."""
    try:
        return await coro_fn(*args, **kwargs)
    except (ConnectionError, OSError) as exc:
        if _is_fake:
            raise
        logger.warning("Redis op failed (%s), switching to fakeredis", type(exc).__name__)
        await _reset_on_error()
        return await coro_fn(*args, **kwargs)
    except Exception as exc:
        exc_name = type(exc).__name__
        if "Connection" in exc_name or "Refused" in str(exc):
            if _is_fake:
                raise
            logger.warning("Redis op failed (%s), switching to fakeredis", exc_name)
            await _reset_on_error()
            return await coro_fn(*args, **kwargs)
        raise


async def set_tool(name: str, data: dict[str, Any]) -> None:
    async def _op():
        r = await _get_redis()
        await r.set(f"tool:{name}", json.dumps(data))
    await _safe(_op)


async def get_tool(name: str) -> dict[str, Any] | None:
    async def _op():
        r = await _get_redis()
        raw = await r.get(f"tool:{name}")
        return json.loads(raw) if raw else None
    return await _safe(_op)


async def get_tool_status(name: str) -> str | None:
    """O(1) status lookup — the critical hot path."""
    async def _op():
        r = await _get_redis()
        return await r.get(f"tool:{name}:status")
    return await _safe(_op)


async def set_tool_status(name: str, status: str) -> None:
    async def _op():
        r = await _get_redis()
        await r.set(f"tool:{name}:status", status)
    await _safe(_op)
    tool = await get_tool(name)
    if tool:
        tool["status"] = status
        await set_tool(name, tool)


async def list_tools() -> list[dict[str, Any]]:
    async def _op():
        r = await _get_redis()
        keys = []
        async for key in r.scan_iter("tool:*"):
            if ":status" not in key:
                keys.append(key)
        tools = []
        for key in keys:
            raw = await r.get(key)
            if raw:
                tools.append(json.loads(raw))
        return tools
    return await _safe(_op)


async def add_alert(alert: dict[str, Any]) -> None:
    async def _op():
        r = await _get_redis()
        await r.lpush("alerts", json.dumps(alert))
        await r.ltrim("alerts", 0, 49)
    await _safe(_op)


async def get_alerts(count: int = 20) -> list[dict[str, Any]]:
    async def _op():
        r = await _get_redis()
        raw_list = await r.lrange("alerts", 0, count - 1)
        return [json.loads(x) for x in raw_list]
    return await _safe(_op)
