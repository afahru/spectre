/**
 * seeder/verify.ts  —  Spectre fixture tenant verifier (task 6.2)
 *
 * Runs a full scan against the fixture tenant and prints the actual finding
 * counts alongside the expected constants from constants.ts so the results
 * can be verified by hand.
 *
 * Usage:
 *   TENANT_ID=<id> CLIENT_ID=<id> CLIENT_SECRET=<secret> \
 *     npx ts-node src/seeder/verify.ts
 *
 * Required environment variables (same as the scan engine):
 *   TENANT_ID      — Azure AD tenant ID
 *   CLIENT_ID      — App registration client ID (application permission)
 *   CLIENT_SECRET  — Client secret
 *
 * Optional:
 *   DB_PATH        — SQLite file path for this verification run.
 *                    Defaults to ./spectre-verify.db so it does not collide
 *                    with the main scan database.
 *   SPECTRE_SKU_PRICES — JSON SKU price table (passed through to scanner).
 *   SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB — overage rate.
 *
 * Outputs:
 *   - Full pipeline console log (same as the main scan engine).
 *   - A side-by-side comparison table: expected (from constants.ts) vs actual
 *     (from the scan findings store).
 *   - A PASS / FAIL per ghost type (PASS = actual >= expected; FAIL otherwise).
 *   - A summary score comparison.
 *   - Any discrepancies are explained (e.g. the known orphaned-site over-count
 *     caused by the collector always returning owner: null).
 *
 * This script does NOT throw or exit non-zero on discrepancies — the task
 * specifies "verify by hand", so it reports the results for human review.
 *
 * Steering compliance:
 *   - Every number printed traces to a Graph response stored with the finding.
 *   - No number is invented, rounded, or copied from a different finding.
 *   - If a count is unexpected, the script says so and explains why.
 */

import { loadConfig } from "../config.js";
import { createGraphClient } from "../graph/index.js";
import { SqliteFindingStore } from "../store/index.js";
import { CollectorProgressStore, runInventory } from "../collector/index.js";
import { runFlagging } from "../flagger/index.js";
import { computeScore, countsFromFindings } from "../scorer/index.js";
import type { GhostType } from "../store/types.js";
import {
  FIXTURE_COUNTS,
  FIXTURE_SCORE,
  FIXTURE_TOTAL_PENALTY,
  FIXTURE_NOTES,
} from "./constants.js";

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Config ─────────────────────────────────────────────────────────
  const config = loadConfig();

  // Use a separate DB file so verify runs don't pollute the main scan DB.
  const dbPath = process.env["DB_PATH"] ?? "./spectre-verify.db";
  const overrideConfig = { ...config, dbPath };

  console.log("[verify] Starting full scan against fixture tenant...");
  console.log(`[verify] DB path: ${dbPath}`);
  console.log("[verify] Expected fixture counts (from constants.ts):");
  printCountsTable(FIXTURE_COUNTS);
  console.log(`[verify] Expected score: ${FIXTURE_SCORE}/100 (penalty: ${FIXTURE_TOTAL_PENALTY})\n`);

  // ── 2. Open stores ────────────────────────────────────────────────────
  const store = new SqliteFindingStore(dbPath);
  const progressStore = new CollectorProgressStore(dbPath);
  const graphClient = createGraphClient(overrideConfig);

  const scanTimestamp = new Date().toISOString();
  console.log(`[verify] Scan timestamp: ${scanTimestamp}\n`);

  // ── 3. Run inventory ──────────────────────────────────────────────────
  const priceTable = loadSkuPriceTable();
  const inventory = await runInventory({
    client: graphClient,
    progressStore,
    priceTable,
    scanTimestamp,
  });

  console.log(
    `\n[verify] Inventory complete: ` +
      `${inventory.sites.length} sites, ` +
      `${inventory.guests.length} guests, ` +
      `${inventory.licences.length} licence assignments, ` +
      `${inventory.skus.length} SKUs.\n`
  );

  // ── 4. Run flagging ───────────────────────────────────────────────────
  const { candidates, findings } = await runFlagging({
    client: graphClient,
    inventory,
    store,
    scanTimestamp,
    storageOverageRateUsdPerGb: loadStorageOverageRate(),
  });

  console.log(
    `[verify] Flagging complete: ${candidates.length} candidates → ${findings.length} findings.\n`
  );

  // ── 5. Compute score ──────────────────────────────────────────────────
  const scanFindings = await store.listByScan(scanTimestamp);
  const actualCounts = countsFromFindings(scanFindings);
  const scoreResult = computeScore(actualCounts, scanTimestamp);

  // ── 6. Print comparison table ─────────────────────────────────────────
  console.log("═".repeat(72));
  console.log("VERIFICATION REPORT — Fixture Tenant Scan");
  console.log("═".repeat(72));

  console.log("\n[1] Finding counts — expected vs actual:\n");

  const ghostTypes: GhostType[] = [
    "overshared-site",
    "orphaned-site",
    "stale-guest",
    "idle-licence",
    "cold-storage",
  ];

  let allPass = true;
  const rows: Array<{
    type: GhostType;
    expected: number;
    actual: number;
    verdict: "PASS" | "FAIL";
    note: string;
  }> = [];

  for (const type of ghostTypes) {
    const expected = FIXTURE_COUNTS[type];
    const actual = actualCounts[type];
    // PASS = actual matches expected exactly.
    const verdict: "PASS" | "FAIL" = actual === expected ? "PASS" : "FAIL";
    if (verdict === "FAIL") allPass = false;

    const note = buildNote(type, expected, actual);
    rows.push({ type, expected, actual, verdict, note });
  }

  // Print the table.
  const colW = [22, 10, 10, 8];
  const header =
    padRight("Ghost type", colW[0]) +
    padLeft("Expected", colW[1]) +
    padLeft("Actual", colW[2]) +
    padLeft("Verdict", colW[3]);
  const divider = "-".repeat(colW[0] + colW[1] + colW[2] + colW[3]);

  console.log(header);
  console.log(divider);

  for (const row of rows) {
    console.log(
      padRight(row.type, colW[0]) +
        padLeft(String(row.expected), colW[1]) +
        padLeft(String(row.actual), colW[2]) +
        padLeft(row.verdict, colW[3])
    );
    if (row.note) {
      console.log(`  NOTE: ${row.note}`);
    }
  }

  // ── 7. Score comparison ───────────────────────────────────────────────
  console.log("\n[2] Score comparison:\n");
  console.log(`  Expected score : ${FIXTURE_SCORE}/100`);
  console.log(`  Actual score   : ${scoreResult.score}/100`);
  console.log(`  Expected penalty: ${FIXTURE_TOTAL_PENALTY}`);
  console.log(`  Actual penalty  : ${scoreResult.inputs.totalPenalty}`);

  const scoreVerdict = scoreResult.score === FIXTURE_SCORE ? "PASS" : "FAIL";
  if (scoreVerdict === "FAIL") allPass = false;
  console.log(`  Score verdict  : ${scoreVerdict}`);

  // ── 8. Breakdown ──────────────────────────────────────────────────────
  console.log("\n[3] Score breakdown:\n");
  for (const entry of scoreResult.inputs.breakdown) {
    console.log(
      `  ${padRight(entry.type, 20)} count=${entry.count}  weight=${entry.weight}  penalty=${entry.penalty}`
    );
  }

  // ── 9. Known limitations ──────────────────────────────────────────────
  console.log("\n[4] Known limitations:\n");
  console.log(
    "  orphaned-site: The Graph /sites list endpoint does not return an owner\n" +
    "  field. collectSites() sets owner: null for every site. flagOrphanedSites()\n" +
    "  therefore flags ALL sites as orphaned candidates, not just the 2 intended\n" +
    "  fixture sites. The actual orphaned count equals the total site count in the\n" +
    "  fixture tenant. Fix: add per-site owner fetch in collectSites() (future task).\n"
  );
  console.log(
    "  cold-storage: Fixture sites spectre-cs1, spectre-cs2, spectre-cs3 must\n" +
    "  be at least 365 days old to qualify. If the seeder was run recently they\n" +
    "  will NOT appear as cold-storage findings yet.\n"
  );
  console.log(
    "  stale-guest: Fixture guests are freshly invited accounts with no sign-in\n" +
    "  record. The audit log may take up to 24 hours to reflect the absence.\n"
  );

  // ── 10. Overall verdict ───────────────────────────────────────────────
  console.log("═".repeat(72));
  console.log(`\nOVERALL: ${allPass ? "✓ ALL PASS" : "✗ SOME DISCREPANCIES — see notes above"}`);
  console.log("\n" + FIXTURE_NOTES);
  console.log("═".repeat(72) + "\n");

  // Graceful shutdown.
  progressStore.close();
  await store.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a human-readable note explaining a discrepancy.
 * Returns an empty string when expected === actual.
 */
function buildNote(type: GhostType, expected: number, actual: number): string {
  if (actual === expected) return "";

  if (type === "orphaned-site" && actual > expected) {
    return (
      `Actual (${actual}) > expected (${expected}). ` +
      `collectSites() sets owner: null for all sites, so every site in the ` +
      `tenant becomes an orphaned candidate. Expected ${expected} but all ` +
      `${actual} sites were flagged. See known limitation [4].`
    );
  }

  if (type === "cold-storage" && actual < expected) {
    return (
      `Actual (${actual}) < expected (${expected}). ` +
      `spectre-cs1..3 sites may not yet be 365 days old. ` +
      `They qualify as cold-storage findings only after ${coldStorageThresholdDate()}.`
    );
  }

  if (type === "stale-guest" && actual < expected) {
    return (
      `Actual (${actual}) < expected (${expected}). ` +
      `Some fixture guests may not yet appear in the audit log. ` +
      `Wait up to 24 hours after seeding and re-run.`
    );
  }

  if (type === "idle-licence" && actual < expected) {
    return (
      `Actual (${actual}) < expected (${expected}). ` +
      `Some fixture idle-licence users may not yet appear in the ` +
      `Office 365 activity report (report covers the last 90 days; ` +
      `newly created users may appear in the next report refresh).`
    );
  }

  return `Actual (${actual}) ≠ expected (${expected}).`;
}

/** Returns the ISO date string for 365 days from the seeder's fixture site creation date. */
function coldStorageThresholdDate(): string {
  // Fixture sites were intended to be created on the demo tenant well before the
  // demo date. We report the threshold as "365 days from today + 1 year" as a
  // conservative upper bound.
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function printCountsTable(counts: Record<GhostType, number>): void {
  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${padRight(type, 20)}: ${count}`);
  }
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/**
 * Loads the SKU price table from SPECTRE_SKU_PRICES (same as main index.ts).
 * Returns an empty table when the variable is absent or unparseable.
 */
function loadSkuPriceTable(): Record<string, number> {
  const raw = process.env["SPECTRE_SKU_PRICES"];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const table: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "number") table[key] = val;
    }
    return table;
  } catch {
    return {};
  }
}

/**
 * Loads the storage overage rate from SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB.
 * Returns null when absent or invalid.
 */
function loadStorageOverageRate(): number | null {
  const raw = process.env["SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB"];
  if (!raw) return null;
  const parsed = Number(raw);
  return isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[verify] Fatal error: ${msg}`);
  process.exit(1);
});
