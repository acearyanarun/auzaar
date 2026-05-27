import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventLogEntry } from "@auzaar/core";
import type { EventQueryFilter, EventStore } from "./store.js";

export class JsonFileEventStore implements EventStore {
  constructor(private readonly filePath: string) {}

  async append(entry: EventLogEntry): Promise<void> {
    const entries = await this.readAll();
    entries.push(entry);
    await this.writeAll(entries);
  }

  async getById(id: string): Promise<EventLogEntry | null> {
    const entries = await this.readAll();
    return entries.find((e) => e.id === id) ?? null;
  }

  async getLastEntry(): Promise<EventLogEntry | null> {
    const entries = await this.readAll();
    if (entries.length === 0) return null;
    return entries[entries.length - 1]!;
  }

  async query(filter: EventQueryFilter): Promise<EventLogEntry[]> {
    let results = (await this.readAll()).filter((entry) => {
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
    return results.slice(offset, offset + limit);
  }

  private async readAll(): Promise<EventLogEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as EventLogEntry[];
    } catch (e: unknown) {
      const code =
        e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") return [];
      throw e;
    }
  }

  private async writeAll(entries: EventLogEntry[]): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  }
}
