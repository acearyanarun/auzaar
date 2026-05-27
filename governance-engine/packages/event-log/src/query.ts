import type { EventLogEntry } from "@auzaar/core";
import { hashChain } from "@auzaar/core";
import type { EventStore, EventQueryFilter } from "./store.js";

export class QueryService {
  constructor(private readonly store: EventStore) {}

  async query(filter: EventQueryFilter): Promise<EventLogEntry[]> {
    return this.store.query(filter);
  }

  verifyChain(entries: EventLogEntry[]): boolean {
    if (entries.length === 0) {
      return true;
    }

    for (let i = 1; i < entries.length; i++) {
      const current = entries[i]!;
      const previous = entries[i - 1]!;

      if (current.previousHash !== previous.hash) {
        return false;
      }
    }

    // Verify each entry's hash is correct
    for (const entry of entries) {
      const contentToHash = JSON.stringify({
        id: entry.id,
        sequenceNumber: entry.sequenceNumber,
        eventType: entry.eventType,
        requestId: entry.requestId,
        agentId: entry.agentId,
        userId: entry.userId,
        mandateId: entry.mandateId,
        request: entry.request,
        decision: entry.decision,
        data: entry.data,
        timestamp: entry.timestamp,
      });

      const expectedHash = hashChain(entry.previousHash, contentToHash);
      if (entry.hash !== expectedHash) {
        return false;
      }
    }

    return true;
  }
}
