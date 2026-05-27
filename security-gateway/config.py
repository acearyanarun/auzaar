from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

LLM_BASE_URL: str = os.getenv("LLM_BASE_URL", "http://localhost:8080/v1")
LLM_API_KEY: str = os.getenv("LLM_API_KEY", "not-needed")
LLM_MODEL: str = os.getenv("LLM_MODEL", "mlx-community/Qwen3.5-9B-MLX-4bit")

GATEWAY_PORT: int = int(os.getenv("GATEWAY_PORT", "8001"))
MCP_SERVER_PORT: int = int(os.getenv("MCP_SERVER_PORT", "8002"))
DASHBOARD_PORT: int = int(os.getenv("DASHBOARD_PORT", "3000"))

REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
MCP_SERVER_URL: str = os.getenv("MCP_SERVER_URL", "http://localhost:8002")
GATEWAY_URL: str = os.getenv("GATEWAY_URL", "http://localhost:8001")
