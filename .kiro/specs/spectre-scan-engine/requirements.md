# Spectre Scan Engine — Requirements

## Introduction

The scan engine inventories an M365 tenant (sites, sharing links, guests,
licences, storage) and turns raw Graph data into scored findings: the five
ghosts (overshared sites, orphaned sites, stale guests, idle licences, cold
storage). Every finding carries a risk score, the exact numbers behind it, and
the owner it belongs to, so the attestation loop and the admin console both
work from one source of truth.

## Requirements

### Requirement 1: Tenant site inventory

**User Story:** As an admin, I want a complete list of SharePoint sites in the
tenant with owner, last activity, and storage, so the scan has a full inventory
to work from.

#### Acceptance Criteria

1. WHEN the scan runs, THE System SHALL list all SharePoint sites via the
   Graph `/sites` endpoint with `$select` limited to id, displayName,
   webUrl, createdDateTime, lastModifiedDateTime.
2. WHEN a site is group-connected and its backing Microsoft 365 group has zero
   owners, THE System SHALL flag it as a candidate orphaned site and record the
   absence explicitly, never inventing an owner. A site with no drive or no
   backing group has no owner that applies (not-applicable) and SHALL NOT be
   flagged. A site whose owner lookup failed or never ran is unknown and SHALL
   NOT be flagged; unknown stays unknown.
3. WHEN the inventory completes, THE System SHALL persist the site list with a
   scan timestamp so a later run can diff against it.

### Requirement 2: Sharing-link detection (overshared sites)

**User Story:** As an admin, I want to know which sites are shared with
"anyone with the link" or with the whole organisation, so Copilot-blocking
oversharing is visible.

#### Acceptance Criteria

1. WHEN a drive item is flagged for permission review, THE System SHALL fetch
   its permissions via `GET /drives/{drive-id}/items/{item-id}/permissions`
   and record the `link` facet scope (anonymous, organization, users).
2. WHEN a site has an anonymous-scope link, THE System SHALL create an
   overshared-site finding with the link scope and the item it applies to.
3. THE System SHALL NOT fetch permissions inside a list loop without a cache;
   the scan SHALL inventory first, then fetch permissions only for flagged
   items.

### Requirement 3: Stale guest detection

**User Story:** As an admin, I want guests who have not signed in for 90+ days
flagged, so dormant external access is visible.

#### Acceptance Criteria

1. WHEN the scan runs, THE System SHALL list guest users and their last
   sign-in from the audit/sign-in logs.
2. WHEN a guest has no sign-in in 90 days or more, THE System SHALL create a
   stale-guest finding with the exact last sign-in date (or "never", when the
   log has no sign-in for that guest).
3. WHEN a guest's sponsor has left the company, THE System SHALL flag the
   guest as ownerless in the finding.

### Requirement 4: Idle licence detection

**User Story:** As an admin, I want licences assigned to users with no activity
in 90 days flagged with a dollar figure, so licence waste is quantified.

#### Acceptance Criteria

1. WHEN the scan runs, THE System SHALL read assigned licences via
   `/subscribedSkus` and per-user activity, and SHALL flag licences with no
   activity in 90 days.
2. WHEN an idle licence is flagged, THE System SHALL attach the monthly cost
   from the tenant's SKU price table, never a guessed price.
3. WHEN no price is on file for a SKU, THE System SHALL record the cost as
   unknown rather than inventing one.

### Requirement 5: Cold storage detection

**User Story:** As an admin, I want sites unmodified for over a year flagged
with their storage size, so cold content is visible for archiving.

#### Acceptance Criteria

1. WHEN a site has no modification in 365 days or more, THE System SHALL
   create a cold-storage finding with the exact last-modified date and the
   site's storage size.
2. WHEN the finding is created, THE System SHALL compute the monthly storage
   cost at the tenant's overage rate, or record it as unknown when the rate
   is not on file.

### Requirement 6: Copilot-readiness score

**User Story:** As an admin, I want a single 0–100 Copilot-readiness score,
so the tenant's posture is readable at a glance.

#### Acceptance Criteria

1. WHEN the scan completes, THE System SHALL compute a score from the five
   ghost counts, weighted by severity, and SHALL show the formula inputs
   beside the score.
2. WHEN a ghost count is zero, THE System SHALL contribute zero penalty for
   that ghost, never a negative penalty.
3. THE System SHALL recompute the score on every completed scan and keep the
   previous score for trend display.
