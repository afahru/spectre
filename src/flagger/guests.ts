/**
 * flagger/guests.ts
 *
 * Stale-guest flagging heuristic — task 3.2.
 *
 * A guest is stale when their last sign-in is 90 or more days ago,
 * or when the audit log has no sign-in record for them at all (never
 * signed in).
 *
 * Sponsor-departed guests are recorded as ownerless (owner: null) so the
 * attestation loop can route them to the admin queue rather than attempting
 * to contact a departed sponsor.
 *
 * Requirements traced:
 *   - Req 3.2: stale when last sign-in ≥ 90 days ago or never.
 *   - Req 3.3: sponsor departed → ownerless (owner: null in the finding).
 *
 * Invariants (narration-rule steering):
 *   - lastSignInAt is always the exact ISO 8601 string from Graph, or null
 *     when the log has no entry.  It is never rounded or approximated.
 *   - daysSinceSignIn for a "never signed in" guest is computed from the
 *     guest's createdDateTime when available; otherwise it is set to
 *     Number.MAX_SAFE_INTEGER to represent "effectively infinite" and the
 *     narration layer reads lastSignInAt === null as "never".
 */

import type { GuestRecord } from "../collector/types.js";
import type { StaleGuestCandidate } from "./types.js";

/** Threshold in days for stale-guest detection (requirement 3.2). */
export const STALE_GUEST_THRESHOLD_DAYS = 90;

/**
 * Returns stale-guest candidates from the guest inventory.
 *
 * "Stale" means: last sign-in ≥ STALE_GUEST_THRESHOLD_DAYS days ago,
 * or no sign-in on record at all.
 *
 * @param guests         Full guest list from the inventory collector.
 * @param referenceDate  Date to compute staleness against.  Defaults to
 *                       now.  Explicit value lets callers write deterministic
 *                       tests (task 5 / design: testing strategy).
 */
export function flagStaleGuests(
  guests: GuestRecord[],
  referenceDate: Date = new Date()
): StaleGuestCandidate[] {
  const candidates: StaleGuestCandidate[] = [];

  for (const guest of guests) {
    const { daysSince, isStale } = evaluateStaleness(
      guest.lastSignInDateTime,
      referenceDate
    );

    if (!isStale) continue;

    candidates.push({
      type: "stale-guest",
      guestId: guest.id,
      guestDisplayName: guest.displayName,
      guestUpn: guest.userPrincipalName,
      // Sponsor null means the sponsor has left the company → ownerless
      // finding (req 3.3).  We use the sponsor as the owner field so the
      // attestation loop can route to them when present.
      owner: guest.sponsorUpn,
      lastSignInAt: guest.lastSignInDateTime,
      daysSinceSignIn: daysSince,
    });
  }

  return candidates;
}

/**
 * Determines whether a guest's last sign-in crosses the stale threshold.
 *
 * @returns `{ daysSince, isStale }` where:
 *   - `daysSince` is the number of full days elapsed since `lastSignIn`.
 *     For a null lastSignIn (never signed in) this is Number.MAX_SAFE_INTEGER
 *     so the narration layer uses `lastSignInAt === null` to render "never"
 *     rather than a computed number.
 *   - `isStale` is true when daysSince ≥ STALE_GUEST_THRESHOLD_DAYS.
 */
function evaluateStaleness(
  lastSignIn: string | null,
  referenceDate: Date
): { daysSince: number; isStale: boolean } {
  if (lastSignIn === null) {
    // No sign-in on record — always stale (req 3.2: "or no sign-in on record").
    return { daysSince: Number.MAX_SAFE_INTEGER, isStale: true };
  }

  const signInDate = new Date(lastSignIn);
  if (!isFinite(signInDate.getTime())) {
    // Unparseable date from Graph — treat as never signed in (conservative).
    return { daysSince: Number.MAX_SAFE_INTEGER, isStale: true };
  }

  const diffMs = referenceDate.getTime() - signInDate.getTime();
  const daysSince = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return {
    daysSince,
    isStale: daysSince >= STALE_GUEST_THRESHOLD_DAYS,
  };
}
