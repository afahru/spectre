/**
 * seeder/constants.ts
 *
 * Fixture counts for the Spectre demo tenant.
 *
 * These constants are the single source of truth for both:
 *   - The seeder (src/seeder/index.ts), which creates exactly this many
 *     fixture objects in the dev tenant via Graph write calls.
 *   - The verifier (src/seeder/verify.ts), which compares the scan output
 *     against these constants so the two are always in sync.
 *   - The scorer unit tests (src/scorer/__tests__/scorer.test.ts), which
 *     declare FIXTURE_COUNTS matching these values.
 *
 * IMPORTANT: these are counts of *expected scan findings*, not raw objects.
 * See FIXTURE_NOTES below for the mapping from seeded objects to findings.
 *
 * Ghost type         count  weight  penalty
 * ───────────────    ─────  ──────  ───────
 * overshared-site      3      3        9
 * orphaned-site        2      2        4
 * stale-guest          5      2       10
 * idle-licence         4      1        4
 * cold-storage         0      1        0
 *                                     ───
 * totalPenalty                        27
 * score = floor((1 − 27/100) × 100) = 73
 *
 * Cold-storage is 0 by design, not by omission: the three cs fixture sites
 * were created in Nov 2026 and cannot be 365 days old until Nov 2027 (the
 * SharePoint REST API does not allow back-dating lastModifiedDateTime).
 * The cold-storage detector itself is proven by the main scan, which finds
 * the tenant's real cold sites.
 *
 * No number in this file is invented. These counts reflect the Graph objects
 * that the seeder creates — see FIXTURE_NOTES for a detailed mapping.
 */

import type { GhostType } from "../store/types.js";

// ── Expected finding counts ───────────────────────────────────────────────────

/** Expected number of overshared-site findings after seeding + scanning. */
export const FIXTURE_OVERSHARED_COUNT = 3;

/** Expected number of orphaned-site findings after seeding + scanning. */
export const FIXTURE_ORPHANED_COUNT = 2;

/** Expected number of stale-guest findings after seeding + scanning. */
export const FIXTURE_STALE_GUEST_COUNT = 5;

/** Expected number of idle-licence findings after seeding + scanning. */
export const FIXTURE_IDLE_LICENCE_COUNT = 4;

/**
 * Expected number of cold-storage findings after seeding + scanning.
 * 0 BY DESIGN: the cs fixture sites were created in Nov 2026 and cannot be
 * 365 days old until Nov 2027; the SharePoint REST API does not allow
 * back-dating lastModifiedDateTime. The detector is proven by the main scan
 * against the tenant's real cold sites.
 */
export const FIXTURE_COLD_STORAGE_COUNT = 0;

/** All expected finding counts in GhostType-keyed form. */
export const FIXTURE_COUNTS: Record<GhostType, number> = {
  "overshared-site": FIXTURE_OVERSHARED_COUNT,
  "orphaned-site": FIXTURE_ORPHANED_COUNT,
  "stale-guest": FIXTURE_STALE_GUEST_COUNT,
  "idle-licence": FIXTURE_IDLE_LICENCE_COUNT,
  "cold-storage": FIXTURE_COLD_STORAGE_COUNT,
};

/** Expected total penalty (sum of count × weight across all types). */
export const FIXTURE_TOTAL_PENALTY = 27;

/** Expected Copilot-readiness score for this fixture set. */
export const FIXTURE_SCORE = 73;

// ── Fixture site specifications ───────────────────────────────────────────────

/**
 * Display-name prefix for all fixture sites.
 * Used to identify and clean up fixture objects across seeder runs.
 */
export const FIXTURE_SITE_PREFIX = "spectre-fixture-";

/**
 * Specifications for each fixture site the seeder creates.
 *
 * sharingCapability values used by the seeder when updating the site's sharing
 * settings via the SharePoint Admin REST endpoint.
 *
 * Notes on the mapping to findings:
 *
 *   "overshared" sites: sharingCapability = "ExternalUserAndGuestSharing"
 *     → flagOversharedSites() produces one overshared-site candidate per site.
 *
 *   "orphaned" sites: no owner can be associated. The scanner enriches owners
 *     per site (drive owner group) and the seeder assigns the tenant admin as
 *     owner of the six non-orphaned fixture groups, so only spectre-or1/or2
 *     stay ownerless and become the orphaned candidates.
 *
 *   "cold" sites: lastModifiedDateTime far enough in the past to exceed the
 *     365-day threshold. The SharePoint REST API does not allow an application
 *     to back-date lastModifiedDateTime, and these sites were created in Nov
 *     2026, so they will only qualify as cold-storage findings after Nov 2027.
 *     The expected cold-storage count is therefore 0; the detector is proven
 *     by the main scan against the tenant's real cold sites.
 */
export const FIXTURE_SITES: Array<{
  /** Short alias used in the site URL (e.g. "spectre-os1"). */
  alias: string;
  /** Display name shown in Graph and the admin console. */
  displayName: string;
  /** Intended ghost type. */
  ghostType: "overshared-site" | "orphaned-site" | "cold-storage";
  /**
   * SharePoint sharing capability to apply after site creation.
   * null means leave default (used for orphaned and cold-storage sites).
   */
  sharingCapability:
    | "ExternalUserAndGuestSharing"
    | "ExternalUserSharingOnly"
    | null;
}> = [
  // ── Overshared sites (3) ────────────────────────────────────────────────
  {
    alias: "spectre-os1",
    displayName: "Spectre Fixture Overshared 1",
    ghostType: "overshared-site",
    sharingCapability: "ExternalUserAndGuestSharing",
  },
  {
    alias: "spectre-os2",
    displayName: "Spectre Fixture Overshared 2",
    ghostType: "overshared-site",
    sharingCapability: "ExternalUserAndGuestSharing",
  },
  {
    alias: "spectre-os3",
    displayName: "Spectre Fixture Overshared 3",
    ghostType: "overshared-site",
    sharingCapability: "ExternalUserSharingOnly",
  },
  // ── Orphaned sites (2) ──────────────────────────────────────────────────
  // These two intentionally have no owner: the seeder assigns the tenant
  // admin as owner of the other six fixture groups, so only or1/or2 stay
  // ownerless and become the orphaned candidates when the scan runs.
  {
    alias: "spectre-or1",
    displayName: "Spectre Fixture Orphaned 1",
    ghostType: "orphaned-site",
    sharingCapability: null,
  },
  {
    alias: "spectre-or2",
    displayName: "Spectre Fixture Orphaned 2",
    ghostType: "orphaned-site",
    sharingCapability: null,
  },
  // ── Cold storage sites (3) ─────────────────────────────────────────────
  // The SharePoint REST API does not allow back-dating lastModifiedDateTime,
  // so these sites (created Nov 2026) will only qualify as cold-storage
  // findings after Nov 2027. The expected cold-storage count is 0 until then;
  // the seeder still creates them so the demo tenant carries the full fixture
  // set and the detector is exercised on the tenant's real cold sites.
  {
    alias: "spectre-cs1",
    displayName: "Spectre Fixture Cold 1",
    ghostType: "cold-storage",
    sharingCapability: null,
  },
  {
    alias: "spectre-cs2",
    displayName: "Spectre Fixture Cold 2",
    ghostType: "cold-storage",
    sharingCapability: null,
  },
  {
    alias: "spectre-cs3",
    displayName: "Spectre Fixture Cold 3",
    ghostType: "cold-storage",
    sharingCapability: null,
  },
];

// ── Fixture guest specifications ──────────────────────────────────────────────

/**
 * UPN suffix for fixture guest accounts.
 * Guests are invited with UPN format: alias#EXT#@{tenantDomain}.
 * The seeder invites these external email addresses into the tenant.
 */
export const FIXTURE_GUEST_INVITATIONS: Array<{
  /** Email address to invite as a guest. */
  email: string;
  /** Display name for the guest. */
  displayName: string;
  /**
   * Days-ago for the last sign-in.
   * The seeder cannot back-date sign-in logs (audit logs are read-only);
   * instead it invites guests and sets lastSignInDateTime to null by not
   * triggering a sign-in, relying on "never signed in" = stale.
   * For guests that need to appear as "signed in 90+ days ago", a
   * manual sign-in must have occurred; the seeder documents the alias.
   * null = never signed in (the stale condition via null lastSignInDateTime).
   */
  staleReason: "never-signed-in" | "signed-in-over-90-days-ago";
}> = [
  // ── Stale guests (5) — all will have lastSignInDateTime = null
  // because a freshly invited guest account has no sign-in record,
  // which satisfies the stale condition (null = no sign-in on record).
  {
    email: "spectre.ghost1@outlook.com",
    displayName: "Spectre Ghost One",
    staleReason: "never-signed-in",
  },
  {
    email: "spectre.ghost2@outlook.com",
    displayName: "Spectre Ghost Two",
    staleReason: "never-signed-in",
  },
  {
    email: "spectre.ghost3@outlook.com",
    displayName: "Spectre Ghost Three",
    staleReason: "never-signed-in",
  },
  {
    email: "spectre.ghost4@outlook.com",
    displayName: "Spectre Ghost Four",
    staleReason: "never-signed-in",
  },
  {
    email: "spectre.ghost5@outlook.com",
    displayName: "Spectre Ghost Five",
    staleReason: "never-signed-in",
  },
];

// ── Fixture licence specifications ────────────────────────────────────────────

/**
 * Display-name prefix for fixture internal (member) users assigned licences.
 * The seeder creates member users, assigns them an M365 SKU, and does NOT
 * trigger any M365 activity — so the activity report will show no activity,
 * satisfying the idle-licence condition (lastActivityDateTime = null).
 */
export const FIXTURE_LICENCE_USERS: Array<{
  /** UPN prefix; full UPN is built as "{upnPrefix}@{tenantDomain}". */
  upnPrefix: string;
  /** Display name. */
  displayName: string;
}> = [
  { upnPrefix: "spectre-idle1", displayName: "Spectre Idle User 1" },
  { upnPrefix: "spectre-idle2", displayName: "Spectre Idle User 2" },
  { upnPrefix: "spectre-idle3", displayName: "Spectre Idle User 3" },
  { upnPrefix: "spectre-idle4", displayName: "Spectre Idle User 4" },
];

// ── Fixture NOTES ─────────────────────────────────────────────────────────────

/**
 * Human-readable explanation of how seeded objects map to expected findings.
 *
 * overshared-site (3):
 *   spectre-os1 and spectre-os2 have sharingCapability set to
 *   "ExternalUserAndGuestSharing" (anonymous links enabled).
 *   spectre-os3 has "ExternalUserSharingOnly".
 *   flagOversharedSites() flags these three.
 *
 * orphaned-site (2):
 *   spectre-or1 and spectre-or2 intentionally have no owner. The scanner
 *   enriches owners per site (drive owner group) and the seeder assigns the
 *   tenant admin as owner of the other six fixture groups, so only these two
 *   appear ownerless. flagOrphanedSites() flags exactly these two.
 *
 * stale-guest (5):
 *   Five guests (spectre.ghost1..5@outlook.com) are invited but never sign in.
 *   lastSignInDateTime = null satisfies the stale condition.
 *
 * idle-licence (4):
 *   Four member users (spectre-idle1..4) are assigned an available SKU but
 *   generate no M365 activity.  The activity report shows no entry for them,
 *   so lastActivityDateTime = null, satisfying the idle condition.
 *
 * cold-storage (0 by design):
 *   spectre-cs1, spectre-cs2, spectre-cs3 must exist on the tenant AND must
 *   not have been modified in the last 365 days.
 *   CONSTRAINT: The SharePoint REST API does not allow backdating
 *   lastModifiedDateTime, and these sites were created in Nov 2026, so they
 *   will not qualify as cold-storage findings until Nov 2027.
 *   The seeder creates them on first run if absent and prints a warning.
 *   The detector is proven by the main scan against the tenant's real
 *   cold sites.
 */
export const FIXTURE_NOTES = `
Fixture seeder — expected findings mapping:
  overshared-site : ${FIXTURE_OVERSHARED_COUNT}  (spectre-os1, spectre-os2, spectre-os3)
  orphaned-site   : ${FIXTURE_ORPHANED_COUNT}  (spectre-or1, spectre-or2)
  stale-guest     : ${FIXTURE_STALE_GUEST_COUNT}  (spectre.ghost1..5@outlook.com — never signed in)
  idle-licence    : ${FIXTURE_IDLE_LICENCE_COUNT}  (spectre-idle1..4 — no M365 activity)
  cold-storage    : ${FIXTURE_COLD_STORAGE_COUNT}  (spectre-cs1, spectre-cs2, spectre-cs3 — created Nov 2026, qualify Nov 2027; expected 0)

  Tenant-wide note: the verifier compares fixture-scoped counts only. The
  main scan also reports the tenant's real sites; those are genuine findings
  on the dev tenant, not fixture discrepancies.

Expected score: ${FIXTURE_SCORE}/100  (penalty ${FIXTURE_TOTAL_PENALTY}/100)
`.trim();
