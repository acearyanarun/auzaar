import { describe, it, expect, vi } from "vitest";
import type { GovernanceRequest, Policy, Mandate, EventType } from "@auzaar/core";
import { GovernanceEngine, type GovernanceEventWriter } from "../engine.js";
import { GovernancePipeline } from "../pipeline.js";
import { RulesEngine } from "../stages/rules-engine.js";
import { watchPolicies } from "../policy-loader.js";
import {
  computeCompositeScore,
  determineDecision,
  DEFAULT_THRESHOLDS,
} from "../scoring.js";

function makeRequest(
  overrides: Partial<GovernanceRequest["transaction"]> = {}
): GovernanceRequest {
  return {
    requestId: "req_test_001",
    transaction: {
      id: "txn_test_001",
      mandateId: "mdt_test_001",
      agentId: "agt_test_001",
      userId: "usr_test_001",
      vendor: "Acme Corp",
      product: "Widget",
      category: "electronics",
      amount: 50,
      currency: "USD",
      quantity: 1,
      timestamp: new Date().toISOString(),
      ...overrides,
    },
    mandateId: "mdt_test_001",
    agentId: "agt_test_001",
    userId: "usr_test_001",
    timestamp: new Date().toISOString(),
  };
}

function makePolicy(
  rules: Policy["rules"],
  overrides: Partial<Policy> = {}
): Policy {
  const now = new Date().toISOString();
  return {
    id: "pol_test_001",
    name: "Test Policy",
    rules,
    priority: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeMockWriter(): GovernanceEventWriter & { calls: Array<{ eventType: EventType; data: unknown }> } {
  const calls: Array<{ eventType: EventType; data: unknown }> = [];
  return {
    calls,
    log: async (eventType, data) => {
      calls.push({ eventType, data });
    },
  };
}

// --- Scoring ---

describe("computeCompositeScore", () => {
  it("should return 0 for empty results", () => {
    expect(computeCompositeScore([])).toBe(0);
  });

  it("should return 0 when all stages score 0", () => {
    const results = [
      { stage: "rules-engine", passed: true, score: 0, blocked: false },
      { stage: "threat-detection", passed: true, score: 0, blocked: false },
    ];
    expect(computeCompositeScore(results)).toBe(0);
  });

  it("should return weighted average of stage scores", () => {
    const results = [
      { stage: "rules-engine", passed: true, score: 1.0, blocked: false },
      { stage: "threat-detection", passed: true, score: 0, blocked: false },
      { stage: "intent-alignment", passed: true, score: 0, blocked: false },
      { stage: "spending-graph", passed: true, score: 0, blocked: false },
    ];
    const score = computeCompositeScore(results);
    expect(score).toBeCloseTo(0.4, 5);
  });

  it("should clamp score to [0, 1]", () => {
    const results = [
      { stage: "rules-engine", passed: false, score: 1.0, blocked: true },
      { stage: "threat-detection", passed: false, score: 1.0, blocked: true },
      { stage: "intent-alignment", passed: false, score: 1.0, blocked: true },
      { stage: "spending-graph", passed: false, score: 1.0, blocked: true },
    ];
    const score = computeCompositeScore(results);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("determineDecision", () => {
  it("should block when hardBlocked is true regardless of score", () => {
    expect(determineDecision(0, true)).toBe("blocked");
    expect(determineDecision(0.1, true)).toBe("blocked");
  });

  it("should approve when score is below autoApproveBelow", () => {
    expect(determineDecision(0, false)).toBe("approved");
    expect(determineDecision(0.29, false)).toBe("approved");
  });

  it("should block when score is at or above blockAbove", () => {
    expect(determineDecision(0.8, false)).toBe("blocked");
    expect(determineDecision(1.0, false)).toBe("blocked");
  });

  it("should flag when score is in the middle", () => {
    expect(determineDecision(0.3, false)).toBe("flagged");
    expect(determineDecision(0.5, false)).toBe("flagged");
    expect(determineDecision(0.79, false)).toBe("flagged");
  });

  it("should use custom thresholds", () => {
    const custom = { autoApproveBelow: 0.1, blockAbove: 0.5 };
    expect(determineDecision(0.05, false, custom)).toBe("approved");
    expect(determineDecision(0.3, false, custom)).toBe("flagged");
    expect(determineDecision(0.5, false, custom)).toBe("blocked");
  });
});

// --- Pipeline ---

describe("GovernancePipeline", () => {
  it("should run all stages when nothing blocks", () => {
    const rulesEngine = new RulesEngine([]);
    const pipeline = new GovernancePipeline(rulesEngine);
    const request = makeRequest();

    const result = pipeline.run(request);

    expect(result.hardBlocked).toBe(false);
    expect(result.blockingStage).toBeUndefined();
    expect(result.stageResults).toHaveLength(4);
    expect(result.stageResults.map((r) => r.stage)).toEqual([
      "rules-engine",
      "threat-detection",
      "intent-alignment",
      "spending-graph",
    ]);
  });

  it("should short-circuit when rules engine blocks", () => {
    const policy = makePolicy([
      {
        type: "spending_limit",
        id: "max_100",
        maxAmount: 100,
        currency: "USD",
        period: "per_transaction",
        enabled: true,
      },
    ]);
    const rulesEngine = new RulesEngine([policy]);
    const pipeline = new GovernancePipeline(rulesEngine);
    const request = makeRequest({ amount: 500 });

    const result = pipeline.run(request);

    expect(result.hardBlocked).toBe(true);
    expect(result.blockingStage).toBe("rules-engine");
    expect(result.stageResults).toHaveLength(1);
    expect(result.stageResults[0]!.stage).toBe("rules-engine");
  });

  it("should pass mandate context to intent alignment", () => {
    const rulesEngine = new RulesEngine([]);
    const pipeline = new GovernancePipeline(rulesEngine);
    const request = makeRequest();
    const mandate: Mandate = {
      id: "mdt_test_001",
      userId: "usr_test_001",
      agentId: "agt_test_001",
      intentText: "Buy a widget under $100",
      structuredIntent: {
        product: "Widget",
        maxBudget: 100,
        currency: "USD",
        quantity: 1,
      },
      signature: "test_sig",
      version: 1,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = pipeline.run(request, mandate);

    expect(result.hardBlocked).toBe(false);
    expect(result.stageResults).toHaveLength(4);
  });
});

// --- RulesEngine ---

describe("RulesEngine", () => {
  it("should pass when no policies exist", () => {
    const engine = new RulesEngine([]);
    const request = makeRequest();

    const result = engine.evaluate(request);

    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.score).toBe(0);
    expect(result.matchedRules).toEqual([]);
  });

  it("should block when spending limit is exceeded", () => {
    const policy = makePolicy([
      {
        type: "spending_limit",
        id: "limit_100",
        maxAmount: 100,
        currency: "USD",
        period: "per_transaction",
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ amount: 150 });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.matchedRules).toContain("limit_100");
  });

  it("should pass when spending is within limit", () => {
    const policy = makePolicy([
      {
        type: "spending_limit",
        id: "limit_100",
        maxAmount: 100,
        currency: "USD",
        period: "per_transaction",
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ amount: 50 });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("should block when vendor is not on allowlist", () => {
    const policy = makePolicy([
      {
        type: "vendor_allowlist",
        id: "allowed_vendors",
        vendors: ["Amazon", "Best Buy"],
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ vendor: "Shady Store" });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.matchedRules).toContain("allowed_vendors");
  });

  it("should pass when vendor is on allowlist (case-insensitive)", () => {
    const policy = makePolicy([
      {
        type: "vendor_allowlist",
        id: "allowed_vendors",
        vendors: ["Amazon", "Best Buy"],
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ vendor: "amazon" });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(true);
  });

  it("should block when vendor is on blocklist", () => {
    const policy = makePolicy([
      {
        type: "vendor_blocklist",
        id: "blocked_vendors",
        vendors: ["Scam Corp"],
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ vendor: "Scam Corp" });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("should block when category is restricted", () => {
    const policy = makePolicy([
      {
        type: "category_restriction",
        id: "no_gambling",
        blockedCategories: ["gambling", "adult"],
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ category: "gambling" });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("should block when quantity exceeds limit", () => {
    const policy = makePolicy([
      {
        type: "quantity_limit",
        id: "max_qty_5",
        maxQuantity: 5,
        enabled: true,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ quantity: 10 });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("should skip disabled rules", () => {
    const policy = makePolicy([
      {
        type: "spending_limit",
        id: "disabled_limit",
        maxAmount: 10,
        currency: "USD",
        period: "per_transaction",
        enabled: false,
      },
    ]);
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ amount: 500 });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it("should skip disabled policies", () => {
    const policy = makePolicy(
      [
        {
          type: "spending_limit",
          id: "limit",
          maxAmount: 10,
          currency: "USD",
          period: "per_transaction",
          enabled: true,
        },
      ],
      { enabled: false }
    );
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ amount: 500 });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(true);
  });

  it("should only apply policies matching user/agent scope", () => {
    const policy = makePolicy(
      [
        {
          type: "spending_limit",
          id: "limit",
          maxAmount: 10,
          currency: "USD",
          period: "per_transaction",
          enabled: true,
        },
      ],
      { appliesTo: { userIds: ["usr_other"] } }
    );
    const engine = new RulesEngine([policy]);
    const request = makeRequest({ amount: 500 });

    const result = engine.evaluate(request);

    expect(result.passed).toBe(true);
  });
});

// --- GovernanceEngine ---

describe("GovernanceEngine", () => {
  it("should approve a clean transaction with no policies", async () => {
    const engine = new GovernanceEngine({ policies: [] });
    const request = makeRequest();

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.decision).toBe("approved");
    expect(result.value.requestId).toBe("req_test_001");
    expect(result.value.compositeScore).toBe(0);
    expect(result.value.stageResults).toHaveLength(4);
    expect(result.value.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.value.decidedAt).toBeTruthy();
  });

  it("should block a transaction that violates a spending limit", async () => {
    const policy = makePolicy([
      {
        type: "spending_limit",
        id: "limit_100",
        maxAmount: 100,
        currency: "USD",
        period: "per_transaction",
        enabled: true,
      },
    ]);
    const engine = new GovernanceEngine({ policies: [policy] });
    const request = makeRequest({ amount: 200 });

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.decision).toBe("blocked");
    expect(result.value.stageResults).toHaveLength(1);
    expect(result.value.stageResults[0]!.stage).toBe("rules-engine");
  });

  it("should block a transaction that hits a vendor blocklist", async () => {
    const policy = makePolicy([
      {
        type: "vendor_blocklist",
        id: "blocked_vendors",
        vendors: ["Evil Corp"],
        enabled: true,
      },
    ]);
    const engine = new GovernanceEngine({ policies: [policy] });
    const request = makeRequest({ vendor: "Evil Corp" });

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.decision).toBe("blocked");
  });

  it("should include latency in the decision", async () => {
    const engine = new GovernanceEngine({ policies: [] });
    const request = makeRequest();

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.value.latencyMs).toBe("number");
    expect(result.value.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should accept a mandate for context", async () => {
    const engine = new GovernanceEngine({ policies: [] });
    const request = makeRequest();
    const mandate: Mandate = {
      id: "mdt_test_001",
      userId: "usr_test_001",
      agentId: "agt_test_001",
      intentText: "Buy a widget",
      structuredIntent: {
        product: "Widget",
        maxBudget: 100,
        currency: "USD",
        quantity: 1,
      },
      signature: "sig",
      version: 1,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await engine.evaluate(request, mandate);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.decision).toBe("approved");
  });

  it("should respect custom thresholds", async () => {
    const engine = new GovernanceEngine({
      policies: [],
      thresholds: { autoApproveBelow: 0.0, blockAbove: 0.0 },
    });
    const request = makeRequest();

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.decision).toBe("blocked");
  });

  it("should reload policies dynamically", async () => {
    const engine = new GovernanceEngine({ policies: [] });
    const request = makeRequest({ amount: 500 });

    const result1 = await engine.evaluate(request);
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.value.decision).toBe("approved");

    const policy = makePolicy([
      {
        type: "spending_limit",
        id: "limit",
        maxAmount: 100,
        currency: "USD",
        period: "per_transaction",
        enabled: true,
      },
    ]);
    engine.reloadPolicies([policy]);

    const result2 = await engine.evaluate(request);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.decision).toBe("blocked");
  });

  it("should combine explanation from all stages", async () => {
    const engine = new GovernanceEngine({ policies: [] });
    const request = makeRequest();

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.explanation).toBeTruthy();
    expect(typeof result.value.explanation).toBe("string");
  });

  it("should write governance_started and governance_decided to event writer", async () => {
    const writer = makeMockWriter();
    const engine = new GovernanceEngine({ policies: [], eventWriter: writer });
    const request = makeRequest();

    await engine.evaluate(request);

    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[0]!.eventType).toBe("governance_started");
    expect(writer.calls[1]!.eventType).toBe("governance_decided");
  });

  it("should not fail if event writer throws", async () => {
    const failingWriter: GovernanceEventWriter = {
      log: async () => { throw new Error("write failed"); },
    };
    const engine = new GovernanceEngine({ policies: [], eventWriter: failingWriter });
    const request = makeRequest();

    const result = await engine.evaluate(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("approved");
  });
});

// =============================================================================
// SEC-11: watchPolicies logs structured error on reload failure
// =============================================================================

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("watchPolicies reload error logging (SEC-11)", () => {
  it("logs a structured error when a reloaded policy file is invalid", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Create a temp dir with a valid policy file to start the watcher
    const dir = mkdtempSync(join(tmpdir(), "auzaar-policy-test-"));
    const policyPath = join(dir, "test.json");

    // Write a valid policy initially
    writeFileSync(
      policyPath,
      JSON.stringify({
        id: "pol_test",
        name: "Test",
        rules: [],
        priority: 0,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );

    const reloadCallback = vi.fn();
    const watcher = watchPolicies(dir, reloadCallback);

    // Overwrite with invalid JSON to trigger a reload error
    writeFileSync(policyPath, "{ invalid json }}}");

    // Allow time for the debounced watcher callback to fire
    await new Promise((r) => setTimeout(r, 300));

    watcher.close();
    rmSync(dir, { recursive: true, force: true });

    // Should have logged a structured error
    const errorCalls = errorSpy.mock.calls;
    const foundStructuredError = errorCalls.some((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return (
          parsed.level === "error" &&
          parsed.event === "policy_reload_failed" &&
          typeof parsed.path === "string" &&
          typeof parsed.reason === "string"
        );
      } catch {
        return false;
      }
    });

    expect(foundStructuredError).toBe(true);
    errorSpy.mockRestore();
  });
});
