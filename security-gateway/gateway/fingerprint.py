"""SHA256 fingerprint of MCP tool registration payloads (canonical JSON)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

def normalized_registration_dict(
    *,
    name: str,
    description: str = "",
    inputSchema: dict[str, Any] | None = None,
    annotations: dict[str, Any] | None = None,
    source: str = "",
    server_url: str = "",
    default_server_url: str = "",
) -> dict[str, Any]:
    """Same logical fields as persisted tool_record / ToolRegistration, with server_url default applied."""
    return {
        "name": name,
        "description": description,
        "inputSchema": dict(inputSchema or {}),
        "annotations": dict(annotations or {}),
        "source": source,
        "server_url": server_url or default_server_url,
    }


def registration_sha256(payload: dict[str, Any]) -> str:
    """Stable digest for drift detection (sorted JSON keys)."""
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()
