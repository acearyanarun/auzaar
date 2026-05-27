import { NextResponse } from "next/server";
import type { GovernanceDecision, GovernanceRequest } from "@auzaar/core";
import {
  getReviewQueue,
  getAllReviewItems,
  getReviewItem,
  resolveReview,
  feedbackCollector,
  graphUpdater,
  trainingDataFormatter,
  spendingGraph,
} from "@/lib/store";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "true";

  const items = all ? getAllReviewItems() : getReviewQueue();
  return NextResponse.json(items);
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as {
    requestId: string;
    decision: "approved" | "rejected";
    reason?: string;
    operatorId: string;
  };

  // SEC-7: operatorId is required so every operator action is attributable in
  // the audit trail. A static fallback string would make audit logs meaningless.
  if (!body.requestId || !body.decision || !body.operatorId) {
    return NextResponse.json(
      { error: "requestId, decision, and operatorId are required" },
      { status: 400 }
    );
  }

  if (body.decision !== "approved" && body.decision !== "rejected") {
    return NextResponse.json(
      { error: "decision must be 'approved' or 'rejected'" },
      { status: 400 }
    );
  }

  const item = getReviewItem(body.requestId);
  if (!item) {
    return NextResponse.json(
      { error: "Review item not found" },
      { status: 404 }
    );
  }

  resolveReview(body.requestId, body.decision);

  const originalDecision: GovernanceDecision = {
    requestId: item.requestId,
    decision: item.decision,
    compositeScore: item.compositeScore,
    stageResults: [],
    explanation: item.explanation,
    decidedAt: item.timestamp,
    latencyMs: 0,
  };

  const originalRequest: GovernanceRequest = {
    requestId: item.requestId,
    transaction: {
      id: item.requestId,
      mandateId: item.mandateId,
      agentId: item.agentId,
      userId: item.userId,
      vendor: item.transaction.vendor,
      product: item.transaction.product,
      amount: item.transaction.amount,
      currency: item.transaction.currency,
      quantity: 1,
      timestamp: item.timestamp,
    },
    mandateId: item.mandateId,
    agentId: item.agentId,
    userId: item.userId,
    timestamp: item.timestamp,
  };

  const feedback = await feedbackCollector.recordDecision(
    body.requestId,
    body.operatorId,
    body.decision,
    originalDecision,
    originalRequest,
    body.reason
  );

  await graphUpdater.updateFromFeedback(feedback);
  await trainingDataFormatter.formatAndStore([feedback]);

  if (body.decision === "approved") {
    await spendingGraph.recordTransaction({
      agentId: item.agentId,
      amount: item.transaction.amount,
      category: undefined,
      vendor: item.transaction.vendor,
      timestamp: new Date().toISOString(),
    });
  }

  return NextResponse.json(item);
}
