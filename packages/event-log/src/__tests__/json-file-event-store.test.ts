import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogger } from "../logger.js";
import { JsonFileEventStore } from "../json-file-event-store.js";
import { QueryService } from "../query.js";

describe("JsonFileEventStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auzaar-event-log-"));
    filePath = join(dir, "event_log.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists entries and supports query", async () => {
    const store = new JsonFileEventStore(filePath);
    const logger = new EventLogger(store);
    await logger.log("mandate_created", { mandateId: "m1", userId: "u1" });

    const q = new QueryService(store);
    const all = await q.query({});
    expect(all).toHaveLength(1);
    expect(all[0]!.eventType).toBe("mandate_created");
  });

  it("continues hash chain when a new EventLogger appends after another process wrote the file", async () => {
    const store = new JsonFileEventStore(filePath);
    const logger1 = new EventLogger(store);
    const r1 = await logger1.log("transaction_submitted", {
      requestId: "req_1",
      agentId: "agt_1",
    });
    expect(r1.ok).toBe(true);

    const logger2 = new EventLogger(store);
    const r2 = await logger2.log("governance_decided", {
      requestId: "req_1",
      agentId: "agt_1",
    });
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r2.value.previousHash).toBe(r1.value.hash);
    expect(r2.value.sequenceNumber).toBe(1);

    const q = new QueryService(store);
    const chain = await q.query({});
    expect(q.verifyChain(chain)).toBe(true);
  });
});
