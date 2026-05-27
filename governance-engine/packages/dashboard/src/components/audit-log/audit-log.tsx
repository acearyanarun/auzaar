"use client";

import { useEffect, useState, useCallback } from "react";
import type { EventLogEntry } from "@auzaar/core";

const EVENT_TYPE_COLORS: Record<string, string> = {
  transaction_submitted: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  governance_started: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  stage_completed: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  governance_decided: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  operator_reviewed: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  mandate_created: "text-teal-400 bg-teal-500/10 border-teal-500/20",
  mandate_amended: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
  mandate_revoked: "text-red-400 bg-red-500/10 border-red-500/20",
};

export function AuditLog() {
  const [entries, setEntries] = useState<EventLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchEntries = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter) params.set("eventType", filter);
      params.set("limit", "100");

      const res = await fetch(`/api/events?${params}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const eventTypes = [
    "",
    "transaction_submitted",
    "governance_started",
    "governance_decided",
    "operator_reviewed",
    "mandate_created",
    "mandate_amended",
    "mandate_revoked",
  ];

  if (loading) {
    return (
      <div className="text-zinc-500 text-sm py-12 text-center">Loading...</div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <label className="text-xs text-zinc-500">Filter by type:</label>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-md px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-zinc-600"
        >
          {eventTypes.map((type) => (
            <option key={type} value={type}>
              {type || "All events"}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void fetchEntries()}
          className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-md hover:border-zinc-600 transition-colors"
        >
          Refresh
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="border border-zinc-800 rounded-lg p-12 text-center">
          <div className="text-zinc-500 text-sm">No events recorded</div>
          <div className="text-zinc-600 text-xs mt-2 max-w-md mx-auto">
            Run <code className="text-zinc-500">npm run demo</code> from the repo
            root, then refresh — the dashboard reads the same{" "}
            <code className="text-zinc-500">event_log.json</code> as the CLI demo.
          </div>
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-lg divide-y divide-zinc-800">
          {entries.map((entry) => {
            const isExpanded = expanded.has(entry.id);
            const colorClass =
              EVENT_TYPE_COLORS[entry.eventType] ??
              "text-zinc-400 bg-zinc-500/10 border-zinc-500/20";

            return (
              <div key={entry.id} className="p-3">
                <button
                  onClick={() => toggleExpanded(entry.id)}
                  className="w-full text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-600 font-mono w-8 text-right shrink-0">
                      #{entry.sequenceNumber}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colorClass}`}
                    >
                      {entry.eventType}
                    </span>
                    <span className="text-xs text-zinc-500 font-mono truncate">
                      {entry.id}
                    </span>
                    <span className="text-xs text-zinc-600 ml-auto shrink-0">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                    <span className="text-zinc-600 text-xs">
                      {isExpanded ? "▼" : "▶"}
                    </span>
                  </div>
                  {!isExpanded && (
                    <div className="mt-1 ml-11 space-y-1">
                      <div className="flex items-center gap-2 text-xs text-zinc-600">
                        {entry.agentId && <span>Agent: {entry.agentId}</span>}
                        {entry.userId && <span>· User: {entry.userId}</span>}
                        {entry.mandateId && (
                          <span>· Mandate: {entry.mandateId}</span>
                        )}
                      </div>
                      {entry.eventType === "governance_decided" &&
                        entry.decision && (
                          <div className="text-xs text-amber-500/90">
                            {entry.decision.decision}
                            {entry.decision.explanation
                              ? ` — ${entry.decision.explanation}`
                              : ""}
                          </div>
                        )}
                    </div>
                  )}
                </button>
                {isExpanded && (
                  <div className="mt-3 ml-11">
                    <pre className="bg-zinc-900 border border-zinc-800 rounded-md p-3 text-xs text-zinc-300 overflow-x-auto">
                      {JSON.stringify(
                        {
                          id: entry.id,
                          sequenceNumber: entry.sequenceNumber,
                          eventType: entry.eventType,
                          timestamp: entry.timestamp,
                          requestId: entry.requestId,
                          agentId: entry.agentId,
                          userId: entry.userId,
                          mandateId: entry.mandateId,
                          request: entry.request,
                          decision: entry.decision,
                          data: entry.data,
                          hash: entry.hash,
                          previousHash: entry.previousHash,
                        },
                        null,
                        2
                      )}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
