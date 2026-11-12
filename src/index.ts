/**
 * index.ts — Spectre scan engine entry point
 *
 * Startup sequence:
 *   1. Load and validate config (fails fast if env vars are missing).
 *   2. Open the findings store and progress store.
 *   3. Build the Graph client.
 *   4. Run (or resume) the inventory collection.
 *   5. Run the flagging heuristics (task 3) — metadata only, no permissions.
 *   6. Run the permissions fetcher (task 4) — flagged items only, with cache.
 *   7. Compute the Copilot-readiness score (task 5) — deterministic, no I/O.
 */

import { loadConfig } from "./config.js";
import { createGraphClient } from "./graph/index.js";
import { SqliteFindingStore } from "./store/index.js";
import { CollectorProgressStore, runInventory, fetchPermissions } from "./collector/index.js";
import { runFlagging } from "./flagger/index.js";
import { computeScore, countsFromFindings } from "./scorer/index.js";

async function main(): Promise<void> {
  // 1. Validate config — throws with a clear message if any variable is absent.
  const config = loadConfig();

  // 2. Open the findings store and the collector progress store.
  const store = new SqliteFindingStore(config.dbPath);
  const progressStore = new CollectorProgressStore(config.dbPath);

  // 3. Build the authenticated Graph client.
  const graphClient = createGraphClient(config);

  // Determine the scan timestamp: start a new scan or identify the current one.
  const scanTimestamp = new Date().toISOString();
  const latestScan = await store.latestScanTimestamp();
  if (latestScan) {
    console.log(`Last scan recorded: ${latestScan}`);
  } else {
    console.log("No previous scan on record. Starting the first scan.");
  }

  // 4. Run the inventory.
  //    SKU price table: load from environment if provided, otherwise empty
  //    (monthlyCostUsd will be null for all SKUs — req 4.3).
  const priceTable = loadSkuPriceTable();
  const inventory = await runInventory({
    client: graphClient,
    progressStore,
    priceTable,
    scanTimestamp,
  });

  console.log(
    `Scan ${scanTimestamp} inventory complete: ` +
      `${inventory.sites.length} sites, ` +
      `${inventory.guests.length} guests, ` +
      `${inventory.licences.length} licence assignments, ` +
      `${inventory.skus.length} SKUs.`
  );

  // 5. Run the flagging heuristics (task 3).
  //    No permissions endpoint is called here; that is task 4.
  const { candidates, findings } = await runFlagging({
    client: graphClient,
    inventory,
    store,
    scanTimestamp,
    storageOverageRateUsdPerGb: loadStorageOverageRate(),
  });

  console.log(
    `Scan ${scanTimestamp} flagging complete: ` +
      `${candidates.length} candidates → ${findings.length} findings persisted.`
  );

  // 6. Fetch permissions for flagged items (task 4).
  //    Only overshared-site findings get a permissions call; nothing else.
  //    Results are cached by (siteId, scanTimestamp) so a re-run skips
  //    already-resolved items.  Unreadable items are recorded, not thrown.
  const permResult = await fetchPermissions({
    client: graphClient,
    findings,
    store,
    dbPath: config.dbPath,
    scanTimestamp,
  });

  console.log(
    `Scan ${scanTimestamp} permissions: ` +
      `fetched=${permResult.fetched}, cached=${permResult.cached}, ` +
      `unreadable=${permResult.unreadable}.`
  );

  // 7. Compute the Copilot-readiness score (task 5).
  //    Pure function: reads the findings for this scan from the store,
  //    counts them by type, then computes score = max(0, floor(100 × (1 − penalty/maxPenalty))).
  //    No Graph calls, no invented numbers.
  const scanFindings = await store.listByScan(scanTimestamp);
  const ghostCounts = countsFromFindings(scanFindings);
  const scoreResult = computeScore(ghostCounts, scanTimestamp);

  console.log(
    `Scan ${scanTimestamp} readiness score: ${scoreResult.score}/100 ` +
      `(penalty=${scoreResult.inputs.totalPenalty}/${scoreResult.inputs.maxPenalty}).`
  );
  console.log(
    "  Breakdown: " +
      scoreResult.inputs.breakdown
        .map((b) => `${b.type}=${b.count}×${b.weight}=${b.penalty}`)
        .join(", ")
  );

  // Graceful shutdown.
  progressStore.close();
  await store.close();
  console.log("Spectre scan engine done.");
}

/**
 * Loads the SKU price table from the SPECTRE_SKU_PRICES environment variable.
 *
 * Format: a JSON object mapping SKU part numbers to monthly USD costs.
 * Example: SPECTRE_SKU_PRICES='{"ENTERPRISEPACK":22,"FLOW_FREE":0}'
 *
 * If the variable is absent or unparseable, returns an empty table.
 * monthlyCostUsd will then be null for all SKUs (req 4.3: never guessed).
 */
function loadSkuPriceTable(): Record<string, number> {
  const raw = process.env["SPECTRE_SKU_PRICES"];
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(
        "[config] SPECTRE_SKU_PRICES is not a JSON object — price table will be empty."
      );
      return {};
    }
    // Validate that all values are numbers.
    const table: Record<string, number> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "number") {
        table[key] = val;
      } else {
        console.warn(
          `[config] SPECTRE_SKU_PRICES: value for SKU "${key}" is not a number — skipped.`
        );
      }
    }
    return table;
  } catch {
    console.warn(
      "[config] SPECTRE_SKU_PRICES could not be parsed as JSON — price table will be empty."
    );
    return {};
  }
}

/**
 * Loads the storage overage rate from the SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB
 * environment variable.
 *
 * Returns null when the variable is absent or not a valid positive number
 * (req 5.2: cost is null when the rate is not on file — never guessed).
 */
function loadStorageOverageRate(): number | null {
  const raw = process.env["SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB"];
  if (!raw) return null;

  const parsed = Number(raw);
  if (!isFinite(parsed) || parsed < 0) {
    console.warn(
      `[config] SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB="${raw}" is not a valid non-negative number — overage rate will be null.`
    );
    return null;
  }
  return parsed;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
