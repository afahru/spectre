/**
 * remediation/__tests__/remediation.test.ts
 *
 * Unit tests for the dispatcher and audit log (tasks 1.1, 1.2).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDispatcher } from "../dispatcher.js";
import { createRevokeLinkHandler } from "../revoke-link.js";
import type { AuditLog } from "../audit.js";
import type { ActionHandler, AuditEntry, Decision, RemediationAction } from "../types.js";
import type { FindingStore } from "../../store/FindingStore.js";
import type { Finding, FindingStatus, GhostType } from "../../store/types.js";

function makeFinding(id: string, type: GhostType): Finding {
  return {
    id,
    type,
    subjectId: `subject-${id}`,
    subjectLabel: null,
    owner: null,
    numbers: {},
    severityWeight: 1,
    status: "open",
    scanTimestamp: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
  };
}

function fakeStore(findings: Finding[]): FindingStore {
  const map = new Map(findings.map((f) => [f.id, { ...f }]));
  return {
    getById: async (id: string) => map.get(id) ?? null,
    updateStatus: async (id: string, status: FindingStatus) => {
      const f = map.get(id);
      if (!f) return null;
      f.status = status;
      return { ...f };
    },
  } as unknown as FindingStore;
}

function fakeAudit(): AuditLog {
  const entries: AuditEntry[] = [];
  return {
    append: async (e) => {
      const full = { ...e, id: randomUUID(), timestamp: new Date().toISOString() };
      entries.push(full);
      return full;
    },
    listByFinding: async (id) => entries.filter((e) => e.findingId === id),
  };
}

const decision = (findingId: string, action: RemediationAction): Decision => ({
  findingId,
  action,
  owner: "owner@example.com",
  approvedAt: "2026-11-13T00:00:00.000Z",
});

function setup(
  result: "success" | "failure" | "queued" | "throw" = "success"
) {
  const store = fakeStore([
    makeFinding("o1", "overshared-site"),
    makeFinding("c1", "cold-storage"),
    makeFinding("g1", "stale-guest"),
    makeFinding("l1", "idle-licence"),
  ]);
  const audit = fakeAudit();
  const calls: string[] = [];
  const mk = (action: RemediationAction): ActionHandler => async (f) => {
    calls.push(action);
    if (result === "throw") throw new Error("boom");
    return {
      result,
      target: f.subjectId,
      error: result === "success" ? undefined : "not done",
      restorePath: action === "restrict" ? null : "restore it",
    };
  };
  const dispatcher = createDispatcher({
    store,
    audit,
    handlers: { restrict: mk("restrict"), archive: mk("archive"), revoke: mk("revoke") },
  });
  return { store, audit, calls, dispatcher };
}

describe("dispatcher routing", () => {
  it("routes each ghost type to its handler", async () => {
    const { calls, dispatcher } = setup();
    await dispatcher.dispatch(decision("o1", "restrict"));
    await dispatcher.dispatch(decision("c1", "archive"));
    await dispatcher.dispatch(decision("g1", "revoke"));
    assert.deepEqual(calls, ["restrict", "archive", "revoke"]);
  });

  it("refuses without a recorded approval and never calls a handler", async () => {
    const { calls, audit, dispatcher } = setup();
    const noApproval = { ...decision("o1", "restrict"), approvedAt: "" };
    const noOwner = { ...decision("o1", "restrict"), owner: null };
    assert.equal((await dispatcher.dispatch(noApproval)).status, "refused");
    assert.equal((await dispatcher.dispatch(noOwner)).status, "refused");
    assert.equal((await dispatcher.dispatch(null)).status, "refused");
    assert.deepEqual(calls, []);
    assert.equal((await audit.listByFinding("o1")).length, 0);
  });

  it("refuses an action that does not match the ghost type", async () => {
    const { calls, dispatcher } = setup();
    assert.equal((await dispatcher.dispatch(decision("o1", "archive"))).status, "refused");
    assert.equal((await dispatcher.dispatch(decision("l1", "revoke"))).status, "refused");
    assert.deepEqual(calls, []);
  });

  it("refuses an unknown finding and a missing handler", async () => {
    const { dispatcher, store, audit } = setup();
    assert.equal((await dispatcher.dispatch(decision("nope", "revoke"))).status, "refused");
    const bare = createDispatcher({ store, audit, handlers: {} });
    assert.equal((await bare.dispatch(decision("g1", "revoke"))).status, "refused");
  });
});

describe("audit and status", () => {
  it("writes one entry per action and marks actioned on success", async () => {
    const { store, audit, dispatcher } = setup("success");
    await dispatcher.dispatch(decision("g1", "revoke"));
    const entries = await audit.listByFinding("g1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].findingId, "g1");
    assert.equal(entries[0].action, "revoke");
    assert.equal(entries[0].target, "subject-g1");
    assert.equal(entries[0].owner, "owner@example.com");
    assert.equal(entries[0].result, "success");
    assert.equal(entries[0].restorePath, "restore it");
    assert.ok(entries[0].timestamp);
    assert.equal((await store.getById("g1"))?.status, "actioned");
  });

  for (const result of ["failure", "queued"] as const) {
    it(`keeps the finding open on ${result}`, async () => {
      const { store, audit, dispatcher } = setup(result);
      await dispatcher.dispatch(decision("o1", "restrict"));
      const entries = await audit.listByFinding("o1");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].result, result);
      assert.equal(entries[0].error, "not done");
      assert.equal((await store.getById("o1"))?.status, "open");
    });
  }

  it("records a handler throw as failure and keeps the finding open", async () => {
    const { store, audit, dispatcher } = setup("throw");
    await dispatcher.dispatch(decision("c1", "archive"));
    const entries = await audit.listByFinding("c1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result, "failure");
    assert.equal(entries[0].error, "boom");
    assert.equal((await store.getById("c1"))?.status, "open");
  });
});

describe("SqliteAuditLog", () => {
  it("round-trips an entry with null owner and restore path", async () => {
    const { SqliteAuditLog } = await import("../audit.js");
    const audit = new SqliteAuditLog(":memory:");
    const e = await audit.append({
      findingId: "x",
      action: "restrict",
      target: "link",
      owner: null,
      result: "success",
      error: null,
      restorePath: null,
    });
    assert.deepEqual(await audit.listByFinding("x"), [e]);
  });
});

describe("restrict handler: revoke anonymous link (tasks 2.1, 2.2)", () => {
  const link = { driveId: "d1", itemId: "i1", permissionId: "p1" };
  const setup = (api: (path: string) => { delete: () => Promise<void> }, withLink = true) => {
    const f = makeFinding("f1", "overshared-site");
    if (withLink) f.numbers = { anonymousLink: link };
    const store = fakeStore([f]);
    const audit = fakeAudit();
    const handler = createRevokeLinkHandler({ api } as never);
    return { store, audit, d: createDispatcher({ store, audit, handlers: { restrict: handler } }) };
  };

  it("DELETEs the recorded permission and marks the finding actioned", async () => {
    const calls: string[] = [];
    const { d, store } = setup((p) => ({ delete: async () => void calls.push(p) }));
    await d.dispatch(decision("f1", "restrict"));
    assert.deepEqual(calls, ["/drives/d1/items/i1/permissions/p1"]);
    assert.equal((await store.getById("f1"))?.status, "actioned");
  });

  it("keeps the finding open and records the error when Graph fails", async () => {
    const { d, store, audit } = setup(() => ({
      delete: async () => { throw new Error("403 Forbidden"); },
    }));
    await d.dispatch(decision("f1", "restrict"));
    assert.equal((await store.getById("f1"))?.status, "open");
    const [e] = await audit.listByFinding("f1");
    assert.equal(e.result, "failure");
    assert.equal(e.error, "403 Forbidden");
  });

  it("makes no Graph call and stays open when no permission id was recorded", async () => {
    let called = false;
    const { d, store, audit } = setup(() => { called = true; return { delete: async () => {} }; }, false);
    await d.dispatch(decision("f1", "restrict"));
    assert.equal(called, false);
    assert.equal((await store.getById("f1"))?.status, "open");
    assert.equal((await audit.listByFinding("f1"))[0].result, "failure");
  });
});
