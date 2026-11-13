import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supersedePreviousFindings } from "../supersede.js";
import type { FindingStore } from "../FindingStore.js";
import type { Finding, FindingStatus, GhostType } from "../types.js";

const T1 = "2026-11-10T00:00:00.000Z";
const T2 = "2026-11-11T00:00:00.000Z";
const T3 = "2026-11-12T00:00:00.000Z";

let seq = 0;
function memStore(): FindingStore & { all(): Finding[]; failAfter: number | null } {
  const rows: Finding[] = [];
  let updates = 0;
  const s = {
    failAfter: null as number | null,
    all: () => rows,
    insert: async (n: Omit<Finding, "id" | "status" | "updatedAt">) => {
      const f: Finding = { ...n, id: `f${++seq}`, status: "open", updatedAt: n.scanTimestamp };
      rows.push(f);
      return f;
    },
    updateStatus: async (id: string, status: FindingStatus) => {
      if (s.failAfter !== null && updates >= s.failAfter) throw new Error("crash");
      updates++;
      const f = rows.find((r) => r.id === id);
      if (!f) return null;
      f.status = status;
      return f;
    },
    listOpen: async () => rows.filter((r) => r.status === "open"),
    listByScan: async (ts: string) => rows.filter((r) => r.scanTimestamp === ts),
    latestScanTimestamp: async () => rows.map((r) => r.scanTimestamp).sort().pop() ?? null,
  };
  return s as unknown as FindingStore & { all(): Finding[]; failAfter: number | null };
}

async function add(store: FindingStore, type: GhostType, subjectId: string, scanTimestamp: string) {
  return store.insert({
    type, subjectId, subjectLabel: null, owner: null, numbers: {}, severityWeight: 1, scanTimestamp,
  });
}

const statusOf = (s: ReturnType<typeof memStore>, id: string) => s.all().find((f) => f.id === id)?.status;

describe("supersedePreviousFindings", () => {
  it("supersedes re-found rows, resolves not re-found rows, leaves this scan and history alone", async () => {
    const s = memStore();
    const oldA = await add(s, "stale-guest", "a", T1);
    const oldB = await add(s, "stale-guest", "b", T1);
    const done = await add(s, "stale-guest", "a", T1);
    await s.updateStatus(done.id, "actioned");
    const dis = await add(s, "orphaned-site", "c", T1);
    await s.updateStatus(dis.id, "dismissed");
    const newA = await add(s, "stale-guest", "a", T2);

    const r = await supersedePreviousFindings(s, [newA], T2);
    assert.deepEqual(r, { superseded: 1, resolved: 1 });
    assert.equal(statusOf(s, oldA.id), "superseded");
    assert.equal(statusOf(s, oldB.id), "resolved");
    assert.equal(statusOf(s, done.id), "actioned");
    assert.equal(statusOf(s, dis.id), "dismissed");
    assert.equal(statusOf(s, newA.id), "open");
  });

  it("treats the same subjectId under a different type as a different ghost", async () => {
    const s = memStore();
    const old = await add(s, "orphaned-site", "x", T1);
    const fresh = await add(s, "overshared-site", "x", T2);
    await supersedePreviousFindings(s, [fresh], T2);
    assert.equal(statusOf(s, old.id), "resolved");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const s = memStore();
    await add(s, "stale-guest", "a", T1);
    const newA = await add(s, "stale-guest", "a", T2);
    await supersedePreviousFindings(s, [newA], T2);
    const snapshot = JSON.stringify(s.all());
    assert.deepEqual(await supersedePreviousFindings(s, [newA], T2), { superseded: 0, resolved: 0 });
    assert.equal(JSON.stringify(s.all()), snapshot);
  });

  it("heals after a partial run", async () => {
    const s = memStore();
    const o1 = await add(s, "stale-guest", "a", T1);
    const o2 = await add(s, "stale-guest", "b", T1);
    const newA = await add(s, "stale-guest", "a", T2);
    s.failAfter = 1;
    await assert.rejects(supersedePreviousFindings(s, [newA], T2), /crash/);
    assert.equal(statusOf(s, o1.id), "superseded");
    assert.equal(statusOf(s, o2.id), "open");
    s.failAfter = null;
    assert.deepEqual(await supersedePreviousFindings(s, [newA], T2), { superseded: 0, resolved: 1 });
    assert.equal(statusOf(s, o2.id), "resolved");
  });

  it("heals rows left by a crashed scan on the next completed scan", async () => {
    const s = memStore();
    const crashed = await add(s, "stale-guest", "a", T1); // scan T1 never superseded anything
    const mid = await add(s, "stale-guest", "a", T2);
    const last = await add(s, "stale-guest", "a", T3);
    await supersedePreviousFindings(s, [last], T3);
    assert.equal(statusOf(s, crashed.id), "superseded");
    assert.equal(statusOf(s, mid.id), "superseded");
  });

  it("invariant: after a completed scan listOpen equals listByScan(latest)", async () => {
    const s = memStore();
    await add(s, "stale-guest", "a", T1);
    await add(s, "stale-guest", "b", T1);
    await add(s, "idle-licence", "l", T1);
    const n2 = [await add(s, "stale-guest", "a", T2), await add(s, "idle-licence", "l", T2)];
    await supersedePreviousFindings(s, n2, T2);
    const n3 = [await add(s, "stale-guest", "a", T3)];
    await supersedePreviousFindings(s, n3, T3);
    const latest = await s.latestScanTimestamp();
    assert.equal(latest, T3);
    const ids = (l: Finding[]) => l.map((f) => f.id).sort();
    assert.deepEqual(ids(await s.listOpen()), ids(await s.listByScan(latest!)));
  });
});
