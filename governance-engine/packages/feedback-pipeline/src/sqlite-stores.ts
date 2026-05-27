import type Database from "better-sqlite3";
import type { FeedbackStore, FeedbackQueryFilter, OperatorFeedback } from "./collector.js";
import type { TrainingDataStore, TrainingExample } from "./trainer.js";
import type { SpendingBaselineStore, SpendingBaseline } from "./graph-updater.js";

export class SqliteFeedbackStore implements FeedbackStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_feedback (
        request_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_feedback_operator ON operator_feedback(operator_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_feedback_action ON operator_feedback(action)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON operator_feedback(timestamp)
    `);
  }

  async save(feedback: OperatorFeedback): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO operator_feedback (request_id, data, operator_id, action, timestamp)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           data = excluded.data,
           operator_id = excluded.operator_id,
           action = excluded.action,
           timestamp = excluded.timestamp`
      )
      .run(
        feedback.requestId,
        JSON.stringify(feedback),
        feedback.operatorId,
        feedback.action,
        feedback.timestamp
      );
  }

  async getByRequestId(requestId: string): Promise<OperatorFeedback | null> {
    const row = this.db
      .prepare("SELECT data FROM operator_feedback WHERE request_id = ?")
      .get(requestId) as { data: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data) as OperatorFeedback;
  }

  async query(filter: FeedbackQueryFilter): Promise<OperatorFeedback[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.operatorId) {
      conditions.push("operator_id = ?");
      params.push(filter.operatorId);
    }
    if (filter.action) {
      conditions.push("action = ?");
      params.push(filter.action);
    }
    if (filter.startTime) {
      conditions.push("timestamp >= ?");
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      conditions.push("timestamp <= ?");
      params.push(filter.endTime);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT data FROM operator_feedback ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ data: string }>;

    return rows.map((r) => JSON.parse(r.data) as OperatorFeedback);
  }
}

export class SqliteTrainingDataStore implements TrainingDataStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS training_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        label TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
  }

  async append(examples: TrainingExample[]): Promise<void> {
    const stmt = this.db.prepare(
      "INSERT INTO training_examples (data, label, timestamp) VALUES (?, ?, ?)"
    );
    const insertMany = this.db.transaction((exs: TrainingExample[]) => {
      for (const ex of exs) {
        stmt.run(JSON.stringify(ex), ex.label, ex.timestamp);
      }
    });
    insertMany(examples);
  }

  async getAll(): Promise<TrainingExample[]> {
    const rows = this.db
      .prepare("SELECT data FROM training_examples ORDER BY id")
      .all() as Array<{ data: string }>;

    return rows.map((r) => JSON.parse(r.data) as TrainingExample);
  }

  async getCount(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM training_examples")
      .get() as { count: number };

    return row.count;
  }

  async clear(): Promise<void> {
    this.db.exec("DELETE FROM training_examples");
  }
}

export class SqliteSpendingBaselineStore implements SpendingBaselineStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spending_baselines (
        agent_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async get(agentId: string): Promise<SpendingBaseline | null> {
    const row = this.db
      .prepare("SELECT data FROM spending_baselines WHERE agent_id = ?")
      .get(agentId) as { data: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.data) as SpendingBaseline;
  }

  async save(baseline: SpendingBaseline): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO spending_baselines (agent_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(baseline.agentId, JSON.stringify(baseline), baseline.lastUpdated);
  }
}
