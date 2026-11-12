/**
 * flagger/types.ts
 *
 * Types produced by the flagging heuristics (task 3).
 *
 * A FlaggedCandidate is an intermediate result — it carries all the
 * metadata-derived numbers needed to build a Finding.  No permission
 * endpoint is called at this stage; that is task 4.
 *
 * Invariants (narration-rule steering):
 *   - Every numeric field that may be unknown uses `null`, never 0 or -1.
 *   - `owner` is null when Graph did not return one — never guessed.
 *   - `monthlyCostUsd` and `storageOverageCostUsd` are null when no price
 *     is on file — never guessed (requirements 4.3, 5.2).
 */

import type { GhostType } from "../store/types.js";

/**
 * A site flagged as an overshared candidate from site-level metadata.
 * No permissions endpoint is called (task 3.1).
 *
 * Graph source: site.sharingCapability returned by /sites list.
 * "externalUserAndGuestSharing" means anonymous links are enabled at the
 * site level — the site is a candidate for oversharing.
 * "externalUserSharingOnly" means external (non-anonymous) sharing is
 * enabled — also flagged, with the actual scope recorded.
 */
export interface OversharedSiteCandidate {
  type: "overshared-site";
  siteId: string;
  siteDisplayName: string | null;
  owner: string | null;
  /** Raw sharingCapability string from Graph. Never invented. */
  sharingCapability: string;
}

/**
 * A site flagged as an orphaned candidate because Graph returned no owner.
 * Task 3.1.
 */
export interface OrphanedSiteCandidate {
  type: "orphaned-site";
  siteId: string;
  siteDisplayName: string | null;
  /** Always null — this is the reason for the candidate. */
  owner: null;
}

/**
 * A guest user flagged as stale — last sign-in 90+ days ago or never.
 * Task 3.2.
 *
 * Graph sources:
 *   - guest.lastSignInDateTime from /auditLogs/signIns (null = never).
 *   - guest.sponsorUpn from /users/{id}/manager (null = sponsor departed).
 */
export interface StaleGuestCandidate {
  type: "stale-guest";
  guestId: string;
  guestDisplayName: string | null;
  guestUpn: string | null;
  /**
   * Sponsor UPN from Graph.
   * null means no sponsor on record (sponsor departed → ownerless finding).
   */
  owner: string | null;
  /**
   * ISO 8601 of the last sign-in, or null when the audit log has no entry.
   * This is the exact value from Graph — never approximated.
   */
  lastSignInAt: string | null;
  /** Number of days since the last sign-in, computed from lastSignInAt. */
  daysSinceSignIn: number;
}

/**
 * A per-user licence assignment flagged as idle — no activity in 90 days.
 * Task 3.3.
 *
 * Graph sources:
 *   - lastActivityDateTime from /reports/getOffice365ActiveUserDetail.
 *   - monthlyCostUsd from the caller-supplied SKU price table (null = unknown).
 */
export interface IdleLicenceCandidate {
  type: "idle-licence";
  userId: string;
  userDisplayName: string | null;
  userUpn: string | null;
  skuId: string;
  skuPartNumber: string;
  owner: string | null;
  /**
   * Last activity date from Graph.  null = no activity recorded in 90 days.
   * This is the exact value from Graph — never rounded or invented.
   */
  lastActivityAt: string | null;
  /**
   * Monthly cost from the SKU price table.
   * null means no price is on file — never invented (req 4.3).
   */
  monthlyCostUsd: number | null;
}

/**
 * A site flagged as cold storage — not modified in 365+ days.
 * Task 3.4.
 *
 * Graph sources:
 *   - lastModifiedDateTime from /sites list.
 *   - storageUsedBytes from /sites/{id}/drive?$select=quota (fetched on
 *     demand for threshold-passing sites, may be null if call fails).
 *   - storageOverageCostUsd from the caller-supplied overage rate (null = unknown).
 */
export interface ColdStorageCandidate {
  type: "cold-storage";
  siteId: string;
  siteDisplayName: string | null;
  owner: string | null;
  /**
   * Exact lastModifiedDateTime from Graph — never rounded or invented.
   */
  lastModifiedAt: string;
  /** Number of days since last modification, computed from lastModifiedAt. */
  daysSinceModification: number;
  /**
   * Storage used in bytes from the site's drive quota.
   * null when the Graph drive call did not succeed or return a quota.
   */
  storageUsedBytes: number | null;
  /**
   * Monthly overage cost in USD.
   * null when no overage rate is on file — never invented (req 5.2).
   */
  storageOverageCostUsd: number | null;
}

/** Union of all candidate types produced by task-3 flaggers. */
export type FlaggedCandidate =
  | OversharedSiteCandidate
  | OrphanedSiteCandidate
  | StaleGuestCandidate
  | IdleLicenceCandidate
  | ColdStorageCandidate;

/** Severity weights for each ghost type, used by the scorer (task 5). */
export const SEVERITY_WEIGHTS: Record<GhostType, number> = {
  "overshared-site": 3,
  "orphaned-site": 2,
  "stale-guest": 2,
  "idle-licence": 1,
  "cold-storage": 1,
};
