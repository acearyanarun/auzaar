"""Load MCP tool metadata from Markdown files (```json ... ``` blocks)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("mcp-server")

_TOOLS_DIR = Path(__file__).resolve().parent / "tools"

# Registration / listing order (filenames under tools/).
_TOOL_MANIFEST = (
    "read_ticket.md",
    "create_ticket.md",
    "analytics_reporter.md",
)


def _parse_tool_markdown(content: str, path: Path) -> dict[str, Any]:
    if "```json" not in content:
        raise ValueError(f"{path}: expected a ```json fenced block")
    _, rest = content.split("```json", 1)
    json_part, _, tail = rest.partition("```")
    if not tail and "```" not in rest:
        raise ValueError(f"{path}: unclosed ```json fence")
    return json.loads(json_part.strip())


def load_tools_from_dir(tools_dir: Path | None = None) -> list[dict[str, Any]]:
    """Return tool dicts in manifest order."""
    base = tools_dir or _TOOLS_DIR
    out: list[dict[str, Any]] = []
    for name in _TOOL_MANIFEST:
        path = base / name
        if not path.is_file():
            raise FileNotFoundError(f"Missing tool spec: {path}")
        tool = _parse_tool_markdown(path.read_text(), path)
        if tool.get("name") != path.stem:
            logger.warning(
                "Tool name %r does not match filename stem %r in %s",
                tool.get("name"),
                path.stem,
                path,
            )
        out.append(tool)
    return out
