/**
 * flagger/licences.ts
 *
 * Idle-licence flagging heuristic — task 3.3.
 *
 * A licence assignment is idle when the user has had no M365 activity in
 * the last 90 days (or has no activity record at all).
 *
 * Cost is attached from the caller-supplied SKU price table.  When the SKU
 * is absent from the table, monthlyCostUsd is null — it is never guessed
 * (requirement 4.3, narration-rule steering).
 *
 * Requirements traced:
 *   - Req 4.1: flag licences with no activity in 90 days.
 *   - Req 4.2: attach monthly cost from SKU price table (never guessed).
 *   - Req 4.3: cost is null when no price is on file.
 *
 * Note on the threshold:
 *   The activity report from /reports/getOffice365ActiveUserDetail(period='D90')
 *   already covers only the last 90 days.  A user absent from the report (or
 *   present with a lastActivityDateTime older than 90 days ago) is idle.
 *   We apply a secondary check here so this module is independently testable.
 */

import type { UserLicenceRecord } from "../collector/types.js";
import type { IdleLicenceCandidate } from "./types.js";

/** Threshold in days for idle-licence detection (requirement 4.1). */
export const IDLE_LICENCE_THRESHOLD_DAYS = 90;

/**
 * Returns idle-licence candidates from the licence-assignment inventory.
 *
 * A licence assignment is idle when:
 *   - lastActivityDateTime is null (no activity in the report window), OR
 *   - lastActivityDateTime is a date ≥ IDLE_LICENCE_THRESHOLD_DAYS days ago.
 *
 * @param licences       Full licence-assignment list from the collector.
 * @param referenceDate  Date to compute idleness against.  Defaults to now;
 *                       explicit value enables deterministic tests.
 */
export function flagIdleLicences(
  licences: UserLicenceRecord[],
  referenceDate: Date = new Date()
): IdleLicenceCandidate[] {
  const candidates: IdleLicenceCandidate[] = [];

  for (const lic of licences) {
    const { isIdle } = evaluateIdleness(lic.lastActivityDateTime, referenceDate);

    if (!isIdle) continue;

    candidates.push({
      type: "idle-licence",
      userId: lic.userId,
      userDisplayName: lic.userDisplayName,
      userUpn: lic.userPrincipalName,
      skuId: lic.skuId,
      skuPartNumber: lic.skuPartNumber,
      // Licences have no "owner" separate from the user themselves; we
      // record null so the attestation loop routes to the admin queue.
      owner: null,
      lastActivityAt: lic.lastActivityDateTime,
      // monthlyCostUsd comes directly from the collector's price-table
      // lookup.  It is null when no price is on file (req 4.3).
      monthlyCostUsd: lic.monthlyCostUsd,
    });
  }

  return candidates;
}

/**
 * Determines whether a licence assignment is idle.
 *
 * @returns `{ isIdle }` — true when no activity within the threshold window.
 */
function evaluateIdleness(
  lastActivity: string | null,
  referenceDate: Date
): { isIdle: boolean } {
  if (lastActivity === null) {
    // No activity record — treat as idle (conservative, req 4.1).
    return { isIdle: true };
  }

  const activityDate = new Date(lastActivity);
  if (!isFinite(activityDate.getTime())) {
    // Unparseable date from Graph — treat as idle (conservative).
    return { isIdle: true };
  }

  const diffMs = referenceDate.getTime() - activityDate.getTime();
  const daysSince = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return { isIdle: daysSince >= IDLE_LICENCE_THRESHOLD_DAYS };
}
