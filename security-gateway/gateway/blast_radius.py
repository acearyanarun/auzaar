"""Static blast radius inference engine.

Maps tool metadata against data-linkage rules to estimate
business impact if the tool were compromised.
Ported from backend/server.js DATA_LINKAGE_RULES.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LinkedData:
    id: str
    label: str
    category: str
    severity: str
    icon: str
    regulation: str
    cost: dict[str, Any]


@dataclass
class BlastRadius:
    linked: list[LinkedData] = field(default_factory=list)
    blast_score: str = "low"
    cost_min: int = 0
    cost_max: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "linked": [
                {
                    "id": l.id,
                    "label": l.label,
                    "category": l.category,
                    "severity": l.severity,
                    "icon": l.icon,
                    "regulation": l.regulation,
                    "cost": l.cost,
                }
                for l in self.linked
            ],
            "blastScore": self.blast_score,
            "costMin": self.cost_min,
            "costMax": self.cost_max,
        }


_DATA_LINKAGE_RULES: list[dict[str, Any]] = [
    {
        "id": "customer-records",
        "label": "Customer records",
        "category": "internal-data",
        "pattern": re.compile(r"\b(customer|user|account|client|subscriber|member|pii|personal.?data)\b", re.I),
        "severity": "critical",
        "icon": "\U0001f464",
        "regulation": "GDPR \u00b7 CCPA \u00b7 SOC 2",
        "cost": {
            "headline": "Breach notification + regulatory fine",
            "low": 50_000,
            "high": 4_000_000,
            "unit": "USD",
            "items": [
                "Mandatory breach notification to affected users",
                "GDPR fines up to 4% of annual global revenue",
                "CCPA statutory damages $100\u2013$750 per record",
                "Class action litigation exposure",
                "Long-term churn from trust damage",
            ],
        },
    },
    {
        "id": "financial-records",
        "label": "Financial records",
        "category": "internal-data",
        "pattern": re.compile(r"\b(financial|payment|invoice|billing|revenue|transaction|bank|payroll|salary)\b", re.I),
        "severity": "critical",
        "icon": "\U0001f4b0",
        "regulation": "PCI-DSS \u00b7 SOX \u00b7 FCA",
        "cost": {
            "headline": "Regulatory fine + fraud liability",
            "low": 100_000,
            "high": 10_000_000,
            "unit": "USD",
            "items": [
                "PCI-DSS non-compliance fines and card-brand penalties",
                "SOX audit failure if financial reporting affected",
                "Fraud liability if payment data exfiltrated",
                "Emergency card reissuance costs",
                "External forensic audit requirement",
            ],
        },
    },
    {
        "id": "employee-data",
        "label": "Employee data",
        "category": "internal-data",
        "pattern": re.compile(r"\b(employee|staff|hr\b|human.?resource|personnel|workforce|benefits)\b", re.I),
        "severity": "high",
        "icon": "\U0001f3e2",
        "regulation": "GDPR \u00b7 HIPAA \u00b7 NLRA",
        "cost": {
            "headline": "Regulatory exposure + HR liability",
            "low": 20_000,
            "high": 500_000,
            "unit": "USD",
            "items": [
                "GDPR violation for employee PII exposure",
                "Potential discrimination claims if salary data leaked",
                "Internal trust collapse and morale impact",
                "Mandatory HR incident response and notification",
            ],
        },
    },
    {
        "id": "credentials",
        "label": "Credentials and secrets",
        "category": "secrets",
        "pattern": re.compile(r"\b(credential|password|secret|api[_\-.]?key|bearer|token|ssh|auth)\b|\.env\b|~/\.aws|id_rsa", re.I),
        "severity": "critical",
        "icon": "\U0001f511",
        "regulation": "ISO 27001 \u00b7 SOC 2 \u00b7 NIST CSF",
        "cost": {
            "headline": "Full infrastructure compromise",
            "low": 200_000,
            "high": 15_000_000,
            "unit": "USD",
            "items": [
                "Cloud account takeover and unbounded cost abuse",
                "Emergency rotation of all exposed secrets",
                "Downstream SaaS compromise from shared credentials",
                "Supply chain risk if CI/CD secrets exposed",
                "Ransomware deployment if infra access achieved",
            ],
        },
    },
    {
        "id": "system-execution",
        "label": "System execution",
        "category": "system",
        "pattern": re.compile(r"\b(exec\b|shell\b|eval\b|spawn\b|command|subprocess|run.?script)\b", re.I),
        "severity": "critical",
        "icon": "\u2699\ufe0f",
        "regulation": "SOC 2 \u00b7 ISO 27001",
        "cost": {
            "headline": "Unauthorized infrastructure actions",
            "low": 50_000,
            "high": 5_000_000,
            "unit": "USD",
            "items": [
                "Config changes causing outages or data loss",
                "Malware or backdoor installation on host",
                "Lateral movement to other internal services",
                "Rollback and restoration costs",
            ],
        },
    },
    {
        "id": "exfiltration-path",
        "label": "Exfiltration path",
        "category": "exfil",
        "pattern": re.compile(r"(callback[_\-.]?url|webhook|outbound|exfil|external.?api|forward.{0,20}result)", re.I),
        "severity": "critical",
        "icon": "\U0001f4e4",
        "regulation": "GDPR Art. 46 \u00b7 CCPA \u00b7 DPA",
        "cost": {
            "headline": "Active data loss channel \u2014 exit point for all linked data",
            "low": 0,
            "high": 0,
            "unit": "multiplier",
            "items": [
                "Amplifies every linked data type \u2014 acts as the exit point",
                "Data may leave before detection occurs",
                "Cross-border transfer violations if sent internationally",
                "No natural audit trail \u2014 hard to scope volume of loss",
            ],
        },
    },
    {
        "id": "internal-docs",
        "label": "Internal documentation",
        "category": "internal-data",
        "pattern": re.compile(r"\b(document|wiki|knowledge.?base|confluence|notion|internal.?doc|playbook|runbook)\b", re.I),
        "severity": "medium",
        "icon": "\U0001f4c4",
        "regulation": "Trade secret law \u00b7 NDA",
        "cost": {
            "headline": "IP leakage and competitive exposure",
            "low": 10_000,
            "high": 500_000,
            "unit": "USD",
            "items": [
                "Proprietary processes or strategy exposed",
                "Trade secret litigation if content misappropriated",
                "Internal audit required to scope what leaked",
            ],
        },
    },
    {
        "id": "cloud-infrastructure",
        "label": "Cloud infrastructure",
        "category": "system",
        "pattern": re.compile(r"\b(aws|azure|gcp|cloud|s3|ec2|lambda|kubernetes|k8s|iam)\b", re.I),
        "severity": "high",
        "icon": "\u2601\ufe0f",
        "regulation": "SOC 2 \u00b7 CSA CCM \u00b7 NIST CSF",
        "cost": {
            "headline": "Cloud account compromise and cost abuse",
            "low": 50_000,
            "high": 3_000_000,
            "unit": "USD",
            "items": [
                "IAM privilege escalation to full account control",
                "Cryptomining or data egress cost abuse",
                "Deletion or encryption of cloud resources",
                "Multi-region containment and forensic analysis",
            ],
        },
    },
    {
        "id": "support-data",
        "label": "Support and ticket data",
        "category": "internal-data",
        "pattern": re.compile(r"\b(support|ticket|zendesk|jira|helpdesk|complaint|case)\b", re.I),
        "severity": "medium",
        "icon": "\U0001f3ab",
        "regulation": "GDPR \u00b7 CCPA",
        "cost": {
            "headline": "Customer PII and operational exposure",
            "low": 15_000,
            "high": 300_000,
            "unit": "USD",
            "items": [
                "Customer contact details and issue history exposed",
                "Internal process details visible to attacker",
                "Potential GDPR notification obligation",
            ],
        },
    },
]


def infer_blast_radius(tool_def: dict[str, Any]) -> BlastRadius:
    """Map tool metadata against data linkage rules and estimate exposure."""
    haystack = " ".join(
        [
            tool_def.get("name", ""),
            tool_def.get("description", ""),
            json.dumps(tool_def.get("inputSchema", {})),
            json.dumps(tool_def.get("annotations", {})),
        ]
    )

    linked: list[LinkedData] = []
    for rule in _DATA_LINKAGE_RULES:
        if rule["pattern"].search(haystack):
            linked.append(
                LinkedData(
                    id=rule["id"],
                    label=rule["label"],
                    category=rule["category"],
                    severity=rule["severity"],
                    icon=rule["icon"],
                    regulation=rule["regulation"],
                    cost=rule["cost"],
                )
            )

    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    linked.sort(key=lambda l: sev_order.get(l.severity, 4))

    has_critical = any(l.severity == "critical" for l in linked)
    has_high = any(l.severity == "high" for l in linked)
    blast_score = "critical" if has_critical else "high" if has_high else "medium" if linked else "low"

    cost_usd = [l for l in linked if l.cost.get("unit") == "USD"]
    cost_min = sum(int(l.cost["low"]) for l in cost_usd)
    cost_max = sum(int(l.cost["high"]) for l in cost_usd)

    # Rules with unit "multiplier" (e.g. exfiltration path) amplify risk but carry $0 in the rule
    # definition so they are not double-counted as standalone USD. If they are the only match,
    # exposure must still reflect breach-scale impact (see analytics_reporter: callback_url only).
    multiplier_linked = [l for l in linked if l.cost.get("unit") == "multiplier"]
    if multiplier_linked:
        if cost_max == 0:
            cost_min = 4_000_000
            cost_max = 14_000_000
        else:
            cost_min = int(cost_min * 1.2)
            cost_max = int(cost_max * 1.5)

    return BlastRadius(
        linked=linked,
        blast_score=blast_score,
        cost_min=cost_min,
        cost_max=cost_max,
    )
