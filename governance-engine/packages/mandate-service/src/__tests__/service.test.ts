import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair } from "@auzaar/core";
import type { Mandate } from "@auzaar/core";
import { MandateService } from "../service.js";
import { InMemoryMandateStore } from "../store.js";

describe("MandateService", () => {
  let service: MandateService;
  let store: InMemoryMandateStore;

  beforeEach(() => {
    store = new InMemoryMandateStore();
    const keyPair = generateKeyPair();
    service = new MandateService(store, keyPair.privateKey);
  });

  describe("createMandate", () => {
    it("should create a mandate with valid structured fields", async () => {
      const result = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a mechanical keyboard under $200",
        {
          product: "mechanical keyboard",
          maxBudget: 200,
          currency: "USD",
          quantity: 1,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toMatch(/^mdt_/);
      expect(result.value.userId).toBe("user_001");
      expect(result.value.agentId).toBe("agent_001");
      expect(result.value.intentText).toBe("Buy a mechanical keyboard under $200");
      expect(result.value.structuredIntent.product).toBe("mechanical keyboard");
      expect(result.value.structuredIntent.maxBudget).toBe(200);
      expect(result.value.version).toBe(1);
      expect(result.value.status).toBe("active");
      expect(result.value.signature).toBeTruthy();
    });

    it("should return an error for invalid structured fields", async () => {
      const result = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy something",
        {
          product: "",
          maxBudget: -10,
        }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INTENT_PARSE_ERROR");
    });

    it("should apply default values for currency and quantity", async () => {
      const result = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy headphones",
        {
          product: "headphones",
          maxBudget: 100,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.structuredIntent.currency).toBe("USD");
      expect(result.value.structuredIntent.quantity).toBe(1);
    });
  });

  describe("getMandate", () => {
    it("should retrieve an existing mandate", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a laptop",
        { product: "laptop", maxBudget: 1500 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const getResult = await service.getMandate(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.id).toBe(createResult.value.id);
      expect(getResult.value.structuredIntent.product).toBe("laptop");
    });

    it("should return MandateNotFoundError for non-existent mandate", async () => {
      const result = await service.getMandate("mdt_nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_NOT_FOUND");
    });

    it("should return MandateExpiredError for expired mandate", async () => {
      // Manually save an expired mandate to the store
      await store.save({
        id: "mdt_expired",
        userId: "user_001",
        agentId: "agent_001",
        intentText: "Old purchase",
        structuredIntent: {
          product: "old item",
          maxBudget: 50,
          currency: "USD",
          quantity: 1,
        },
        signature: "fake_sig",
        version: 1,
        status: "expired",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });

      const result = await service.getMandate("mdt_expired");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_EXPIRED");
    });

    // SEC-2: revoked mandates must be rejected
    it("should return MandateRevokedError for revoked mandate", async () => {
      await store.save({
        id: "mdt_revoked",
        userId: "user_001",
        agentId: "agent_001",
        intentText: "Revoked purchase",
        structuredIntent: { product: "item", maxBudget: 50, currency: "USD", quantity: 1 },
        signature: "fake_sig",
        version: 1,
        status: "revoked",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      } satisfies Mandate);

      const result = await service.getMandate("mdt_revoked");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_REVOKED");
    });

    // SEC-2: amended (superseded) mandates must be rejected so agents cannot
    // use an old mandate ID after it has been replaced by a newer version
    it("should return MandateAmendedError for superseded mandate", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a keyboard",
        { product: "keyboard", maxBudget: 150 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const originalId = createResult.value.id;
      await service.amendMandate(originalId, { maxBudget: 200 });

      // The original mandate is now "amended" — must not be usable
      const result = await service.getMandate(originalId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_AMENDED");
    });

    // SEC-1: signature verification must reject a mandate whose stored data
    // has been tampered with after creation
    it("should return MandateIntegrityError when the stored signature does not match the content", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a monitor",
        { product: "monitor", maxBudget: 400 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Simulate storage-layer tampering: overwrite maxBudget without re-signing
      const stored = await store.getById(createResult.value.id);
      expect(stored).not.toBeNull();
      await store.save({
        ...stored!,
        structuredIntent: { ...stored!.structuredIntent, maxBudget: 999999 },
      });

      const result = await service.getMandate(createResult.value.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_INTEGRITY_ERROR");
    });

    // SEC-1: a mandate with a completely invalid/garbage signature must be rejected
    it("should return MandateIntegrityError for a mandate with an invalid signature", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy headphones",
        { product: "headphones", maxBudget: 200 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Replace the valid signature with garbage
      const stored = await store.getById(createResult.value.id);
      expect(stored).not.toBeNull();
      await store.save({ ...stored!, signature: "aW52YWxpZHNpZ25hdHVyZQ==" });

      const result = await service.getMandate(createResult.value.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_INTEGRITY_ERROR");
    });

    // SEC-1: a correctly amended mandate (re-signed) must pass verification
    it("should verify signature correctly for amended mandates", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a chair",
        { product: "chair", maxBudget: 300 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const amendResult = await service.amendMandate(createResult.value.id, {
        maxBudget: 450,
      });
      expect(amendResult.ok).toBe(true);
      if (!amendResult.ok) return;

      // Amended mandate should be retrievable and its signature should be valid
      const getResult = await service.getMandate(amendResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value.structuredIntent.maxBudget).toBe(450);
    });
  });

  describe("amendMandate", () => {
    it("should create a new version with updated fields", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a monitor",
        { product: "monitor", maxBudget: 500 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const amendResult = await service.amendMandate(createResult.value.id, {
        maxBudget: 700,
      });

      expect(amendResult.ok).toBe(true);
      if (!amendResult.ok) return;

      expect(amendResult.value.id).not.toBe(createResult.value.id);
      expect(amendResult.value.version).toBe(2);
      expect(amendResult.value.previousVersionId).toBe(createResult.value.id);
      expect(amendResult.value.structuredIntent.maxBudget).toBe(700);
      expect(amendResult.value.structuredIntent.product).toBe("monitor");
      expect(amendResult.value.status).toBe("active");
    });

    it("should mark the old mandate as amended", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a desk",
        { product: "desk", maxBudget: 300 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const originalId = createResult.value.id;
      await service.amendMandate(originalId, { maxBudget: 400 });

      // Fetch the old mandate directly from store
      const oldMandate = await store.getById(originalId);
      expect(oldMandate).not.toBeNull();
      expect(oldMandate!.status).toBe("amended");
    });

    it("should preserve version history", async () => {
      const createResult = await service.createMandate(
        "user_001",
        "agent_001",
        "Buy a chair",
        { product: "chair", maxBudget: 200 }
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const amend1 = await service.amendMandate(createResult.value.id, {
        maxBudget: 300,
      });
      expect(amend1.ok).toBe(true);
      if (!amend1.ok) return;

      const amend2 = await service.amendMandate(amend1.value.id, {
        maxBudget: 400,
      });
      expect(amend2.ok).toBe(true);
      if (!amend2.ok) return;

      const history = await store.getVersionHistory(amend2.value.id);
      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(3);
      expect(history[1].version).toBe(2);
      expect(history[2].version).toBe(1);
    });

    it("should return error when amending non-existent mandate", async () => {
      const result = await service.amendMandate("mdt_nonexistent", {
        maxBudget: 100,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MANDATE_NOT_FOUND");
    });
  });
});

// =============================================================================
// SEC-13: MandateService validates the private key at construction time
// =============================================================================

import { generateKeyPairSync } from "node:crypto";

describe("MandateService constructor key validation (SEC-13)", () => {
  it("throws when constructed with a garbage string as the private key", () => {
    const store = new InMemoryMandateStore();
    expect(() => new MandateService(store, "not-a-real-key")).toThrow(
      /invalid private key/i
    );
  });

  it("throws when constructed with an RSA key instead of Ed25519", () => {
    // Generate an RSA key — wrong algorithm for Auzaar
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const store = new InMemoryMandateStore();
    expect(() => new MandateService(store, privateKey)).toThrow(
      /invalid private key/i
    );
  });

  it("accepts a valid Ed25519 key without throwing", () => {
    const store = new InMemoryMandateStore();
    const keyPair = generateKeyPair();
    expect(() => new MandateService(store, keyPair.privateKey)).not.toThrow();
  });
});
