import type {
  GovernanceDecision,
  GovernanceRequest,
  EventType,
} from "@auzaar/core";

export type OperatorAction = "approved" | "rejected";

export interface OperatorFeedback {
  requestId: string;
  operatorId: string;
  action: OperatorAction;
  reason?: string;
  originalDecision: GovernanceDecision;
  originalRequest: GovernanceRequest;
  timestamp: string;
}

export interface FeedbackStore {
  save(feedback: OperatorFeedback): Promise<void>;
  getByRequestId(requestId: string): Promise<OperatorFeedback | null>;
  query(filter: FeedbackQueryFilter): Promise<OperatorFeedback[]>;
}

export interface FeedbackQueryFilter {
  operatorId?: string;
  action?: OperatorAction;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

export interface FeedbackEventWriter {
  log(
    eventType: EventType,
    data: {
      requestId?: string;
      agentId?: string;
      userId?: string;
      mandateId?: string;
      data?: Record<string, unknown>;
    }
  ): Promise<unknown>;
}

export class FeedbackCollector {
  constructor(
    private readonly store: FeedbackStore,
    private readonly eventWriter?: FeedbackEventWriter
  ) {}

  async recordDecision(
    requestId: string,
    operatorId: string,
    action: OperatorAction,
    originalDecision: GovernanceDecision,
    originalRequest: GovernanceRequest,
    reason?: string
  ): Promise<OperatorFeedback> {
    const feedback: OperatorFeedback = {
      requestId,
      operatorId,
      action,
      reason,
      originalDecision,
      originalRequest,
      timestamp: new Date().toISOString(),
    };

    await this.store.save(feedback);

    await this.eventWriter?.log("operator_reviewed", {
      requestId,
      agentId: originalRequest.agentId,
      userId: originalRequest.userId,
      mandateId: originalRequest.mandateId,
      data: {
        operatorId,
        action,
        reason,
        originalDecision: originalDecision.decision,
        compositeScore: originalDecision.compositeScore,
      },
    });

    return feedback;
  }

  async getFeedback(requestId: string): Promise<OperatorFeedback | null> {
    return this.store.getByRequestId(requestId);
  }

  async queryFeedback(
    filter: FeedbackQueryFilter
  ): Promise<OperatorFeedback[]> {
    return this.store.query(filter);
  }
}

export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly entries: OperatorFeedback[] = [];

  async save(feedback: OperatorFeedback): Promise<void> {
    const existing = this.entries.findIndex(
      (e) => e.requestId === feedback.requestId
    );
    if (existing >= 0) {
      this.entries[existing] = feedback;
    } else {
      this.entries.push(feedback);
    }
  }

  async getByRequestId(requestId: string): Promise<OperatorFeedback | null> {
    return this.entries.find((e) => e.requestId === requestId) ?? null;
  }

  async query(filter: FeedbackQueryFilter): Promise<OperatorFeedback[]> {
    let results = this.entries.filter((entry) => {
      if (filter.operatorId && entry.operatorId !== filter.operatorId)
        return false;
      if (filter.action && entry.action !== filter.action) return false;
      if (filter.startTime && entry.timestamp < filter.startTime) return false;
      if (filter.endTime && entry.timestamp > filter.endTime) return false;
      return true;
    });

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? results.length;
    results = results.slice(offset, offset + limit);
    return results;
  }
}
