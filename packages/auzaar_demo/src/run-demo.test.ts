import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GovernanceEngine, loadPolicyFile } from "@auzaar/governance-engine";

const dir = dirname(fileURLToPath(import.meta.url));
const policyPath = join(dir, "..", "policies", "deterministic_policy.json");

function makeRequest(amount: number) {
  const ts = new Date().toISOString();
  return {
    requestId: "req_demo_test",
    transaction: {
      id: "txn_test",
      mandateId: "man_test",
      agentId: "agent_test",
      userId: "user_test",
      vendor: "Keychron",
      product: "Keychron Q1 Pro mechanical keyboard",
      category: "office_supplies",
      amount,
      currency: "USD",
      quantity: 1,
      timestamp: ts,
    },
    mandateId: "man_test",
    agentId: "agent_test",
    userId: "user_test",
    timestamp: ts,
  };
}

describe("auzaar_demo deterministic policy", () => {
  it("blocks $120 purchase against Sarah $50 per-transaction cap", async () => {
    const policy = loadPolicyFile(policyPath);
    const engine = new GovernanceEngine({ policies: [policy] });
    const result = await engine.evaluate(makeRequest(120));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.decision).toBe("blocked");
    const rules = result.value.stageResults.find((s) => s.stage === "rules-engine");
    expect(rules?.matchedRules).toContain("sarah_office_supply_per_txn");
  });
});
