import type { OperatorFeedback } from "./collector.js";

export interface SpendingBaseline {
  agentId: string;
  averageAmount: number;
  standardDeviation: number;
  transactionCount: number;
  lastUpdated: string;
  categoryAverages: Record<string, number>;
  vendorFrequency: Record<string, number>;
}

export interface SpendingBaselineStore {
  get(agentId: string): Promise<SpendingBaseline | null>;
  save(baseline: SpendingBaseline): Promise<void>;
}

export class GraphUpdater {
  constructor(private readonly store: SpendingBaselineStore) {}

  async updateFromFeedback(feedback: OperatorFeedback): Promise<void> {
    // Only update baselines from approved transactions (confirmed good behavior)
    if (feedback.action !== "approved") return;

    const { agentId } = feedback.originalRequest;
    const { amount, category, vendor } = feedback.originalRequest.transaction;

    const existing = await this.store.get(agentId);

    if (!existing) {
      // Create new baseline
      const baseline: SpendingBaseline = {
        agentId,
        averageAmount: amount,
        standardDeviation: 0,
        transactionCount: 1,
        lastUpdated: new Date().toISOString(),
        categoryAverages: category ? { [category]: amount } : {},
        vendorFrequency: { [vendor]: 1 },
      };
      await this.store.save(baseline);
      return;
    }

    // Incremental update using Welford's online algorithm
    const n = existing.transactionCount + 1;
    const oldMean = existing.averageAmount;
    const newMean = oldMean + (amount - oldMean) / n;

    // Update standard deviation using Welford's method
    // We store M2 = variance * (n-1) implicitly
    const oldVariance = existing.standardDeviation ** 2;
    const oldM2 = oldVariance * (existing.transactionCount - 1 || 1);
    const newM2 = oldM2 + (amount - oldMean) * (amount - newMean);
    const newStdDev = n > 1 ? Math.sqrt(newM2 / (n - 1)) : 0;

    // Update category averages
    const categoryAverages = { ...existing.categoryAverages };
    if (category) {
      const catAvg = categoryAverages[category] ?? 0;
      const catCount =
        Object.values(existing.vendorFrequency).reduce((a, b) => a + b, 0) || 1;
      categoryAverages[category] = catAvg + (amount - catAvg) / (catCount + 1);
    }

    // Update vendor frequency
    const vendorFrequency = { ...existing.vendorFrequency };
    vendorFrequency[vendor] = (vendorFrequency[vendor] ?? 0) + 1;

    const updated: SpendingBaseline = {
      agentId,
      averageAmount: newMean,
      standardDeviation: newStdDev,
      transactionCount: n,
      lastUpdated: new Date().toISOString(),
      categoryAverages,
      vendorFrequency,
    };

    await this.store.save(updated);
  }

  async updateBatch(feedbacks: OperatorFeedback[]): Promise<number> {
    let updated = 0;
    for (const feedback of feedbacks) {
      await this.updateFromFeedback(feedback);
      if (feedback.action === "approved") updated++;
    }
    return updated;
  }

  async getBaseline(agentId: string): Promise<SpendingBaseline | null> {
    return this.store.get(agentId);
  }
}

export class InMemorySpendingBaselineStore implements SpendingBaselineStore {
  private readonly baselines = new Map<string, SpendingBaseline>();

  async get(agentId: string): Promise<SpendingBaseline | null> {
    return this.baselines.get(agentId) ?? null;
  }

  async save(baseline: SpendingBaseline): Promise<void> {
    this.baselines.set(baseline.agentId, baseline);
  }
}
