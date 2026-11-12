/**
 * store/SqliteFindingStore.ts
 *
 * SQLite-backed implementation of FindingStore, used for the demo.
 * Uses better-sqlite3 (synchronous API) so there is no connection pool to
 * manage and the demo stays single-process.
 *
 * Schema notes:
 *   - `numbers` is stored as a JSON text column; the full Graph payload is
 *     never truncated or summarised — it is stored verbatim.
 *   - `owner` is nullable; NULL in the DB means Graph returned no owner.
 *   - Rows are never deleted; status transitions are append-friendly.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { FindingStore } from "./FindingStore.js";
import type { Finding, FindingNumbers, FindingStatus, GhostType, NewFinding } from "./types.js";

/** SQLite row shape, as returned by better-sqlite3. */
interface FindingRow {
  id: string;
  type: string;
  subject_id: string;
  subject_label: string | null;
  owner: string | null;
  numbers: string; // JSON text
  severity_weight: number;
  status: string;
  scan_timestamp: string;
  updated_at: string;
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    type: row.type as GhostType,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    owner: row.owner,
    numbers: JSON.parse(row.numbers) as FindingNumbers,
    severityWeight: row.severity_weight,
    status: row.status as FindingStatus,
    scanTimestamp: row.scan_timestamp,
    updatedAt: row.updated_at,
  };
}

export class SqliteFindingStore implements FindingStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  /** Idempotent schema migration — safe to call on every startup. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        subject_id     TEXT NOT NULL,
        subject_label  TEXT,
        owner          TEXT,
        numbers        TEXT NOT NULL,
        severity_weight REAL NOT NULL,
        status         TEXT NOT NULL DEFAULT 'open',
        scan_timestamp TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_findings_scan
        ON findings (scan_timestamp);

      CREATE INDEX IF NOT EXISTS idx_findings_status_type
        ON findings (status, type);
    `);
  }

  async insert(finding: NewFinding): Promise<Finding> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO findings
           (id, type, subject_id, subject_label, owner, numbers,
            severity_weight, status, scan_timestamp, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(
        id,
        finding.type,
        finding.subjectId,
        finding.subjectLabel ?? null,
        finding.owner ?? null,
        JSON.stringify(finding.numbers),
        finding.severityWeight,
        finding.scanTimestamp,
        now
      );

    return {
      ...finding,
      id,
      status: "open",
      updatedAt: now,
    };
  }

  async updateStatus(
    id: string,
    status: FindingStatus
  ): Promise<Finding | null> {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(
        `UPDATE findings SET status = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, now, id);

    if (result.changes === 0) {
      return null;
    }

    return this.getById(id);
  }

  async listByScan(scanTimestamp: string): Promise<Finding[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM findings WHERE scan_timestamp = ? ORDER BY updated_at ASC`
      )
      .all(scanTimestamp) as FindingRow[];

    return rows.map(rowToFinding);
  }

  async listOpen(type?: string): Promise<Finding[]> {
    const rows =
      type !== undefined
        ? (this.db
            .prepare(
              `SELECT * FROM findings WHERE status = 'open' AND type = ?
               ORDER BY scan_timestamp DESC`
            )
            .all(type) as FindingRow[])
        : (this.db
            .prepare(
              `SELECT * FROM findings WHERE status = 'open'
               ORDER BY scan_timestamp DESC`
            )
            .all() as FindingRow[]);

    return rows.map(rowToFinding);
  }

  async getById(id: string): Promise<Finding | null> {
    const row = this.db
      .prepare(`SELECT * FROM findings WHERE id = ?`)
      .get(id) as FindingRow | undefined;

    return row ? rowToFinding(row) : null;
  }

  async latestScanTimestamp(): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT scan_timestamp FROM findings
         ORDER BY scan_timestamp DESC LIMIT 1`
      )
      .get() as { scan_timestamp: string } | undefined;

    return row?.scan_timestamp ?? null;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
