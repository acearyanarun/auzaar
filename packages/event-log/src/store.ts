import type { EventLogEntry, EventType } from "@auzaar/core";

export interface EventQueryFilter {
  startTime?: string;
  endTime?: string;
  agentId?: string;
  userId?: string;
  eventType?: EventType;
  requestId?: string;
  limit?: number;
  offset?: number;
}

export interface EventStore {
  append(entry: EventLogEntry): Promise<void>;
  getById(id: string): Promise<EventLogEntry | null>;
  getLastEntry(): Promise<EventLogEntry | null>;
  query(filter: EventQueryFilter): Promise<EventLogEntry[]>;
}

export class InMemoryEventStore implements EventStore {
  private readonly entries: EventLogEntry[] = [];

  async append(entry: EventLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async getById(id: string): Promise<EventLogEntry | null> {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  async getLastEntry(): Promise<EventLogEntry | null> {
    if (this.entries.length === 0) {
      return null;
    }
    return this.entries[this.entries.length - 1]!;
  }

  async query(filter: EventQueryFilter): Promise<EventLogEntry[]> {
    let results = this.entries.filter((entry) => {
      if (filter.startTime && entry.timestamp < filter.startTime) {
        return false;
      }
      if (filter.endTime && entry.timestamp > filter.endTime) {
        return false;
      }
      if (filter.agentId && entry.agentId !== filter.agentId) {
        return false;
      }
      if (filter.userId && entry.userId !== filter.userId) {
        return false;
      }
      if (filter.eventType && entry.eventType !== filter.eventType) {
        return false;
      }
      if (filter.requestId && entry.requestId !== filter.requestId) {
        return false;
      }
      return true;
    });

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? results.length;
    results = results.slice(offset, offset + limit);

    return results;
  }
}
