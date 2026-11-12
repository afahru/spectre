/**
 * flagger/storage.ts
 *
 * Cold-storage flagging heuristic — task 3.4.
 *
 * A site is flagged as cold when it has had no modification in 365 or more
 * days.  The finding includes the site's storage size (from the drive quota)
 * and the computed monthly overage cost (from the caller-supplied rate, or
 * null when no rate is on file).
 *
 * Requirements traced:
 *   - Req 5.1: cold when no modification in 365+ days; include exact
 *              last-modified date and storage size.
 *   - Req 5.2: monthly storage cost at the tenant's overage rate, or
 *              null when the rate is not on file.
 *
 * Graph conventions:
 *   - Storage size is fetched from /sites/{id}/drive?$select=quota for each
 *     threshold-passing site.
 *   - Calls are batched (up to 20 per $batch request) per graph-conventions.
 *   - 429 Retry-After is honoured via retryAfterDelay.
 *   - If the drive call fails for a site, storageUsedBytes is null — never
 *     invented.
 *
 * Metadata only: no permissions endpoint is called (task 3 constraint).
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { SiteRecord } from "../collector/types.js";
import type { ColdStorageCandidate } from "./types.js";
import { retryAfterDelay } from "../collector/retry.js";

/** Threshold in days for cold-storage detection (requirement 5.1). */
export const COLD_STORAGE_THRESHOLD_DAYS = 365;

/**
 * Monthly storage overage rate in USD per GB.
 * Callers may supply a tenant-specific rate.  null means no rate on file.
 */
export type StorageOverageRate = number | null;

/** Graph $batch request item. */
interface BatchItem {
  id: string;
  method: "GET";
  url: string;
}

/** Graph $batch response item. */
interface BatchResponseItem {
  id: string;
  status: number;
  body?: unknown;
}

interface BatchResponse {
  responses: BatchResponseItem[];
}

/** Drive quota shape we select from Graph. */
interface GraphDrive {
  quota?: {
    used?: number | null;
  };
}

/**
 * Returns cold-storage candidates from the site inventory.
 *
 * For each site that passes the 365-day threshold, the function fetches the
 * site's drive quota using Graph $batch (≤ 20 per batch) so we avoid calling
 * the drive endpoint in a list loop without batching (graph-conventions).
 *
 * @param sites          Full site list from the inventory collector.
 * @param client         Authenticated Graph client (used for drive-quota batch).
 * @param overageRateUsdPerGb  Monthly overage rate per GB, or null (req 5.2).
 * @param referenceDate  Date to compute staleness against.  Defaults to now.
 */
export async function flagColdStorage(
  sites: SiteRecord[],
  client: Client,
  overageRateUsdPerGb: StorageOverageRate = null,
  referenceDate: Date = new Date()
): Promise<ColdStorageCandidate[]> {
  // Step 1: Filter to sites that pass the 365-day threshold.
  const coldSites = sites.filter((s) => isCold(s.lastModifiedDateTime, referenceDate));

  if (coldSites.length === 0) return [];

  // Step 2: Batch-fetch drive quota for each cold site.
  const storageMap = await fetchDriveQuotas(client, coldSites);

  // Step 3: Build candidates with exact Graph numbers.
  const candidates: ColdStorageCandidate[] = [];

  for (const site of coldSites) {
    // lastModifiedDateTime is non-null because isCold() already checked it.
    const lastModifiedAt = site.lastModifiedDateTime as string;

    const daysSinceModification = computeDaysSince(lastModifiedAt, referenceDate);

    const storageUsedBytes = storageMap.get(site.id) ?? null;

    // Compute overage cost only when both the rate and the size are known.
    // Never invent either value (req 5.2).
    const storageOverageCostUsd = computeOverageCost(storageUsedBytes, overageRateUsdPerGb);

    candidates.push({
      type: "cold-storage",
      siteId: site.id,
      siteDisplayName: site.displayName,
      owner: site.owner,
      lastModifiedAt,
      daysSinceModification,
      storageUsedBytes,
      storageOverageCostUsd,
    });
  }

  return candidates;
}

/**
 * Returns true when a site's lastModifiedDateTime is 365+ days before
 * referenceDate, or when the value is null (unknown = not flagged;
 * we never flag on missing data).
 */
function isCold(lastModifiedDateTime: string | null, referenceDate: Date): boolean {
  if (!lastModifiedDateTime) return false; // unknown — cannot flag

  const modDate = new Date(lastModifiedDateTime);
  if (!isFinite(modDate.getTime())) return false; // unparseable — cannot flag

  const daysSince = computeDaysSince(lastModifiedDateTime, referenceDate);
  return daysSince >= COLD_STORAGE_THRESHOLD_DAYS;
}

/** Computes the number of full days between a date string and referenceDate. */
function computeDaysSince(isoDate: string, referenceDate: Date): number {
  const d = new Date(isoDate);
  const diffMs = referenceDate.getTime() - d.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Computes the monthly overage cost in USD.
 * Returns null when either value is unknown (never invents a number).
 *
 * @param storageUsedBytes   Storage in bytes, or null.
 * @param rateUsdPerGb       Monthly rate per GB, or null.
 */
function computeOverageCost(
  storageUsedBytes: number | null,
  rateUsdPerGb: number | null
): number | null {
  if (storageUsedBytes === null || rateUsdPerGb === null) return null;
  const usedGb = storageUsedBytes / (1024 * 1024 * 1024);
  return usedGb * rateUsdPerGb;
}

/**
 * Fetches drive quota for a list of sites using Graph $batch.
 * Returns a Map of siteId → storageUsedBytes (null when the call failed).
 *
 * Graph $batch allows up to 20 requests per batch.
 */
async function fetchDriveQuotas(
  client: Client,
  sites: SiteRecord[]
): Promise<Map<string, number | null>> {
  const storageMap = new Map<string, number | null>();
  const BATCH_SIZE = 20;

  for (let i = 0; i < sites.length; i += BATCH_SIZE) {
    const chunk = sites.slice(i, i + BATCH_SIZE);

    const requests: BatchItem[] = chunk.map((site) => ({
      id: `drive-${site.id}`,
      method: "GET",
      url: `/sites/${site.id}/drive?$select=quota`,
    }));

    let batchResp: BatchResponse;
    try {
      batchResp = await retryAfterDelay(
        () => client.api("/$batch").post({ requests }) as Promise<BatchResponse>
      );
    } catch (err: unknown) {
      // If the entire batch call fails, record null for all sites in the chunk.
      console.warn(
        `[flagger/storage] $batch drive-quota call failed: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `storageUsedBytes will be null for ${chunk.length} sites.`
      );
      for (const site of chunk) {
        storageMap.set(site.id, null);
      }
      continue;
    }

    for (const resp of batchResp.responses ?? []) {
      const siteId = resp.id.startsWith("drive-")
        ? resp.id.slice("drive-".length)
        : null;

      if (!siteId) continue;

      if (resp.status === 200) {
        const drive = resp.body as GraphDrive;
        const used = drive?.quota?.used ?? null;
        // Ensure the value is a number before recording it.
        storageMap.set(siteId, typeof used === "number" ? used : null);
      } else {
        // 403, 404, or other — record null, never invent a size.
        storageMap.set(siteId, null);
      }
    }
  }

  return storageMap;
}
