import type { GovernanceRequest, GovernanceDecision, Transaction } from "@auzaar/core";
import { generateRequestId, generateTransactionId, AgentNotFoundError, AgentSuspendedError, GovernanceError } from "@auzaar/core";
import { verifyDelegationChain } from "@auzaar/agent-registry";
import type { AuzaarContext } from "./context.js";

export interface RoutingResult {
  requestId: string;
  transactionId: string;
  decision: GovernanceDecision;
  released: boolean;
}

/**
 * Routes incoming requests (from MCP or API proxy) through the governance engine.
 */
export class RequestRouter {
  constructor(private readonly ctx: AuzaarContext) {}

  async routeTransaction(params: {
    mandateId: string;
    agentId: string;
    userId: string;
    vendor: string;
    product: string;
    amount: number;
    currency?: string;
    quantity?: number;
    category?: string;
    targetProtocol?: "acp" | "ucp" | "ap2" | "direct";
    targetUrl?: string;
  }): Promise<RoutingResult> {
    if (this.ctx.agentRegistry) {
      const agentResult = await this.ctx.agentRegistry.getAgent(params.agentId);
      if (!agentResult.ok) {
        throw new AgentNotFoundError(params.agentId);
      }
      const agent = agentResult.value;
      if (agent.status === "suspended") {
        throw new AgentSuspendedError(params.agentId);
      }
      if (agent.status === "revoked") {
        throw new GovernanceError(`Agent ${params.agentId} has been revoked`);
      }

      const chainResult = verifyDelegationChain(agent.delegationChain);
      if (!chainResult.ok) {
        throw new GovernanceError(
          `Invalid delegation chain for agent ${params.agentId}: ${chainResult.error.message}`
        );
      }

      if (agent.authorizationScope.length > 0 && params.category) {
        const scopeMatch = agent.authorizationScope.some(
          (s) => s.toLowerCase() === params.category!.toLowerCase()
        );
        if (!scopeMatch) {
          throw new GovernanceError(
            `Transaction category "${params.category}" not in agent's authorized scope: [${agent.authorizationScope.join(", ")}]`
          );
        }
      }
    }

    const mandateResult = await this.ctx.mandateService.getMandate(
      params.mandateId
    );

    if (!mandateResult.ok) {
      throw new Error(`Mandate not found: ${params.mandateId}`);
    }

    const requestId = generateRequestId();
    const txnId = generateTransactionId();
    const now = new Date().toISOString();

    const transaction: Transaction = {
      id: txnId,
      mandateId: params.mandateId,
      agentId: params.agentId,
      userId: params.userId,
      vendor: params.vendor,
      product: params.product,
      category: params.category,
      amount: params.amount,
      currency: params.currency ?? "USD",
      quantity: params.quantity ?? 1,
      targetProtocol: params.targetProtocol,
      targetUrl: params.targetUrl,
      timestamp: now,
    };

    const request: GovernanceRequest = {
      requestId,
      transaction,
      mandateId: params.mandateId,
      agentId: params.agentId,
      userId: params.userId,
      timestamp: now,
    };

    await this.ctx.eventWriter?.log("transaction_submitted", {
      requestId,
      agentId: params.agentId,
      userId: params.userId,
      mandateId: params.mandateId,
      request,
    });

    let agentTrustScore: number | undefined;
    if (this.ctx.agentRegistry) {
      const agentResult = await this.ctx.agentRegistry.getAgent(params.agentId);
      if (agentResult.ok) {
        agentTrustScore = agentResult.value.trustScore;
      }
    }

    const decisionResult = await this.ctx.governanceEngine.evaluate(
      request,
      mandateResult.value,
      agentTrustScore
    );

    if (!decisionResult.ok) {
      throw new Error(decisionResult.error.message);
    }

    const decision = decisionResult.value;
    this.ctx.decisions.set(requestId, decision);
    this.ctx.requests.set(requestId, request);

    if (decision.decision === "approved" && this.ctx.spendingGraph) {
      await this.ctx.spendingGraph.recordTransaction({
        agentId: params.agentId,
        amount: params.amount,
        category: params.category,
        vendor: params.vendor,
        timestamp: now,
      });
    }

    let released = false;
    if (decision.decision === "approved" && this.ctx.protocolRouter) {
      const releaseResult = this.ctx.protocolRouter.release(
        transaction,
        params.mandateId,
        decision
      );
      released = releaseResult.ok;
    }

    return { requestId, transactionId: txnId, decision, released };
  }
}
