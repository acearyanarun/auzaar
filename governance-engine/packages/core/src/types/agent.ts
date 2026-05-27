import { z } from "zod";

export const DelegationLinkSchema = z.object({
  delegatorId: z.string().min(1),
  delegateeId: z.string().min(1),
  scope: z.array(z.string()),
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  signature: z.string().min(1),
});

export type DelegationLink = z.infer<typeof DelegationLinkSchema>;

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  framework: z.string().optional(),
  authorizationScope: z.array(z.string()),
  delegationChain: z.array(DelegationLinkSchema),
  trustScore: z.number().min(0).max(1),
  status: z.enum(["active", "suspended", "revoked"]),
  registeredAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
});

export type Agent = z.infer<typeof AgentSchema>;
