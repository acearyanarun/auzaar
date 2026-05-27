"use client";

import { useEffect, useState, useCallback } from "react";
import type { Policy } from "@auzaar/core";

interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
  policy?: Policy;
}

export function PolicyEditor() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [yaml, setYaml] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPolicies = useCallback(async () => {
    try {
      const res = await fetch("/api/policies");
      if (res.ok) {
        const data = await res.json();
        setPolicies(data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  useEffect(() => {
    if (policies.length > 0 && selectedIndex < policies.length) {
      const policy = policies[selectedIndex];
      setYaml(policyToYaml(policy!));
      setValidation(null);
    }
  }, [selectedIndex, policies]);

  async function handleValidate() {
    const res = await fetch("/api/policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml }),
    });

    const data = await res.json();
    setValidation(data);
  }

  if (loading) {
    return (
      <div className="text-zinc-500 text-sm py-12 text-center">Loading...</div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      <div className="lg:col-span-1">
        <h3 className="text-sm font-medium text-zinc-400 mb-3">
          Active Policies
        </h3>
        {policies.length === 0 ? (
          <div className="text-xs text-zinc-600 p-3 border border-zinc-800 rounded-lg">
            No policies loaded. Add YAML files to the policies/ directory.
          </div>
        ) : (
          <div className="space-y-1">
            {policies.map((policy, idx) => (
              <button
                key={policy.id}
                onClick={() => setSelectedIndex(idx)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  idx === selectedIndex
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }`}
              >
                <div className="font-medium truncate">{policy.name}</div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  {policy.rules.length} rule
                  {policy.rules.length !== 1 ? "s" : ""} ·{" "}
                  {policy.enabled ? "enabled" : "disabled"}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="lg:col-span-3">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-400">YAML Editor</h3>
          <button
            onClick={handleValidate}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Validate
          </button>
        </div>
        <textarea
          value={yaml}
          onChange={(e) => {
            setYaml(e.target.value);
            setValidation(null);
          }}
          className="w-full h-96 bg-zinc-900 border border-zinc-800 rounded-lg p-4 font-mono text-sm text-zinc-200 resize-y focus:outline-none focus:border-zinc-600 transition-colors"
          spellCheck={false}
        />
        {validation && (
          <div
            className={`mt-3 p-3 rounded-lg text-sm ${
              validation.valid
                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                : "bg-red-500/10 border border-red-500/20 text-red-400"
            }`}
          >
            {validation.valid ? (
              <span>Policy is valid</span>
            ) : (
              <div>
                <div className="font-medium mb-1">Validation errors:</div>
                <ul className="space-y-1">
                  {validation.errors?.map((err, i) => (
                    <li key={i} className="text-xs">
                      {err.path && (
                        <span className="font-mono text-red-300">
                          {err.path}:{" "}
                        </span>
                      )}
                      {err.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function policyToYaml(policy: Policy): string {
  const lines: string[] = [];
  lines.push(`id: ${policy.id}`);
  lines.push(`name: ${policy.name}`);
  if (policy.description) lines.push(`description: ${policy.description}`);
  lines.push(`rules:`);

  for (const rule of policy.rules) {
    lines.push(`  - type: ${rule.type}`);
    lines.push(`    id: ${rule.id}`);

    switch (rule.type) {
      case "spending_limit":
        lines.push(`    maxAmount: ${rule.maxAmount}`);
        lines.push(`    currency: ${rule.currency}`);
        lines.push(`    period: ${rule.period}`);
        break;
      case "vendor_allowlist":
      case "vendor_blocklist":
        lines.push(`    vendors:`);
        for (const v of rule.vendors) lines.push(`      - "${v}"`);
        break;
      case "category_restriction":
        if (rule.allowedCategories?.length) {
          lines.push(`    allowedCategories:`);
          for (const c of rule.allowedCategories) lines.push(`      - ${c}`);
        }
        if (rule.blockedCategories?.length) {
          lines.push(`    blockedCategories:`);
          for (const c of rule.blockedCategories) lines.push(`      - ${c}`);
        }
        break;
      case "quantity_limit":
        lines.push(`    maxQuantity: ${rule.maxQuantity}`);
        break;
      case "temporal_rule":
        if (rule.allowedDays?.length)
          lines.push(`    allowedDays: [${rule.allowedDays.join(", ")}]`);
        if (rule.allowedHoursStart !== undefined)
          lines.push(`    allowedHoursStart: ${rule.allowedHoursStart}`);
        if (rule.allowedHoursEnd !== undefined)
          lines.push(`    allowedHoursEnd: ${rule.allowedHoursEnd}`);
        lines.push(`    timezone: ${rule.timezone}`);
        break;
    }

    lines.push(`    enabled: ${rule.enabled}`);
  }

  lines.push(`priority: ${policy.priority}`);
  lines.push(`enabled: ${policy.enabled}`);
  lines.push(`createdAt: "${policy.createdAt}"`);
  lines.push(`updatedAt: "${policy.updatedAt}"`);

  return lines.join("\n");
}
