import type { OperatorFeedback } from "./collector.js";

export interface TrainingExample {
  input: {
    transactionContext: Record<string, unknown>;
    mandateId: string;
    agentId: string;
    vendor: string;
    product: string;
    amount: number;
    category?: string;
    compositeScore: number;
    stageScores: Record<string, number>;
  };
  label: "approved" | "rejected";
  operatorReason?: string;
  timestamp: string;
}

export interface TrainingDataStore {
  append(examples: TrainingExample[]): Promise<void>;
  getAll(): Promise<TrainingExample[]>;
  getCount(): Promise<number>;
  clear(): Promise<void>;
}

export class TrainingDataFormatter {
  constructor(private readonly store: TrainingDataStore) {}

  async formatAndStore(feedbacks: OperatorFeedback[]): Promise<number> {
    const examples: TrainingExample[] = feedbacks.map((fb) => {
      const stageScores: Record<string, number> = {};
      for (const stage of fb.originalDecision.stageResults) {
        stageScores[stage.stage] = stage.score;
      }

      return {
        input: {
          transactionContext: {
            vendor: fb.originalRequest.transaction.vendor,
            product: fb.originalRequest.transaction.product,
            amount: fb.originalRequest.transaction.amount,
            category: fb.originalRequest.transaction.category,
            quantity: fb.originalRequest.transaction.quantity,
            currency: fb.originalRequest.transaction.currency,
          },
          mandateId: fb.originalRequest.mandateId,
          agentId: fb.originalRequest.agentId,
          vendor: fb.originalRequest.transaction.vendor,
          product: fb.originalRequest.transaction.product,
          amount: fb.originalRequest.transaction.amount,
          category: fb.originalRequest.transaction.category,
          compositeScore: fb.originalDecision.compositeScore,
          stageScores,
        },
        label: fb.action === "approved" ? "approved" : "rejected",
        operatorReason: fb.reason,
        timestamp: fb.timestamp,
      };
    });

    await this.store.append(examples);
    return examples.length;
  }

  async exportForFineTuning(): Promise<TrainingExample[]> {
    return this.store.getAll();
  }

  async getDatasetSize(): Promise<number> {
    return this.store.getCount();
  }
}

export class InMemoryTrainingDataStore implements TrainingDataStore {
  private readonly examples: TrainingExample[] = [];

  async append(examples: TrainingExample[]): Promise<void> {
    this.examples.push(...examples);
  }

  async getAll(): Promise<TrainingExample[]> {
    return [...this.examples];
  }

  async getCount(): Promise<number> {
    return this.examples.length;
  }

  async clear(): Promise<void> {
    this.examples.length = 0;
  }
}
