import { z } from "zod";

export const TransactionSchema = z.object({
  id: z.string().min(1),
  mandateId: z.string().min(1),
  agentId: z.string().min(1),
  userId: z.string().min(1),
  vendor: z.string().min(1),
  product: z.string().min(1),
  category: z.string().optional(),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  quantity: z.number().int().positive().default(1),
  metadata: z.record(z.unknown()).optional(),
  targetProtocol: z.enum(["acp", "ucp", "ap2", "direct"]).optional(),
  targetUrl: z.string().url().optional(),
  timestamp: z.string().datetime(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export const GovernanceRequestSchema = z.object({
  requestId: z.string().min(1),
  transaction: TransactionSchema,
  mandateId: z.string().min(1),
  agentId: z.string().min(1),
  userId: z.string().min(1),
  timestamp: z.string().datetime(),
});

export type GovernanceRequest = z.infer<typeof GovernanceRequestSchema>;

export const StageResultSchema = z.object({
  stage: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  matchedRules: z.array(z.string()).optional(),
  explanation: z.string().optional(),
  blocked: z.boolean().default(false),
});

export type StageResult = z.infer<typeof StageResultSchema>;

export const GovernanceDecisionSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["approved", "flagged", "blocked"]),
  compositeScore: z.number().min(0).max(1),
  stageResults: z.array(StageResultSchema),
  explanation: z.string(),
  decidedAt: z.string().datetime(),
  latencyMs: z.number().nonnegative(),
});

export type GovernanceDecision = z.infer<typeof GovernanceDecisionSchema>;
