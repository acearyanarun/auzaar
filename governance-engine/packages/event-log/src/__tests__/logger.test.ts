import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore } from "../store.js";
import { EventLogger } from "../logger.js";
import { QueryService } from "../query.js";

describe("EventLogger", () => {
  let store: InMemoryEventStore;
  let logger: EventLogger;

  beforeEach(() => {
    store = new InMemoryEventStore();
    logger = new EventLogger(store);
  });

  it("should log an event and create a valid entry", async () => {
    const result = await logger.log("transaction_submitted", {
      requestId: "req_abc123",
      agentId: "agt_def456",
      userId: "usr_ghi789",
      mandateId: "mdt_jkl012",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = result.value;
    expect(entry.id).toMatch(/^evt_/);
    expect(entry.sequenceNumber).toBe(0);
    expect(entry.eventType).toBe("transaction_submitted");
    expect(entry.requestId).toBe("req_abc123");
    expect(entry.agentId).toBe("agt_def456");
    expect(entry.userId).toBe("usr_ghi789");
    expect(entry.mandateId).toBe("mdt_jkl012");
    expect(entry.hash).toBeTruthy();
    expect(entry.previousHash).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
  });

  it("should chain hashes across multiple logged events", async () => {
    const result1 = await logger.log("mandate_created", {
      mandateId: "mdt_001",
      userId: "usr_001",
    });
    const result2 = await logger.log("transaction_submitted", {
      requestId: "req_001",
      agentId: "agt_001",
      userId: "usr_001",
      mandateId: "mdt_001",
    });
    const result3 = await logger.log("governance_decided", {
      requestId: "req_001",
      agentId: "agt_001",
      userId: "usr_001",
    });

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(result3.ok).toBe(true);
    if (!result1.ok || !result2.ok || !result3.ok) return;

    const entry1 = result1.value;
    const entry2 = result2.value;
    const entry3 = result3.value;

    // Sequence numbers increment
    expect(entry1.sequenceNumber).toBe(0);
    expect(entry2.sequenceNumber).toBe(1);
    expect(entry3.sequenceNumber).toBe(2);

    // Hash chain links correctly
    expect(entry2.previousHash).toBe(entry1.hash);
    expect(entry3.previousHash).toBe(entry2.hash);

    // All hashes are distinct
    expect(entry1.hash).not.toBe(entry2.hash);
    expect(entry2.hash).not.toBe(entry3.hash);
  });

  it("should retrieve an entry by id", async () => {
    const logResult = await logger.log("mandate_created", {
      mandateId: "mdt_x",
    });
    expect(logResult.ok).toBe(true);
    if (!logResult.ok) return;

    const getResult = await logger.getEntry(logResult.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.id).toBe(logResult.value.id);
  });

  it("should return an error when entry is not found", async () => {
    const result = await logger.getEntry("evt_nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("QueryService", () => {
  let store: InMemoryEventStore;
  let logger: EventLogger;
  let queryService: QueryService;

  beforeEach(async () => {
    store = new InMemoryEventStore();
    logger = new EventLogger(store);
    queryService = new QueryService(store);

    await logger.log("mandate_created", {
      mandateId: "mdt_001",
      userId: "usr_alice",
      agentId: "agt_a",
    });
    await logger.log("transaction_submitted", {
      requestId: "req_001",
      agentId: "agt_a",
      userId: "usr_alice",
      mandateId: "mdt_001",
    });
    await logger.log("governance_decided", {
      requestId: "req_001",
      agentId: "agt_b",
      userId: "usr_bob",
    });
  });

  it("should query by event type", async () => {
    const results = await queryService.query({
      eventType: "mandate_created",
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.eventType).toBe("mandate_created");
  });

  it("should query by agent ID", async () => {
    const results = await queryService.query({ agentId: "agt_a" });
    expect(results).toHaveLength(2);
    results.forEach((entry) => {
      expect(entry.agentId).toBe("agt_a");
    });
  });

  it("should query by user ID", async () => {
    const results = await queryService.query({ userId: "usr_bob" });
    expect(results).toHaveLength(1);
    expect(results[0]!.userId).toBe("usr_bob");
  });

  it("should support limit and offset", async () => {
    const page1 = await queryService.query({ limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = await queryService.query({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
  });

  it("should verify a valid hash chain", async () => {
    const entries = await queryService.query({});
    const isValid = queryService.verifyChain(entries);
    expect(isValid).toBe(true);
  });

  it("should detect a tampered hash chain", async () => {
    const entries = await queryService.query({});
    // Tamper with the second entry's hash
    const tampered = entries.map((e, i) => {
      if (i === 1) {
        return { ...e, hash: "tampered_hash_value" };
      }
      return e;
    });
    const isValid = queryService.verifyChain(tampered);
    expect(isValid).toBe(false);
  });

  it("should return true for an empty chain", () => {
    const isValid = queryService.verifyChain([]);
    expect(isValid).toBe(true);
  });
});
