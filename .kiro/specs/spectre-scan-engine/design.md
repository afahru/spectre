# Spectre Scan Engine — Design

## Overview

The scan engine is a staged, cached pipeline: inventory first, permissions
only for flagged items. This is forced by the Graph constraint that the
permissions collection cannot be expanded in a driveItem list call — each
item needs its own permissions call, so a naive tenant-wide scan would be
slow and throttled.

## Architecture

```
inventory (sites, users, guests, licences)
  -> flag candidates (heuristics on metadata only, no permission calls)
  -> permissions fetch (flagged items only, with cache)
  -> risk scoring (deterministic, no AI in the score)
  -> findings store (scan timestamp, per-finding numbers + owner)
  -> readiness score + cost rollup
```

## Components

### Inventory collector

- `GET /sites/getAllSites?$select=id,displayName,webUrl,createdDateTime,lastModifiedDateTime`
  paged through the full tenant.  `sharingCapability` is **not** in this
  `$select` and is **not fetched separately**: Microsoft Graph (v1.0 and beta)
  does not expose `sharingCapability` on the site resource — including it in
  `$select` returns "Could not find a property named sharingCapability on type
  microsoft.graph.site."  All `SiteRecord.sharingCapability` values are
  therefore `null`; the flagger treats `null` as "data unavailable" and
  produces no overshared-site candidates from site-level metadata.  Overshared
  detection is done via the permissions fetcher (see below).
- `GET /users` (guests filtered by userType), `GET /subscribedSkus`,
  `GET /auditLogs/signIns` (last sign-in per guest, 90-day window).
- All collectors use delta queries where the endpoint supports them, and
  `$select` discipline everywhere (steering: graph-conventions.md).

### Owner enrichment (staged after inventory)

For group-connected SharePoint team sites, the owner is the first owner of
the M365 group that backs the site.  The enrichment step runs after the full
site list is collected (never inside the list loop — graph-conventions
steering) and uses a two-step lookup:

1. `GET /sites/{siteId}/drive?$select=owner`
   → `drive.owner.group.id`  (the backing M365 group)
2. `GET /groups/{groupId}/owners?$select=id,userPrincipalName&$top=1`
   → first owner UPN

Calls are batched (`OWNER_BATCH_SIZE = 10`) to avoid throttling.
Sites without a drive (communication sites, root site) return 404 on step 1 —
`owner` stays `null`.
Groups with no owners (genuinely orphaned group-connected sites) return an
empty owners list — `owner` stays `null`.
Both steps honour Retry-After on 429 via `retryAfterDelay`.
No owner is ever invented — `null` is the signal for "genuinely orphaned".

### Flagging heuristics (metadata only)

- Overshared candidate: produced by the permissions fetcher (see below) when
  `GET /sites/{id}/drive/root/permissions` returns a permission with
  `link.scope === "anonymous"`.  The site-level `sharingCapability` field is
  not available from Graph, so this is the only reliable signal.
- Orphaned candidate: site with no owner after enrichment (`owner === null`).
- Stale guest: last sign-in 90+ days ago, or no sign-in on record.
- Idle licence: assigned SKU with no user activity in 90 days.
- Cold storage: last modified 365+ days ago.

### Permissions fetcher (flagged items only)

- `GET /drives/{drive-id}/items/{item-id}/permissions` per flagged item.
- Records the `link` facet (scope: anonymous / organization / users) and
  `inheritedFrom`.
- In-memory + on-disk cache keyed by item id + scan run, so a re-run does not
  re-fetch unchanged items. Batching via Graph `$batch` where it helps.

### Risk scorer (deterministic)

- Each ghost type has a severity weight; the score is a pure function of the
  finding counts and weights. No model output enters the score.
- Per-finding numbers (who, how many, what they can see) are stored with the
  finding so the narration layer can quote them verbatim.

### Findings store

- One record per finding: type, site/item/guest id, owner, numbers, score
  contribution, scan timestamp, status (open / actioned / dismissed).
- The attestation loop and the admin console read from this store only.

## Correctness properties

- No number in a finding is invented: every figure traces to a Graph
  response or is marked unknown.
- No owner is invented: a finding with no owner is ownerless, never assigned
  to a guess.
- A scan is resumable: if it stops mid-run, the next run resumes from the
  last persisted page, it does not restart the inventory.

## Errors

- Graph throttling (429): back off with the `Retry-After` header, resume the
  same page, never skip it silently.
- Missing permission on a call: record the gap on the finding as "unreadable
  (permission missing)" and continue; the scan never fails the whole run for
  one unreadable item.
- Tenant with zero sites: the scan completes with zero findings and a score
  of 100, not an error.

## Testing strategy

- Unit tests for the scorer against a fixed fixture tenant (seeded sites,
  guests, licences with known expected scores).
- Unit tests for the flagging heuristics against fixture metadata.
- A fixture tenant seeder that creates the demo data in the dev tenant, so
  the demo video shows the full loop on known numbers.
- A hook on file save runs the scorer tests; a hook on commit runs lint plus
  a spec-completeness check (every task maps to an acceptance criterion).
