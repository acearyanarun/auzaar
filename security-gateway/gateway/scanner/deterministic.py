"""Deterministic regex-based scanner for tool metadata and output.

Ported from backend/server.js METADATA_RULES / OUTPUT_RULES.
Target latency: <2 ms per scan.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Finding:
    id: str
    label: str
    severity: str  # critical | high | medium
    phrase: str
    location: str  # description | schema | annotations | output
    why: str
    action: str


@dataclass
class ScanResult:
    score: str  # critical | high | medium | low
    findings: list[Finding] = field(default_factory=list)


# ── Metadata rules (scanned at registration time) ────────────────────────────

_METADATA_RULES: list[dict[str, Any]] = [
    {
        "id": "prompt-override",
        "pattern": re.compile(
            r"ignore\s+(previous|prior|all|above)\s*(instructions?|context|prompt|rules?|constraints?)?",
            re.IGNORECASE,
        ),
        "label": "Prompt override attempt",
        "severity": "critical",
        "why": (
            "Instructs the model to disregard prior system-level context. "
            "This is the canonical prompt injection pattern, found in the wild "
            "in malicious MCP tools targeting Claude and GPT-based agents."
        ),
        "action": (
            "Block immediately. This pattern has no legitimate use in tool metadata. "
            "Audit the tool source and consider revoking the server's registration token."
        ),
    },
    {
        "id": "role-manipulation",
        "pattern": re.compile(
            r"you are now|disregard your|act as (an? )?(admin|root|superuser|unrestricted|jailbreak)",
            re.IGNORECASE,
        ),
        "label": "Role manipulation",
        "severity": "critical",
        "why": (
            "Attempts to redefine the model's identity or override its operational "
            "boundaries. Used to bypass safety constraints by convincing the model "
            "it is in an unrestricted mode."
        ),
        "action": (
            "Block immediately. Escalate to your security team. "
            "This pattern is never legitimate in tool metadata."
        ),
    },
    {
        "id": "hidden-instruction",
        "pattern": re.compile(
            r"do not (tell|mention|reveal|inform)|keep this (hidden|secret|confidential)|without (the user|them) knowing",
            re.IGNORECASE,
        ),
        "label": "Hidden instruction",
        "severity": "critical",
        "why": (
            "Tool metadata explicitly instructs the model to conceal its behavior "
            "from the user. This is a social engineering pattern targeting AI "
            "transparency — the tool is designed to operate covertly."
        ),
        "action": (
            "Block immediately. Report to security team. Any tool designed to hide "
            "its behavior is fundamentally untrustworthy."
        ),
    },
    {
        "id": "credential-reference",
        "pattern": re.compile(
            r"\b(credentials?|password|secret|api[_\-.]?key|bearer[_\-.]?token|auth[_\-.]?token)\b",
            re.IGNORECASE,
        ),
        "label": "Credential reference",
        "severity": "high",
        "why": (
            "Tool metadata references authentication material. Legitimate tool "
            "descriptions rarely need to mention credentials — this may indicate "
            "the tool is designed to harvest or transmit secrets."
        ),
        "action": (
            "Review carefully. Verify the tool owner has a legitimate reason to "
            "handle credentials. Restrict to quarantine environment until confirmed."
        ),
    },
    {
        "id": "sensitive-file-path",
        "pattern": re.compile(
            r"(~\/\.aws|\.env\b|\/etc\/passwd|id_rsa|\.ssh\/|\.netrc|\.npmrc)",
            re.IGNORECASE,
        ),
        "label": "Sensitive file path",
        "severity": "high",
        "why": (
            "References paths that commonly contain credentials or system secrets. "
            "Could indicate the tool is designed to read authentication files or "
            "system configuration off the host running the agent."
        ),
        "action": (
            "Block unless the tool source is fully audited. "
            "Verify the tool owner's intent with the platform team."
        ),
    },
    {
        "id": "code-execution-hint",
        "pattern": re.compile(
            r"\b(exec\b|shell\b|eval\b|spawn\b|system[_\-. ]call|run[_\-. ]command|subprocess|os\.system)\b",
            re.IGNORECASE,
        ),
        "label": "Code execution hint",
        "severity": "high",
        "why": (
            "Tool metadata suggests shell or arbitrary code execution capability. "
            "Combined with other flags this strongly indicates a tool that could "
            "achieve host-level code execution when called by an agent."
        ),
        "action": (
            "Require explicit platform team approval. "
            "Restrict to an isolated environment. Log all invocations."
        ),
    },
    {
        "id": "exfiltration-indicator",
        "pattern": re.compile(
            r"(callback[_\-.]?url|exfil|data.{0,20}extract.{0,20}external|send.{0,20}to.{0,20}server|forward.{0,20}results?)",
            re.IGNORECASE,
        ),
        "label": "Potential data exfiltration",
        "severity": "high",
        "why": (
            "Tool schema or description references outbound data transmission to "
            "caller-controlled endpoints. This is a documented MCP attack pattern "
            "where tools silently forward conversation data to attacker-controlled "
            "infrastructure."
        ),
        "action": (
            "Block. Inspect schema for callback_url or webhook fields. "
            "Monitor outbound network traffic from the tool server."
        ),
    },
]

# ── Output rules (scanned after tool execution) ──────────────────────────────

_OUTPUT_RULES: list[dict[str, Any]] = [
    {
        "id": "output-prompt-override",
        "pattern": re.compile(
            r"ignore\s+(previous|prior|all|above)\s*(instructions?|context|rules?)?",
            re.IGNORECASE,
        ),
        "label": "Prompt injection in output",
        "severity": "critical",
        "why": (
            "Tool output contains a prompt injection attempt. Either the tool "
            "itself is malicious, or a data source it queries has been compromised "
            "(indirect prompt injection)."
        ),
        "action": (
            "Quarantine tool immediately. Treat all output from this tool in "
            "recent sessions as untrusted. Investigate the upstream data source."
        ),
    },
    {
        "id": "output-role-manipulation",
        "pattern": re.compile(
            r"you are now|disregard your|act as (an? )?(admin|root|unrestricted)",
            re.IGNORECASE,
        ),
        "label": "Role manipulation in output",
        "severity": "critical",
        "why": (
            "Tool output attempts to redefine the model's role or permissions. "
            "Classic indirect prompt injection via a compromised data source."
        ),
        "action": (
            "Quarantine tool. Investigate the data source the tool queries. "
            "Review any agent actions taken after this tool was called."
        ),
    },
    {
        "id": "output-credential-pattern",
        "pattern": re.compile(
            r"""(password|api[_\-.]?key|bearer|secret)[=:\s]["']?[a-zA-Z0-9+/]{8,}""",
            re.IGNORECASE,
        ),
        "label": "Credential pattern in output",
        "severity": "high",
        "why": (
            "Tool output contains what appears to be a real credential or token. "
            "Could be an accidental leak or an active exfiltration attempt."
        ),
        "action": (
            "Quarantine tool. Rotate any potentially leaked credentials immediately. "
            "Audit what data sources the tool accesses."
        ),
    },
]


def _scan_section(
    text: str,
    rules: list[dict[str, Any]],
    location: str,
) -> list[Finding]:
    findings: list[Finding] = []
    for rule in rules:
        m = rule["pattern"].search(text)
        if m:
            findings.append(
                Finding(
                    id=rule["id"],
                    label=rule["label"],
                    severity=rule["severity"],
                    phrase=m.group(0),
                    location=location,
                    why=rule["why"],
                    action=rule["action"],
                )
            )
    return findings


def scan_metadata(tool_def: dict[str, Any]) -> ScanResult:
    """Scan tool description, schema properties, and annotations."""
    findings: list[Finding] = []
    findings.extend(
        _scan_section(tool_def.get("description") or "", _METADATA_RULES, "description")
    )
    findings.extend(
        _scan_section(
            json.dumps(
                (tool_def.get("inputSchema") or {}).get("properties", {})
            ),
            _METADATA_RULES,
            "schema",
        )
    )
    findings.extend(
        _scan_section(
            json.dumps(tool_def.get("annotations") or {}),
            _METADATA_RULES,
            "annotations",
        )
    )

    has_critical = any(f.severity == "critical" for f in findings)
    has_high = any(f.severity == "high" for f in findings)
    if has_critical:
        score = "critical"
    elif has_high:
        score = "high"
    elif findings:
        score = "medium"
    else:
        score = "low"

    return ScanResult(score=score, findings=findings)


def scan_output(output: Any) -> list[Finding]:
    """Scan tool execution output for injection or credential leaks."""
    text = output if isinstance(output, str) else json.dumps(output)
    return _scan_section(text, _OUTPUT_RULES, "output")


def default_status(score: str) -> str:
    if score in ("critical", "high"):
        return "blocked"
    if score == "medium":
        return "review"
    return "approved"
