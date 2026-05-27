import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry } from "../registry.js";
import { InMemoryAgentStore } from "../store.js";
import { verifyDelegationChain } from "../delegation.js";
import { computeTrustScore } from "../trust.js";
import type { Agent, DelegationLink } from "@auzaar/core";

describe("AgentRegistry", () => {
  let registry: AgentRegistry;
  let store: InMemoryAgentStore;

  beforeEach(() => {
    store = new InMemoryAgentStore();
    registry = new AgentRegistry(store);
  });

  describe("registerAgent", () => {
    it("should register an agent with default values", async () => {
      const result = await registry.registerAgent("test-agent");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("test-agent");
      expect(result.value.id).toMatch(/^agt_/);
      expect(result.value.trustScore).toBe(0.5);
      expect(result.value.status).toBe("active");
      expect(result.value.authorizationScope).toEqual([]);
      expect(result.value.delegationChain).toEqual([]);
      expect(result.value.framework).toBeUndefined();
    });

    it("should register an agent with framework and scope", async () => {
      const result = await registry.registerAgent(
        "my-agent",
        "langchain",
        ["purchase", "browse"]
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.framework).toBe("langchain");
      expect(result.value.authorizationScope).toEqual(["purchase", "browse"]);
    });

    it("should persist the agent in the store", async () => {
      const result = await registry.registerAgent("stored-agent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = await store.getById(result.value.id);
      expect(stored).not.toBeNull();
      expect(stored?.name).toBe("stored-agent");
    });
  });

  describe("getAgent", () => {
    it("should retrieve a registered agent", async () => {
      const regResult = await registry.registerAgent("findable-agent");
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const getResult = await registry.getAgent(regResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value.name).toBe("findable-agent");
    });

    it("should return error for non-existent agent", async () => {
      const result = await registry.getAgent("agt_nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("AGENT_NOT_FOUND");
    });
  });

  describe("suspendAgent", () => {
    it("should suspend an active agent", async () => {
      const regResult = await registry.registerAgent("suspend-me");
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const suspendResult = await registry.suspendAgent(regResult.value.id);
      expect(suspendResult.ok).toBe(true);
      if (!suspendResult.ok) return;

      expect(suspendResult.value.status).toBe("suspended");
    });

    it("should return error when suspending non-existent agent", async () => {
      const result = await registry.suspendAgent("agt_ghost");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("AGENT_NOT_FOUND");
    });
  });

  describe("revokeAgent", () => {
    it("should revoke an active agent", async () => {
      const regResult = await registry.registerAgent("revoke-me");
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const revokeResult = await registry.revokeAgent(regResult.value.id);
      expect(revokeResult.ok).toBe(true);
      if (!revokeResult.ok) return;

      expect(revokeResult.value.status).toBe("revoked");
    });

    it("should return error when revoking non-existent agent", async () => {
      const result = await registry.revokeAgent("agt_ghost");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("AGENT_NOT_FOUND");
    });
  });

  describe("updateTrustScore", () => {
    it("should update trust score within valid range", async () => {
      const regResult = await registry.registerAgent("trust-me");
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const updateResult = await registry.updateTrustScore(
        regResult.value.id,
        0.85
      );
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      expect(updateResult.value.trustScore).toBe(0.85);
    });

    it("should reject trust score below 0", async () => {
      const regResult = await registry.registerAgent("bad-score");
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const result = await registry.updateTrustScore(regResult.value.id, -0.1);
      expect(result.ok).toBe(false);
    });

    it("should reject trust score above 1", async () => {
      const regResult = await registry.registerAgent("bad-score");
      expect(regResult.ok).toBe(true);
      if (!regResult.ok) return;

      const result = await registry.updateTrustScore(regResult.value.id, 1.5);
      expect(result.ok).toBe(false);
    });

    it("should return error for non-existent agent", async () => {
      const result = await registry.updateTrustScore("agt_ghost", 0.7);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("AGENT_NOT_FOUND");
    });
  });
});

describe("verifyDelegationChain", () => {
  it("should accept an empty chain", () => {
    const result = verifyDelegationChain([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  it("should accept a valid contiguous chain", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const chain: DelegationLink[] = [
      {
        delegatorId: "agt_alice",
        delegateeId: "agt_bob",
        scope: ["purchase"],
        grantedAt: new Date().toISOString(),
        expiresAt: future,
        signature: "sig_abc",
      },
      {
        delegatorId: "agt_bob",
        delegateeId: "agt_charlie",
        scope: ["purchase"],
        grantedAt: new Date().toISOString(),
        expiresAt: future,
        signature: "sig_def",
      },
    ];

    const result = verifyDelegationChain(chain);
    expect(result.ok).toBe(true);
  });

  it("should reject a non-contiguous chain", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const chain: DelegationLink[] = [
      {
        delegatorId: "agt_alice",
        delegateeId: "agt_bob",
        scope: ["purchase"],
        grantedAt: new Date().toISOString(),
        expiresAt: future,
        signature: "sig_abc",
      },
      {
        delegatorId: "agt_eve",
        delegateeId: "agt_charlie",
        scope: ["purchase"],
        grantedAt: new Date().toISOString(),
        expiresAt: future,
        signature: "sig_def",
      },
    ];

    const result = verifyDelegationChain(chain);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GOVERNANCE_ERROR");
  });

  it("should reject a chain with an expired link", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const chain: DelegationLink[] = [
      {
        delegatorId: "agt_alice",
        delegateeId: "agt_bob",
        scope: ["purchase"],
        grantedAt: new Date(Date.now() - 172800000).toISOString(),
        expiresAt: past,
        signature: "sig_abc",
      },
    ];

    const result = verifyDelegationChain(chain);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GOVERNANCE_ERROR");
  });

  it("should accept a single-link chain without expiry", () => {
    const chain: DelegationLink[] = [
      {
        delegatorId: "agt_alice",
        delegateeId: "agt_bob",
        scope: ["purchase"],
        grantedAt: new Date().toISOString(),
        signature: "sig_abc",
      },
    ];

    const result = verifyDelegationChain(chain);
    expect(result.ok).toBe(true);
  });
});

describe("computeTrustScore", () => {
  const baseAgent: Agent = {
    id: "agt_test",
    name: "test-agent",
    authorizationScope: [],
    delegationChain: [],
    trustScore: 0.5,
    status: "active",
    registeredAt: new Date().toISOString(),
  };

  it("should return base score with no transactions and zero age", () => {
    const score = computeTrustScore(baseAgent, {
      successfulTransactions: 0,
      flaggedTransactions: 0,
      blockedTransactions: 0,
      accountAge: 0,
    });

    expect(score).toBe(0.5);
  });

  it("should increase score with high success ratio", () => {
    const score = computeTrustScore(baseAgent, {
      successfulTransactions: 100,
      flaggedTransactions: 0,
      blockedTransactions: 0,
      accountAge: 0,
    });

    expect(score).toBeGreaterThan(0.5);
  });

  it("should decrease score with high block ratio", () => {
    const score = computeTrustScore(baseAgent, {
      successfulTransactions: 0,
      flaggedTransactions: 0,
      blockedTransactions: 100,
      accountAge: 0,
    });

    expect(score).toBeLessThan(0.5);
  });

  it("should increase score with account age", () => {
    const score = computeTrustScore(baseAgent, {
      successfulTransactions: 0,
      flaggedTransactions: 0,
      blockedTransactions: 0,
      accountAge: 365,
    });

    expect(score).toBeGreaterThan(0.5);
  });

  it("should clamp score to [0, 1]", () => {
    const highScore = computeTrustScore(baseAgent, {
      successfulTransactions: 10000,
      flaggedTransactions: 0,
      blockedTransactions: 0,
      accountAge: 3650,
    });
    expect(highScore).toBeLessThanOrEqual(1);

    const lowScore = computeTrustScore(baseAgent, {
      successfulTransactions: 0,
      flaggedTransactions: 0,
      blockedTransactions: 10000,
      accountAge: 0,
    });
    expect(lowScore).toBeGreaterThanOrEqual(0);
  });

  it("should cap account age contribution at maturity", () => {
    const score1 = computeTrustScore(baseAgent, {
      successfulTransactions: 0,
      flaggedTransactions: 0,
      blockedTransactions: 0,
      accountAge: 365,
    });

    const score2 = computeTrustScore(baseAgent, {
      successfulTransactions: 0,
      flaggedTransactions: 0,
      blockedTransactions: 0,
      accountAge: 3650,
    });

    expect(score1).toBe(score2);
  });
});
