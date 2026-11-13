# Spectre Architecture

## 1. System overview

Spectre is a single Node.js and TypeScript service that works in four
stages: scan, ask, act, and show. The scan engine inventories a Microsoft
365 tenant through the Microsoft Graph API and writes findings to a SQLite
store. The attestation loop sends each finding to its owner as one
plain-English Teams Adaptive Card with three actions. The remediation
dispatcher executes only decisions the owner (or the admin, from the
exceptions queue) has approved, and writes one audit log entry per action.
The admin console is a read view over the same store, with one write
endpoint for admin decisions on queued findings.

The product problem is specific: Copilot rollouts stall on oversharing.
Incumbent tools report the exposure; Spectre closes the loop by asking the
owner and acting on the answer. The design evidence is in the repository
`README.md`: most tenants expose sensitive data to AI tools, most
governance incidents involve stale access, and the Microsoft native answers
are capped, expensive, or read-only.

## 2. Components

### 2.1 Scan engine (`src/index.ts`, `src/collector/`, `src/flagger/`, `src/scorer/`)

The scan engine is a staged, cached pipeline. It runs as a one-shot
process (`node dist/index.js`) and exits when the scan completes.

1. **Inventory collection** (`src/collector/`). Lists SharePoint sites via
   `GET /sites/getAllSites`, guest users via `GET /users`, licences via
   `GET /subscribedSkus`, and per-user activity via
   `GET /reports/getOffice365ActiveUserDetail(period='D90')`. All list
   calls use `$select` discipline. Collection is resumable: progress is
   persisted per collection in the `collector_progress` table, so a
   stopped run resumes from the last persisted page instead of restarting.
2. **Owner enrichment.** For group-connected team sites, the owner is the
   first owner of the backing Microsoft 365 group, resolved in two steps:
   `GET /sites/{siteId}/drive` gives the group id, then
   `GET /groups/{groupId}/owners` gives the first owner UPN. Enrichment
   runs after the full site list is collected, never inside the list loop,
   and is batched. Sites without a drive (communication sites, the root
   site) keep `owner` as `null`. Groups with no owners keep `owner` as
   `null`. No owner is ever invented.
3. **Flagging** (`src/flagger/`). Metadata-only heuristics, no permissions
   calls. Five ghost types, with thresholds defined in code:
   overshared-site, orphaned-site (owner is `null` after enrichment),
   stale-guest (last sign-in 90 or more days ago, or never),
   idle-licence (no activity in 90 days), cold-storage (not modified in
   365 or more days).
4. **Permissions fetch** (`src/collector/permissions.ts`). Runs only for
   flagged items. It fetches `GET /drives/{drive-id}/items/{item-id}/permissions`
   and records the `link` facet scope (`anonymous`, `organization`,
   `users`). Results are cached by item id and scan timestamp in the
   `permissions_cache` table, so a re-run does not re-fetch unchanged
   items. A separate step, `detectAnonymousLinks`, scans all sites for
   anonymous links, because Graph does not expose `sharingCapability` on
   the site resource in v1.0 or beta. Including it in `$select` returns
   an error, so site-level metadata cannot detect oversharing; the
   permissions fetcher is the only reliable signal.
5. **Scoring** (`src/scorer/`). A pure function of the finding counts.
   See section 5.

### 2.2 Findings store (`src/store/`)

The store is an interface (`FindingStore`) with one implementation,
`SqliteFindingStore`, backed by `better-sqlite3` in a single file. The
interface is swappable: moving to another database requires only a new
class that implements it. Findings are never deleted; lifecycle changes
are status transitions (`open`, `actioned`, `dismissed`). The `numbers`
field is stored as JSON text, verbatim from Graph, so the narration layer
can quote it exactly. See section 4 for the full schema.

### 2.3 Attestation loop (`src/attestation/`)

The loop turns open findings into owner decisions. Its parts are:

- **Recipient resolution** (`recipient.ts`). The recipient is
  `finding.owner`. A finding with no owner, or an owner the bot has no
  conversation with, goes to the admin exceptions queue with a reason
  (`ownerless`, `owner unreachable`, `no response`). The recipient is
  never guessed.
- **Narration** (`narration.ts`). One plain-English sentence per finding,
  built from the finding record only. Numbers are quoted verbatim from
  `finding.numbers`; unknown figures are stated as unknown. Templates
  contain no digits and no legal or compliance verdict.
- **Card** (`card.ts`). An Adaptive Card v1.5 with the narration sentence,
  a short plain-English explanation of the three actions, and exactly
  three `Action.Submit` buttons. Button titles are "Keep it shared",
  "Remove the public link", "Archive this site"; the action values posted
  back are `Keep`, `Restrict`, `Archive`, together with the finding id.
- **Delivery** (`delivery.ts`). Proactive 1:1 sends through the Bot
  Framework Connector, using a client-credentials token for the bot
  registration. Every send is recorded in `attestation_sends`. A finding
  with any recorded send is never sent again by delivery; the second
  message belongs to the nudge rule.
- **Messaging endpoint** (`endpoint.ts`). `POST /api/messages`. Every
  request must carry a valid Bot Framework JWT (RS256, issuer
  `https://api.botframework.com`, audience equal to the bot App ID, and
  the `serviceurl` claim equal to the activity's service URL). Anything
  else receives 401 and is not parsed. The endpoint learns the owner's
  1:1 conversation reference from any authenticated activity the owner
  sends (install, hello, tap) and stores it in
  `attestation_conversations`. A message activity with a `value` is an
  `Action.Submit` postback and is handed to the decision handler.
- **Decision handling** (`decision.ts`). Records the decision (finding id,
  owner, action, timestamp) before doing anything else. A duplicate
  postback returns the recorded decision; it does not create a second
  record. Keep closes the finding as accepted risk with `acceptedUntil`
  set to now plus 30 days. Restrict and Archive are handed to the
  remediation dispatcher. Unknown or corrupt postbacks are logged and
  ignored; the finding stays open.
- **Nudge clock** (`nudge.ts`). A daily check: no answer 7 days after the
  send means one nudge (the same card, marked as a reminder). At most two
  messages per finding (initial plus nudge). Still no answer 7 days after
  the nudge means the finding moves to the admin exceptions queue with
  reason `no response`.

**Not implemented in the current code:** there is no built-in scheduler.
`deliverOpenFindings` and `runNudgeCheck` are exported functions; nothing
in the service invokes them on a timer. The bot server
(`src/attestation/server.ts`) only listens for postbacks. The daily
delivery and nudge run is an operational task. See
[operations.md](operations.md#daily-run).

### 2.4 Remediation dispatcher (`src/remediation/`)

The dispatcher routes an approved decision to the handler for its ghost
type. It refuses, without calling any handler and without writing an
audit entry, when there is no recorded approval, the finding does not
exist, the action is not allowed for the ghost type, or no handler is
registered. A finding is marked `actioned` only when the handler reports
success. One audit log entry is written per executed action, with the
finding id, action, target, approver, timestamp, result (`success`,
`failure`, `queued`), error, and restore path. See
[remediation.md](remediation.md) for each action.

**Implemented, not wired:** the bot server and the console server both
construct the dispatcher with an empty handler map (`handlers: {}`). In
the current wiring, Restrict and Archive decisions are recorded and then
refused by the dispatcher, and the refusal is reported to the caller. No
Graph write happens until the handlers are registered. This is deliberate
in the current build and is the next wiring step.

### 2.5 Admin console (`src/console/`, `web/`)

A service read API plus a React 18 single-page application built with
Fluent UI v9, served as static files from `web/dist` by the same service.
The UI holds no credentials and makes no Graph calls. The API is
documented in [api.md](api.md). The console never executes a fix itself:
its only write endpoint hands Restrict and Archive to the remediation
dispatcher with a recorded admin approval, exactly as an owner decision
does.

### 2.6 Seeder and verifier (`src/seeder/`)

The seeder creates a known fixture tenant in the developer tenant so the
demo and the tests run against known numbers: 8 group-connected sites (3
overshared, 2 orphaned, 3 cold-storage), 5 invited guests who never sign
in, and 4 member users with a licence and no activity. The verifier
(`src/seeder/verify.ts`) compares a scan against the expected fixture
counts and reports pass or fail per ghost type. The fixture set is defined
in `src/seeder/constants.ts`. See section 5.3.

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

- The findings store is the single source of truth. The attestation loop
  and the admin console both read from it and never call Graph directly
  (the console makes no Graph calls at all; the bot endpoint calls Graph
  only to resolve a Teams user's AAD object id to a UPN).
- A scan never fails the whole run for one unreadable item. A permissions
  call that fails with a non-429 error records the item as unreadable
  (`itemReadable: false`) and the run continues. Graph throttling (429)
  is handled with `Retry-After` backoff and the same page is resumed,
  never skipped silently.
- A tenant with zero sites completes with zero findings and a score of
  100, not an error.
- Decisions are recorded before any action. A failed remediation keeps
  the finding open with the error attached; it is never marked fixed.

## 4. Storage

All state lives in one SQLite file, by default `./spectre.db` (see
`DB_PATH`). The file contains six tables, each created idempotently on
startup with `CREATE TABLE IF NOT EXISTS`.

### 4.1 `findings`

One row per finding, written by the scan engine and updated by decision
handling and remediation.

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

Indexes: `idx_findings_scan` on `scan_timestamp`,
`idx_findings_status_type` on (`status`, `type`).

The `numbers` JSON carries, per ghost type: `linkScope`
(`anonymous`, `organization`, `users`), `reachableUserCount`,
`lastSignInAt`, `monthlyCostUsd`, `storageSizeBytes`,
`storageOverageCostUsd`, `lastModifiedAt`, `skuPartNumber`,
`itemReadable`, and `anonymousLink` (`driveId`, `itemId`,
`permissionId`) when the scan recorded the link ids. Every field may be
`null`, meaning Graph did not provide the value. `null` is never rendered
as zero.

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

Index: `idx_attestation_sends_finding` on `finding_id`. The nudge rule
reads this table to enforce the two-message maximum.

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

### 4.7 What is not stored

- **Decisions are not stored in SQLite.** The decision store used by the
  bot server and the console server is `InMemoryDecisionStore`, an
  in-memory map. Decisions are lost when the process restarts. A
  persistent `DecisionStore` is a defined, swappable interface
  (`src/attestation/decision.ts`), but no SQLite implementation exists
  yet. This is a known limitation; see
  [operations.md](operations.md#known-limitations).
- **No credentials are stored in the database.** Tokens are held in
  memory by the SDK credential objects and refreshed automatically.
- **No admin exceptions queue is persisted.** The `AdminQueue` interface
  exists (`src/attestation/nudge.ts`), but no implementation exists in
  the tree. The console derives its exceptions view from ownerless
  findings in the store, not from a persisted queue. Queue reasons
  written by the delivery and nudge loops (`owner unreachable`,
  `no response`) are therefore not visible in the console until a queue
  store is implemented.

## 5. Scoring model

### 5.1 Formula

The Copilot-readiness score is a deterministic pure function of the open
finding counts (`src/scorer/index.ts`). No model output and no Graph call
enters the score.

```
penalty(type)  = count(type) x weight(type)
totalPenalty   = sum of penalty(type) over the five ghost types
score          = max(0, floor(100 x (1 - totalPenalty / maxPenalty)))
```

`maxPenalty` is 100. A tenant with no open findings scores exactly 100.
A tenant whose total penalty reaches or exceeds 100 scores 0. The
function validates its inputs: counts must be non-negative integers, and
a negative or non-integer count raises a `RangeError`.

### 5.2 Weights

| Ghost type | Weight | Reason in code |
|---|---|---|
| `overshared-site` | 3 | Highest: anonymous links pose direct data-leak risk |
| `orphaned-site` | 2 | No accountability for the site |
| `stale-guest` | 2 | Dormant external access |
| `idle-licence` | 1 | Cost waste, lower security impact |
| `cold-storage` | 1 | Storage waste, lower security impact |

The weights are defined once in `src/flagger/types.ts`
(`SEVERITY_WEIGHTS`) and reused by the scorer
(`src/scorer/index.ts`, `DEFAULT_CONFIG`). A zero count contributes zero
penalty for that type.

### 5.3 Fixture score

The fixture tenant is defined in `src/seeder/constants.ts`. The expected
finding counts, weights, and penalties are:

| Ghost type | Count | Weight | Penalty |
|---|---|---|---|
| `overshared-site` | 3 | 3 | 9 |
| `orphaned-site` | 2 | 2 | 4 |
| `stale-guest` | 5 | 2 | 10 |
| `idle-licence` | 4 | 1 | 4 |
| `cold-storage` | 0 | 1 | 0 |
| **Total** | | | **27** |

Fixture score: `floor((1 - 27 / 100) x 100) = 73`. The cold-storage
count is 0 by design, not by omission: the three cold-storage fixture
sites were created in November 2026 and cannot be 365 days old until
November 2027, and the SharePoint API does not allow back-dating
`lastModifiedDateTime`. The cold-storage detector is proven by the main
scan against the tenant's real cold sites.

### 5.4 Tenant-wide score versus fixture score

The console reports two scores side by side from the same scan
(`GET /score`): the **tenant** score, computed over all open findings,
and the **fixture** score, computed over open findings whose subject
label starts with `Spectre Fixture `, `Spectre Ghost `, or
`Spectre Idle User `. The two numbers are different by design. The
fixture score measures the demo scenario (73 by construction). The
tenant-wide score measures the real tenant, including its pre-existing
sites, and in the demo tenant it is 0 because the real sites add findings
beyond the fixture set. The console labels both scores so they are never
confused. The cost rollup beside the score sums `monthlyCostUsd` over open
idle-licence findings and `storageOverageCostUsd` over open cold-storage
findings; either figure is `null` (shown as "unknown") as soon as one
price is not on file.

### 5.5 Score history

The scorer returns `scanTimestamp` and `computedAt` with every result,
but it does not store previous scores. Trend display is the caller's
responsibility: the caller must persist each scan's result. No trend
storage exists in the current code.
