"use client";

import { useEffect, useState, useCallback } from "react";

interface ReviewItem {
  requestId: string;
  decision: "flagged" | "blocked";
  compositeScore: number;
  explanation: string;
  transaction: {
    vendor: string;
    product: string;
    amount: number;
    currency: string;
  };
  agentId: string;
  userId: string;
  mandateId: string;
  timestamp: string;
  operatorDecision?: "approved" | "rejected";
}

export function ReviewQueue() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch("/api/decisions");
      if (res.ok) {
        const data = await res.json();
        setItems(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
    const interval = setInterval(fetchItems, 5000);
    return () => clearInterval(interval);
  }, [fetchItems]);

  async function handleDecision(
    requestId: string,
    decision: "approved" | "rejected"
  ) {
    const res = await fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    });

    if (res.ok) {
      setItems((prev) => prev.filter((item) => item.requestId !== requestId));
    }
  }

  if (loading) {
    return (
      <div className="text-zinc-500 text-sm py-12 text-center">Loading...</div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="border border-zinc-800 rounded-lg p-12 text-center">
        <div className="text-zinc-500 text-sm">No items pending review</div>
        <div className="text-zinc-600 text-xs mt-2">
          Flagged transactions will appear here when agents submit purchases
          that trigger governance rules.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div
          key={item.requestId}
          className="border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    item.decision === "blocked"
                      ? "bg-red-500/10 text-red-400 border border-red-500/20"
                      : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  }`}
                >
                  {item.decision}
                </span>
                <span className="text-xs text-zinc-500 font-mono">
                  {item.requestId}
                </span>
              </div>
              <div className="text-sm font-medium">
                {item.transaction.product} from {item.transaction.vendor}
              </div>
              <div className="text-xs text-zinc-400 mt-1">
                {item.transaction.currency} {item.transaction.amount.toFixed(2)}{" "}
                · Agent {item.agentId} · User {item.userId}
              </div>
              <div className="text-xs text-zinc-500 mt-2">
                {item.explanation}
              </div>
              <div className="flex items-center gap-3 mt-2 text-xs text-zinc-600">
                <span>Score: {item.compositeScore.toFixed(2)}</span>
                <span>·</span>
                <span>
                  {new Date(item.timestamp).toLocaleString()}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => handleDecision(item.requestId, "approved")}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
              >
                Approve
              </button>
              <button
                onClick={() => handleDecision(item.requestId, "rejected")}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
