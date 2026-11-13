# Spectre Architecture

## 1. System overview

Spectre solves one business problem: Copilot rollouts stall on oversharing. Copilot only surfaces data the user has at least view permission to ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy)), so oversharing is surfaced, not created, by Copilot. A tenant full of anonymous links, ownerless sites, and dormant guests is not ready for an AI assistant that can read everything a user can reach. Reporting tools describe the exposure; Spectre closes the loop by asking the owner and acting on the answer. That is the whole design, and every component below exists to serve it.

The system is a single Node.js and TypeScript service that works in four stages: scan, ask, act, and show. The scan engine inventories a Microsoft 365 tenant through the Microsoft Graph API (the programming interface Microsoft provides for reading and managing Microsoft 365 data) and writes findings to a SQLite store. The attestation loop sends each finding to its owner as one plain-English Teams Adaptive Card with three actions. An Adaptive Card is the interactive message format Teams uses for buttons and forms. The remediation dispatcher executes only decisions the owner (or the admin, from the exceptions queue) has approved, and writes one audit log entry per action. The admin console is a read view over the same store, with one write endpoint for admin decisions on queued findings.

The design evidence is in the repository `README.md` (Varonis 2025, ShareGate 2026, Gartner via Computerworld). Microsoft's own discovery tools are capped: Purview Data Security Posture Management item-level scanning covers at most 10 sites with no OneDrive item-level scanning and a 200,000-item limit per location, and data access governance reports without SharePoint Advanced Management are activity-only for at most 10,000 sites, with no snapshot reports or remedial actions. Microsoft recommends running snapshot reports quarterly and activity reports monthly. ([Purview DSPM](https://learn.microsoft.com/en-us/purview/data-security-posture-management-oversharing), [data access governance reports](https://learn.microsoft.com/en-us/sharepoint/data-access-governance-reports))

## 2. Components

### 2.1 Scan engine (`src/index.ts`, `src/collector/`, `src/flagger/`, `src/scorer/`)

The scan engine is a staged, cached pipeline. It runs as a one-shot process (`node dist/index.js`) and exits when the scan completes.

1. **Inventory collection** (`src/collector/`). Lists SharePoint sites via `GET /sites/getAllSites`, guest users via `GET /users`, licences via `GET /subscribedSkus` ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0)), and per-user activity via `GET /reports/getOffice365ActiveUserDetail(period='D90')`. That report returns a 302 redirect to a CSV download, with per-service last-activity dates and no single "last activity date" column ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/reportroot-getoffice365activeuserdetail?view=graph-rest-1.0)). All list calls use `$select` discipline, which means each call asks for only the fields it needs. Collection is resumable: progress is persisted per collection in the `collector_progress` table, so a stopped run resumes from the last persisted page instead of restarting.
2. **Owner enrichment.** For group-connected team sites, the owner is the first owner of the backing Microsoft 365 group, resolved in two steps: `GET /sites/{siteId}/drive` gives the group id, then `GET /groups/{groupId}/owners` gives the first owner UPN. A UPN is the user's sign-in name, in email form. Enrichment runs after the full site list is collected, never inside the list loop, and is batched. Sites without a drive (communication sites, the root site) keep `owner` as `null`. Groups with no owners keep `owner` as `null`. No owner is ever invented.
3. **Flagging** (`src/flagger/`). Metadata-only heuristics, no permissions calls. Five ghost types, with thresholds defined in code: overshared-site, orphaned-site (owner is `null` after enrichment), stale-guest (last sign-in 90 or more days ago, or never), idle-licence (no activity in 90 days), cold-storage (not modified in 365 or more days). Three of those thresholds are Spectre heuristics, not Microsoft definitions:
   - **Stale guest, 90 days (heuristic).** Microsoft defines no fixed "stale guest" period. Its closest concept is the inactive-guest report, whose 90-day threshold is the configurable default; guests who never signed in are measured from their creation date. Spectre uses 90 days. ([Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/users/clean-up-stale-guest-accounts))
   - **Idle licence, 90 days (heuristic).** Microsoft publishes no unused-licence threshold or cost-waste guidance. Its method is to compare licence assignment against per-service last-activity dates in the usage reports. Spectre flags 90 days of no activity. ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/active-users-ww))
   - **Cold storage, 365 days (heuristic).** Microsoft leaves the inactivity period to the admin's inactive-site policy; there is no fixed Microsoft definition of an inactive site. Spectre uses 365 days. ([Microsoft Learn](https://learn.microsoft.com/en-us/sharepoint/inactive-site-policy))
4. **Permissions fetch** (`src/collector/permissions.ts`). Runs only for flagged items. It fetches `GET /drives/{drive-id}/items/{item-id}/permissions` and records the `link` facet scope (`anonymous`, `organization`, `users`). Results are cached by item id and scan timestamp in the `permissions_cache` table, so a re-run does not re-fetch unchanged items. A separate step, `detectAnonymousLinks`, scans all sites for anonymous links, because Graph does not expose `sharingCapability` on the site resource in v1.0 or beta ([Microsoft Learn: site resource](https://learn.microsoft.com/en-us/graph/api/resources/site?view=graph-rest-1.0)). Including it in `$select` returns an error, so site-level metadata cannot detect oversharing; the permissions fetcher is the only reliable signal. Tenant-level sharing can be read and changed through Graph v1.0 via `sharepointSettings` (`GET`/`PATCH /admin/sharepoint/settings`), but that is the tenant setting, not a per-site setting ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/resources/sharepointsettings?view=graph-rest-1.0)).
5. **Scoring** (`src/scorer/`). A pure function of the finding counts. See section 5.

### 2.2 Findings store (`src/store/`)

The store is an interface (`FindingStore`) with one implementation, `SqliteFindingStore`, backed by `better-sqlite3` in a single file. The interface is swappable: moving to another database requires only a new class that implements it. Findings are never deleted; lifecycle changes are status transitions (`open`, `actioned`, `dismissed`). The `numbers` field is stored as JSON text, verbatim from Graph, so the narration layer can quote it exactly. See section 4 for the full schema.

### 2.3 Attestation loop (`src/attestation/`)

The loop turns open findings into owner decisions. Its parts are:

- **Recipient resolution** (`recipient.ts`). The recipient is `finding.owner`. A finding with no owner, or an owner the bot has no conversation with, goes to the admin exceptions queue with a reason (`ownerless`, `owner unreachable`, `no response`). The recipient is never guessed.
- **Narration** (`narration.ts`). One plain-English sentence per finding, built from the finding record only. Numbers are quoted verbatim from `finding.numbers`; unknown figures are stated as unknown. Templates contain no digits and no legal or compliance verdict.
- **Card** (`card.ts`). An Adaptive Card v1.5 with the narration sentence, a short plain-English explanation of the three actions, and exactly three `Action.Submit` buttons. Button titles are "Keep it shared", "Remove the public link", "Archive this site"; the action values posted back are `Keep`, `Restrict`, `Archive`, together with the finding id.
- **Delivery** (`delivery.ts`). Proactive 1:1 sends through the Bot Framework Connector, using a client-credentials token for the bot registration. Every send is recorded in `attestation_sends`. A finding with any recorded send is never sent again by delivery; the second message belongs to the nudge rule.
- **Messaging endpoint** (`endpoint.ts`). `POST /api/messages`. Every request must carry a valid Bot Framework JWT (RS256, issuer `https://api.botframework.com`, audience equal to the bot App ID, and the `serviceurl` claim equal to the activity's service URL). A JSON Web Token, or JWT, is the signed credential the Bot Framework uses to prove a request really comes from Teams. Anything else receives 401 and is not parsed. The endpoint learns the owner's 1:1 conversation reference from any authenticated activity the owner sends (install, hello, tap) and stores it in `attestation_conversations`. A message activity with a `value` is an `Action.Submit` postback and is handed to the decision handler.
- **Decision handling** (`decision.ts`). Records the decision (finding id, owner, action, timestamp) before doing anything else. Decisions are persisted in the `attestation_decisions` table, so they survive a restart. A duplicate postback returns the recorded decision; it does not create a second record. Keep closes the finding as accepted risk with `acceptedUntil` set to now plus 30 days. Restrict and Archive are handed to the remediation dispatcher. Unknown or corrupt postbacks are logged and ignored; the finding stays open.
- **Nudge clock** (`nudge.ts`). A daily check: no answer 7 days after the send means one nudge (the same card, marked as a reminder). At most two messages per finding (initial plus nudge). Still no answer 7 days after the nudge means the finding moves to the admin exceptions queue with reason `no response`.

**Running the daily loop:** the daily runner exists as `src/attestation/run.ts` and the `npm run attest` script. It delivers open findings, then runs the nudge check, and prints one JSON summary line (`sent`, `nudged`, `escalated`, `queued`, `skipped`). Nothing in the service invokes it on a timer yet, so running it daily is still an operator task, and it has not yet been run against the live database (it would send real cards to owners). The bot server (`src/attestation/server.ts`) only listens for postbacks. See [operations.md](operations.md#1-daily-run).

### 2.4 Remediation dispatcher (`src/remediation/`)

The dispatcher routes an approved decision to the handler for its ghost type. It refuses, without calling any handler and without writing an audit entry, when there is no recorded approval, the finding does not exist, the action is not allowed for the ghost type, or no handler is registered. A finding is marked `actioned` only when the handler reports success. One audit log entry is written per executed action, with the finding id, action, target, approver, timestamp, result (`success`, `failure`, `queued`), error, and restore path. See [remediation.md](remediation.md) for each action.

The bot server and the console server both construct the dispatcher with the three real Graph handlers wired in (`createRevokeLinkHandler`, `createExpireGuestHandler`, `createArchiveSiteHandler`). The archive handler runs with no delegated admin session in the servers, so Archive decisions are recorded and queued for an admin with the exact command to run. See [remediation.md](remediation.md#4-archive-a-cold-site).

### 2.5 Admin console (`src/console/`, `web/`)

A service read API plus a React 18 single-page application built with Fluent UI v9, served as static files from `web/dist` by the same service. The UI holds no credentials and makes no Graph calls. The API is documented in [api.md](api.md). The console never executes a fix itself: its only write endpoint hands Restrict and Archive to the remediation dispatcher with a recorded admin approval, exactly as an owner decision does.

### 2.6 Seeder and verifier (`src/seeder/`)

The seeder creates a known fixture tenant in the developer tenant so the demo and the tests run against known numbers: 8 group-connected sites (3 overshared, 2 orphaned, 3 cold-storage), 5 invited guests who never sign in, and 4 member users with a licence and no activity. The verifier (`src/seeder/verify.ts`) compares a scan against the expected fixture counts and reports pass or fail per ghost type. The fixture set is defined in `src/seeder/constants.ts`. See section 5.3.

## 3. Data flow

```
Graph (app-only token)
  -> collector: sites, guests, licences, activity
  -> owner enrichment (group owners)
  -> flagger: five ghost types, metadata only
  -> permissions fetcher: link scope for flagged items, cached
  -> findings store (SQLite): one row per finding, status open
  -> scorer: deterministic 0-100 score from open finding counts
  -> attestation: card to owner -> decision recorded
       -> Keep: finding dismissed, no re-ask for 30 days
       -> Restrict / Archive: remediation dispatcher
            -> Graph / SharePoint call
            -> audit_log entry, finding actioned on success, open on failure
  -> admin console: score, findings, exceptions, audit (read API)
```

Key properties of the flow:

- The findings store is the single source of truth. The attestation loop and the admin console both read from it and never call Graph directly (the console makes no Graph calls at all; the bot endpoint calls Graph only to resolve a Teams user's AAD object id to a UPN).
- A scan never fails the whole run for one unreadable item. A permissions call that fails with a non-429 error records the item as unreadable (`itemReadable: false`) and the run continues. Graph throttling (429) is handled with `Retry-After` backoff and the same page is resumed, never skipped silently.
- A tenant with zero sites completes with zero findings and a score of 100, not an error.
- Decisions are recorded before any action. A failed remediation keeps the finding open with the error attached; it is never marked fixed.

## 4. Storage

All state lives in one SQLite file, by default `./spectre.db` (see `DB_PATH`). SQLite is a small file-based database: the whole system state is one file on disk, with no database server to run. The file contains eight tables, each created idempotently on startup with `CREATE TABLE IF NOT EXISTS`.

### 4.1 `findings`

One row per finding, written by the scan engine and updated by decision handling and remediation.

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PRIMARY KEY | Stable UUID, generated at insert |
| `type` | TEXT NOT NULL | Ghost type: `overshared-site`, `orphaned-site`, `stale-guest`, `idle-licence`, `cold-storage` |
| `subject_id` | TEXT NOT NULL | Graph ID of the site, item, user, or SKU the finding refers to |
| `subject_label` | TEXT | Human-readable label (site or user display name, SKU name); null when Graph returned only the id |
| `owner` | TEXT | Owner UPN; null means Graph returned no owner, never a guess |
| `numbers` | TEXT NOT NULL | JSON text, the raw Graph-sourced numbers, stored verbatim |
| `severity_weight` | REAL NOT NULL | Per-finding weight used by the scorer |
| `status` | TEXT NOT NULL, default `open` | Lifecycle: `open`, `actioned`, `dismissed` |
| `scan_timestamp` | TEXT NOT NULL | ISO 8601 timestamp of the scan run that produced the finding |
| `updated_at` | TEXT NOT NULL | ISO 8601 timestamp of the last update |

Indexes: `idx_findings_scan` on `scan_timestamp`, `idx_findings_status_type` on (`status`, `type`).

The `numbers` JSON carries, per ghost type: `linkScope` (`anonymous`, `organization`, `users`), `reachableUserCount`, `lastSignInAt`, `monthlyCostUsd`, `storageSizeBytes`, `storageOverageCostUsd`, `lastModifiedAt`, `skuPartNumber`, `itemReadable`, and `anonymousLink` (`driveId`, `itemId`, `permissionId`) when the scan recorded the link ids. Every field may be `null`, meaning Graph did not provide the value. `null` is never rendered as zero.

### 4.2 `audit_log`

One row per remediation action executed, written by the dispatcher.

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PRIMARY KEY | UUID, generated at insert |
| `finding_id` | TEXT NOT NULL | Finding the action belongs to |
| `action` | TEXT NOT NULL | `restrict`, `archive`, or `revoke` |
| `target` | TEXT NOT NULL | The link, site, or guest the action targeted |
| `owner` | TEXT | Approver UPN (owner or admin) |
| `timestamp` | TEXT NOT NULL | ISO 8601 time the action was executed |
| `result` | TEXT NOT NULL | `success`, `failure`, or `queued` |
| `error` | TEXT | Error text when the action failed or was queued; null otherwise |
| `restore_path` | TEXT | How to undo the action, or null where the platform has none |

Index: `idx_audit_finding` on `finding_id`.

### 4.3 `attestation_conversations`

Learned 1:1 conversation references for the bot, one row per owner UPN.

| Column | Type | Meaning |
|---|---|---|
| `upn` | TEXT PRIMARY KEY | Owner UPN, stored lowercased |
| `service_url` | TEXT NOT NULL | Bot Framework service URL for this conversation |
| `conversation_id` | TEXT NOT NULL | Conversation id for proactive sends |

### 4.4 `attestation_sends`

One row per card send.

| Column | Type | Meaning |
|---|---|---|
| `finding_id` | TEXT NOT NULL | Finding the card was about |
| `owner` | TEXT NOT NULL | Recipient UPN |
| `sent_at` | TEXT NOT NULL | ISO 8601 send time |

Index: `idx_attestation_sends_finding` on `finding_id`. The nudge rule reads this table to enforce the two-message maximum.

### 4.5 `permissions_cache`

Permissions fetch results, keyed by item and scan run.

| Column | Type | Meaning |
|---|---|---|
| `item_id` | TEXT NOT NULL | Drive item id |
| `scan_timestamp` | TEXT NOT NULL | Scan run the entry belongs to |
| `link_scope` | TEXT | Recorded link scope; null means none found or unreadable |
| `item_readable` | INTEGER NOT NULL, default 1 | 0 means the permissions call failed |
| `fetched_at` | TEXT NOT NULL | ISO 8601 fetch time |

Primary key: (`item_id`, `scan_timestamp`).

### 4.6 `collector_progress`

Scan resume state, one row per collection per scan run.

| Column | Type | Meaning |
|---|---|---|
| `collection` | TEXT NOT NULL | Collection name (for example, sites) |
| `scan_timestamp` | TEXT NOT NULL | Scan run the entry belongs to |
| `next_link` | TEXT | Paging cursor to resume from; null when complete |
| `completed` | INTEGER NOT NULL, default 0 | 1 when the collection finished |

Primary key: (`collection`, `scan_timestamp`).

### 4.7 `attestation_decisions`

One row per recorded decision, written by the decision handler before anything else happens. The table is `attestation_decisions` in `src/attestation/SqliteDecisionStore.ts`. Each record holds the finding id, the owner, the action (`Keep`, `Restrict`, or `Archive`), the decision time, and the accepted-until date for a Keep. `finding_id` is the primary key, and inserts use `INSERT OR IGNORE`, so a duplicate decision for the same finding returns the existing record instead of creating a second one. Because decisions live in the database file, they survive a process restart, and a database backup restores them along with everything else.

### 4.8 `attestation_admin_queue`

The persisted admin exceptions queue, in `src/attestation/SqliteAdminQueue.ts`. Each entry holds the finding id, the reason it is queued (`ownerless`, `owner unreachable`, or `no response`), and any delivery error attached by the delivery or nudge loop. Inserts use `INSERT OR IGNORE`, and listing returns entries oldest first. The console serves this persisted queue through `GET /exceptions`, so queue reasons written by the delivery and nudge loops are visible to the admin.

### 4.9 What is not stored

- **No credentials are stored in the database.** Tokens are held in memory by the SDK credential objects and refreshed automatically.
- **No file contents, message bodies, or document text are stored.** The `numbers` JSON holds Graph metadata (scopes, counts, dates, costs, ids), not content.

## 5. Scoring model

### 5.1 Formula

The Copilot-readiness score is a deterministic pure function of the open finding counts (`src/scorer/index.ts`). No model output and no Graph call enters the score. Heuristic: the 0 to 100 score is Spectre's own design. Microsoft publishes no Copilot readiness score or percentage; its Copilot readiness report shows counts only, such as eligible users and assigned licences. ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness))

```
penalty(type)  = count(type) x weight(type)
totalPenalty   = sum of penalty(type) over the five ghost types
score          = max(0, floor(100 x (1 - totalPenalty / maxPenalty)))
```

`maxPenalty` is 100. A tenant with no open findings scores exactly 100. A tenant whose total penalty reaches or exceeds 100 scores 0. The function validates its inputs: counts must be non-negative integers, and a negative or non-integer count raises a `RangeError`.

### 5.2 Weights

| Ghost type | Weight | Reason in code |
|---|---|---|
| `overshared-site` | 3 | Highest: anonymous links pose direct data-leak risk |
| `orphaned-site` | 2 | No accountability for the site |
| `stale-guest` | 2 | Dormant external access |
| `idle-licence` | 1 | Cost waste, lower security impact |
| `cold-storage` | 1 | Storage waste, lower security impact |

The weights are defined once in `src/flagger/types.ts` (`SEVERITY_WEIGHTS`) and reused by the scorer (`src/scorer/index.ts`, `DEFAULT_CONFIG`). A zero count contributes zero penalty for that type.

### 5.3 Fixture score

The fixture tenant is defined in `src/seeder/constants.ts`. The expected finding counts, weights, and penalties are:

| Ghost type | Count | Weight | Penalty |
|---|---|---|---|
| `overshared-site` | 3 | 3 | 9 |
| `orphaned-site` | 2 | 2 | 4 |
| `stale-guest` | 5 | 2 | 10 |
| `idle-licence` | 4 | 1 | 4 |
| `cold-storage` | 0 | 1 | 0 |
| **Total** | | | **27** |

Fixture score: `floor((1 - 27 / 100) x 100) = 73`. The cold-storage count is 0 by design, not by omission: the three cold-storage fixture sites were created in November 2026 and cannot be 365 days old until November 2027, and the SharePoint API does not allow back-dating `lastModifiedDateTime`. The cold-storage detector is proven by the main scan against the tenant's real cold sites.

### 5.4 Tenant-wide score versus fixture score

The console reports two scores side by side from the same scan (`GET /score`): the **tenant** score, computed over all open findings, and the **fixture** score, computed over open findings whose subject label starts with `Spectre Fixture `, `Spectre Ghost `, or `Spectre Idle User `. The two numbers are different by design. The fixture score measures the demo scenario (73 by construction). The tenant-wide score measures the real tenant, including its pre-existing sites, and in the demo tenant it is 0 because the real sites add findings beyond the fixture set. The console labels both scores so they are never confused. The cost rollup beside the score sums `monthlyCostUsd` over open idle-licence findings and `storageOverageCostUsd` over open cold-storage findings; either figure is `null` (shown as "unknown") as soon as one price is not on file. Heuristic: Microsoft publishes no guidance on licence cost waste or unused-licence savings, so Spectre never estimates a saving. Costs are unknown unless the operator supplies prices.

### 5.5 Score history

The scorer returns `scanTimestamp` and `computedAt` with every result, but it does not store previous scores. Trend display is the caller's responsibility: the caller must persist each scan's result. No trend storage exists in the current code.

## 6. References

Microsoft Learn links first. All links below appear in the research report of 13 November 2026; pages marked (live) were opened live that day.

- Microsoft Learn (live): Copilot privacy, Copilot only surfaces data the user has at least view permission to: https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy
- Microsoft Learn (live): Configure a secure and governed data foundation for Microsoft 365 Copilot: https://learn.microsoft.com/en-us/microsoft-365/copilot/configure-secure-governed-data-foundation-microsoft-365-copilot
- Microsoft Learn (live): Monitor and clean up stale guest accounts: https://learn.microsoft.com/en-us/entra/identity/users/clean-up-stale-guest-accounts
- Microsoft Learn (live): Microsoft 365 admin centre active users report: https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/active-users-ww
- Microsoft Learn (live): Inactive site policies: https://learn.microsoft.com/en-us/sharepoint/inactive-site-policy
- Microsoft Learn (live): Data Security Posture Management for oversharing: https://learn.microsoft.com/en-us/purview/data-security-posture-management-oversharing
- Microsoft Learn (live): Data access governance reports: https://learn.microsoft.com/en-us/sharepoint/data-access-governance-reports
- Microsoft Learn (live): Copilot readiness report (counts, no score): https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness
- Microsoft Learn (live): Site resource (no owner field, no sharingCapability): https://learn.microsoft.com/en-us/graph/api/resources/site?view=graph-rest-1.0
- Microsoft Learn (live): sharepointSettings resource (tenant-level sharingCapability): https://learn.microsoft.com/en-us/graph/api/resources/sharepointsettings?view=graph-rest-1.0
- Microsoft Learn (live): List subscribed SKUs: https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0
- Microsoft Learn (live): getOffice365ActiveUserDetail (CSV, per-service last-activity dates): https://learn.microsoft.com/en-us/graph/api/reportroot-getoffice365activeuserdetail?view=graph-rest-1.0

Heuristics in this document: the 0 to 100 readiness score; the 90-day stale-guest threshold; the 90-day idle-licence threshold; the 365-day cold-storage threshold; licence and storage cost figures, which are unknown unless the operator supplies prices. None of these is a Microsoft definition; each is labelled "Heuristic" where it appears above.
