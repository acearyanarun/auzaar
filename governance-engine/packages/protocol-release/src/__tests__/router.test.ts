import { describe, it, expect } from "vitest";
import type { Transaction, GovernanceDecision } from "@auzaar/core";
import { ProtocolRouter } from "../router.js";
import { createAttestation, serializeAttestation } from "../attestation.js";

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn_001",
    mandateId: "mdt_001",
    agentId: "agt_001",
    userId: "usr_001",
    vendor: "Acme Corp",
    product: "Widget",
    category: "electronics",
    amount: 50,
    currency: "USD",
    quantity: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeDecision(
  overrides: Partial<GovernanceDecision> = {}
): GovernanceDecision {
  return {
    requestId: "req_001",
    decision: "approved",
    compositeScore: 0,
    stageResults: [],
    explanation: "No rules matched",
    decidedAt: new Date().toISOString(),
    latencyMs: 1.5,
    ...overrides,
  };
}

describe("ProtocolRouter", () => {
  const router = new ProtocolRouter();

  it("should release an approved transaction", () => {
    const tx = makeTransaction();
    const decision = makeDecision();

    const result = router.release(tx, "mdt_001", decision);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.released).toBe(true);
    expect(result.value.payload.protocol).toBe("direct");
    expect(result.value.payload.headers["X-Auzaar-Attestation"]).toBeTruthy();
    expect(result.value.payload.headers["X-Auzaar-Mandate-Id"]).toBe(
      "mdt_001"
    );
    expect(result.value.payload.headers["X-Auzaar-Request-Id"]).toBe(
      "req_001"
    );
  });

  it("should reject a blocked transaction", () => {
    const tx = makeTransaction();
    const decision = makeDecision({ decision: "blocked" });

    const result = router.release(tx, "mdt_001", decision);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GOVERNANCE_ERROR");
  });

  it("should reject a flagged transaction", () => {
    const tx = makeTransaction();
    const decision = makeDecision({ decision: "flagged" });

    const result = router.release(tx, "mdt_001", decision);

    expect(result.ok).toBe(false);
  });

  it("should resolve protocol from transaction", () => {
    const tx = makeTransaction({ targetProtocol: "acp" });
    const decision = makeDecision();

    const result = router.release(tx, "mdt_001", decision);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload.protocol).toBe("acp");
  });

  it("should default to direct protocol", () => {
    const tx = makeTransaction();
    const decision = makeDecision();

    const result = router.release(tx, "mdt_001", decision);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload.protocol).toBe("direct");
  });

  it("should include target URL from transaction", () => {
    const tx = makeTransaction({
      targetUrl: "https://api.vendor.com/orders",
    });
    const decision = makeDecision();

    const result = router.release(tx, "mdt_001", decision);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload.targetUrl).toBe(
      "https://api.vendor.com/orders"
    );
  });
});

describe("Attestation", () => {
  it("should create a valid attestation", () => {
    const decision = makeDecision();
    const attestation = createAttestation("mdt_001", decision);

    expect(attestation.mandateId).toBe("mdt_001");
    expect(attestation.requestId).toBe("req_001");
    expect(attestation.decision).toBe("approved");
    expect(attestation.decisionHash).toBeTruthy();
    expect(attestation.decisionHash).toHaveLength(64);
  });

  it("should produce deterministic hashes for same decision", () => {
    const decision = makeDecision({ decidedAt: "2025-01-01T00:00:00.000Z" });
    const a1 = createAttestation("mdt_001", decision);
    const a2 = createAttestation("mdt_001", decision);

    expect(a1.decisionHash).toBe(a2.decisionHash);
  });

  it("should serialize attestation to base64", () => {
    const decision = makeDecision();
    const attestation = createAttestation("mdt_001", decision);
    const serialized = serializeAttestation(attestation);

    expect(typeof serialized).toBe("string");

    const decoded = JSON.parse(
      Buffer.from(serialized, "base64").toString("utf-8")
    );
    expect(decoded.mandateId).toBe("mdt_001");
    expect(decoded.requestId).toBe("req_001");
  });
});
