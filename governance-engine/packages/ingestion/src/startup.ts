import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateKeyPair } from "@auzaar/core";
import { MandateService, InMemoryMandateStore } from "@auzaar/mandate-service";
import {
  GovernanceEngine,
  SpendingGraph,
  InMemorySpendingGraphStore,
  loadPoliciesFromDirectory,
} from "@auzaar/governance-engine";
import { EventLogger, InMemoryEventStore } from "@auzaar/event-log";
import { ProtocolRouter } from "@auzaar/protocol-release";
import { AgentRegistry, InMemoryAgentStore } from "@auzaar/agent-registry";
import {
  FeedbackCollector,
  InMemoryFeedbackStore,
  TrainingDataFormatter,
  InMemoryTrainingDataStore,
  GraphUpdater,
  InMemorySpendingBaselineStore,
} from "@auzaar/feedback-pipeline";
import { ApiProxy } from "./api-proxy.js";
import { BoundedMap, type AuzaarContext } from "./context.js";
import { createMcpServer } from "./mcp-server.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function startMcpServer(): Promise<void> {
  const keyPair = generateKeyPair();
  const mandateStore = new InMemoryMandateStore();
  const mandateService = new MandateService(mandateStore, keyPair.privateKey);

  const policiesDir = resolve(process.cwd(), "policies");
  const policies = existsSync(policiesDir)
    ? loadPoliciesFromDirectory(policiesDir)
    : [];

  const eventStore = new InMemoryEventStore();
  const eventLogger = new EventLogger(eventStore);

  const spendingGraphStore = new InMemorySpendingGraphStore();
  const spendingGraph = new SpendingGraph(spendingGraphStore);

  const governanceEngine = new GovernanceEngine({
    policies,
    eventWriter: eventLogger,
    pipelineOptions: { spendingGraph },
  });

  const protocolRouter = new ProtocolRouter();

  const agentStore = new InMemoryAgentStore();
  const agentRegistry = new AgentRegistry(agentStore);

  const feedbackStore = new InMemoryFeedbackStore();
  const feedbackCollector = new FeedbackCollector(feedbackStore, eventLogger);

  const ctx: AuzaarContext = {
    mandateService,
    governanceEngine,
    eventWriter: eventLogger,
    protocolRouter,
    agentRegistry,
    feedbackCollector,
    spendingGraph,
    // SEC-19: Use BoundedMap to prevent unbounded memory growth in long-running
    // processes. Evicts the least-recently-used entry at 10,000 entries.
    decisions: new BoundedMap(10_000),
    requests: new BoundedMap(10_000),
  };

  const server = createMcpServer(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.AUZAAR_PROXY_ENABLED === "true") {
    const proxyPort = parseInt(process.env.AUZAAR_PROXY_PORT ?? "3102", 10);
    const patterns = process.env.AUZAAR_PROXY_TARGET_PATTERNS?.split(",") ?? [
      "*.openai.com/acp/*",
      "*.ucp.dev/*",
    ];
    const proxy = new ApiProxy(ctx, {
      port: proxyPort,
      targetPatterns: patterns,
    });
    await proxy.start();
  }
}

startMcpServer().catch((error) => {
  console.error("Failed to start Auzaar MCP server:", error);
  process.exit(1);
});
