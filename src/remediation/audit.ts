/**
 * remediation/audit.ts
 *
 * Audit log: one entry per action executed. SQLite implementation uses its
 * own `audit_log` table; pass ":memory:" for tests.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AuditEntry, AuditResult, RemediationAction } from "./types.js";

export interface AuditLog {
  append(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry>;
  listByFinding(findingId: string): Promise<AuditEntry[]>;
}

interface AuditRow {
  id: string;
  finding_id: string;
  action: string;
  target: string;
  owner: string | null;
  timestamp: string;
  result: string;
  error: string | null;
  restore_path: string | null;
}

export class SqliteAuditLog implements AuditLog {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id           TEXT PRIMARY KEY,
        finding_id   TEXT NOT NULL,
        action       TEXT NOT NULL,
        target       TEXT NOT NULL,
        owner        TEXT,
        timestamp    TEXT NOT NULL,
        result       TEXT NOT NULL,
        error        TEXT,
        restore_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_finding
        ON audit_log (finding_id);
    `);
  }

  async append(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry> {
    const full: AuditEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO audit_log
           (id, finding_id, action, target, owner, timestamp, result, error, restore_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.findingId,
        full.action,
        full.target,
        full.owner,
        full.timestamp,
        full.result,
        full.error,
        full.restorePath
      );
    return full;
  }

  async listByFinding(findingId: string): Promise<AuditEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log WHERE finding_id = ? ORDER BY timestamp ASC, rowid ASC`
      )
      .all(findingId) as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      findingId: r.finding_id,
      action: r.action as RemediationAction,
      target: r.target,
      owner: r.owner,
      timestamp: r.timestamp,
      result: r.result as AuditResult,
      error: r.error,
      restorePath: r.restore_path,
    }));
  }

  close(): void {
    this.db.close();
  }
}
