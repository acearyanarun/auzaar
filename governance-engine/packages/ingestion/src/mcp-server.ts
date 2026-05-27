import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GovernanceDecision } from "@auzaar/core";
import {
  generateRequestId,
  generateTransactionId,
} from "@auzaar/core";
import type { AuzaarContext } from "./context.js";

export function createMcpServer(ctx: AuzaarContext): McpServer {
  const server = new McpServer({
    name: "auzaar-governance",
    version: "0.1.0",
  });

  server.tool(
    "submit_mandate",
    "Create a new governance mandate defining what an agent is authorized to purchase",
    {
      userId: z.string().describe("ID of the user who owns the mandate"),
      agentId: z.string().describe("ID of the agent being authorized"),
      intentText: z.string().describe("Natural language description of the purchase intent"),
      product: z.string().describe("Product name or description"),
      maxBudget: z.number().positive().describe("Maximum budget for the purchase"),
      currency: z.string().default("USD").describe("Currency code"),
      quantity: z.number().int().positive().default(1).describe("Number of items"),
      vendorAllowlist: z.array(z.string()).optional().describe("Allowed vendor names"),
      vendorBlocklist: z.array(z.string()).optional().describe("Blocked vendor names"),
      category: z.string().optional().describe("Product category"),
    },
    async (params) => {
      const result = await ctx.mandateService.createMandate(
        params.userId,
        params.agentId,
        params.intentText,
        {
          product: params.product,
          maxBudget: params.maxBudget,
          currency: params.currency,
          quantity: params.quantity,
          category: params.category,
          vendorPreferences:
            params.vendorAllowlist || params.vendorBlocklist
              ? {
                  allowlist: params.vendorAllowlist,
                  blocklist: params.vendorBlocklist,
                }
              : undefined,
        }
      );

      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: result.error.code,
                message: result.error.message,
              }),
            },
          ],
          isError: true,
        };
      }

      await ctx.eventWriter?.log("mandate_created", {
        mandateId: result.value.id,
        userId: params.userId,
        agentId: params.agentId,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              mandateId: result.value.id,
              status: result.value.status,
              version: result.value.version,
              structuredIntent: result.value.structuredIntent,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "submit_transaction",
    "Submit a purchase transaction for governance review before execution",
    {
      mandateId: z.string().describe("ID of the mandate authorizing this purchase"),
      agentId: z.string().describe("ID of the agent making the purchase"),
      userId: z.string().describe("ID of the user on behalf of whom the purchase is made"),
      vendor: z.string().describe("Vendor/merchant name"),
      product: z.string().describe("Product being purchased"),
      amount: z.number().positive().describe("Purchase amount"),
      currency: z.string().default("USD").describe("Currency code"),
      quantity: z.number().int().positive().default(1).describe("Quantity"),
      category: z.string().optional().describe("Product category"),
      targetProtocol: z
        .enum(["acp", "ucp", "ap2", "direct"])
        .optional()
        .describe("Target commerce protocol"),
      targetUrl: z.string().url().optional().describe("Target merchant URL"),
    },
    async (params) => {
      const mandateResult = await ctx.mandateService.getMandate(
        params.mandateId
      );

      if (!mandateResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: mandateResult.error.code,
                message: mandateResult.error.message,
                decision: "blocked",
                reason: "No valid mandate found",
              }),
            },
          ],
          isError: true,
        };
      }

      const requestId = generateRequestId();
      const txnId = generateTransactionId();
      const now = new Date().toISOString();

      const request = {
        requestId,
        transaction: {
          id: txnId,
          mandateId: params.mandateId,
          agentId: params.agentId,
          userId: params.userId,
          vendor: params.vendor,
          product: params.product,
          category: params.category,
          amount: params.amount,
          currency: params.currency,
          quantity: params.quantity,
          targetProtocol: params.targetProtocol,
          targetUrl: params.targetUrl,
          timestamp: now,
        },
        mandateId: params.mandateId,
        agentId: params.agentId,
        userId: params.userId,
        timestamp: now,
      };

      await ctx.eventWriter?.log("transaction_submitted", {
        requestId,
        agentId: params.agentId,
        userId: params.userId,
        mandateId: params.mandateId,
        request,
      });

      const decisionResult = await ctx.governanceEngine.evaluate(
        request,
        mandateResult.value
      );

      if (!decisionResult.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "GOVERNANCE_ERROR",
                message: decisionResult.error.message,
                decision: "blocked",
              }),
            },
          ],
          isError: true,
        };
      }

      const decision = decisionResult.value;

      ctx.decisions.set(requestId, decision);
      ctx.requests.set(requestId, request);

      if (decision.decision === "approved" && ctx.spendingGraph) {
        await ctx.spendingGraph.recordTransaction({
          agentId: params.agentId,
          amount: params.amount,
          category: params.category,
          vendor: params.vendor,
          timestamp: now,
        });
      }

      let releaseInfo: Record<string, unknown> | undefined;
      if (decision.decision === "approved" && ctx.protocolRouter) {
        const releaseResult = ctx.protocolRouter.release(
          request.transaction,
          params.mandateId,
          decision
        );
        if (releaseResult.ok) {
          releaseInfo = {
            released: true,
            protocol: releaseResult.value.payload.protocol,
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              requestId,
              transactionId: txnId,
              decision: decision.decision,
              compositeScore: decision.compositeScore,
              explanation: decision.explanation,
              latencyMs: decision.latencyMs,
              release: releaseInfo,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "check_status",
    "Check the status of a governance decision for a previously submitted transaction",
    {
      requestId: z.string().describe("The request ID returned from submit_transaction"),
    },
    async ({ requestId }) => {
      const decision = ctx.decisions.get(requestId);

      if (!decision) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "NOT_FOUND",
                message: `No decision found for request: ${requestId}`,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              requestId,
              decision: decision.decision,
              compositeScore: decision.compositeScore,
              explanation: decision.explanation,
              decidedAt: decision.decidedAt,
              stageResults: decision.stageResults,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "amend_mandate",
    "Modify an existing mandate's constraints",
    {
      mandateId: z.string().describe("ID of the mandate to amend"),
      maxBudget: z.number().positive().optional().describe("New maximum budget"),
      quantity: z.number().int().positive().optional().describe("New quantity limit"),
      vendorAllowlist: z.array(z.string()).optional().describe("Updated vendor allowlist"),
      vendorBlocklist: z.array(z.string()).optional().describe("Updated vendor blocklist"),
    },
    async (params) => {
      const changes: Record<string, unknown> = {};
      if (params.maxBudget !== undefined) changes.maxBudget = params.maxBudget;
      if (params.quantity !== undefined) changes.quantity = params.quantity;
      if (params.vendorAllowlist || params.vendorBlocklist) {
        changes.vendorPreferences = {
          allowlist: params.vendorAllowlist,
          blocklist: params.vendorBlocklist,
        };
      }

      const result = await ctx.mandateService.amendMandate(
        params.mandateId,
        changes
      );

      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: result.error.code,
                message: result.error.message,
              }),
            },
          ],
          isError: true,
        };
      }

      await ctx.eventWriter?.log("mandate_amended", {
        mandateId: result.value.id,
        userId: result.value.userId,
        agentId: result.value.agentId,
        data: {
          previousVersionId: result.value.previousVersionId,
          newVersion: result.value.version,
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              mandateId: result.value.id,
              previousVersionId: result.value.previousVersionId,
              version: result.value.version,
              status: result.value.status,
              structuredIntent: result.value.structuredIntent,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "submit_feedback",
    "Submit operator feedback on a governance decision (approve or reject a flagged transaction)",
    {
      requestId: z.string().describe("The request ID of the transaction to provide feedback on"),
      action: z.enum(["approved", "rejected"]).describe("The operator's decision"),
      operatorId: z.string().default("mcp-operator").describe("ID of the operator"),
      reason: z.string().optional().describe("Reason for the decision"),
    },
    async (params) => {
      const decision = ctx.decisions.get(params.requestId);
      const request = ctx.requests.get(params.requestId);

      if (!decision || !request) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "NOT_FOUND",
                message: `No decision or request found for: ${params.requestId}`,
              }),
            },
          ],
          isError: true,
        };
      }

      if (!ctx.feedbackCollector) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "NOT_CONFIGURED",
                message: "Feedback pipeline is not configured",
              }),
            },
          ],
          isError: true,
        };
      }

      const feedback = await ctx.feedbackCollector.recordDecision(
        params.requestId,
        params.operatorId,
        params.action,
        decision,
        request,
        params.reason
      );

      if (params.action === "approved" && ctx.spendingGraph) {
        await ctx.spendingGraph.recordTransaction({
          agentId: request.agentId,
          amount: request.transaction.amount,
          category: request.transaction.category,
          vendor: request.transaction.vendor,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              requestId: params.requestId,
              action: params.action,
              operatorId: params.operatorId,
              timestamp: feedback.timestamp,
            }),
          },
        ],
      };
    }
  );

  return server;
}
