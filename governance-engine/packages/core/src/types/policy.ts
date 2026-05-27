import { z } from "zod";

export const PolicyRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("spending_limit"),
    id: z.string().min(1),
    maxAmount: z.number().positive(),
    currency: z.string().default("USD"),
    period: z.enum(["per_transaction", "daily", "weekly", "monthly"]).default("per_transaction"),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("vendor_allowlist"),
    id: z.string().min(1),
    vendors: z.array(z.string().min(1)),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("vendor_blocklist"),
    id: z.string().min(1),
    vendors: z.array(z.string().min(1)),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("category_restriction"),
    id: z.string().min(1),
    allowedCategories: z.array(z.string()).optional(),
    blockedCategories: z.array(z.string()).optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("quantity_limit"),
    id: z.string().min(1),
    maxQuantity: z.number().int().positive(),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("temporal_rule"),
    id: z.string().min(1),
    allowedDays: z.array(z.number().int().min(0).max(6)).optional(),
    allowedHoursStart: z.number().int().min(0).max(23).optional(),
    allowedHoursEnd: z.number().int().min(0).max(23).optional(),
    timezone: z.string().default("UTC"),
    enabled: z.boolean().default(true),
  }),
]);

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.array(PolicyRuleSchema),
  appliesTo: z
    .object({
      userIds: z.array(z.string()).optional(),
      agentIds: z.array(z.string()).optional(),
      categories: z.array(z.string()).optional(),
    })
    .optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Policy = z.infer<typeof PolicySchema>;
