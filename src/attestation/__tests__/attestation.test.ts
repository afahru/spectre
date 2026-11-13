/**
 * attestation/__tests__/attestation.test.ts
 *
 * Unit tests for the attestation loop: recipient resolution, narration,
 * card, decision handling, nudge clock and the SQLite decision store.
 * Fake data only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRecipient } from "../recipient.js";
import { narrate } from "../narration.js";
import { buildCard } from "../card.js";
import { createDecisionHandler, InMemoryDecisionStore, isDecisionActive, KEEP_SUPPRESS_DAYS } from "../decision.js";
import type { DecisionRecord } from "../decision.js";
import { runNudgeCheck } from "../nudge.js";
import type { AdminQueue, SendLog, SendRecord } from "../nudge.js";
import { SqliteDecisionStore } from "../SqliteDecisionStore.js";
import { SqliteAdminQueue } from "../SqliteAdminQueue.js";
import { SqliteDeliveryStore, deliverOpenFindings } from "../delivery.js";
import { SqliteFindingStore } from "../../store/index.js";
import Database from "better-sqlite3";
import type { FindingStore } from "../../store/FindingStore.js";
import type { Finding, FindingNumbers, FindingStatus, GhostType } from "../../store/types.js";
import type { Decision, DispatchResult } from "../../remediation/types.js";

const OWNER = "owner@example.com";
const DAY = 86_400_000;
const T0 = new Date("2026-11-12T00:00:00.000Z");

function makeFinding(
  id: string,
  type: GhostType,
  numbers: FindingNumbers = {},
  owner: string | null = OWNER,
): Finding {
  return {
    id,
    type,
    subjectId: `subject-${id}`,
    subjectLabel: `Label ${id}`,
    owner,
    numbers,
    severityWeight: 1,
    status: "open",
    scanTimestamp: T0.toISOString(),
    updatedAt: T0.toISOString(),
  };
}

function fakeStore(findings: Finding[]): FindingStore {
  const map = new Map(findings.map((f) => [f.id, { ...f }]));
  return {
    getById: async (id: string) => map.get(id) ?? null,
    listOpen: async () => [...map.values()].filter((f) => f.status === "open"),
    updateStatus: async (id: string, status: FindingStatus) => {
      const f = map.get(id);
      if (!f) return null;
      f.status = status;
      return { ...f };
    },
  } as unknown as FindingStore;
}

describe("resolveRecipient", () => {
  it("routes to the owner when one exists", () => {
    assert.deepEqual(resolveRecipient({ owner: OWNER }), { kind: "owner", upn: OWNER });
  });
  it("sends an ownerless finding to the admin queue", () => {
    assert.deepEqual(resolveRecipient({ owner: null }), { kind: "admin-queue", reason: "ownerless" });
  });
  it("sends an unreachable owner to the admin queue", () => {
    assert.deepEqual(resolveRecipient({ owner: OWNER }, () => false), {
      kind: "admin-queue",
      reason: "owner unreachable",
    });
  });
});

describe("narrate", () => {
  it("says anyone with the link can open an overshared site with an anonymous link", () => {
    const text = narrate(makeFinding("f1", "overshared-site", { linkScope: "anonymous" }));
    assert.match(text, /can be opened by anyone with the link/);
  });
  it("says an orphaned site has no owner", () => {
    assert.match(narrate(makeFinding("f2", "orphaned-site", {}, null)), /has no owner/);
  });
  it("says there is no sign-in record for a stale guest without one", () => {
    const text = narrate(makeFinding("f3", "stale-guest", { lastSignInAt: null }));
    assert.match(text, /no record of them signing in/);
  });
  it("quotes the idle licence cost verbatim", () => {
    const text = narrate(makeFinding("f4", "idle-licence", { monthlyCostUsd: 36, skuPartNumber: "FAKESKU" }));
    assert.match(text, /\$36 per month/);
    assert.match(text, /FAKESKU/);
  });
  it("keeps an unknown licence cost unknown", () => {
    const text = narrate(makeFinding("f5", "idle-licence", { monthlyCostUsd: null }));
    assert.match(text, /unknown monthly cost/);
    assert.doesNotMatch(text, /\$/);
  });
  it("quotes the cold-storage last-modified date and keeps unknown numbers unknown", () => {
    const known = narrate(
      makeFinding("f6", "cold-storage", { lastModifiedAt: "2025-01-02T00:00:00Z", storageSizeBytes: 2048 }),
    );
    assert.match(known, /2025-01-02T00:00:00Z/);
    assert.match(known, /2048 bytes/);
    const unknown = narrate(makeFinding("f7", "cold-storage", {}));
    assert.match(unknown, /an unknown date/);
    assert.match(unknown, /uses unknown\./);
  });
});

describe("buildCard", () => {
  const f = makeFinding("f-card", "orphaned-site", {}, null);
  it("is an Adaptive Card v1.5 with exactly three Action.Submit actions", () => {
    const card = buildCard(f);
    assert.equal(card.type, "AdaptiveCard");
    assert.equal(card.version, "1.5");
    assert.deepEqual(
      card.actions.map((a) => [a.type, a.title, a.data]),
      [
        ["Action.Submit", "Keep it shared", { findingId: "f-card", action: "Keep" }],
        ["Action.Submit", "Remove the public link", { findingId: "f-card", action: "Restrict" }],
        ["Action.Submit", "Archive this site", { findingId: "f-card", action: "Archive" }],
      ],
    );
  });
  it("prefixes the narration with Reminder: on a reminder card", () => {
    const first = buildCard(f).body[0] as { text: string };
    const reminder = buildCard(f, { reminder: true }).body[0] as { text: string };
    assert.equal(first.text, narrate(f));
    assert.equal(reminder.text, "Reminder: " + narrate(f));
  });
});

describe("createDecisionHandler", () => {
  function setup(findings: Finding[]) {
    const store = fakeStore(findings);
    const decisions = new InMemoryDecisionStore();
    let puts = 0;
    const origPut = decisions.put.bind(decisions);
    decisions.put = async (r) => {
      puts++;
      return origPut(r);
    };
    const dispatched: Decision[] = [];
    const dispatch = async (d: Decision): Promise<DispatchResult> => {
      dispatched.push(d);
      return { status: "refused", reason: "fake dispatcher" };
    };
    const handle = createDecisionHandler({ findings: store, decisions, dispatch, now: () => T0 });
    return { store, decisions, dispatched, handle, puts: () => puts };
  }

  it("records Keep, dismisses the finding and suppresses for 30 days", async () => {
    const s = setup([makeFinding("f1", "overshared-site")]);
    const out = await s.handle({ findingId: "f1", action: "Keep" });
    assert.equal(out.status, "recorded");
    const rec = await s.decisions.get("f1");
    assert.equal(rec?.owner, OWNER);
    assert.equal(rec?.acceptedUntil, new Date(T0.getTime() + KEEP_SUPPRESS_DAYS * DAY).toISOString());
    assert.equal((await s.store.getById("f1"))?.status, "dismissed");
    assert.equal(s.dispatched.length, 0);
  });

  it("returns the recorded decision on a duplicate without a second write", async () => {
    const s = setup([makeFinding("f1", "overshared-site")]);
    await s.handle({ findingId: "f1", action: "Keep" });
    const second = await s.handle({ findingId: "f1", action: "Archive" });
    assert.equal(second.status, "duplicate");
    if (second.status === "duplicate") assert.equal(second.record.action, "Keep");
    assert.equal(s.puts(), 1);
    assert.equal(s.dispatched.length, 0);
  });

  it("ignores a postback for a finding with no owner and leaves it open", async () => {
    const s = setup([makeFinding("f2", "orphaned-site", {}, null)]);
    const out = await s.handle({ findingId: "f2", action: "Keep" });
    assert.equal(out.status, "ignored");
    assert.equal(await s.decisions.get("f2"), null);
    assert.equal((await s.store.getById("f2"))?.status, "open");
  });

  it("ignores an unknown action", async () => {
    const s = setup([makeFinding("f1", "overshared-site")]);
    const out = await s.handle({ findingId: "f1", action: "Delete" });
    assert.equal(out.status, "ignored");
    assert.equal(s.puts(), 0);
    assert.equal((await s.store.getById("f1"))?.status, "open");
  });

  it("hands Restrict and Archive to the injected dispatcher", async () => {
    const s = setup([makeFinding("f1", "overshared-site"), makeFinding("f3", "cold-storage")]);
    await s.handle({ findingId: "f1", action: "Restrict" });
    await s.handle({ findingId: "f3", action: "Archive" });
    assert.deepEqual(
      s.dispatched.map((d) => [d.findingId, d.action, d.owner]),
      [
        ["f1", "restrict", OWNER],
        ["f3", "archive", OWNER],
      ],
    );
    assert.equal((await s.store.getById("f1"))?.status, "open");
  });
});

describe("runNudgeCheck", () => {
  function setup(sentDaysAgo: number[]) {
    const store = fakeStore([makeFinding("f1", "overshared-site", { linkScope: "anonymous" })]);
    const decisions = new InMemoryDecisionStore();
    const log: SendRecord[] = sentDaysAgo.map((d) => ({
      findingId: "f1",
      owner: OWNER,
      sentAt: new Date(T0.getTime() - d * DAY).toISOString(),
    }));
    const sends: SendLog = {
      list: async (id) => log.filter((r) => r.findingId === id),
      listBySubject: async (_t, subjectId) => log.filter((r) => `subject-${r.findingId}` === subjectId),
      add: async (r) => void log.push(r),
    };
    const queued: Array<{ findingId: string; reason: string }> = [];
    const queue: AdminQueue = {
      has: async (id) => queued.some((q) => q.findingId === id),
      hasBySubject: async (_t, subjectId) => queued.some((q) => `subject-${q.findingId}` === subjectId),
      enqueue: async (e) => void queued.push(e),
    };
    const delivered: Array<{ owner: string; card: ReturnType<typeof buildCard> }> = [];
    const send = async (owner: string, card: ReturnType<typeof buildCard>) => {
      delivered.push({ owner, card });
    };
    const run = () => runNudgeCheck({ findings: store, decisions, sends, queue, send, now: () => T0 });
    return { run, delivered, queued, log };
  }

  it("does not nudge before 7 days", async () => {
    const s = setup([6]);
    assert.deepEqual(await s.run(), { nudged: [], escalated: [] });
    assert.equal(s.delivered.length, 0);
  });

  it("nudges once after 7 days with a reminder card, and never a second time", async () => {
    const s = setup([8]);
    assert.deepEqual((await s.run()).nudged, ["f1"]);
    assert.equal(s.delivered.length, 1);
    assert.equal(s.delivered[0].owner, OWNER);
    assert.match((s.delivered[0].card.body[0] as { text: string }).text, /^Reminder: /);
    assert.equal(s.log.length, 2);
    // Run again: the nudge is 0 days old, no further message is sent.
    assert.deepEqual(await s.run(), { nudged: [], escalated: [] });
    assert.equal(s.delivered.length, 1);
  });

  it("never sends a third message even when both sends are old, and escalates instead", async () => {
    const s = setup([20, 14]);
    const out = await s.run();
    assert.deepEqual(out, { nudged: [], escalated: ["f1"] });
    assert.equal(s.delivered.length, 0);
    assert.deepEqual(s.queued, [{ findingId: "f1", reason: "no response" }]);
    // Already escalated: not queued twice.
    assert.deepEqual(await s.run(), { nudged: [], escalated: [] });
    assert.equal(s.queued.length, 1);
  });

  it("does not escalate before 7 days after the nudge", async () => {
    const s = setup([13, 6]);
    assert.deepEqual(await s.run(), { nudged: [], escalated: [] });
    assert.equal(s.queued.length, 0);
  });
});

describe("SqliteDecisionStore", () => {
  const record: DecisionRecord = {
    findingId: "f-sqlite",
    type: "overshared-site",
    subjectId: "subject-sqlite",
    owner: OWNER,
    action: "Keep",
    decidedAt: T0.toISOString(),
    acceptedUntil: new Date(T0.getTime() + 30 * DAY).toISOString(),
  };

  function withTempDb(fn: (path: string) => Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), "spectre-attest-"));
      try {
        await fn(join(dir, "decisions.sqlite"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it("returns the same record after put", withTempDb(async (path) => {
    const store = new SqliteDecisionStore(path);
    await store.put(record);
    assert.deepEqual(await store.get("f-sqlite"), record);
  }));

  it("returns the record by subject and rejects a second decision for the same subject", withTempDb(async (path) => {
    const store = new SqliteDecisionStore(path);
    await store.put(record);
    assert.deepEqual(await store.getBySubject("overshared-site", "subject-sqlite"), record);
    assert.equal(await store.getBySubject("stale-guest", "subject-sqlite"), null);
    await assert.rejects(store.put({ ...record, findingId: "f-later" }));
    assert.deepEqual(await store.get("f-sqlite"), record);
  }));

  it("replaces an expired Keep but never an active one", withTempDb(async (path) => {
    const store = new SqliteDecisionStore(path);
    await store.put(record);
    const later = new Date(T0.getTime() + 31 * DAY).toISOString();
    const fresh: DecisionRecord = { ...record, findingId: "f-new", action: "Restrict", decidedAt: later, acceptedUntil: null };
    await store.put(fresh);
    assert.deepEqual(await store.getBySubject("overshared-site", "subject-sqlite"), fresh);
    await assert.rejects(store.put({ ...fresh, findingId: "f-newer", decidedAt: later }));
  }));

  it("migrates a per-finding table to the subject key and aborts on a missing finding row", withTempDb(async (path) => {
    const db = new Database(path);
    db.exec(`CREATE TABLE attestation_decisions (
      finding_id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL,
      decided_at TEXT NOT NULL, accepted_until TEXT);`);
    const findings = new SqliteFindingStore(path);
    const { id: realId, ...rest } = makeFinding("x", "overshared-site");
    void realId;
    const inserted = await findings.insert({ ...rest, subjectId: "subject-mig" });
    db.prepare("INSERT INTO attestation_decisions VALUES (?, ?, ?, ?, ?)")
      .run(inserted.id, OWNER, "Keep", record.decidedAt, record.acceptedUntil);
    db.prepare("INSERT INTO attestation_decisions VALUES (?, ?, ?, ?, ?)")
      .run("ghost-row", OWNER, "Keep", record.decidedAt, record.acceptedUntil);
    assert.throws(() => new SqliteDecisionStore(path), /no finding row/);
    db.prepare("DELETE FROM attestation_decisions WHERE finding_id = 'ghost-row'").run();
    const migrated = new SqliteDecisionStore(path);
    assert.deepEqual(await migrated.getBySubject("overshared-site", "subject-mig"), {
      ...record, findingId: inserted.id, subjectId: "subject-mig",
    });
    db.close();
  }));

  it("returns null for an unknown finding", withTempDb(async (path) => {
    const store = new SqliteDecisionStore(path);
    assert.equal(await store.get("no-such-finding"), null);
  }));

  it("still returns the record after a restart", withTempDb(async (path) => {
    await new SqliteDecisionStore(path).put(record);
    const restarted = new SqliteDecisionStore(path);
    assert.deepEqual(await restarted.get("f-sqlite"), record);
  }));
});

describe("isDecisionActive", () => {
  const keep = (until: string | null): DecisionRecord => ({
    findingId: "f1", type: "overshared-site", subjectId: "s", owner: OWNER, action: "Keep",
    decidedAt: T0.toISOString(), acceptedUntil: until,
  });
  it("treats no record as inactive", () => assert.equal(isDecisionActive(null, T0), false));
  it("treats Restrict and Archive as always active", () => {
    const far = new Date(T0.getTime() + 3650 * DAY);
    for (const action of ["Restrict", "Archive"] as const) {
      assert.equal(isDecisionActive({ ...keep(null), action }, far), true);
    }
  });
  it("treats Keep as active only until acceptedUntil", () => {
    const until = new Date(T0.getTime() + 30 * DAY);
    assert.equal(isDecisionActive(keep(until.toISOString()), new Date(until.getTime() - 1)), true);
    assert.equal(isDecisionActive(keep(until.toISOString()), until), false);
  });
});

describe("decisions keyed by subject", () => {
  function setup(findings: Finding[], now: () => Date) {
    const store = fakeStore(findings);
    const decisions = new InMemoryDecisionStore();
    const dispatched: Decision[] = [];
    const dispatch = async (d: Decision): Promise<DispatchResult> => {
      dispatched.push(d);
      return { status: "refused", reason: "fake dispatcher" };
    };
    const handle = createDecisionHandler({ findings: store, decisions, dispatch, now });
    return { store, decisions, dispatched, handle };
  }
  const row2 = (id: string, subjectId: string, type: GhostType = "overshared-site") => ({
    ...makeFinding(id, type), subjectId,
  });

  it("Keep on row 1 suppresses row 2 of the same subject while unexpired, not after expiry", async () => {
    let clock = T0;
    const s = setup([row2("r1", "same"), row2("r2", "same"), row2("r3", "other")], () => clock);
    assert.equal((await s.handle({ findingId: "r1", action: "Keep" })).status, "recorded");
    clock = new Date(T0.getTime() + 29 * DAY);
    const dup = await s.handle({ findingId: "r2", action: "Restrict" });
    assert.equal(dup.status, "duplicate");
    assert.equal(s.dispatched.length, 0);
    assert.equal((await s.handle({ findingId: "r3", action: "Keep" })).status, "recorded"); // other subject
    clock = new Date(T0.getTime() + 31 * DAY);
    assert.equal((await s.handle({ findingId: "r2", action: "Restrict" })).status, "recorded");
    assert.equal(s.dispatched.length, 1);
  });

  it("a Restrict decision blocks a second decision on a new row, even long after", async () => {
    let clock = T0;
    const s = setup([row2("r1", "same"), row2("r2", "same")], () => clock);
    await s.handle({ findingId: "r1", action: "Restrict" });
    clock = new Date(T0.getTime() + 400 * DAY);
    assert.equal((await s.handle({ findingId: "r2", action: "Keep" })).status, "duplicate");
    assert.equal(s.dispatched.length, 1);
  });
});

describe("sends and queue keyed by subject (SQLite)", () => {
  async function withDeliveryDb(fn: (ctx: {
    path: string; findings: SqliteFindingStore; sends: SqliteDeliveryStore; queue: SqliteAdminQueue;
  }) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "spectre-subject-"));
    try {
      const path = join(dir, "s.sqlite");
      const findings = new SqliteFindingStore(path);
      await fn({ path, findings, sends: new SqliteDeliveryStore(path), queue: new SqliteAdminQueue(path) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** Row 1 from an older scan (superseded) and row 2 from this scan, same ghost. */
  async function seedTwoRows(findings: SqliteFindingStore) {
    const { id, status, updatedAt, ...base } = makeFinding("x", "overshared-site");
    void id; void status; void updatedAt;
    const r1 = await findings.insert({
      ...base, subjectId: "same", scanTimestamp: new Date(T0.getTime() - 20 * DAY).toISOString(),
    });
    const r2 = await findings.insert({ ...base, subjectId: "same" });
    await findings.updateStatus(r1.id, "superseded");
    return { r1: r1.id, r2: r2.id };
  }

  it("a send for row 1 blocks a fresh card for row 2, and the nudge fires once against combined history", async () => {
    await withDeliveryDb(async ({ findings, sends, queue }) => {
      const { r1, r2 } = await seedTwoRows(findings);
      await sends.add({ findingId: r1, owner: OWNER, sentAt: new Date(T0.getTime() - 8 * DAY).toISOString() });
      assert.equal((await sends.listBySubject("overshared-site", "same")).length, 1);
      assert.equal((await sends.listBySubject("stale-guest", "same")).length, 0);

      const delivered: string[] = [];
      const send = async (owner: string) => void delivered.push(owner);
      const decisions = new InMemoryDecisionStore();
      const summary = await deliverOpenFindings({
        findings, decisions, sends, queue, conversations: sends, send, now: () => T0,
      });
      assert.deepEqual(summary.skipped, [r2]);
      assert.equal(delivered.length, 0);

      const first = await runNudgeCheck({ findings, decisions, sends, queue, send, now: () => T0 });
      assert.deepEqual(first.nudged, [r2]);
      const second = await runNudgeCheck({ findings, decisions, sends, queue, send, now: () => T0 });
      assert.deepEqual(second.nudged, []);
      assert.equal(delivered.length, 1);
      assert.equal((await sends.listBySubject("overshared-site", "same")).length, 2);
    });
  });

  it("a subject queued under an old row is not re-sent or re-queued under its new row", async () => {
    await withDeliveryDb(async ({ findings, sends, queue }) => {
      const { r1, r2 } = await seedTwoRows(findings);
      await queue.enqueue({ findingId: r1, reason: "no response" });
      assert.equal(await queue.hasBySubject("overshared-site", "same"), true);
      assert.equal(await queue.hasBySubject("overshared-site", "different"), false);
      const delivered: string[] = [];
      const summary = await deliverOpenFindings({
        findings, decisions: new InMemoryDecisionStore(), sends, queue, conversations: sends,
        send: async (o) => void delivered.push(o), now: () => T0,
      });
      assert.deepEqual(summary.skipped, [r2]);
      assert.equal(delivered.length, 0);
    });
  });
});
