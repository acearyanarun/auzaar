import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair } from "@auzaar/core";
import { MandateService, InMemoryMandateStore } from "@auzaar/mandate-service";
import { GovernanceEngine } from "@auzaar/governance-engine";
import { EventLogger, InMemoryEventStore } from "@auzaar/event-log";
import { ProtocolRouter } from "@auzaar/protocol-release";
import type { AuzaarContext } from "../context.js";
import { createMcpServer } from "../mcp-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function createTestContext(): AuzaarContext {
  const keyPair = generateKeyPair();
  const mandateStore = new InMemoryMandateStore();
  const mandateService = new MandateService(mandateStore, keyPair.privateKey);

  const eventStore = new InMemoryEventStore();
  const eventLogger = new EventLogger(eventStore);

  const governanceEngine = new GovernanceEngine({
    policies: [
      {
        id: "pol_test",
        name: "Test Policy",
        rules: [
          {
            type: "spending_limit",
            id: "limit_1000",
            maxAmount: 1000,
            currency: "USD",
            period: "per_transaction",
            enabled: true,
          },
          {
            type: "vendor_blocklist",
            id: "blocked_vendors",
            vendors: ["Scam Corp"],
            enabled: true,
          },
        ],
        priority: 0,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    eventWriter: eventLogger,
  });

  const protocolRouter = new ProtocolRouter();

  return {
    mandateService,
    governanceEngine,
    eventWriter: eventLogger,
    protocolRouter,
    decisions: new Map(),
    requests: new Map(),
  };
}

async function createClientServer() {
  const ctx = createTestContext();
  const server = createMcpServer(ctx);
  const client = new Client({ name: "test-client", version: "0.1.0" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return { client, server, ctx };
}

describe("MCP Server", () => {
  let client: Client;
  let ctx: AuzaarContext;

  beforeEach(async () => {
    const setup = await createClientServer();
    client = setup.client;
    ctx = setup.ctx;
  });

  it("should list all four tools", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "amend_mandate",
      "check_status",
      "submit_feedback",
      "submit_mandate",
      "submit_transaction",
    ]);
  });

  describe("submit_mandate", () => {
    it("should create a mandate", async () => {
      const result = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy a laptop under $1000",
          product: "laptop",
          maxBudget: 1000,
        },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0]!.text);
      expect(data.mandateId).toMatch(/^mdt_/);
      expect(data.status).toBe("active");
      expect(data.version).toBe(1);
    });

    it("should reject invalid mandate", async () => {
      const result = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy something",
          product: "",
          maxBudget: -10,
        },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe("submit_transaction", () => {
    it("should approve a valid transaction", async () => {
      const mandateResult = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy a keyboard",
          product: "keyboard",
          maxBudget: 200,
        },
      });
      const mandateData = JSON.parse(
        (mandateResult.content as Array<{ text: string }>)[0]!.text
      );

      const txResult = await client.callTool({
        name: "submit_transaction",
        arguments: {
          mandateId: mandateData.mandateId,
          agentId: "agt_001",
          userId: "usr_001",
          vendor: "Amazon",
          product: "keyboard",
          amount: 75,
        },
      });

      expect(txResult.isError).toBeFalsy();
      const txData = JSON.parse(
        (txResult.content as Array<{ text: string }>)[0]!.text
      );
      expect(txData.decision).toBe("approved");
      expect(txData.requestId).toMatch(/^req_/);
      expect(txData.transactionId).toMatch(/^txn_/);
      expect(txData.release).toBeTruthy();
      expect(txData.release.released).toBe(true);
    });

    it("should block a transaction exceeding spending limit", async () => {
      const mandateResult = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy expensive equipment",
          product: "server rack",
          maxBudget: 50000,
        },
      });
      const mandateData = JSON.parse(
        (mandateResult.content as Array<{ text: string }>)[0]!.text
      );

      const txResult = await client.callTool({
        name: "submit_transaction",
        arguments: {
          mandateId: mandateData.mandateId,
          agentId: "agt_001",
          userId: "usr_001",
          vendor: "Dell",
          product: "server rack",
          amount: 5000,
        },
      });

      const txData = JSON.parse(
        (txResult.content as Array<{ text: string }>)[0]!.text
      );
      expect(txData.decision).toBe("blocked");
    });

    it("should block a transaction with a blocklisted vendor", async () => {
      const mandateResult = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy something",
          product: "widget",
          maxBudget: 100,
        },
      });
      const mandateData = JSON.parse(
        (mandateResult.content as Array<{ text: string }>)[0]!.text
      );

      const txResult = await client.callTool({
        name: "submit_transaction",
        arguments: {
          mandateId: mandateData.mandateId,
          agentId: "agt_001",
          userId: "usr_001",
          vendor: "Scam Corp",
          product: "widget",
          amount: 50,
        },
      });

      const txData = JSON.parse(
        (txResult.content as Array<{ text: string }>)[0]!.text
      );
      expect(txData.decision).toBe("blocked");
    });

    it("should reject a transaction with an invalid mandate", async () => {
      const txResult = await client.callTool({
        name: "submit_transaction",
        arguments: {
          mandateId: "mdt_nonexistent",
          agentId: "agt_001",
          userId: "usr_001",
          vendor: "Amazon",
          product: "widget",
          amount: 50,
        },
      });

      expect(txResult.isError).toBe(true);
      const data = JSON.parse(
        (txResult.content as Array<{ text: string }>)[0]!.text
      );
      expect(data.decision).toBe("blocked");
      expect(data.reason).toBe("No valid mandate found");
    });
  });

  describe("check_status", () => {
    it("should return the decision for a known request", async () => {
      const mandateResult = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy a mouse",
          product: "mouse",
          maxBudget: 100,
        },
      });
      const mandateData = JSON.parse(
        (mandateResult.content as Array<{ text: string }>)[0]!.text
      );

      const txResult = await client.callTool({
        name: "submit_transaction",
        arguments: {
          mandateId: mandateData.mandateId,
          agentId: "agt_001",
          userId: "usr_001",
          vendor: "Logitech",
          product: "mouse",
          amount: 30,
        },
      });
      const txData = JSON.parse(
        (txResult.content as Array<{ text: string }>)[0]!.text
      );

      const statusResult = await client.callTool({
        name: "check_status",
        arguments: { requestId: txData.requestId },
      });

      expect(statusResult.isError).toBeFalsy();
      const statusData = JSON.parse(
        (statusResult.content as Array<{ text: string }>)[0]!.text
      );
      expect(statusData.decision).toBe("approved");
      expect(statusData.requestId).toBe(txData.requestId);
    });

    it("should return error for unknown request", async () => {
      const result = await client.callTool({
        name: "check_status",
        arguments: { requestId: "req_nonexistent" },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe("amend_mandate", () => {
    it("should amend a mandate", async () => {
      const mandateResult = await client.callTool({
        name: "submit_mandate",
        arguments: {
          userId: "usr_001",
          agentId: "agt_001",
          intentText: "Buy a display",
          product: "display",
          maxBudget: 500,
        },
      });
      const mandateData = JSON.parse(
        (mandateResult.content as Array<{ text: string }>)[0]!.text
      );

      const amendResult = await client.callTool({
        name: "amend_mandate",
        arguments: {
          mandateId: mandateData.mandateId,
          maxBudget: 800,
        },
      });

      expect(amendResult.isError).toBeFalsy();
      const amendData = JSON.parse(
        (amendResult.content as Array<{ text: string }>)[0]!.text
      );
      expect(amendData.version).toBe(2);
      expect(amendData.previousVersionId).toBe(mandateData.mandateId);
      expect(amendData.structuredIntent.maxBudget).toBe(800);
    });

    it("should fail for non-existent mandate", async () => {
      const result = await client.callTool({
        name: "amend_mandate",
        arguments: {
          mandateId: "mdt_nonexistent",
          maxBudget: 100,
        },
      });

      expect(result.isError).toBe(true);
    });
  });
});
