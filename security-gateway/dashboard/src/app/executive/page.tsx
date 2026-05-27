"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewToggle } from "@/components/ViewToggle";

/* ─── Types (executive route; gateway blast_radius.to_dict shape) ─────────── */

interface LinkedDatum {
  id: string;
  label: string;
  regulation: string;
  severity: string;
  cost?: { headline?: string; items?: string[] };
}

interface BlastRadius {
  costMin: number;
  costMax: number;
  blastScore: string;
  linked: LinkedDatum[];
}

interface Tool {
  name: string;
  description: string;
  status: string;
  riskScore: string;
  blastRadius: BlastRadius;
}

interface Alert {
  tool_name: string;
  severity: string;
  message: string;
}

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8001";

const fmt = (n: number) => {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
};

function isCallable(status: string): boolean {
  return status === "approved" || status === "review" || status === "env-scoped";
}

function br(tool: Tool): BlastRadius {
  const b = tool.blastRadius;
  if (!b) {
    return { costMin: 0, costMax: 0, blastScore: "low", linked: [] };
  }
  return {
    costMin: b.costMin ?? 0,
    costMax: b.costMax ?? 0,
    blastScore: b.blastScore ?? "low",
    linked: Array.isArray(b.linked) ? b.linked : [],
  };
}

function unmitigatedAggregates(callable: Tool[]) {
  let costMin = 0;
  let costMax = 0;
  for (const t of callable) {
    const b = br(t);
    costMin += b.costMin;
    costMax += b.costMax;
  }
  return { costMin, costMax };
}

/** Sum cost across all tools (callable + uncallable) for total exposure. */
function totalAggregates(tools: Tool[]) {
  let costMin = 0;
  let costMax = 0;
  for (const t of tools) {
    const b = br(t);
    costMin += b.costMin;
    costMax += b.costMax;
  }
  return { costMin, costMax };
}

function criticalCount(tools: Tool[]): number {
  return tools.filter((t) => t.riskScore === "critical").length;
}

/** Critical-risk tools that are blocked or quarantined (uncallable). */
function criticalUncallableTools(tools: Tool[]): Tool[] {
  return tools.filter(
    (t) =>
      !isCallable(t.status) &&
      (t.riskScore === "critical" || br(t).blastScore === "critical"),
  );
}

/** Section 2: downside if we do nothing — callable exposure plus modeled cost of critical contained tools (if unblocked). */
function inactionCostBand(tools: Tool[], callable: Tool[]) {
  const { costMin: cMin, costMax: cMax } = unmitigatedAggregates(callable);
  const { costMin: uMin, costMax: uMax } = unmitigatedAggregates(criticalUncallableTools(tools));
  return { costMin: cMin + uMin, costMax: cMax + uMax };
}

function dataReachLabels(callable: Tool[], cap = 8): { shown: string[]; more: number } {
  const seen = new Set<string>();
  for (const t of callable) {
    for (const l of br(t).linked) {
      if (l.label) seen.add(l.label);
    }
  }
  const all = [...seen];
  return {
    shown: all.slice(0, cap),
    more: Math.max(0, all.length - cap),
  };
}

function frameworksAtRisk(callable: Tool[]): string[] {
  const set = new Set<string>();
  for (const t of callable) {
    for (const l of br(t).linked) {
      if (!l.regulation) continue;
      for (const part of l.regulation.split(/·|\|/).map((s) => s.trim()).filter(Boolean)) {
        set.add(part);
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

const CITATION_HINTS: { test: RegExp; line: string }[] = [
  { test: /GDPR/i, line: "GDPR — illustrative: Art. 32–33 (security of processing; breach notification)" },
  { test: /CCPA/i, line: "CCPA — illustrative: statutory damages & consumer notice obligations" },
  { test: /PCI/i, line: "PCI-DSS — illustrative: Req. 6–8 (secure systems, access control, logging)" },
  { test: /SOX/i, line: "SOX — illustrative: internal controls over financial reporting (ITGC)" },
  { test: /HIPAA/i, line: "HIPAA — illustrative: Security Rule §164.308–312" },
  { test: /SOC\s*2/i, line: "SOC 2 — illustrative: CC6/CC7 (logical access & system operations)" },
  { test: /FCA/i, line: "FCA — illustrative: operational resilience & conduct expectations" },
  { test: /ISO\s*27001/i, line: "ISO 27001 — illustrative: Annex A controls (access, crypto, ops security)" },
];

function citationLinesForFrameworks(frameworks: string[]): string[] {
  const lines: string[] = [];
  const used = new Set<string>();
  for (const fw of frameworks) {
    for (const { test, line } of CITATION_HINTS) {
      if (test.test(fw) && !used.has(line)) {
        used.add(line);
        lines.push(line);
        break;
      }
    }
  }
  return lines;
}

function auditPosture(callable: Tool[]): { level: "severe" | "elevated" | "lower"; text: string } {
  const anyCrit =
    callable.some((t) => t.riskScore === "critical" || br(t).blastScore === "critical");
  const anyHigh =
    callable.some((t) => t.riskScore === "high" || br(t).blastScore === "high");
  if (anyCrit) {
    return {
      level: "severe",
      text: "Callable tools touch critical blast scenarios — elevated likelihood of findings in a focused compliance or security review.",
    };
  }
  if (anyHigh) {
    return {
      level: "elevated",
      text: "Some callable tools carry elevated risk — expect scrutiny under audit or customer diligence.",
    };
  }
  return {
    level: "lower",
    text: "Lower active regulatory surface from currently callable MCP tools (per registered definitions).",
  };
}

const RISK_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

type ExecRecommendation = {
  headline: string;
  detail: string;
  exposureNote: string;
  mitigationNote?: string;
};

function buildRecommendation(callable: Tool[], allTools: Tool[]): ExecRecommendation {
  const uncallableCrit = criticalUncallableTools(allTools);

  function mitigationBlock(): string | undefined {
    if (uncallableCrit.length === 0) return undefined;
    const sorted = [...uncallableCrit].sort((a, b) => br(b).costMax - br(a).costMax);
    const names = sorted.map((t) => t.name).join(", ");
    const totalAvoided = sorted.reduce((s, t) => s + br(t).costMax, 0);
    return `Mitigation in place: Keep **${names}** blocked or quarantined — combined exposure avoided if unblocked: up to ${fmt(totalAvoided)}.`;
  }

  if (callable.length === 0) {
    const blockedHigh = allTools.filter(
      (t) =>
        !isCallable(t.status) &&
        (t.riskScore === "critical" || t.riskScore === "high" || br(t).blastScore === "critical"),
    );
    if (blockedHigh.length > 0) {
      const sortedBlocked = [...blockedHigh].sort((a, b) => br(b).costMax - br(a).costMax);
      const top = sortedBlocked[0];
      return {
        headline: "Maintain containment",
        detail: `Keep **${top.name}** and other high-risk tools blocked or quarantined until security signs off.`,
        exposureNote: `Modeled exposure for the highest blocked tool: up to ${fmt(br(top).costMax)}.`,
        mitigationNote: uncallableCrit.length > 0 ? mitigationBlock() : undefined,
      };
    }
    return {
      headline: "Registry posture",
      detail: "No tools are in callable states (approved, review, or env-scoped).",
      exposureNote: "Confirm this matches intended production policy.",
    };
  }

  const sorted = [...callable].sort((a, b) => {
    const ra = RISK_ORDER[a.riskScore] ?? 9;
    const rb = RISK_ORDER[b.riskScore] ?? 9;
    if (ra !== rb) return ra - rb;
    const ca = br(a).costMax;
    const cb = br(b).costMax;
    if (cb !== ca) return cb - ca;
    return a.name.localeCompare(b.name);
  });

  const worst = sorted[0];
  const wbr = br(worst);
  const max = wbr.costMax;

  const needsHold =
    worst.riskScore === "critical" ||
    worst.riskScore === "high" ||
    wbr.blastScore === "critical" ||
    wbr.blastScore === "high" ||
    max > 0;

  if (!needsHold) {
    return {
      headline: "No mandatory executive action",
      detail: "Maintain monitoring and periodic tool review — callable tools are lower tier in this snapshot.",
      exposureNote: "Revisit if new tools register or statuses change to approved/review.",
      mitigationNote: uncallableCrit.length > 0 ? mitigationBlock() : undefined,
    };
  }

  const exposureNote =
    max > 0
      ? `Potential downside if this capability is abused or misconfigured: up to ${fmt(max)} (modeled).`
      : "Model shows limited dollar exposure for this tool; still complete review before widening access.";

  if (worst.status === "review") {
    return {
      headline: "Complete review before approval",
      detail: `Finish security review for **${worst.name}** before granting broader or production access.`,
      exposureNote,
      mitigationNote: uncallableCrit.length > 0 ? mitigationBlock() : undefined,
    };
  }

  return {
    headline: "Withhold expanded approval",
    detail: `Do not expand use of **${worst.name}** until security and compliance sign off.`,
    exposureNote,
    mitigationNote: uncallableCrit.length > 0 ? mitigationBlock() : undefined,
  };
}

/** Illustrative split of max exposure — not actuarial. */
const COST_SPLIT = [
  { key: "breach", label: "Breach response & forensics", w: 0.3 },
  { key: "reg", label: "Regulatory fines & penalties", w: 0.35 },
  { key: "rep", label: "Reputation & churn", w: 0.2 },
  { key: "ops", label: "Operational downtime & recovery", w: 0.15 },
] as const;

const STATUS_ORDER: Record<string, number> = {
  blocked: 0,
  quarantined: 1,
  review: 2,
  approved: 3,
  "env-scoped": 4,
};

const statusBadgeClass: Record<string, string> = {
  approved: "bg-green/10 text-green border-green/30",
  review: "bg-high/10 text-high border-high/30",
  blocked: "bg-critical/10 text-critical border-critical/30",
  quarantined: "bg-purple/10 text-purple border-purple/30",
  "env-scoped": "bg-accent/10 text-accent border-accent/30",
};

function StatusBadge({ status }: { status: string }) {
  const cls = statusBadgeClass[status] || "bg-white/5 text-white/50 border-white/10";
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold border ${cls}`}>
      {status}
    </span>
  );
}

function sortTools(tools: Tool[]): Tool[] {
  return [...tools].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5),
  );
}

function rowTone(tool: Tool): "danger" | "warning" | "default" {
  const danger =
    tool.riskScore === "critical" ||
    tool.status === "blocked" ||
    tool.status === "quarantined";
  if (danger) return "danger";
  if (tool.status === "review" || tool.riskScore === "high") return "warning";
  return "default";
}

function exportReport(
  tools: Tool[],
  alerts: Alert[],
  extras: {
    totalMin: number;
    totalMax: number;
    inactionMin: number;
    inactionMax: number;
    criticalTotal: number;
    frameworks: string[];
    recommendation: ExecRecommendation;
  },
) {
  const lines = [
    "Auzaar — Executive Security Report",
    new Date().toLocaleString(),
    "─".repeat(60),
    "",
    "TOTAL EXPOSURE (all registered tools)",
    `  Aggregate range: ${fmt(extras.totalMin)} – ${fmt(extras.totalMax)}`,
    `  Critical-risk tools: ${extras.criticalTotal}`,
    "",
    "POTENTIAL INCIDENT COST BAND (callable + critical-risk blocked/quarantined)",
    `  ${fmt(extras.inactionMin)} – ${fmt(extras.inactionMax)}`,
    "  (includes downside if contained critical tools were callable again)",
    "",
    "FRAMEWORKS IN SCOPE (callable tools)",
    extras.frameworks.length ? extras.frameworks.map((f) => `  • ${f}`).join("\n") : "  (none inferred)",
    "",
    "RECOMMENDATION",
    `  ${extras.recommendation.headline}`,
    `  ${extras.recommendation.detail.replace(/\*\*/g, "")}`,
    `  ${extras.recommendation.exposureNote}`,
    ...(extras.recommendation.mitigationNote
      ? [`  ${extras.recommendation.mitigationNote.replace(/\*\*/g, "")}`]
      : []),
    "",
    "NOTE: Cost breakdown in the UI uses illustrative allocation of the max exposure; actual loss varies.",
    "─".repeat(60),
    "",
    `Total tools: ${tools.length}`,
    `Callable: ${tools.filter((t) => isCallable(t.status)).length}`,
    `Blocked: ${tools.filter((t) => t.status === "blocked").length}`,
    `Quarantined: ${tools.filter((t) => t.status === "quarantined").length}`,
    "",
    "TOOL REGISTRY",
    "─".repeat(60),
    ...tools.map((t) => {
      const b = br(t);
      const exp = b.costMax ? ` exposure=${fmt(b.costMin)}–${fmt(b.costMax)}` : "";
      const call = isCallable(t.status) ? " [callable]" : "";
      return `${t.name.padEnd(24)} ${t.status.padEnd(12)} risk=${t.riskScore}${call}${exp}`;
    }),
    "",
    "ALERTS",
    "─".repeat(60),
    ...alerts.map(
      (a) =>
        `[${a.severity.toUpperCase().padEnd(8)}] ${a.tool_name}: ${a.message}`,
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mcp-guard-report.txt";
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── Page ─────────────────────────────────────────────────────────────────── */

export default function ExecutivePage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [callableOnly, setCallableOnly] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    const safeFetch = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const [t, a] = await Promise.all([
      safeFetch<Tool[]>(`${GATEWAY}/tools`),
      safeFetch<Alert[]>(`${GATEWAY}/alerts`),
    ]);

    if (Array.isArray(t)) setTools(t);
    if (Array.isArray(a)) setAlerts(a);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);

    const wsUrl = GATEWAY.replace(/^http/, "ws") + "/ws";
    const toolMutatingTraceOps = new Set([
      "register.complete",
      "register.fingerprint_drift",
      "status_change",
    ]);

    const connect = () => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.event === "alert" && msg.data) {
            setAlerts((prev) => [msg.data, ...prev].slice(0, 30));
            refresh();
          }
          if (msg.event === "status_change") {
            refresh();
          }
          if (msg.event === "trace" && msg.data?.op && toolMutatingTraceOps.has(msg.data.op)) {
            refresh();
          }
        } catch {
          /* ignore */
        }
      };
    };
    connect();

    return () => {
      clearInterval(interval);
      wsRef.current?.close();
    };
  }, [refresh]);

  const callable = useMemo(() => tools.filter((t) => isCallable(t.status)), [tools]);
  const { costMin: totalMin, costMax: totalMax } = useMemo(
    () => totalAggregates(tools),
    [tools],
  );
  const criticalTotal = useMemo(() => criticalCount(tools), [tools]);
  const { costMin: inactionMin, costMax: inactionMax } = useMemo(
    () => inactionCostBand(tools, callable),
    [tools, callable],
  );
  const reach = useMemo(() => dataReachLabels(callable), [callable]);
  const frameworks = useMemo(() => frameworksAtRisk(callable), [callable]);
  const posture = useMemo(() => auditPosture(callable), [callable]);
  const citations = useMemo(() => citationLinesForFrameworks(frameworks), [frameworks]);
  const recommendation = useMemo(() => buildRecommendation(callable, tools), [callable, tools]);

  const splitRows = useMemo(() => {
    if (inactionMax <= 0) return COST_SPLIT.map((r) => ({ ...r, value: 0 }));
    return COST_SPLIT.map((r) => ({ ...r, value: Math.round(inactionMax * r.w) }));
  }, [inactionMax]);

  const sorted = sortTools(tools);
  const listTools = callableOnly ? sorted.filter((t) => isCallable(t.status)) : sorted;

  const subtitle = `MCP Tool Registry — ${new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  })}`;

  const postureBorder =
    posture.level === "severe"
      ? "border-critical/40 bg-critical/[0.07]"
      : posture.level === "elevated"
        ? "border-high/40 bg-high/[0.06]"
        : "border-green/30 bg-green/[0.04]";

  return (
    <div className="min-h-screen flex flex-col overflow-hidden">
      <header className="h-13 glass border-b border-white/[0.06] px-5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <img
            src="/auzaar-icon.png"
            alt=""
            width={28}
            height={28}
            aria-hidden
            className="w-7 h-7 rounded-md object-cover shadow-[0_0_16px_rgba(0,200,255,0.25)]"
          />
          <span className="text-sm font-bold tracking-tight">Auzaar</span>
          <span className="text-[11px] text-white/40 uppercase tracking-wider">
            Executive
          </span>
        </div>
        <div className="flex items-center gap-3 flex-wrap justify-end">
          <button
            type="button"
            onClick={() =>
              exportReport(tools, alerts, {
                totalMin,
                totalMax,
                inactionMin,
                inactionMax,
                criticalTotal,
                frameworks,
                recommendation,
              })
            }
            className="shrink-0 px-4 py-1.5 rounded-lg border border-accent text-accent text-[11px] font-bold tracking-wide hover:bg-accent hover:text-bg transition-colors"
          >
            Export Report →
          </button>
          <ViewToggle />
          <div className="text-xs text-white/50">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${wsConnected ? "bg-green live-dot" : "bg-critical"}`}
            />
            {wsConnected ? "Live" : "Connecting..."}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 md:p-8">
        <div className="max-w-6xl mx-auto space-y-8">
          <div>
            <h1 className="text-2xl md:text-[28px] font-extrabold tracking-tight text-white mb-1">
              Executive risk snapshot
            </h1>
            <p className="text-sm text-white/45">{subtitle}</p>
            <p className="text-[11px] text-white/25 mt-2">
              Session alerts: {alerts.length} (detail in Developer view)
            </p>
          </div>

          {/* 1. How exposed are we */}
          <section className="glass rounded-2xl p-6 md:p-8 border border-white/[0.08]">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-4">
              1. How exposed are we right now
            </h2>
            <div className="text-4xl md:text-5xl font-black tabular-nums text-critical leading-none mb-2">
              {fmt(totalMax)}
            </div>
            <p className="text-sm text-white/50 mb-1">
              Total exposure (max) — all registered tools
            </p>
            <p className="text-xs text-white/35 mb-6">
              Range: {fmt(totalMin)} – {fmt(totalMax)} · Callable tools: {callable.length} of{" "}
              {tools.length}
            </p>
            <div className="flex flex-wrap gap-4 items-baseline">
              <div>
                <span className="text-[10px] font-bold uppercase text-white/35 block mb-1">
                  Critical-risk
                </span>
                <span className="text-2xl font-extrabold text-critical tabular-nums">
                  {criticalTotal}
                </span>
                <span className="text-xs text-white/40 ml-2">tools</span>
              </div>
            </div>
            <div className="mt-5">
              <span className="text-[10px] font-bold uppercase text-white/35 block mb-2">
                Data &amp; systems in scope (modeled reach)
              </span>
              {reach.shown.length === 0 ? (
                <p className="text-xs text-white/30">No linkage labels for callable tools in this snapshot.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {reach.shown.map((label) => (
                    <span
                      key={label}
                      className="px-2 py-1 rounded-md bg-white/[0.06] border border-white/10 text-[11px] text-white/70"
                    >
                      {label}
                    </span>
                  ))}
                  {reach.more > 0 && (
                    <span className="px-2 py-1 text-[11px] text-white/35">+{reach.more} more</span>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* 2. Cost if we do nothing */}
          <section className="glass rounded-2xl p-6 md:p-8 border border-white/[0.08]">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-4">
              2. What it costs if we do nothing
            </h2>
            <p className="text-lg font-bold text-white mb-1">
              Potential incident cost band: {fmt(inactionMin)} – {fmt(inactionMax)}
            </p>
            <p className="text-[11px] text-white/35 mb-2">
              Includes callable-tool misuse plus modeled exposure from{" "}
              <span className="text-white/50">critical-risk blocked or quarantined</span> tools if
              they were callable again.
            </p>
            <p className="text-[11px] text-white/35 mb-4">
              Illustrative allocation of the <span className="text-white/50">upper</span> bound — not
              actuarial; actual loss varies by incident.
            </p>
            <ul className="space-y-2">
              {splitRows.map((row) => (
                <li
                  key={row.key}
                  className="flex justify-between gap-4 text-sm border-b border-white/[0.05] pb-2"
                >
                  <span className="text-white/55">{row.label}</span>
                  <span className="font-mono font-bold text-white/90 tabular-nums shrink-0">
                    {inactionMax > 0 ? fmt(row.value) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* 3. Compliance */}
          <section className={`glass rounded-2xl p-6 md:p-8 border ${postureBorder}`}>
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40 mb-4">
              3. Are we compliant
            </h2>
            <p className="text-sm text-white/80 mb-4 leading-relaxed">{posture.text}</p>
            <span className="text-[10px] font-bold uppercase text-white/35 block mb-2">
              Frameworks in scope (callable tools)
            </span>
            {frameworks.length === 0 ? (
              <p className="text-xs text-white/30 mb-4">No regulatory tags inferred from tool metadata.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 mb-5">
                {frameworks.map((f) => (
                  <span
                    key={f}
                    className="px-2 py-1 rounded-md border border-white/15 text-[11px] font-semibold text-white/80"
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}
            {citations.length > 0 && (
              <>
                <span className="text-[10px] font-bold uppercase text-white/35 block mb-2">
                  Illustrative citation hooks
                </span>
                <ul className="list-disc list-inside space-y-1 text-[11px] text-white/45">
                  {citations.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {/* 5. One decision */}
          <section className="glass rounded-2xl p-6 md:p-8 border border-accent/30 bg-accent/[0.04]">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-accent/80 mb-4">
              Decision for leadership
            </h2>
            <p className="text-xl font-extrabold text-white mb-2">{recommendation.headline}</p>
            <p className="text-sm text-white/75 mb-3 leading-relaxed">
              {recommendation.detail.split("**").map((part, i) =>
                i % 2 === 1 ? (
                  <span key={i} className="font-mono font-bold text-accent">
                    {part}
                  </span>
                ) : (
                  part
                ),
              )}
            </p>
            <p className="text-xs text-white/50 border-t border-white/10 pt-3">{recommendation.exposureNote}</p>
            {recommendation.mitigationNote && (
              <p className="text-xs text-white/50 border-t border-white/10 pt-3 mt-3">
                {recommendation.mitigationNote.split("**").map((part, i) =>
                  i % 2 === 1 ? (
                    <span key={i} className="font-mono font-semibold text-accent/90">
                      {part}
                    </span>
                  ) : (
                    part
                  ),
                )}
              </p>
            )}
          </section>

          {/* Registry list */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40">
                Tool registry
              </h2>
              <label className="flex items-center gap-2 text-[11px] text-white/45 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={callableOnly}
                  onChange={(e) => setCallableOnly(e.target.checked)}
                  className="rounded border-white/20 bg-white/5"
                />
                Callable only
              </label>
            </div>
            <div className="space-y-2">
              {listTools.length === 0 && (
                <div className="glass rounded-lg p-10 text-center text-sm text-white/30">
                  {tools.length === 0
                    ? "Waiting for tools to register…"
                    : "No tools match this filter."}
                </div>
              )}
              {listTools.map((tool) => {
                const tone = rowTone(tool);
                const borderLeft =
                  tone === "danger"
                    ? "border-l-[3px] border-l-critical bg-critical/[0.06]"
                    : tone === "warning"
                      ? "border-l-[3px] border-l-high bg-high/[0.04]"
                      : "";
                const desc = tool.description || "";
                const descShort = desc.length > 70 ? `${desc.slice(0, 70)}…` : desc;
                const b = br(tool);
                const call = isCallable(tool.status);
                return (
                  <div
                    key={tool.name}
                    className={`glass rounded-[10px] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 backdrop-blur-md border border-white/[0.07] ${call ? "ring-1 ring-accent/20" : ""} ${borderLeft}`}
                  >
                    <div className="flex items-center gap-2 shrink-0 min-w-0">
                      <span className="font-mono text-sm font-bold text-white truncate">{tool.name}</span>
                      {call && (
                        <span className="text-[8px] font-black uppercase text-accent/90 border border-accent/30 rounded px-1 py-px shrink-0">
                          Callable
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-white/40 flex-1 min-w-0 sm:line-clamp-1">
                      {descShort || "—"}
                    </span>
                    <div className="flex items-center gap-2.5 shrink-0 justify-end">
                      <StatusBadge status={tool.status} />
                      <span
                        className={`text-sm font-extrabold tabular-nums whitespace-nowrap min-w-[6rem] text-right ${b.costMax ? "text-critical" : "text-green"}`}
                      >
                        {b.costMax ? `${fmt(b.costMin)}–${fmt(b.costMax)}` : "Clean"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
