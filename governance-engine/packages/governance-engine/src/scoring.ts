import type { StageResult } from "@auzaar/core";

const STAGE_WEIGHTS: Record<string, number> = {
  "rules-engine": 0.4,
  "threat-detection": 0.25,
  "intent-alignment": 0.2,
  "spending-graph": 0.15,
};

/**
 * Low-trust agents (below 0.3) get a penalty that increases the composite score.
 * High-trust agents (above 0.7) get a slight discount.
 * Trust score of 0.5 is neutral.
 */
const TRUST_PENALTY_WEIGHT = 0.15;

export function computeCompositeScore(
  results: StageResult[],
  agentTrustScore?: number
): number {
  if (results.length === 0) return 0;

  let totalWeight = 0;
  let weightedSum = 0;

  for (const result of results) {
    const weight = STAGE_WEIGHTS[result.stage] ?? 0.1;
    weightedSum += result.score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;

  let score = weightedSum / totalWeight;

  if (agentTrustScore !== undefined) {
    const trustModifier = (0.5 - agentTrustScore) * TRUST_PENALTY_WEIGHT;
    score += trustModifier;
  }

  return Math.min(1, Math.max(0, score));
}

export interface DecisionThresholds {
  autoApproveBelow: number;
  blockAbove: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  autoApproveBelow: 0.3,
  blockAbove: 0.8,
};

export function determineDecision(
  compositeScore: number,
  hardBlocked: boolean,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): "approved" | "flagged" | "blocked" {
  if (hardBlocked) return "blocked";
  if (compositeScore >= thresholds.blockAbove) return "blocked";
  if (compositeScore < thresholds.autoApproveBelow) return "approved";
  return "flagged";
}
