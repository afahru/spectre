/**
 * console/__tests__/api.test.ts
 *
 * Task 5.1: unit tests for the console read API and the decide endpoint.
 * Everything is injected: in-memory finding/audit/decision stores and stub
 * action handlers. No database file, no Graph call, no Teams card, no HTTP
 * server or port is used.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConsoleApi, type ConsoleDeps } from "../api.js";
import { InMemoryDecisionStore } from "../../attestation/decision.js";
import { createDispatcher } from "../../remediation/dispatcher.js";
import type { AuditLog } from "../../remediation/audit.js";
import type { ActionHandler, AuditEntry, Decision, DispatchResult } from "../../remediation/types.js";
import type { FindingStore } from "../../store/FindingStore.js";
import type { Finding, FindingStatus, GhostType } from "../../store/types.js";
import type {
  ApiError, AuditResponse, DecideResponse, ExceptionsResponse, FindingsResponse, ScoreResponse,
} from "../types.js";

const SCAN = "2026-11-12T00:00:00.000Z";
const NOW = new Date("2026-11-13T09:00:00.000Z");
const ADMIN = "admin@example.test";

function makeFinding(id: string, type: GhostType, over: Partial<Finding> = {}): Finding {
  return {
    id,
    type,
    subjectId: `subject-${id}`,
    subjectLabel: `Label ${id}`,
    owner: null, // ownerless -> lands in the exceptions queue
    numbers: {},
    severityWeight: 1,
    status: "open",
    scanTimestamp: SCAN,
    updatedAt: SCAN,
    ...over,
  };
}

function memStore(findings: Finding[], scan: string | null = SCAN): FindingStore {
  const map = new Map(findings.map((f) => [f.id, { ...f }]));
  return {
    getById: async (id: string) => map.get(id) ?? null,
    updateStatus: async (id: string, status: FindingStatus) => {
      const f = map.get(id);
      if (!f) return null;
      f.status = status;
      return { ...f };
    },
    latestScanTimestamp: async () => scan,
    listByScan: async (ts: string) => [...map.values()].filter((f) => f.scanTimestamp === ts),
  } as unknown as FindingStore;
}

function memAudit(seed: AuditEntry[] = []): AuditLog & { listAll(): Promise<AuditEntry[]> } {
  const entries = [...seed];
  return {
    append: async (e) => {
      const entry: AuditEntry = { ...e, id: `audit-${entries.length + 1}`, timestamp: NOW.toISOString() };
      entries.push(entry);
      return entry;
    },
    listByFinding: async (id: string) => entries.filter((e) => e.findingId === id),
    listAll: async () => [...entries],
  };
}

interface Rig {
  api: ReturnType<typeof createConsoleApi>;
  store: FindingStore;
  audit: ReturnType<typeof memAudit>;
  decisions: InMemoryDecisionStore;
  handlerCalls: Decision[];
  dispatchCalls: Decision[];
}

function rig(
  findings: Finding[],
  opts: { handler?: ActionHandler; adminUpn?: string | null; audit?: AuditEntry[]; scan?: string | null } = {},
): Rig {
  const store = memStore(findings, opts.scan === undefined ? SCAN : opts.scan);
  const audit = memAudit(opts.audit);
  const decisions = new InMemoryDecisionStore();
  const handlerCalls: Decision[] = [];
  const dispatchCalls: Decision[] = [];
  const stub: ActionHandler =
    opts.handler ??
    (async (f) => ({ result: "success", target: f.subjectId, restorePath: "restore via stub" }));
  const handler: ActionHandler = async (f, d) => {
    handlerCalls.push(d);
    return stub(f, d);
  };
  const dispatcher = createDispatcher({ store, audit, handlers: { restrict: handler, archive: handler } });
  const deps: ConsoleDeps = {
    findings: store,
    audit,
    decisions,
    dispatch: (d): Promise<DispatchResult> => {
      dispatchCalls.push(d);
      return dispatcher.dispatch(d);
    },
    adminUpn: opts.adminUpn === undefined ? ADMIN : opts.adminUpn,
    now: () => NOW,
  };
  return { api: createConsoleApi(deps), store, audit, decisions, handlerCalls, dispatchCalls };
}

const body = <T>(r: { body: unknown }): T => r.body as T;

describe("console read API", () => {
  it("GET /score returns counts, weights and the cost rollup", async () => {
    const { api } = rig([
      makeFinding("s1", "overshared-site"),
      makeFinding("s2", "overshared-site"),
      makeFinding("g1", "stale-guest"),
      makeFinding("l1", "idle-licence", { numbers: { monthlyCostUsd: 10 } }),
      makeFinding("l2", "idle-licence", { numbers: { monthlyCostUsd: 5 } }),
      makeFinding("c1", "cold-storage", { numbers: { storageOverageCostUsd: null } }),
      makeFinding("done", "overshared-site", { status: "actioned" }), // not open: not counted
    ]);
    const r = await api.score();
    assert.equal(r.status, 200);
    const b = body<ScoreResponse>(r);
    assert.equal(b.scanTimestamp, SCAN);
    assert.ok(b.tenant);
    assert.equal(b.tenant.inputs.counts["overshared-site"], 2);
    assert.equal(b.tenant.inputs.counts["stale-guest"], 1);
    assert.equal(b.tenant.inputs.counts["idle-licence"], 2);
    assert.equal(b.tenant.inputs.counts["cold-storage"], 1);
    const overshared = b.tenant.inputs.breakdown.find((x) => x.type === "overshared-site");
    assert.equal(overshared?.weight, 3);
    assert.equal(overshared?.penalty, 6);
    assert.equal(b.tenant.inputs.maxPenalty, 100);
    assert.ok(b.tenant.score >= 0 && b.tenant.score <= 100);
    // None of these are Spectre fixture objects.
    assert.ok(b.fixture);
    assert.equal(b.fixture.inputs.totalPenalty, 0);
    assert.equal(b.fixture.score, 100);
    assert.equal(b.cost?.idleLicencesUsd, 15);
    assert.equal(b.cost?.coldStorageUsd, null); // price not on file: unknown, never 0
  });

  it("GET /score with no scan recorded returns nulls, not zeros", async () => {
    const { api } = rig([], { scan: null });
    const b = body<ScoreResponse>(await api.score());
    assert.deepEqual(b, { scanTimestamp: null, tenant: null, fixture: null, cost: null });
  });

  it("GET /score scores fixture objects separately from the tenant", async () => {
    const { api } = rig([
      makeFinding("f1", "overshared-site", { subjectLabel: "Spectre Fixture Site 1" }),
      makeFinding("t1", "overshared-site", { subjectLabel: "Real Site" }),
    ]);
    const b = body<ScoreResponse>(await api.score());
    assert.equal(b.tenant?.inputs.counts["overshared-site"], 2);
    assert.equal(b.fixture?.inputs.counts["overshared-site"], 1);
  });

  it("GET /findings lists findings with decision and audit history", async () => {
    const entry: AuditEntry = {
      id: "a1", findingId: "s1", action: "restrict", target: "t", owner: ADMIN,
      timestamp: SCAN, result: "failure", error: "boom", restorePath: null,
    };
    const r = rig([makeFinding("s1", "overshared-site"), makeFinding("g1", "stale-guest")], { audit: [entry] });
    await r.decisions.put({ findingId: "s1", owner: ADMIN, action: "Restrict", decidedAt: SCAN, acceptedUntil: null });
    const res = await r.api.findings(new URLSearchParams());
    assert.equal(res.status, 200);
    const list = body<FindingsResponse>(res).findings;
    assert.equal(list.length, 2);
    const s1 = list.find((v) => v.finding.id === "s1");
    assert.equal(s1?.decision?.action, "Restrict");
    assert.deepEqual(s1?.audit.map((e) => e.id), ["a1"]);
    const g1 = list.find((v) => v.finding.id === "g1");
    assert.equal(g1?.decision, null);
    assert.deepEqual(g1?.audit, []);
  });

  it("GET /findings filters by type and status and rejects unknown values", async () => {
    const { api } = rig([
      makeFinding("s1", "overshared-site"),
      makeFinding("s2", "overshared-site", { status: "dismissed" }),
      makeFinding("g1", "stale-guest"),
    ]);
    const byType = body<FindingsResponse>(await api.findings(new URLSearchParams("type=overshared-site")));
    assert.deepEqual(byType.findings.map((v) => v.finding.id).sort(), ["s1", "s2"]);
    const both = body<FindingsResponse>(await api.findings(new URLSearchParams("type=overshared-site&status=open")));
    assert.deepEqual(both.findings.map((v) => v.finding.id), ["s1"]);
    assert.equal((await api.findings(new URLSearchParams("type=bogus"))).status, 400);
    assert.equal((await api.findings(new URLSearchParams("status=bogus"))).status, 400);
  });

  it("GET /findings is empty when no scan is recorded", async () => {
    const { api } = rig([], { scan: null });
    assert.deepEqual(body<FindingsResponse>(await api.findings(new URLSearchParams())).findings, []);
  });

  it("GET /exceptions lists ownerless findings with reason and allowed actions", async () => {
    const { api } = rig([
      makeFinding("s1", "overshared-site"), // ownerless
      makeFinding("c1", "cold-storage"), // ownerless
      makeFinding("g1", "stale-guest"), // ownerless
      makeFinding("owned", "overshared-site", { owner: "owner@example.test" }), // not in queue
    ]);
    const r = await api.exceptions();
    assert.equal(r.status, 200);
    const list = body<ExceptionsResponse>(r).exceptions;
    assert.deepEqual(list.map((e) => e.finding.id).sort(), ["c1", "g1", "s1"]);
    const byId = (id: string) => list.find((e) => e.finding.id === id)!;
    assert.equal(byId("s1").reason, "ownerless");
    assert.equal(byId("s1").error, null);
    assert.deepEqual(byId("s1").allowedActions, ["Keep", "Restrict"]);
    assert.deepEqual(byId("c1").allowedActions, ["Keep", "Archive"]);
    assert.deepEqual(byId("g1").allowedActions, ["Keep"]);
  });

  it("GET /exceptions includes findings queued by the nudge loop, with reason and error", async () => {
    const owned = makeFinding("owned", "overshared-site", { owner: "owner@example.test" });
    const r = rig([owned]);
    const api = createConsoleApi({
      findings: r.store,
      audit: r.audit,
      decisions: r.decisions,
      dispatch: async () => ({ status: "refused", reason: "unused" }),
      queued: async () => [{ findingId: "owned", reason: "no response", error: "card bounced" }],
      adminUpn: ADMIN,
    });
    const list = body<ExceptionsResponse>(await api.exceptions()).exceptions;
    assert.equal(list.length, 1);
    assert.equal(list[0].reason, "no response");
    assert.equal(list[0].error, "card bounced");
  });

  it("GET /audit returns every audit entry", async () => {
    const seed: AuditEntry[] = [
      { id: "a1", findingId: "s1", action: "restrict", target: "t1", owner: ADMIN, timestamp: SCAN, result: "success", error: null, restorePath: "undo" },
      { id: "a2", findingId: "c1", action: "archive", target: "t2", owner: ADMIN, timestamp: SCAN, result: "failure", error: "denied", restorePath: null },
    ];
    const { api } = rig([], { audit: seed });
    const r = await api.audit();
    assert.equal(r.status, 200);
    assert.deepEqual(body<AuditResponse>(r).entries, seed);
  });
});

describe("console decide endpoint", () => {
  it("records the decision and hands Restrict to the dispatcher", async () => {
    const r = rig([makeFinding("s1", "overshared-site")]);
    const res = await r.api.decide("s1", { action: "Restrict" });
    assert.equal(res.status, 200);
    const b = body<DecideResponse>(res);
    assert.equal(b.record.findingId, "s1");
    assert.equal(b.record.owner, ADMIN);
    assert.equal(b.record.action, "Restrict");
    assert.equal(b.record.decidedAt, NOW.toISOString());
    assert.equal(b.record.acceptedUntil, null);
    assert.deepEqual(await r.decisions.get("s1"), b.record);
    assert.equal(b.dispatch?.status, "executed");
    assert.equal(r.dispatchCalls.length, 1);
    assert.deepEqual(r.dispatchCalls[0], {
      findingId: "s1", action: "restrict", owner: ADMIN, approvedAt: NOW.toISOString(),
    });
    assert.equal(r.handlerCalls.length, 1);
    assert.equal((await r.store.getById("s1"))?.status, "actioned");
    assert.equal((await r.audit.listAll()).length, 1);
  });

  it("hands Archive to the dispatcher as archive", async () => {
    const r = rig([makeFinding("c1", "cold-storage")]);
    const b = body<DecideResponse>(await r.api.decide("c1", { action: "Archive" }));
    assert.equal(b.dispatch?.status, "executed");
    assert.equal(r.dispatchCalls[0].action, "archive");
  });

  it("Keep dismisses the finding, sets acceptedUntil and runs no remediation", async () => {
    const r = rig([makeFinding("s1", "overshared-site")]);
    const res = await r.api.decide("s1", { action: "Keep" });
    assert.equal(res.status, 200);
    const b = body<DecideResponse>(res);
    assert.equal(b.dispatch, null);
    assert.equal(b.record.acceptedUntil, new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
    assert.equal((await r.store.getById("s1"))?.status, "dismissed");
    assert.equal(r.dispatchCalls.length, 0);
    assert.equal(r.handlerCalls.length, 0);
  });

  it("returns 503 and does nothing when ADMIN_UPN is not set", async () => {
    const r = rig([makeFinding("s1", "overshared-site")], { adminUpn: null });
    const res = await r.api.decide("s1", { action: "Restrict" });
    assert.equal(res.status, 503);
    assert.match(body<ApiError>(res).error, /ADMIN_UPN/);
    assert.equal(await r.decisions.get("s1"), null);
    assert.equal(r.dispatchCalls.length, 0);
    assert.equal(r.handlerCalls.length, 0);
    assert.equal((await r.store.getById("s1"))?.status, "open");
  });

  it("treats an empty ADMIN_UPN as unset (503)", async () => {
    const r = rig([makeFinding("s1", "overshared-site")], { adminUpn: "" });
    assert.equal((await r.api.decide("s1", { action: "Keep" })).status, 503);
  });

  it("handles an unknown exception id as an error, not a silent success", async () => {
    const r = rig([makeFinding("s1", "overshared-site")]);
    const res = await r.api.decide("no-such-id", { action: "Restrict" });
    assert.equal(res.status, 404);
    assert.ok(body<ApiError>(res).error);
    assert.equal(await r.decisions.get("no-such-id"), null);
    assert.equal(r.dispatchCalls.length, 0);
    assert.equal(r.handlerCalls.length, 0);
    assert.equal((await r.audit.listAll()).length, 0);
  });

  it("rejects a finding that is not in the exceptions queue (has an owner)", async () => {
    const r = rig([makeFinding("owned", "overshared-site", { owner: "owner@example.test" })]);
    const res = await r.api.decide("owned", { action: "Restrict" });
    assert.equal(res.status, 404);
    assert.equal(r.dispatchCalls.length, 0);
  });

  it("rejects an unknown or missing action with 400", async () => {
    const r = rig([makeFinding("s1", "overshared-site")]);
    assert.equal((await r.api.decide("s1", { action: "Delete" })).status, 400);
    assert.equal((await r.api.decide("s1", {})).status, 400);
    assert.equal((await r.api.decide("s1", null)).status, 400);
    assert.equal(await r.decisions.get("s1"), null);
    assert.equal(r.dispatchCalls.length, 0);
  });

  it("rejects an action not allowed for the ghost type with 422", async () => {
    const r = rig([makeFinding("s1", "overshared-site"), makeFinding("g1", "stale-guest")]);
    assert.equal((await r.api.decide("s1", { action: "Archive" })).status, 422);
    assert.equal((await r.api.decide("g1", { action: "Restrict" })).status, 422);
    assert.equal(await r.decisions.get("s1"), null);
    assert.equal(r.dispatchCalls.length, 0);
  });

  it("rejects a duplicate decision with 409 and the recorded decision", async () => {
    const r = rig([makeFinding("s1", "overshared-site")]);
    const first = body<DecideResponse>(await r.api.decide("s1", { action: "Restrict" }));
    const second = await r.api.decide("s1", { action: "Restrict" });
    assert.equal(second.status, 409);
    assert.deepEqual(body<ApiError>(second).record, first.record);
    assert.equal(r.dispatchCalls.length, 1);
    assert.equal(r.handlerCalls.length, 1);
  });

  it("failure never marks fixed: a failing action leaves the finding open and audits the failure", async () => {
    const r = rig([makeFinding("s1", "overshared-site")], {
      handler: async (f) => ({ result: "failure", target: f.subjectId, error: "Graph 403" }),
    });
    const res = await r.api.decide("s1", { action: "Restrict" });
    assert.equal(res.status, 200);
    const b = body<DecideResponse>(res);
    assert.equal(b.dispatch?.status, "executed");
    if (b.dispatch?.status === "executed") {
      assert.equal(b.dispatch.entry.result, "failure");
      assert.equal(b.dispatch.entry.error, "Graph 403");
    }
    assert.equal((await r.store.getById("s1"))?.status, "open");
  });

  it("failure never marks fixed: a throwing handler leaves the finding open", async () => {
    const r = rig([makeFinding("c1", "cold-storage")], {
      handler: async () => {
        throw new Error("network down");
      },
    });
    const b = body<DecideResponse>(await r.api.decide("c1", { action: "Archive" }));
    assert.equal(b.dispatch?.status, "executed");
    if (b.dispatch?.status === "executed") assert.equal(b.dispatch.entry.result, "failure");
    assert.equal((await r.store.getById("c1"))?.status, "open");
  });

  it("a queued (not executed) outcome does not mark the finding fixed", async () => {
    const r = rig([makeFinding("c1", "cold-storage")], {
      handler: async (f) => ({ result: "queued", target: f.subjectId }),
    });
    await r.api.decide("c1", { action: "Archive" });
    assert.equal((await r.store.getById("c1"))?.status, "open");
  });

  it("surfaces a dispatcher refusal as refused, with the finding left open", async () => {
    const r = rig([makeFinding("s1", "overshared-site")]);
    const api = createConsoleApi({
      findings: r.store,
      audit: r.audit,
      decisions: r.decisions,
      dispatch: async () => ({ status: "refused", reason: "No handler registered for restrict." }),
      adminUpn: ADMIN,
      now: () => NOW,
    });
    const b = body<DecideResponse>(await api.decide("s1", { action: "Restrict" }));
    assert.deepEqual(b.dispatch, { status: "refused", reason: "No handler registered for restrict." });
    assert.equal((await r.store.getById("s1"))?.status, "open");
  });
});
