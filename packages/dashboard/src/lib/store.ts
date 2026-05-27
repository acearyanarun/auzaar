import { generateKeyPair } from "@auzaar/core";
import type { GovernanceDecision, GovernanceRequest } from "@auzaar/core";
import { MandateService, InMemoryMandateStore } from "@auzaar/mandate-service";
import {
  GovernanceEngine,
  SpendingGraph,
  InMemorySpendingGraphStore,
  loadPoliciesFromDirectory,
} from "@auzaar/governance-engine";
import { EventLogger, JsonFileEventStore, QueryService } from "@auzaar/event-log";
import {
  FeedbackCollector,
  InMemoryFeedbackStore,
  TrainingDataFormatter,
  InMemoryTrainingDataStore,
  GraphUpdater,
  InMemorySpendingBaselineStore,
} from "@auzaar/feedback-pipeline";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Resolves the interactive demo root (`packages/auzaar_demo`) so the dashboard
 * reads the same policy JSON and `event_log.json` as `npm run demo`.
 */
function resolveAuzaarDemoRoot(): string | null {
  if (process.env.AUZAAR_DEMO_ROOT) {
    const p = resolve(process.env.AUZAAR_DEMO_ROOT);
    if (existsSync(join(p, "policies", "deterministic_policy.json"))) {
      return p;
    }
  }
  const candidates = [
    resolve(process.cwd(), "packages/auzaar_demo"),
    resolve(process.cwd(), "../../packages/auzaar_demo"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "policies", "deterministic_policy.json"))) {
      return c;
    }
  }
  return null;
}

const demoRoot = resolveAuzaarDemoRoot();

const eventLogPath = process.env.AUZAAR_EVENT_LOG_PATH
  ? resolve(process.env.AUZAAR_EVENT_LOG_PATH)
  : demoRoot
    ? join(demoRoot, "event_log.json")
    : resolve(process.cwd(), "event_log.json");

const policiesDir = process.env.AUZAAR_POLICIES_DIR
  ? resolve(process.env.AUZAAR_POLICIES_DIR)
  : demoRoot
    ? join(demoRoot, "policies")
    : resolve(process.cwd(), "policies");

const keyPair = generateKeyPair();
const mandateStore = new InMemoryMandateStore();
const eventStore = new JsonFileEventStore(eventLogPath);

const policies = existsSync(policiesDir)
  ? loadPoliciesFromDirectory(policiesDir)
  : [];

export const mandateService = new MandateService(
  mandateStore,
  keyPair.privateKey
);
export const eventLogger = new EventLogger(eventStore);
export const queryService = new QueryService(eventStore);

const spendingGraphStore = new InMemorySpendingGraphStore();
export const spendingGraph = new SpendingGraph(spendingGraphStore);

export const governanceEngine = new GovernanceEngine({
  policies,
  eventWriter: eventLogger,
  pipelineOptions: { spendingGraph },
});

const feedbackStore = new InMemoryFeedbackStore();
const trainingDataStore = new InMemoryTrainingDataStore();
const spendingBaselineStore = new InMemorySpendingBaselineStore();

export const feedbackCollector = new FeedbackCollector(feedbackStore, eventLogger);
export const trainingDataFormatter = new TrainingDataFormatter(trainingDataStore);
export const graphUpdater = new GraphUpdater(spendingBaselineStore);

/** Absolute path to the on-disk audit file (same file the CLI demo writes). */
export const dashboardEventLogPath = eventLogPath;

export interface ReviewItem {
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

const reviewQueue = new Map<string, ReviewItem>();

export function addToReviewQueue(item: ReviewItem): void {
  reviewQueue.set(item.requestId, item);
}

export function getReviewQueue(): ReviewItem[] {
  return Array.from(reviewQueue.values())
    .filter((item) => !item.operatorDecision)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function getReviewItem(requestId: string): ReviewItem | undefined {
  return reviewQueue.get(requestId);
}

export function resolveReview(
  requestId: string,
  decision: "approved" | "rejected"
): ReviewItem | undefined {
  const item = reviewQueue.get(requestId);
  if (!item) return undefined;

  item.operatorDecision = decision;
  return item;
}

export function getAllReviewItems(): ReviewItem[] {
  return Array.from(reviewQueue.values()).sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp)
  );
}

export { policies };
