# Spectre API Reference

Spectre exposes two HTTP surfaces: the admin console read API (plus its
one write endpoint) and the Teams bot messaging endpoint. This document
describes both as they are implemented in `src/console/` and
`src/attestation/endpoint.ts`. All paths are relative to the server root.
All responses are JSON unless stated otherwise. The console API sets
`cache-control: no-store` on every response.

## 1. Console API

Base URL: `http://<CONSOLE_HOST>:<CONSOLE_PORT>` (defaults
`127.0.0.1:3979`). The console server serves the React app as static
files from `web/dist` for any `GET` request that is not an API path, and
returns 404 for any other method or path.

The API reads only from the SQLite findings store. It never calls Graph.
The score is computed by the scorer from the store, never by the UI. An
unconfirmable figure is `null`, never 0 and never a guess.

### 1.1 `GET /score`

Returns the latest readiness score with its inputs and the cost rollup.

**Response (200):**

```json
{
  "scanTimestamp": "2026-11-13T04:00:00.000Z",
  "tenant": { "score": 0, "inputs": { "counts": {}, "breakdown": [], "totalPenalty": 0, "maxPenalty": 100 }, "scanTimestamp": "...", "computedAt": "..." },
  "fixture": { "score": 73, "inputs": {}, "scanTimestamp": "...", "computedAt": "..." },
  "cost": { "idleLicencesUsd": null, "coldStorageUsd": null }
}
```

| Field | Meaning |
|---|---|
| `scanTimestamp` | ISO 8601 timestamp of the latest scan, or `null` when no scan is recorded |
| `tenant` | `ScorerResult` over all open findings, or `null` when no scan is recorded |
| `fixture` | `ScorerResult` over open fixture findings only (subject label starts with `Spectre Fixture `, `Spectre Ghost `, or `Spectre Idle User `), or `null` when no scan is recorded |
| `cost` | Cost rollup, or `null` when no scan is recorded |

`ScorerResult` carries `score` (integer, 0 to 100), `inputs` (the exact
counts, per-type breakdown of count, weight, and penalty, total penalty,
and `maxPenalty`), `scanTimestamp`, and `computedAt`. The cost rollup sums
`monthlyCostUsd` over open idle-licence findings and
`storageOverageCostUsd` over open cold-storage findings; either figure is
`null` as soon as one price is not on file. When no scan is recorded, all
four fields are `null`.

### 1.2 `GET /findings?type=&status=`

Returns findings from the latest scan, each with its recorded decision
and its audit entries.

**Query parameters (both optional):**

| Parameter | Values | Behaviour |
|---|---|---|
| `type` | `overshared-site`, `orphaned-site`, `stale-guest`, `idle-licence`, `cold-storage` | Filters by ghost type. An unknown type returns 400. |
| `status` | `open`, `actioned`, `dismissed` | Filters by lifecycle status. An unknown status returns 400. |

**Response (200):**

```json
{
  "findings": [
    {
      "finding": { "id": "...", "type": "overshared-site", "subjectId": "...", "subjectLabel": "...", "owner": "<ADMIN_UPN>", "numbers": {}, "severityWeight": 3, "status": "open", "scanTimestamp": "...", "updatedAt": "..." },
      "decision": null,
      "audit": []
    }
  ]
}
```

`decision` is the recorded `DecisionRecord` for the finding, or `null`
when none exists. `audit` is the list of audit entries for the finding,
in timestamp order. When no scan is recorded, the list is empty.

**Errors:** `400` with `{ "error": "Unknown type \"...\"." }` or
`{ "error": "Unknown status \"...\"." }`.

### 1.3 `GET /exceptions`

Returns the admin exceptions queue: findings no owner could answer, each
with the reason it is queued, any delivery error, and the actions the
admin may take.

**Response (200):**

```json
{
  "exceptions": [
    {
      "finding": {},
      "decision": null,
      "audit": [],
      "reason": "ownerless",
      "error": null,
      "allowedActions": ["Keep"]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `reason` | `ownerless`, `owner unreachable`, or `no response` |
| `error` | Delivery error attached by the nudge loop, or `null` |
| `allowedActions` | `Keep` plus the remediation action allowed for the ghost type, if one exists. Orphaned-site and idle-licence findings allow only `Keep`, because no remediation action is mapped for them. |

**Current limitation:** the console server does not pass a persisted
queue to the API, and no queue store implementation exists in the tree.
The exceptions view is therefore derived from ownerless findings in the
store. Queue entries written by the delivery and nudge loops with reason
`owner unreachable` or `no response` are not surfaced by the console
until a queue store is implemented. See
[architecture.md](architecture.md#47-what-is-not-stored).

### 1.4 `GET /audit`

Returns every audit entry, newest first.

**Response (200):**

```json
{
  "entries": [
    { "id": "...", "findingId": "...", "action": "restrict", "target": "...", "owner": "<ADMIN_UPN>", "timestamp": "...", "result": "success", "error": null, "restorePath": null }
  ]
}
```

`action` is `restrict`, `archive`, or `revoke`. `result` is `success`,
`failure`, or `queued`. `error` carries the failure or queue text.
`restorePath` carries the undo path where one exists, or `null`.

### 1.5 `POST /exceptions/{findingId}/decide`

The only write endpoint in the console. It records the admin's approval
for a queued finding and hands Restrict or Archive to the remediation
dispatcher. It executes nothing itself.

**Request:**

- Method: `POST`
- Path: `/exceptions/<findingId>/decide`
- Header: `Content-Type: application/json` (required; any other content
  type returns 415)
- Body: `{ "action": "Keep" | "Restrict" | "Archive" }`

**Response (200):**

```json
{
  "record": { "findingId": "...", "owner": "<ADMIN_UPN>", "action": "Keep", "decidedAt": "...", "acceptedUntil": "..." },
  "dispatch": null
}
```

For Restrict or Archive, `dispatch` is either
`{ "status": "executed", "entry": {} }` (the audit entry written by the
dispatcher) or `{ "status": "refused", "reason": "..." }` (the dispatcher
refused, for example because no handler is registered). For Keep,
`dispatch` is `null` and the finding is set to `dismissed`, with
`acceptedUntil` set to the decision time plus 30 days.

**Errors:**

| Status | Meaning |
|---|---|
| 400 | Unknown action. Body: `{ "error": "Unknown action." }` |
| 404 | The finding is not in the exceptions queue |
| 409 | A decision is already recorded for this finding. Body includes the existing record as `record` |
| 415 | Content-Type is not `application/json` |
| 422 | The action is not allowed for the finding's ghost type (for example, Restrict on an orphaned-site finding) |
| 503 | `ADMIN_UPN` is not configured on the server, so decisions are disabled. Body: `{ "error": "Admin identity is not configured (ADMIN_UPN); decisions are disabled." }` |

The approval is recorded before dispatching, so a decision is never lost
when dispatch fails. A Keep decision closes the finding as accepted risk
for 30 days, exactly as an owner Keep does.

## 2. Bot messaging endpoint

Base URL: the public HTTPS URL registered as the bot's messaging
endpoint, for example `https://<your-tunnel>/api/messages`. The server
listens on plain HTTP locally (default port 3978) and TLS terminates at
the tunnel or reverse proxy in front of it.

### 2.1 `POST /api/messages`

Receives Bot Framework activities: message activities from owners
(install, hello, tap) and `Action.Submit` postbacks from Adaptive Cards.

**Authentication (checked before parsing):**

- The request must carry an `Authorization: Bearer <JWT>` header.
- The JWT must be signed with RS256. Signing keys are fetched from the
  Bot Framework OpenID configuration
  (`https://login.botframework.com/v1/.well-known/openidconfiguration`)
  and its JWKS endpoint, cached for 24 hours, and refreshed on key
  rotation.
- The token must satisfy: issuer `https://api.botframework.com`,
  audience equal to the bot App ID, expiry in the future, and the
  `serviceurl` claim equal to the activity's `serviceUrl`.

Any request that fails authentication receives **401** and is not parsed.
Any request to another path, or with another method, receives **404**.
A request that throws during handling receives **500**, so Teams retries
the submit and the owner can tap again.

**Conversation learning:**

On any authenticated activity that carries a sender AAD object id, a
service URL, and a conversation id, the endpoint resolves the AAD object
id to a UPN with `GET /users/{aadObjectId}` (Graph, `User.ReadBasic.All`)
and stores the conversation reference in `attestation_conversations`.
This is how the bot learns to message an owner: the owner must first open
Spectre in Teams and send any message once. If the UPN lookup returns
null, nothing is stored and the finding stays in the admin queue as
`owner unreachable`.

**Postback handling:**

A message activity whose `value` is present is an `Action.Submit`
postback. The `value` carries `{ findingId, action }`. Handling is:

1. Validate the postback: a missing finding id or an unknown action is
   logged and ignored; the finding stays open.
2. Check for an existing decision for the finding. A duplicate postback
   returns the recorded decision; it does not create a second record.
3. Load the finding. A missing finding is ignored. A finding with no
   owner is ignored, because the decision record needs an owner UPN from
   the finding and the owner is never guessed.
4. Record the decision (finding id, owner, action, timestamp) before
   doing anything else. For Keep, `acceptedUntil` is the decision time
   plus 30 days.
5. For Keep, set the finding status to `dismissed` and return. For
   Restrict or Archive, hand the decision to the remediation dispatcher
   and return the dispatch result.

The endpoint returns **200** once the postback is handled, whether the
outcome was recorded, duplicate, or ignored.

### 2.2 Outbound sends (Bot Framework Connector)

Proactive sends go to
`{serviceUrl}/v3/conversations/{conversationId}/activities` with a
`Bearer` token acquired with the bot App ID and secret for the
`https://api.botframework.com/.default` scope. The body is a message
activity with one attachment of content type
`application/vnd.microsoft.card.adaptive` carrying the card JSON. A
non-OK response from the Connector is an error: the finding goes to the
admin queue with reason `owner unreachable` and the error attached, and
is not retried.

### 2.3 Idempotency and suppression

- **Decisions:** one record per finding. A duplicate submit returns the
  recorded decision. A decision is never recorded twice.
- **Sends:** a finding with any recorded send is never sent again by
  card delivery. The second message is the nudge's, and only the nudge
  sends it.
- **Keep suppression:** a Keep decision sets `acceptedUntil` to 30 days
  after the decision. The loop must not re-ask before that date. The
  finding re-opens on the next scan if the exposure still exists and the
  suppression has expired.
- **Nudge limit:** at most two messages per finding per owner (initial
  plus one nudge). See [operations.md](operations.md#nudge-schedule).

## 3. What is not an API

- There is no public API for triggering a scan, for sending a card on
  demand, or for running the nudge check. `deliverOpenFindings` and
  `runNudgeCheck` are exported functions in the codebase, not HTTP
  endpoints. They are invoked by the operator's daily run. See
  [operations.md](operations.md#daily-run).
- There is no API for editing or deleting audit entries, findings, or
  decisions. The console exposes reads and one decide endpoint only.
- There is no API for managing the bot registration, the Teams app
  package, or the Entra app registration. Those are manual steps in the
  Entra admin center, the Teams Developer Portal, and the Teams admin
  center. See [deployment.md](deployment.md).
