/**
 * collector/progress.ts
 *
 * Resumable-collection progress store backed by SQLite.
 *
 * Design (from design.md "Correctness properties"):
 *   A scan is resumable: if it stops mid-run, the next run resumes from the
 *   last persisted page — it does not restart the inventory.
 *
 * One row per (collection, scanTimestamp). The row is upserted after every
 * successfully consumed page. When a collection finishes, `completed` is set
 * to 1 and `next_link` is cleared.
 *
 * The same SQLite database as the findings store is used so the demo stays
 * single-file. The `CollectorProgressStore` accepts the same `dbPath` and
 * creates its own `Database` handle — both handles share the same WAL.
 */

import Database from "better-sqlite3";
import type { CollectorProgress } from "./types.js";

export class CollectorProgressStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  /** Idempotent schema migration — safe to call on every startup. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collector_progress (
        collection      TEXT NOT NULL,
        scan_timestamp  TEXT NOT NULL,
        next_link       TEXT,
        completed       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (collection, scan_timestamp)
      );
    `);
  }

  /**
   * Returns the persisted progress for a collection in this scan run.
   * Returns null if no entry exists yet (fresh start for this collection).
   */
  get(collection: string, scanTimestamp: string): CollectorProgress | null {
    const row = this.db
      .prepare(
        `SELECT collection, scan_timestamp, next_link, completed
         FROM collector_progress
         WHERE collection = ? AND scan_timestamp = ?`
      )
      .get(collection, scanTimestamp) as
      | {
          collection: string;
          scan_timestamp: string;
          next_link: string | null;
          completed: number;
        }
      | undefined;

    if (!row) return null;

    return {
      collection: row.collection,
      scanTimestamp: row.scan_timestamp,
      nextLink: row.next_link,
      completed: row.completed === 1,
    };
  }

  /**
   * Upserts the next-link for a collection after a page is consumed.
   * Call with `nextLink = null, completed = true` when the collection finishes.
   */
  save(
    collection: string,
    scanTimestamp: string,
    nextLink: string | null,
    completed: boolean
  ): void {
    this.db
      .prepare(
        `INSERT INTO collector_progress (collection, scan_timestamp, next_link, completed)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (collection, scan_timestamp)
         DO UPDATE SET next_link = excluded.next_link,
                       completed = excluded.completed`
      )
      .run(collection, scanTimestamp, nextLink, completed ? 1 : 0);
  }

  /** Close the database handle. */
  close(): void {
    this.db.close();
  }
}
