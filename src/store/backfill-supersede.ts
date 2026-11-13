/**
 * store/backfill-supersede.ts
 *
 * One-time backfill for spec spectre-scan-supersession (requirement 6).
 * Usage: npm run backfill:supersede [-- --apply]   (database: DB_PATH)
 *
 * Dry-run by default: the same writes run inside a transaction that is
 * rolled back, so the dry-run report is exactly what --apply would do and
 * nothing is written. Per (type, subject_id) the newest open row stays open
 * and older open rows become "superseded"; nothing is ever marked
 * "resolved" (the backfill cannot prove the latest scan completed). Decision
 * rows are migrated to the subject-keyed table. Aborts, changing nothing,
 * when the admin queue is non-empty or a decision's finding row is missing,
 * and refuses to claim success when the invariant fails.
 */

import Database from "better-sqlite3";
import { migrateDecisionsToSubjectKey, needsDecisionMigration } from "../attestation/SqliteDecisionStore.js";

export interface BackfillReport {
  applied: boolean;
  openBefore: number;
  openAfter: number;
  distinctSubjects: number;
  superseded: number;
  decisionsMigrated: number;
}

class DryRunRollback extends Error {}

const count = (db: Database.Database, sql: string): number =>
  (db.prepare(sql).get() as { n: number }).n;

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

export function runBackfill(db: Database.Database, apply: boolean): BackfillReport {
  if (tableExists(db, "attestation_admin_queue") && count(db, "SELECT COUNT(*) AS n FROM attestation_admin_queue") > 0) {
    throw new Error("backfill aborted: the admin queue is not empty; this script does not guess what to do with queued rows");
  }
  let report: BackfillReport | undefined;
  const work = db.transaction(() => {
    const openBefore = count(db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'open'");
    const distinctSubjects = count(
      db,
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT type, subject_id FROM findings WHERE status = 'open')",
    );
    // Newest open row per (type, subject_id): latest scan, then latest updated_at, then rowid.
    const superseded = db
      .prepare(
        `UPDATE findings SET status = 'superseded'
         WHERE status = 'open' AND rowid NOT IN (
           SELECT (SELECT f2.rowid FROM findings f2
                   WHERE f2.status = 'open' AND f2.type = g.type AND f2.subject_id = g.subject_id
                   ORDER BY f2.scan_timestamp DESC, f2.updated_at DESC, f2.rowid DESC LIMIT 1)
           FROM (SELECT DISTINCT type, subject_id FROM findings WHERE status = 'open') g
         )`,
      )
      .run().changes;
    const decisionsMigrated = tableExists(db, "attestation_decisions") && needsDecisionMigration(db)
      ? migrateDecisionsToSubjectKey(db)
      : 0;
    const openAfter = count(db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'open'");
    if (openAfter !== distinctSubjects || superseded !== openBefore - openAfter) {
      throw new Error(
        `backfill invariant failed, nothing written: open before ${openBefore}, open after ${openAfter}, ` +
          `distinct subjects ${distinctSubjects}, superseded ${superseded}`,
      );
    }
    report = { applied: apply, openBefore, openAfter, distinctSubjects, superseded, decisionsMigrated };
    if (!apply) throw new DryRunRollback();
  });
  try {
    work();
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report as BackfillReport;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const dbPath = process.env["DB_PATH"] ?? "./spectre.db";
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const r = runBackfill(db, apply);
    const verb = r.applied ? "applied" : "dry-run (nothing written; pass --apply to write)";
    console.log(`[backfill] ${verb} on ${dbPath}`);
    console.log(`[backfill] open before: ${r.openBefore}`);
    console.log(`[backfill] open after: ${r.openAfter} (distinct subjects: ${r.distinctSubjects})`);
    console.log(`[backfill] superseded: ${r.superseded}`);
    console.log(`[backfill] decisions migrated: ${r.decisionsMigrated}`);
    console.log("[backfill] invariant holds: open after equals distinct subjects; superseded equals open before minus open after");
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[backfill] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
