/**
 * attestation/SqliteDecisionStore.ts
 *
 * Persistent DecisionStore in the same SQLite file as the findings, so a
 * restart keeps every recorded decision (including Keep suppressions).
 * One row per finding; a failed write throws (not acknowledged).
 */

import Database from "better-sqlite3";
import type { DecisionRecord, DecisionStore } from "./decision.js";
import type { AttestationAction } from "./card.js";

export class SqliteDecisionStore implements DecisionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attestation_decisions (
        finding_id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL,
        decided_at TEXT NOT NULL, accepted_until TEXT
      );
    `);
  }

  async get(findingId: string): Promise<DecisionRecord | null> {
    const r = this.db
      .prepare(
        "SELECT finding_id, owner, action, decided_at, accepted_until FROM attestation_decisions WHERE finding_id = ?"
      )
      .get(findingId) as
      | { finding_id: string; owner: string; action: string; decided_at: string; accepted_until: string | null }
      | undefined;
    return r
      ? {
          findingId: r.finding_id,
          owner: r.owner,
          action: r.action as AttestationAction,
          decidedAt: r.decided_at,
          acceptedUntil: r.accepted_until,
        }
      : null;
  }

  async put(record: DecisionRecord): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO attestation_decisions (finding_id, owner, action, decided_at, accepted_until) VALUES (?, ?, ?, ?, ?)"
      )
      .run(record.findingId, record.owner, record.action, record.decidedAt, record.acceptedUntil);
  }
}
