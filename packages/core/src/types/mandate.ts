import { z } from "zod";

export const StructuredIntentSchema = z.object({
  product: z.string().min(1),
  category: z.string().optional(),
  maxBudget: z.number().positive(),
  currency: z.string().default("USD"),
  vendorPreferences: z
    .object({
      allowlist: z.array(z.string()).optional(),
      blocklist: z.array(z.string()).optional(),
    })
    .optional(),
  quantity: z.number().int().positive().default(1),
  timing: z
    .object({
      notBefore: z.string().datetime().optional(),
      notAfter: z.string().datetime().optional(),
    })
    .optional(),
});

export type StructuredIntent = z.infer<typeof StructuredIntentSchema>;

export const MandateSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  intentText: z.string().min(1),
  structuredIntent: StructuredIntentSchema,
  constraints: z.record(z.unknown()).optional(),
  signature: z.string().min(1),
  version: z.number().int().positive(),
  previousVersionId: z.string().optional(),
  status: z.enum(["active", "amended", "revoked", "expired"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Mandate = z.infer<typeof MandateSchema>;
