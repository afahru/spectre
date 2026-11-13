/**
 * attestation/SqliteAdminQueue.ts
 *
 * Persistent AdminQueue in the same SQLite file as the findings, so
 * escalations survive a restart. One row per finding; enqueue is idempotent.
 */

import Database from "better-sqlite3";
import type { AdminQueue } from "./nudge.js";
import type { ExceptionReason } from "./recipient.js";
import type { GhostType } from "../store/types.js";

export interface AdminQueueEntry {
  findingId: string;
  reason: ExceptionReason;
  error: string | null;
  /** ISO 8601 time the entry was queued. */
  queuedAt: string;
}

export class SqliteAdminQueue implements AdminQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attestation_admin_queue (
        finding_id TEXT PRIMARY KEY, reason TEXT NOT NULL, error TEXT, queued_at TEXT NOT NULL
      );
    `);
  }

  async has(findingId: string): Promise<boolean> {
    return this.db.prepare("SELECT 1 FROM attestation_admin_queue WHERE finding_id = ?").get(findingId) !== undefined;
  }

  /** Joins to findings (rows are never deleted), so a queue entry under an old row still counts. */
  async hasBySubject(type: GhostType, subjectId: string): Promise<boolean> {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM attestation_admin_queue q JOIN findings f ON f.id = q.finding_id
           WHERE f.type = ? AND f.subject_id = ?`,
        )
        .get(type, subjectId) !== undefined
    );
  }

  async enqueue(entry: { findingId: string; reason: ExceptionReason; error?: string }): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO attestation_admin_queue (finding_id, reason, error, queued_at) VALUES (?, ?, ?, ?)"
      )
      .run(entry.findingId, entry.reason, entry.error ?? null, new Date().toISOString());
  }

  /** Every queued entry, oldest first (for the console). */
  async list(): Promise<AdminQueueEntry[]> {
    const rows = this.db
      .prepare("SELECT finding_id, reason, error, queued_at FROM attestation_admin_queue ORDER BY queued_at")
      .all() as { finding_id: string; reason: string; error: string | null; queued_at: string }[];
    return rows.map((r) => ({
      findingId: r.finding_id,
      reason: r.reason as ExceptionReason,
      error: r.error,
      queuedAt: r.queued_at,
    }));
  }
}
