/**
 * attestation/SqliteDecisionStore.ts
 *
 * Persistent DecisionStore in the same SQLite file as the findings, so a
 * restart keeps every recorded decision (including Keep suppressions).
 * One row per ghost, PRIMARY KEY (type, subject_id); a failed write throws
 * (not acknowledged), and so does a second decision while one is active.
 */

import Database from "better-sqlite3";
import { isDecisionActive, type DecisionRecord, type DecisionStore } from "./decision.js";
import type { AttestationAction } from "./card.js";
import type { GhostType } from "../store/types.js";

const COLUMNS = "finding_id, type, subject_id, owner, action, decided_at, accepted_until";

const CREATE_SQL = (name: string) => `
  CREATE TABLE ${name} (
    finding_id TEXT NOT NULL, type TEXT NOT NULL, subject_id TEXT NOT NULL,
    owner TEXT NOT NULL, action TEXT NOT NULL, decided_at TEXT NOT NULL, accepted_until TEXT,
    PRIMARY KEY (type, subject_id)
  )`;

/** True when attestation_decisions still has the old per-finding key. */
export function needsDecisionMigration(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(attestation_decisions)").all() as { name: string }[];
  return cols.length > 0 && !cols.some((c) => c.name === "subject_id");
}

/**
 * Migrates attestation_decisions from PRIMARY KEY (finding_id) to
 * PRIMARY KEY (type, subject_id): create new, copy with a join to findings,
 * drop old, rename, in one transaction. Throws (and changes nothing) when a
 * decision's finding row is missing. Returns the number of rows migrated;
 * 0 when there is nothing to migrate.
 */
export function migrateDecisionsToSubjectKey(db: Database.Database): number {
  if (!needsDecisionMigration(db)) return 0;
  return db.transaction(() => {
    const missing = db
      .prepare(
        `SELECT d.finding_id FROM attestation_decisions d
         LEFT JOIN findings f ON f.id = d.finding_id WHERE f.id IS NULL`,
      )
      .all() as { finding_id: string }[];
    if (missing.length > 0) {
      throw new Error(
        `decision migration aborted: no finding row for decision(s) ${missing.map((m) => m.finding_id).join(", ")}`,
      );
    }
    db.exec(CREATE_SQL("attestation_decisions_new"));
    const info = db
      .prepare(
        `INSERT INTO attestation_decisions_new (${COLUMNS})
         SELECT d.finding_id, f.type, f.subject_id, d.owner, d.action, d.decided_at, d.accepted_until
         FROM attestation_decisions d JOIN findings f ON f.id = d.finding_id`,
      )
      .run();
    db.exec("DROP TABLE attestation_decisions; ALTER TABLE attestation_decisions_new RENAME TO attestation_decisions");
    return info.changes;
  })();
}

interface Row {
  finding_id: string;
  type: string;
  subject_id: string;
  owner: string;
  action: string;
  decided_at: string;
  accepted_until: string | null;
}

const toRecord = (r: Row): DecisionRecord => ({
  findingId: r.finding_id,
  type: r.type as GhostType,
  subjectId: r.subject_id,
  owner: r.owner,
  action: r.action as AttestationAction,
  decidedAt: r.decided_at,
  acceptedUntil: r.accepted_until,
});

export class SqliteDecisionStore implements DecisionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    migrateDecisionsToSubjectKey(this.db);
    this.db.exec(`${CREATE_SQL("IF NOT EXISTS attestation_decisions")}`);
  }

  async get(findingId: string): Promise<DecisionRecord | null> {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM attestation_decisions WHERE finding_id = ?`)
      .get(findingId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  async getBySubject(type: GhostType, subjectId: string): Promise<DecisionRecord | null> {
    const r = this.db
      .prepare(`SELECT ${COLUMNS} FROM attestation_decisions WHERE type = ? AND subject_id = ?`)
      .get(type, subjectId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  /** Plain insert: throws on conflict. Only an expired Keep is replaced first. */
  async put(record: DecisionRecord): Promise<void> {
    this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT ${COLUMNS} FROM attestation_decisions WHERE type = ? AND subject_id = ?`)
        .get(record.type, record.subjectId) as Row | undefined;
      if (existing && !isDecisionActive(toRecord(existing), new Date(record.decidedAt))) {
        this.db
          .prepare("DELETE FROM attestation_decisions WHERE type = ? AND subject_id = ?")
          .run(record.type, record.subjectId);
      }
      this.db
        .prepare(`INSERT INTO attestation_decisions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.findingId, record.type, record.subjectId, record.owner,
          record.action, record.decidedAt, record.acceptedUntil,
        );
    })();
  }
}
