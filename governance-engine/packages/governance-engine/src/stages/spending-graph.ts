import type { GovernanceRequest, StageResult } from "@auzaar/core";

export interface SpendingRecord {
  agentId: string;
  amount: number;
  category?: string;
  vendor: string;
  timestamp: string;
}

export interface AgentSpendingProfile {
  agentId: string;
  transactionCount: number;
  totalSpent: number;
  mean: number;
  m2: number; // Sum of squared differences from the mean (Welford's)
  categoryMeans: Record<string, { mean: number; count: number; m2: number }>;
  vendorFrequency: Record<string, number>;
  recentAmounts: number[]; // Sliding window for short-term baseline
}

export interface SpendingGraphStore {
  getProfile(agentId: string): Promise<AgentSpendingProfile | null>;
  saveProfile(profile: AgentSpendingProfile): Promise<void>;
}

const RECENT_WINDOW_SIZE = 50;
const Z_SCORE_THRESHOLD = 2.5;
const CATEGORY_Z_THRESHOLD = 3.0;
const MIN_TRANSACTIONS_FOR_SCORING = 5;

export class SpendingGraph {
  constructor(private readonly store: SpendingGraphStore) {}

  async recordTransaction(record: SpendingRecord): Promise<void> {
    const existing = await this.store.getProfile(record.agentId);
    const profile = existing ?? createEmptyProfile(record.agentId);

    // Welford's online algorithm for running mean/variance
    const n = profile.transactionCount + 1;
    const delta = record.amount - profile.mean;
    const newMean = profile.mean + delta / n;
    const delta2 = record.amount - newMean;
    const newM2 = profile.m2 + delta * delta2;

    profile.transactionCount = n;
    profile.totalSpent += record.amount;
    profile.mean = newMean;
    profile.m2 = newM2;

    // Update category stats
    if (record.category) {
      const cat = profile.categoryMeans[record.category] ?? {
        mean: 0,
        count: 0,
        m2: 0,
      };
      const cn = cat.count + 1;
      const cd = record.amount - cat.mean;
      const cm = cat.mean + cd / cn;
      const cd2 = record.amount - cm;
      cat.m2 = cat.m2 + cd * cd2;
      cat.mean = cm;
      cat.count = cn;
      profile.categoryMeans[record.category] = cat;
    }

    // Vendor frequency
    profile.vendorFrequency[record.vendor] =
      (profile.vendorFrequency[record.vendor] ?? 0) + 1;

    // Sliding window
    profile.recentAmounts.push(record.amount);
    if (profile.recentAmounts.length > RECENT_WINDOW_SIZE) {
      profile.recentAmounts.shift();
    }

    await this.store.saveProfile(profile);
  }

  async evaluate(request: GovernanceRequest): Promise<StageResult> {
    const profile = await this.store.getProfile(request.agentId);

    if (
      !profile ||
      profile.transactionCount < MIN_TRANSACTIONS_FOR_SCORING
    ) {
      return {
        stage: "spending-graph",
        passed: true,
        score: 0,
        blocked: false,
        explanation: `Insufficient history (${profile?.transactionCount ?? 0}/${MIN_TRANSACTIONS_FOR_SCORING} transactions)`,
      };
    }

    const amount = request.transaction.amount;
    const category = request.transaction.category;
    const vendor = request.transaction.vendor;
    const signals: string[] = [];
    let maxScore = 0;

    // 1. Global z-score
    const globalStdDev = computeStdDev(profile.m2, profile.transactionCount);
    if (globalStdDev > 0) {
      const globalZ = Math.abs(amount - profile.mean) / globalStdDev;
      if (globalZ > Z_SCORE_THRESHOLD) {
        const zScore = Math.min(1, (globalZ - Z_SCORE_THRESHOLD) / 3);
        maxScore = Math.max(maxScore, zScore);
        signals.push(
          `Amount $${amount} is ${globalZ.toFixed(1)}σ from global mean $${profile.mean.toFixed(2)}`
        );
      }
    }

    // 2. Category z-score
    if (category && profile.categoryMeans[category]) {
      const cat = profile.categoryMeans[category];
      if (cat.count >= 3) {
        const catStdDev = computeStdDev(cat.m2, cat.count);
        if (catStdDev > 0) {
          const catZ = Math.abs(amount - cat.mean) / catStdDev;
          if (catZ > CATEGORY_Z_THRESHOLD) {
            const catScore = Math.min(1, (catZ - CATEGORY_Z_THRESHOLD) / 3);
            maxScore = Math.max(maxScore, catScore);
            signals.push(
              `Amount $${amount} is ${catZ.toFixed(1)}σ from category "${category}" mean $${cat.mean.toFixed(2)}`
            );
          }
        }
      }
    }

    // 3. New vendor penalty (never seen before)
    if (
      profile.transactionCount >= 10 &&
      !profile.vendorFrequency[vendor]
    ) {
      maxScore = Math.max(maxScore, 0.15);
      signals.push(`First transaction with vendor "${vendor}"`);
    }

    // 4. Short-term spike detection (recent window)
    if (profile.recentAmounts.length >= 5) {
      const recentMean =
        profile.recentAmounts.reduce((a, b) => a + b, 0) /
        profile.recentAmounts.length;
      const recentM2 = profile.recentAmounts.reduce(
        (sum, x) => sum + (x - recentMean) ** 2,
        0
      );
      const recentStdDev = Math.sqrt(recentM2 / profile.recentAmounts.length);
      if (recentStdDev > 0) {
        const recentZ = Math.abs(amount - recentMean) / recentStdDev;
        if (recentZ > Z_SCORE_THRESHOLD) {
          const recentScore = Math.min(
            1,
            (recentZ - Z_SCORE_THRESHOLD) / 3
          );
          maxScore = Math.max(maxScore, recentScore);
          signals.push(
            `Amount $${amount} is ${recentZ.toFixed(1)}σ from recent mean $${recentMean.toFixed(2)}`
          );
        }
      }
    }

    const passed = maxScore < 0.5;
    const explanation =
      signals.length > 0
        ? signals.join("; ")
        : "Transaction within normal spending patterns";

    return {
      stage: "spending-graph",
      passed,
      score: Math.round(maxScore * 1000) / 1000,
      blocked: maxScore >= 0.9,
      explanation,
    };
  }
}

export class InMemorySpendingGraphStore implements SpendingGraphStore {
  private readonly profiles = new Map<string, AgentSpendingProfile>();

  async getProfile(agentId: string): Promise<AgentSpendingProfile | null> {
    return this.profiles.get(agentId) ?? null;
  }

  async saveProfile(profile: AgentSpendingProfile): Promise<void> {
    this.profiles.set(profile.agentId, profile);
  }
}

function createEmptyProfile(agentId: string): AgentSpendingProfile {
  return {
    agentId,
    transactionCount: 0,
    totalSpent: 0,
    mean: 0,
    m2: 0,
    categoryMeans: {},
    vendorFrequency: {},
    recentAmounts: [],
  };
}

function computeStdDev(m2: number, count: number): number {
  if (count < 2) return 0;
  return Math.sqrt(m2 / (count - 1));
}

/**
 * Backward-compatible standalone function for use in pipeline when
 * no SpendingGraph instance is available.
 */
export function evaluateSpendingPattern(
  _request: GovernanceRequest
): StageResult {
  return {
    stage: "spending-graph",
    passed: true,
    score: 0,
    blocked: false,
    explanation: "No spending graph store configured",
  };
}
