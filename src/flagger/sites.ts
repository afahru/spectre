/**
 * flagger/sites.ts
 *
 * Site flagging heuristics — task 3.1.
 *
 * Produces two candidate types from site metadata alone:
 *
 *   OversharedSiteCandidate
 *     A site whose sharingCapability (from Graph) allows anonymous or
 *     external sharing at the site level.  No permissions endpoint is called;
 *     we use the site-level field returned by /sites with $select including
 *     sharingCapability.
 *
 *     Flagged when sharingCapability is one of:
 *       "externalUserAndGuestSharing"  — anonymous links enabled
 *       "externalUserSharingOnly"      — external sharing enabled
 *
 *     The raw sharingCapability string is stored verbatim on the candidate
 *     so the finding narration can quote it exactly (narration-rule steering).
 *
 *   OrphanedSiteCandidate
 *     A group-connected site whose backing group has zero owners
 *     (ownerStatus === 'orphaned'). Sites with no drive or no backing group
 *     ('not-applicable') and sites whose lookup failed ('unknown') are not
 *     flagged. Never invent an owner.
 *
 * Requirements traced:
 *   - Req 1.2: orphaned candidate from no-owner metadata.
 *   - Req 2.2: overshared-site candidate from site-level sharing metadata.
 * Design:
 *   "Overshared candidate: site with sharing settings allowing anonymous or
 *    org-wide links (from site settings, not from per-item permissions)."
 */

import type { SiteRecord } from "../collector/types.js";
import type { OversharedSiteCandidate, OrphanedSiteCandidate } from "./types.js";

/**
 * sharingCapability values that indicate the site-level setting allows
 * anonymous or external sharing.  Stored as a Set for O(1) lookup.
 *
 * Graph-documented values (SharePoint REST):
 *   "disabled"                       — sharing turned off
 *   "existingExternalUserSharingOnly"— existing external users only
 *   "externalUserSharingOnly"        — authenticated external users (B2B)
 *   "externalUserAndGuestSharing"    — anonymous "anyone with the link" enabled
 *
 * We flag the two values that allow reaching external or anonymous users.
 */
const OVERSHARED_CAPABILITY_VALUES = new Set([
  "externalUserAndGuestSharing",
  "externalUserSharingOnly",
]);

/**
 * Returns overshared-site candidates from site metadata.
 *
 * A site is flagged when its sharingCapability (from Graph) is one of the
 * values that allow sharing beyond the internal tenant.
 *
 * No permissions endpoint is called — this is metadata only (task 3.1).
 *
 * @param sites  Full site list from the inventory collector.
 */
export function flagOversharedSites(
  sites: SiteRecord[]
): OversharedSiteCandidate[] {
  const candidates: OversharedSiteCandidate[] = [];

  for (const site of sites) {
    // sharingCapability null means Graph did not return this field.
    // We cannot flag without data — we do not invent a value.
    if (!site.sharingCapability) continue;

    if (OVERSHARED_CAPABILITY_VALUES.has(site.sharingCapability)) {
      candidates.push({
        type: "overshared-site",
        siteId: site.id,
        siteDisplayName: site.displayName,
        owner: site.owner,
        sharingCapability: site.sharingCapability,
      });
    }
  }

  return candidates;
}

/**
 * Returns orphaned-site candidates from site metadata.
 *
 * A site is flagged only when ownerStatus === 'orphaned': group-connected and
 * the backing group has zero owners. owner === null alone is not enough.
 * Requirement 1.2: record the absence explicitly, never invent an owner.
 *
 * @param sites  Full site list from the inventory collector.
 */
export function flagOrphanedSites(
  sites: SiteRecord[]
): OrphanedSiteCandidate[] {
  const candidates: OrphanedSiteCandidate[] = [];

  for (const site of sites) {
    if (site.ownerStatus === "orphaned") {
      candidates.push({
        type: "orphaned-site",
        siteId: site.id,
        siteDisplayName: site.displayName,
        owner: null,
      });
    }
  }

  return candidates;
}
