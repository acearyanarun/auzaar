import type { GovernanceDecision, GovernanceRequest } from "@auzaar/core";
import type { MandateService } from "@auzaar/mandate-service";
import type { GovernanceEngine, GovernanceEventWriter, SpendingGraph } from "@auzaar/governance-engine";
import type { ProtocolRouter } from "@auzaar/protocol-release";
import type { AgentRegistry } from "@auzaar/agent-registry";
import type { FeedbackCollector } from "@auzaar/feedback-pipeline";

/**
 * SEC-19: Bounded LRU Map that evicts the least-recently-used entry when the
 * maximum capacity is exceeded. Prevents the in-memory decision and request
 * maps from growing without bound in long-running processes.
 *
 * LRU semantics are approximated via Map insertion order: on each `set` the
 * key is moved to the end, so the first key is always the oldest/LRU entry.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  constructor(maxSize: number = 10_000) {
    super();
    this.maxSize = maxSize;
  }

  override set(key: K, value: V): this {
    // Move existing key to end (most-recently-used position)
    if (this.has(key)) {
      super.delete(key);
    } else if (this.size >= this.maxSize) {
      // Evict the oldest (first) entry
      const oldestKey = this.keys().next().value as K;
      super.delete(oldestKey);
    }
    return super.set(key, value);
  }
}

export interface AuzaarContext {
  mandateService: MandateService;
  governanceEngine: GovernanceEngine;
  eventWriter?: GovernanceEventWriter;
  protocolRouter?: ProtocolRouter;
  agentRegistry?: AgentRegistry;
  feedbackCollector?: FeedbackCollector;
  spendingGraph?: SpendingGraph;
  decisions: Map<string, GovernanceDecision>;
  requests: Map<string, GovernanceRequest>;
}
