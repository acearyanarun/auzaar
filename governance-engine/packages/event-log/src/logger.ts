import type {
  EventLogEntry,
  EventType,
  GovernanceRequest,
  GovernanceDecision,
} from "@auzaar/core";
import {
  ok,
  err,
  StorageError,
  generateEventId,
  hashChain,
  sha256,
} from "@auzaar/core";
import type { Result } from "@auzaar/core";
import type { EventStore } from "./store.js";

export interface LogEventData {
  requestId?: string;
  agentId?: string;
  userId?: string;
  mandateId?: string;
  request?: GovernanceRequest;
  decision?: GovernanceDecision;
  data?: Record<string, unknown>;
}

export class EventLogger {
  private lastHash: string;
  private sequenceNumber: number;

  constructor(private readonly store: EventStore) {
    this.lastHash = sha256("genesis");
    this.sequenceNumber = 0;
  }

  async log(
    eventType: EventType,
    data: LogEventData
  ): Promise<Result<EventLogEntry>> {
    try {
      const last = await this.store.getLastEntry();
      if (last) {
        this.lastHash = last.hash;
        this.sequenceNumber = last.sequenceNumber + 1;
      } else {
        this.lastHash = sha256("genesis");
        this.sequenceNumber = 0;
      }

      const id = generateEventId();
      const sequenceNumber = this.sequenceNumber++;
      const timestamp = new Date().toISOString();
      const previousHash = this.lastHash;

      const contentToHash = JSON.stringify({
        id,
        sequenceNumber,
        eventType,
        requestId: data.requestId,
        agentId: data.agentId,
        userId: data.userId,
        mandateId: data.mandateId,
        request: data.request,
        decision: data.decision,
        data: data.data,
        timestamp,
      });

      const hash = hashChain(previousHash, contentToHash);

      const entry: EventLogEntry = {
        id,
        sequenceNumber,
        eventType,
        requestId: data.requestId,
        agentId: data.agentId,
        userId: data.userId,
        mandateId: data.mandateId,
        request: data.request,
        decision: data.decision,
        data: data.data,
        hash,
        previousHash,
        timestamp,
      };

      await this.store.append(entry);
      this.lastHash = hash;

      return ok(entry);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown storage error";
      return err(new StorageError(message));
    }
  }

  async getEntry(id: string): Promise<Result<EventLogEntry>> {
    try {
      const entry = await this.store.getById(id);
      if (!entry) {
        return err(
          new StorageError(`Event log entry not found: ${id}`, {
            entryId: id,
          })
        );
      }
      return ok(entry);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown storage error";
      return err(new StorageError(message));
    }
  }
}
