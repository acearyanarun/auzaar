import type { Agent } from "@auzaar/core";

export interface TrustScoreFactors {
  successfulTransactions: number;
  flaggedTransactions: number;
  blockedTransactions: number;
  /** Account age in days */
  accountAge: number;
}

const WEIGHTS = {
  successRatio: 0.3,
  accountAge: 0.2,
} as const;

const BASE_SCORE = 0.5;
const ACCOUNT_AGE_MATURITY_DAYS = 365;

export function computeTrustScore(
  _agent: Agent,
  factors: TrustScoreFactors
): number {
  const totalTransactions =
    factors.successfulTransactions +
    factors.flaggedTransactions +
    factors.blockedTransactions;

  // Success ratio contribution: ranges from -0.3 to +0.3
  let successContribution = 0;
  if (totalTransactions > 0) {
    const successRatio = factors.successfulTransactions / totalTransactions;
    // Map [0, 1] to [-1, 1] then scale by weight
    successContribution = (successRatio * 2 - 1) * WEIGHTS.successRatio;
  }

  // Account age contribution: ranges from 0 to +0.2
  const ageRatio = Math.min(factors.accountAge / ACCOUNT_AGE_MATURITY_DAYS, 1);
  const ageContribution = ageRatio * WEIGHTS.accountAge;

  const score = BASE_SCORE + successContribution + ageContribution;

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}
