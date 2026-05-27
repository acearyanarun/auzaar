import type Database from "better-sqlite3";
import type { SpendingGraphStore, AgentSpendingProfile } from "./spending-graph.js";

export class SqliteSpendingGraphStore implements SpendingGraphStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spending_profiles (
        agent_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async getProfile(agentId: string): Promise<AgentSpendingProfile | null> {
    const row = this.db
      .prepare("SELECT data FROM spending_profiles WHERE agent_id = ?")
      .get(agentId) as { data: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data) as AgentSpendingProfile;
  }

  async saveProfile(profile: AgentSpendingProfile): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO spending_profiles (agent_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(profile.agentId, JSON.stringify(profile), new Date().toISOString());
  }
}
