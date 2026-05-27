import type { GovernanceRequest, StageResult, Policy, PolicyRule } from "@auzaar/core";

export class RulesEngine {
  private readonly policies: Policy[];

  constructor(policies: Policy[]) {
    this.policies = policies;
  }

  evaluate(request: GovernanceRequest): StageResult {
    const matchedRules: string[] = [];
    let blocked = false;
    let softViolationCount = 0;

    const applicablePolicies = this.getApplicablePolicies(request);

    for (const policy of applicablePolicies) {
      for (const rule of policy.rules) {
        if (!rule.enabled) continue;

        const result = this.evaluateRule(rule, request);
        if (result.matched) {
          matchedRules.push(rule.id);
          if (result.blocks) {
            blocked = true;
          } else {
            softViolationCount++;
          }
        }
      }
    }

    const score = blocked ? 1.0 : Math.min(softViolationCount * 0.2, 0.9);

    return {
      stage: "rules-engine",
      passed: !blocked,
      score,
      matchedRules,
      blocked,
      explanation: blocked
        ? `Blocked by rules: ${matchedRules.join(", ")}`
        : matchedRules.length > 0
          ? `Soft matches: ${matchedRules.join(", ")}`
          : "No rules matched",
    };
  }

  private getApplicablePolicies(request: GovernanceRequest): Policy[] {
    return this.policies.filter((policy) => {
      if (!policy.enabled) return false;
      if (!policy.appliesTo) return true;

      const { userIds, agentIds } = policy.appliesTo;

      if (userIds && userIds.length > 0 && !userIds.includes(request.userId)) {
        return false;
      }
      if (agentIds && agentIds.length > 0 && !agentIds.includes(request.agentId)) {
        return false;
      }

      return true;
    });
  }

  private evaluateRule(
    rule: PolicyRule,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    switch (rule.type) {
      case "spending_limit":
        return this.evaluateSpendingLimit(rule, request);
      case "vendor_allowlist":
        return this.evaluateVendorAllowlist(rule, request);
      case "vendor_blocklist":
        return this.evaluateVendorBlocklist(rule, request);
      case "category_restriction":
        return this.evaluateCategoryRestriction(rule, request);
      case "quantity_limit":
        return this.evaluateQuantityLimit(rule, request);
      case "temporal_rule":
        return this.evaluateTemporalRule(rule, request);
      default: {
        const _exhaustive: never = rule;
        return { matched: false, blocks: false };
      }
    }
  }

  private evaluateSpendingLimit(
    rule: Extract<PolicyRule, { type: "spending_limit" }>,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    if (rule.period !== "per_transaction") {
      // Phase 1: only per_transaction is supported; others require aggregation
      return { matched: false, blocks: false };
    }
    if (request.transaction.amount > rule.maxAmount) {
      return { matched: true, blocks: true };
    }
    return { matched: false, blocks: false };
  }

  private evaluateVendorAllowlist(
    rule: Extract<PolicyRule, { type: "vendor_allowlist" }>,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    const vendorLower = request.transaction.vendor.toLowerCase();
    const allowed = rule.vendors.some((v) => v.toLowerCase() === vendorLower);
    if (!allowed) {
      return { matched: true, blocks: true };
    }
    return { matched: false, blocks: false };
  }

  private evaluateVendorBlocklist(
    rule: Extract<PolicyRule, { type: "vendor_blocklist" }>,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    const vendorLower = request.transaction.vendor.toLowerCase();
    const isBlocked = rule.vendors.some((v) => v.toLowerCase() === vendorLower);
    if (isBlocked) {
      return { matched: true, blocks: true };
    }
    return { matched: false, blocks: false };
  }

  private evaluateCategoryRestriction(
    rule: Extract<PolicyRule, { type: "category_restriction" }>,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    const category = request.transaction.category;
    if (!category) {
      // No category on transaction; if allowedCategories is set, block
      if (rule.allowedCategories && rule.allowedCategories.length > 0) {
        return { matched: true, blocks: true };
      }
      return { matched: false, blocks: false };
    }

    const categoryLower = category.toLowerCase();

    if (rule.blockedCategories && rule.blockedCategories.length > 0) {
      const isBlocked = rule.blockedCategories.some(
        (c) => c.toLowerCase() === categoryLower
      );
      if (isBlocked) {
        return { matched: true, blocks: true };
      }
    }

    if (rule.allowedCategories && rule.allowedCategories.length > 0) {
      const isAllowed = rule.allowedCategories.some(
        (c) => c.toLowerCase() === categoryLower
      );
      if (!isAllowed) {
        return { matched: true, blocks: true };
      }
    }

    return { matched: false, blocks: false };
  }

  private evaluateQuantityLimit(
    rule: Extract<PolicyRule, { type: "quantity_limit" }>,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    if (request.transaction.quantity > rule.maxQuantity) {
      return { matched: true, blocks: true };
    }
    return { matched: false, blocks: false };
  }

  private evaluateTemporalRule(
    rule: Extract<PolicyRule, { type: "temporal_rule" }>,
    request: GovernanceRequest
  ): { matched: boolean; blocks: boolean } {
    const txDate = new Date(request.transaction.timestamp);

    if (rule.allowedDays && rule.allowedDays.length > 0) {
      const day = txDate.getUTCDay();
      if (!rule.allowedDays.includes(day)) {
        return { matched: true, blocks: true };
      }
    }

    if (
      rule.allowedHoursStart !== undefined &&
      rule.allowedHoursEnd !== undefined
    ) {
      const hour = txDate.getUTCHours();
      if (hour < rule.allowedHoursStart || hour > rule.allowedHoursEnd) {
        return { matched: true, blocks: true };
      }
    }

    return { matched: false, blocks: false };
  }
}
