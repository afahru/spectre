/**
 * store/supersede.ts
 *
 * Scan supersession (spec: spectre-scan-supersession, requirement 1).
 * Runs once per scan, after anonymous-link detection and before scoring,
 * from both src/index.ts and src/seeder/verify.ts.
 *
 * Open rows from older scans whose (type, subjectId) this scan re-found
 * become "superseded"; those it did not re-find become "resolved". Rows of
 * this scan and rows that are not open (actioned, dismissed) are never
 * touched. Idempotent and self-healing: a second run, or a run after a
 * crash, finds only what is still open and older than this scan.
 */

import type { FindingStore } from "./FindingStore.js";
import type { Finding } from "./types.js";

const key = (f: Pick<Finding, "type" | "subjectId">) => `${f.type}|${f.subjectId}`;

export async function supersedePreviousFindings(
  store: FindingStore,
  newFindings: Finding[],
  scanTimestamp: string
): Promise<{ superseded: number; resolved: number }> {
  const refound = new Set(newFindings.map(key));
  let superseded = 0;
  let resolved = 0;
  for (const f of await store.listOpen()) {
    if (f.scanTimestamp >= scanTimestamp) continue; // this scan's rows (or newer) stay
    if (refound.has(key(f))) {
      await store.updateStatus(f.id, "superseded");
      superseded++;
    } else {
      await store.updateStatus(f.id, "resolved");
      resolved++;
    }
  }
  return { superseded, resolved };
}
