import type {
  GovernanceRequest,
  GovernanceDecision,
  Policy,
  Mandate,
  EventType,
  Result,
} from "@auzaar/core";
import { ok, err, GovernanceError } from "@auzaar/core";
import { RulesEngine } from "./stages/rules-engine.js";
import { GovernancePipeline, type PipelineOptions } from "./pipeline.js";
import {
  computeCompositeScore,
  determineDecision,
  type DecisionThresholds,
  DEFAULT_THRESHOLDS,
} from "./scoring.js";
import {
  TriageRouter,
  type TriageConfig,
  type SlmTriageModel,
  type TriageResult,
} from "./triage.js";

export interface GovernanceEventWriter {
  log(
    eventType: EventType,
    data: {
      requestId?: string;
      agentId?: string;
      userId?: string;
      mandateId?: string;
      request?: GovernanceRequest;
      decision?: GovernanceDecision;
      data?: Record<string, unknown>;
    }
  ): Promise<unknown>;
}

export interface GovernanceEngineOptions {
  policies: Policy[];
  thresholds?: DecisionThresholds;
  eventWriter?: GovernanceEventWriter;
  pipelineOptions?: PipelineOptions;
  triageConfig?: Partial<TriageConfig>;
  slmModel?: SlmTriageModel;
}

export class GovernanceEngine {
  private pipeline: GovernancePipeline;
  private readonly thresholds: DecisionThresholds;
  private readonly eventWriter?: GovernanceEventWriter;
  private readonly triageRouter: TriageRouter;

  constructor(options: GovernanceEngineOptions) {
    this.pipeline = new GovernancePipeline(
      new RulesEngine(options.policies),
      options.pipelineOptions
    );
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.eventWriter = options.eventWriter;
    this.triageRouter = new TriageRouter(
      options.triageConfig,
      options.slmModel
    );
  }

  async evaluate(
    request: GovernanceRequest,
    mandate?: Mandate,
    agentTrustScore?: number
  ): Promise<Result<GovernanceDecision>> {
    const startTime = performance.now();

    try {
      await this.logEvent("governance_started", {
        requestId: request.requestId,
        agentId: request.agentId,
        userId: request.userId,
        mandateId: request.mandateId,
        request,
      });

      // Use async pipeline if ML models are configured
      const hasAsyncStages =
        this.pipeline["threatClassifier"]?.isLoaded() ||
        this.pipeline["alignmentScorer"]?.isLoaded() ||
        this.pipeline["spendingGraph"];

      const pipelineResult = hasAsyncStages
        ? await this.pipeline.runAsync(request, mandate)
        : this.pipeline.run(request, mandate);

      const compositeScore = computeCompositeScore(
        pipelineResult.stageResults,
        agentTrustScore
      );
      const decision = determineDecision(
        compositeScore,
        pipelineResult.hardBlocked,
        this.thresholds
      );

      // Run triage for flagged transactions
      let triageResult: TriageResult | undefined;
      if (decision === "flagged") {
        triageResult = await this.triageRouter.route({
          request,
          stageResults: pipelineResult.stageResults,
          compositeScore,
          decision,
        });
      }

      const explanations = pipelineResult.stageResults
        .filter((r) => r.explanation)
        .map((r) => r.explanation!);

      if (triageResult) {
        explanations.push(`Triage: ${triageResult.recommendation}`);
      }

      // Apply triage routing to final decision
      let finalDecision = decision;
      if (triageResult) {
        if (triageResult.route === "auto-approve") finalDecision = "approved";
        else if (triageResult.route === "auto-block") finalDecision = "blocked";
        // human-review keeps it as "flagged"
      }

      const latencyMs = performance.now() - startTime;

      const governanceDecision: GovernanceDecision = {
        requestId: request.requestId,
        decision: finalDecision,
        compositeScore,
        stageResults: pipelineResult.stageResults,
        explanation: explanations.join("; "),
        decidedAt: new Date().toISOString(),
        latencyMs: Math.round(latencyMs * 100) / 100,
      };

      await this.logEvent("governance_decided", {
        requestId: request.requestId,
        agentId: request.agentId,
        userId: request.userId,
        mandateId: request.mandateId,
        request,
        decision: governanceDecision,
        data: triageResult
          ? {
              triageRoute: triageResult.route,
              triageConfidence: triageResult.confidence,
              triageRecommendation: triageResult.recommendation,
            }
          : undefined,
      });

      return ok(governanceDecision);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown governance error";
      return err(
        new GovernanceError(`Governance pipeline failed: ${message}`)
      );
    }
  }

  reloadPolicies(policies: Policy[]): void {
    const options = {
      threatClassifier: this.pipeline["threatClassifier"],
      alignmentScorer: this.pipeline["alignmentScorer"],
      spendingGraph: this.pipeline["spendingGraph"],
    };
    this.pipeline = new GovernancePipeline(
      new RulesEngine(policies),
      options
    );
  }

  private async logEvent(
    eventType: EventType,
    data: Parameters<GovernanceEventWriter["log"]>[1]
  ): Promise<void> {
    if (!this.eventWriter) return;
    try {
      await this.eventWriter.log(eventType, data);
    } catch {
      // Event logging is non-blocking — failures don't affect governance decisions
    }
  }
}
