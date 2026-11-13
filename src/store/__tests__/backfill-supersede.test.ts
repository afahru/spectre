import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SqliteFindingStore } from "../SqliteFindingStore.js";
import { runBackfill } from "../backfill-supersede.js";

const TYPES = ["overshared-site", "stale-guest"] as const;

/** Synthetic DB with the live shape: several scans, same subjects re-found each scan. */
async function seed(path: string, scans: number, subjects: number) {
  const store = new SqliteFindingStore(path);
  for (let s = 1; s <= scans; s++) {
    const ts = `2026-11-${String(s).padStart(2, "0")}T00:00:00.000Z`;
    for (let i = 0; i < subjects; i++) {
      await store.insert({
        type: TYPES[i % 2], subjectId: `subject-${i}`, subjectLabel: null, owner: null,
        numbers: {}, severityWeight: 1, scanTimestamp: ts,
      });
    }
  }
  await store.close();
}

const n = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const snapshot = (db: Database.Database) =>
  JSON.stringify(db.prepare("SELECT id, status FROM findings ORDER BY id").all());

function open(tmp: string) {
  const db = new Database(tmp);
  db.exec(`CREATE TABLE attestation_decisions (
    finding_id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL,
    decided_at TEXT NOT NULL, accepted_until TEXT)`);
  return db;
}

describe("backfill:supersede", () => {
  it("dry-run changes nothing, apply leaves one open row per subject, second run changes nothing", async () => {
    const path = `${process.env["TMPDIR"] ?? "/tmp"}/spectre-backfill-${process.pid}-${Date.now()}.db`;
    await seed(path, 13, 8);
    const db = open(path);
    const oldest = db.prepare("SELECT id FROM findings ORDER BY rowid LIMIT 1").get() as { id: string };
    db.prepare("INSERT INTO attestation_decisions VALUES (?, 'o@x', 'keep', '2026-11-13T00:00:00.000Z', NULL)").run(oldest.id);
    db.prepare("UPDATE findings SET status = 'dismissed' WHERE rowid = 2").run();
    const before = snapshot(db);

    const dry = runBackfill(db, false);
    assert.equal(snapshot(db), before);
    assert.equal(db.prepare("PRAGMA table_info(attestation_decisions)").all().length, 5);
    assert.equal(dry.openBefore, 13 * 8 - 1);
    assert.equal(dry.decisionsMigrated, 1);

    const applied = runBackfill(db, true);
    assert.deepEqual({ ...applied, applied: false }, dry);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'open'"), 8);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'resolved'"), 0);
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'dismissed'"), 1);
    assert.equal(
      n(db, "SELECT COUNT(*) AS n FROM (SELECT DISTINCT type, subject_id FROM findings WHERE status = 'open')"),
      8,
    );
    assert.equal(
      n(db, "SELECT COUNT(*) AS n FROM findings WHERE status = 'open' AND scan_timestamp <> '2026-11-13T00:00:00.000Z'"),
      0,
    );
    assert.equal(n(db, "SELECT COUNT(*) AS n FROM attestation_decisions WHERE subject_id IS NOT NULL"), 1);

    const after = snapshot(db);
    for (const apply of [false, true]) {
      const again = runBackfill(db, apply);
      assert.equal(again.superseded, 0);
      assert.equal(again.decisionsMigrated, 0);
      assert.equal(again.openBefore, again.openAfter);
      assert.equal(snapshot(db), after);
    }
    db.close();
  });

  it("aborts without writing when the admin queue is non-empty", async () => {
    const path = `${process.env["TMPDIR"] ?? "/tmp"}/spectre-backfill-q-${process.pid}-${Date.now()}.db`;
    await seed(path, 2, 2);
    const db = new Database(path);
    db.exec("CREATE TABLE attestation_admin_queue (finding_id TEXT PRIMARY KEY, reason TEXT NOT NULL, error TEXT, queued_at TEXT NOT NULL)");
    db.prepare("INSERT INTO attestation_admin_queue VALUES ('x', 'r', NULL, 't')").run();
    const before = snapshot(db);
    assert.throws(() => runBackfill(db, true), /admin queue is not empty/);
    assert.equal(snapshot(db), before);
    db.close();
  });

  it("aborts without writing when a decision's finding row is missing", async () => {
    const path = `${process.env["TMPDIR"] ?? "/tmp"}/spectre-backfill-d-${process.pid}-${Date.now()}.db`;
    await seed(path, 2, 2);
    const db = open(path);
    db.prepare("INSERT INTO attestation_decisions VALUES ('missing', 'o@x', 'keep', 't', NULL)").run();
    const before = snapshot(db);
    assert.throws(() => runBackfill(db, true), /no finding row/);
    assert.equal(snapshot(db), before);
    db.close();
  });
});
