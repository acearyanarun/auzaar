import { describe, it, expect, beforeEach } from "vitest";
import {
  FeedbackCollector,
  InMemoryFeedbackStore,
} from "../collector.js";
import {
  TrainingDataFormatter,
  InMemoryTrainingDataStore,
} from "../trainer.js";
import {
  GraphUpdater,
  InMemorySpendingBaselineStore,
} from "../graph-updater.js";
import type { GovernanceDecision, GovernanceRequest } from "@auzaar/core";

function makeRequest(overrides?: Partial<GovernanceRequest>): GovernanceRequest {
  return {
    requestId: "req_test1",
    transaction: {
      id: "txn_test1",
      mandateId: "mdt_test1",
      agentId: "agt_test1",
      userId: "user_1",
      vendor: "Amazon",
      product: "Laptop",
      category: "electronics",
      amount: 999,
      currency: "USD",
      quantity: 1,
      timestamp: new Date().toISOString(),
    },
    mandateId: "mdt_test1",
    agentId: "agt_test1",
    userId: "user_1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeDecision(overrides?: Partial<GovernanceDecision>): GovernanceDecision {
  return {
    requestId: "req_test1",
    decision: "flagged",
    compositeScore: 0.45,
    stageResults: [
      { stage: "rules-engine", passed: true, score: 0.1, blocked: false },
      { stage: "threat-detection", passed: true, score: 0.2, blocked: false },
      { stage: "intent-alignment", passed: true, score: 0.3, blocked: false },
      { stage: "spending-graph", passed: true, score: 0.4, blocked: false },
    ],
    explanation: "Test explanation",
    decidedAt: new Date().toISOString(),
    latencyMs: 5,
    ...overrides,
  };
}

describe("FeedbackCollector", () => {
  let collector: FeedbackCollector;
  let store: InMemoryFeedbackStore;

  beforeEach(() => {
    store = new InMemoryFeedbackStore();
    collector = new FeedbackCollector(store);
  });

  it("records an operator approval", async () => {
    const feedback = await collector.recordDecision(
      "req_test1",
      "operator_1",
      "approved",
      makeDecision(),
      makeRequest(),
      "Looks good"
    );

    expect(feedback.requestId).toBe("req_test1");
    expect(feedback.operatorId).toBe("operator_1");
    expect(feedback.action).toBe("approved");
    expect(feedback.reason).toBe("Looks good");
  });

  it("records an operator rejection", async () => {
    const feedback = await collector.recordDecision(
      "req_test1",
      "operator_1",
      "rejected",
      makeDecision(),
      makeRequest(),
      "Suspicious vendor"
    );

    expect(feedback.action).toBe("rejected");
    expect(feedback.reason).toBe("Suspicious vendor");
  });

  it("retrieves feedback by requestId", async () => {
    await collector.recordDecision(
      "req_test1",
      "operator_1",
      "approved",
      makeDecision(),
      makeRequest()
    );

    const result = await collector.getFeedback("req_test1");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("approved");
  });

  it("returns null for unknown requestId", async () => {
    const result = await collector.getFeedback("req_unknown");
    expect(result).toBeNull();
  });

  it("queries feedback by action", async () => {
    await collector.recordDecision("req_1", "op_1", "approved", makeDecision(), makeRequest());
    await collector.recordDecision(
      "req_2",
      "op_1",
      "rejected",
      makeDecision({ requestId: "req_2" }),
      makeRequest({ requestId: "req_2" })
    );

    const approved = await collector.queryFeedback({ action: "approved" });
    expect(approved).toHaveLength(1);
    expect(approved[0]!.requestId).toBe("req_1");
  });

  it("logs to event writer when provided", async () => {
    const events: unknown[] = [];
    const eventWriter = {
      log: async (_type: string, data: unknown) => {
        events.push(data);
      },
    };
    const collectorWithEvents = new FeedbackCollector(
      store,
      eventWriter as never
    );

    await collectorWithEvents.recordDecision(
      "req_test1",
      "op_1",
      "approved",
      makeDecision(),
      makeRequest()
    );

    expect(events).toHaveLength(1);
  });
});

describe("TrainingDataFormatter", () => {
  let formatter: TrainingDataFormatter;
  let dataStore: InMemoryTrainingDataStore;

  beforeEach(() => {
    dataStore = new InMemoryTrainingDataStore();
    formatter = new TrainingDataFormatter(dataStore);
  });

  it("formats feedback into training examples", async () => {
    const feedbackStore = new InMemoryFeedbackStore();
    const collector = new FeedbackCollector(feedbackStore);

    const fb = await collector.recordDecision(
      "req_1",
      "op_1",
      "approved",
      makeDecision(),
      makeRequest()
    );

    const count = await formatter.formatAndStore([fb]);
    expect(count).toBe(1);

    const examples = await formatter.exportForFineTuning();
    expect(examples).toHaveLength(1);
    expect(examples[0]!.label).toBe("approved");
    expect(examples[0]!.input.vendor).toBe("Amazon");
    expect(examples[0]!.input.amount).toBe(999);
  });

  it("tracks dataset size", async () => {
    expect(await formatter.getDatasetSize()).toBe(0);

    const fb = await new FeedbackCollector(new InMemoryFeedbackStore()).recordDecision(
      "req_1",
      "op_1",
      "rejected",
      makeDecision(),
      makeRequest()
    );

    await formatter.formatAndStore([fb]);
    expect(await formatter.getDatasetSize()).toBe(1);
  });
});

describe("GraphUpdater", () => {
  let updater: GraphUpdater;
  let baselineStore: InMemorySpendingBaselineStore;

  beforeEach(() => {
    baselineStore = new InMemorySpendingBaselineStore();
    updater = new GraphUpdater(baselineStore);
  });

  it("creates a new baseline for first approved transaction", async () => {
    const fb = await new FeedbackCollector(new InMemoryFeedbackStore()).recordDecision(
      "req_1",
      "op_1",
      "approved",
      makeDecision(),
      makeRequest()
    );

    await updater.updateFromFeedback(fb);

    const baseline = await updater.getBaseline("agt_test1");
    expect(baseline).not.toBeNull();
    expect(baseline!.transactionCount).toBe(1);
    expect(baseline!.averageAmount).toBe(999);
    expect(baseline!.vendorFrequency["Amazon"]).toBe(1);
  });

  it("updates existing baseline incrementally", async () => {
    const collector = new FeedbackCollector(new InMemoryFeedbackStore());

    const fb1 = await collector.recordDecision(
      "req_1",
      "op_1",
      "approved",
      makeDecision(),
      makeRequest()
    );
    await updater.updateFromFeedback(fb1);

    const fb2 = await collector.recordDecision(
      "req_2",
      "op_1",
      "approved",
      makeDecision({ requestId: "req_2" }),
      makeRequest({
        requestId: "req_2",
        transaction: {
          ...makeRequest().transaction,
          amount: 501,
        },
      })
    );
    await updater.updateFromFeedback(fb2);

    const baseline = await updater.getBaseline("agt_test1");
    expect(baseline!.transactionCount).toBe(2);
    expect(baseline!.averageAmount).toBe(750);
  });

  it("ignores rejected transactions", async () => {
    const fb = await new FeedbackCollector(new InMemoryFeedbackStore()).recordDecision(
      "req_1",
      "op_1",
      "rejected",
      makeDecision(),
      makeRequest()
    );

    await updater.updateFromFeedback(fb);

    const baseline = await updater.getBaseline("agt_test1");
    expect(baseline).toBeNull();
  });

  it("batch updates multiple feedbacks", async () => {
    const collector = new FeedbackCollector(new InMemoryFeedbackStore());

    const feedbacks = await Promise.all([
      collector.recordDecision("req_1", "op_1", "approved", makeDecision(), makeRequest()),
      collector.recordDecision("req_2", "op_1", "rejected", makeDecision(), makeRequest()),
      collector.recordDecision("req_3", "op_1", "approved", makeDecision(), makeRequest()),
    ]);

    const updated = await updater.updateBatch(feedbacks);
    expect(updated).toBe(2);
  });
});
