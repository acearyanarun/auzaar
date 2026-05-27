import { z } from "zod";
import { GovernanceRequestSchema, GovernanceDecisionSchema } from "./governance.js";

export const EventTypeSchema = z.enum([
  "transaction_submitted",
  "governance_started",
  "stage_completed",
  "governance_decided",
  "operator_reviewed",
  "mandate_created",
  "mandate_amended",
  "mandate_revoked",
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const EventLogEntrySchema = z.object({
  id: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative(),
  eventType: EventTypeSchema,
  requestId: z.string().optional(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
  mandateId: z.string().optional(),
  request: GovernanceRequestSchema.optional(),
  decision: GovernanceDecisionSchema.optional(),
  data: z.record(z.unknown()).optional(),
  hash: z.string().min(1),
  previousHash: z.string(),
  timestamp: z.string().datetime(),
});

export type EventLogEntry = z.infer<typeof EventLogEntrySchema>;
