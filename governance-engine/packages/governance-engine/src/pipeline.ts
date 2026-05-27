import type { GovernanceRequest, StageResult, Mandate } from "@auzaar/core";
import { RulesEngine } from "./stages/rules-engine.js";
import {
  evaluateThreat,
  evaluateThreatAsync,
  type ThreatClassifier,
} from "./stages/threat-detection.js";
import {
  evaluateAlignment,
  evaluateAlignmentAsync,
  type AlignmentScorer,
} from "./stages/intent-alignment.js";
import {
  evaluateSpendingPattern,
  type SpendingGraph,
} from "./stages/spending-graph.js";

export interface PipelineResult {
  stageResults: StageResult[];
  hardBlocked: boolean;
  blockingStage?: string;
}

export interface PipelineOptions {
  threatClassifier?: ThreatClassifier;
  alignmentScorer?: AlignmentScorer;
  spendingGraph?: SpendingGraph;
}

export class GovernancePipeline {
  private readonly threatClassifier?: ThreatClassifier;
  private readonly alignmentScorer?: AlignmentScorer;
  private readonly spendingGraph?: SpendingGraph;

  constructor(
    private readonly rulesEngine: RulesEngine,
    options?: PipelineOptions
  ) {
    this.threatClassifier = options?.threatClassifier;
    this.alignmentScorer = options?.alignmentScorer;
    this.spendingGraph = options?.spendingGraph;
  }

  /**
   * Synchronous pipeline run using heuristic fallbacks.
   * Used when no async ML models are configured.
   */
  run(request: GovernanceRequest, mandate?: Mandate): PipelineResult {
    const stageResults: StageResult[] = [];

    // Stage 1: Deterministic rules — always runs first
    const rulesResult = this.rulesEngine.evaluate(request);
    stageResults.push(rulesResult);

    if (rulesResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "rules-engine",
      };
    }

    // Stage 2: Threat detection (heuristic)
    const threatResult = evaluateThreat(request);
    stageResults.push(threatResult);

    if (threatResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "threat-detection",
      };
    }

    // Stage 3: Intent alignment (heuristic)
    const mandateContext = mandate
      ? {
          intentText: mandate.intentText,
          structuredIntent:
            mandate.structuredIntent as unknown as Record<string, unknown>,
        }
      : { intentText: "", structuredIntent: {} };

    const alignmentResult = evaluateAlignment(request, mandateContext);
    stageResults.push(alignmentResult);

    if (alignmentResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "intent-alignment",
      };
    }

    // Stage 4: Spending graph (no-op without store)
    const spendingResult = evaluateSpendingPattern(request);
    stageResults.push(spendingResult);

    if (spendingResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "spending-graph",
      };
    }

    return { stageResults, hardBlocked: false };
  }

  /**
   * Async pipeline run using ML models when available.
   * Falls back to heuristics for any unloaded model.
   */
  async runAsync(
    request: GovernanceRequest,
    mandate?: Mandate
  ): Promise<PipelineResult> {
    const stageResults: StageResult[] = [];

    // Stage 1: Deterministic rules — always runs first
    const rulesResult = this.rulesEngine.evaluate(request);
    stageResults.push(rulesResult);

    if (rulesResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "rules-engine",
      };
    }

    // Stage 2: Threat detection
    let threatResult: StageResult;
    if (this.threatClassifier?.isLoaded()) {
      threatResult = await evaluateThreatAsync(
        request,
        this.threatClassifier,
        mandate?.intentText
      );
    } else {
      threatResult = evaluateThreat(request);
    }
    stageResults.push(threatResult);

    if (threatResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "threat-detection",
      };
    }

    // Stage 3: Intent alignment
    const mandateContext = mandate
      ? {
          intentText: mandate.intentText,
          structuredIntent:
            mandate.structuredIntent as unknown as Record<string, unknown>,
        }
      : { intentText: "", structuredIntent: {} };

    let alignmentResult: StageResult;
    if (this.alignmentScorer?.isLoaded()) {
      alignmentResult = await evaluateAlignmentAsync(
        request,
        mandateContext,
        this.alignmentScorer
      );
    } else {
      alignmentResult = evaluateAlignment(request, mandateContext);
    }
    stageResults.push(alignmentResult);

    if (alignmentResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "intent-alignment",
      };
    }

    // Stage 4: Spending graph
    let spendingResult: StageResult;
    if (this.spendingGraph) {
      spendingResult = await this.spendingGraph.evaluate(request);
    } else {
      spendingResult = evaluateSpendingPattern(request);
    }
    stageResults.push(spendingResult);

    if (spendingResult.blocked) {
      return {
        stageResults,
        hardBlocked: true,
        blockingStage: "spending-graph",
      };
    }

    return { stageResults, hardBlocked: false };
  }
}
