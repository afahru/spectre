# Spectre Remediation

This document describes each remediation action in detail: what it does,
which platform call it makes, whether it can be undone, and the safety
rules the dispatcher enforces. The design source is
`.kiro/specs/spectre-remediation/design.md`; the implementation is
`src/remediation/`.

## 1. The dispatcher

Every remediation action goes through one dispatcher
(`src/remediation/dispatcher.ts`). The attestation loop and the admin
console never execute a fix themselves; they hand an approved decision to
the dispatcher, and the dispatcher decides whether to run it.

### 1.1 Allowed actions by ghost type

| Ghost type | Allowed action | Handler |
|---|---|---|
| `overshared-site` | `restrict` | `createRevokeLinkHandler` |
| `cold-storage` | `archive` | `createArchiveSiteHandler` |
| `stale-guest` | `revoke` | `createExpireGuestHandler` |
| `orphaned-site` | none | No handler; only Keep is offered |
| `idle-licence` | none | No handler; only Keep is offered |

The mapping is `ACTION_BY_GHOST_TYPE` in `src/remediation/dispatcher.ts`.
The console enforces the same mapping when it offers actions on a queued
finding: it offers Keep plus the mapped action, if one exists.

### 1.2 Safety rules

The dispatcher enforces these rules on every call, without exception:

1. **No action without a recorded approval.** The decision must carry a
   finding id, an action, an owner, and an approval timestamp. A call
   with a missing or incomplete decision is refused with reason "No
   recorded owner approval for this action." No handler is called and no
   audit entry is written.
2. **The finding must exist.** A decision for an unknown finding id is
   refused.
3. **The action must be allowed for the ghost type.** A Restrict decision
   on a cold-storage finding, for example, is refused.
4. **A handler must be registered.** If no handler is registered for the
   action, the decision is refused with "No handler registered for
   `<action>`."
5. **A finding is marked `actioned` only on success.** The handler
   returns `success`, `failure`, or `queued`. Only `success` changes the
   finding status to `actioned`. On `failure` or `queued`, the finding
   stays `open`.
6. **One audit entry per executed action.** The dispatcher appends the
   entry after the handler returns, before reporting the result. A
   refused action writes no entry, because nothing was executed.
7. **Handler errors are caught, not thrown.** If a handler throws, the
   dispatcher converts the throw into a `failure` outcome with the error
   text, writes the audit entry, and keeps the finding open.

A refused dispatch returns `{ status: "refused", reason }`. An executed
dispatch returns `{ status: "executed", entry, finding }`, where `entry`
is the audit entry and `finding` is the finding after the status update
(or the unchanged finding when the action failed or was queued).

### 1.3 Current wiring status

**Implemented, not wired:** the bot server (`src/attestation/server.ts`)
and the console server (`src/console/server.ts`) both construct the
dispatcher with an empty handler map (`handlers: {}`). In the current
wiring, Restrict and Archive decisions are recorded and then refused by
the dispatcher, and the refusal is reported to the caller. No Graph write
happens until the handlers are registered with the dispatcher. Register
`createRevokeLinkHandler`, `createExpireGuestHandler`, and
`createArchiveSiteHandler` (with a delegated admin session for archive)
before relying on remediation.

## 2. Restrict: revoke an anonymous link

**Ghost type:** `overshared-site`.
**Decision that triggers it:** the owner (or the admin, from the
exceptions queue) taps Restrict.
**Platform call:** `DELETE /drives/{drive-id}/items/{item-id}/permissions/{permission-id}`.
**Permission required:** `Sites.ReadWrite.All`.

### 2.1 How it works

The scan's permissions fetcher records the anonymous link's Graph ids on
the finding, in `numbers.anonymousLink`: `driveId`, `itemId`, and
`permissionId`. The handler reads those three ids from the finding and
deletes that one permission. It never invents an id. If any of the three
is missing, the handler reports `failure` with the error "No permission
id was recorded for this link during the scan; nothing was revoked", and
nothing is deleted.

On a successful `DELETE`, the handler reports `success` with the target
set to the full permission path. The dispatcher writes the audit entry
and marks the finding `actioned`.

### 2.2 What it changes

Only the anonymous sharing link is removed. People who already had
access through the team, the site, or a direct share keep their access.
The site, the file, and all other permissions are untouched. After the
revocation, the content can no longer be opened by anyone with the link.

### 2.3 Reversibility

**Not reversible.** The link is gone. If the link is needed again, the
owner must create a new sharing link. The audit entry records
`restorePath` as null, which is the system's way of saying there is no
undo path. The handler's own comment states this plainly: "The link is
gone and must be recreated by the owner."

Because revocation cannot be undone, the owner-facing card explains
Restrict in plain words ("Remove the public link so only your team can
open it") and the decision is recorded before the call is made.

### 2.4 Failure modes

| Failure | Handler result | Finding | Audit entry |
|---|---|---|---|
| No link ids on the finding | `failure` | Stays `open` | Written, with the error |
| Graph rejects the `DELETE` (for example, 403 or 404) | `failure` | Stays `open` | Written, with the Graph error |

A common cause of the missing-ids failure is a finding created by a scan
that ran before the fetcher recorded link ids, or a finding whose
permissions call was unreadable. Re-run the scan so the fetcher records
the ids, then decide again on a fresh card.

## 3. Revoke: expire a stale guest

**Ghost type:** `stale-guest`.
**Decision that triggers it:** the owner (or the admin, from the
exceptions queue) taps Restrict on a stale-guest card. Note the naming:
the card action is Restrict, and the dispatcher maps it to the
`revoke` remediation action for this ghost type.
**Platform call:** `DELETE /users/{guest-id}`.
**Permission required:** a user write permission on the Graph app
registration. The repository does not name the exact permission in code
for this call; grant the permission that covers user deletion and verify
it before relying on the action.

### 3.1 How it works

The guest id is the finding's `subjectId` and is never guessed. The
handler deletes the guest user at `/users/{guest-id}`. On success, it
reports `success` with the target set to the user path and the restore
path set (see section 3.3). The dispatcher writes the audit entry and
marks the finding `actioned`.

### 3.2 The 404 case

If Graph returns 404, the handler does not immediately fail. It checks
`GET /directory/deletedItems/{guest-id}`:

- If the directory confirms the guest is in deleted items, the handler
  reports `success`: the guest is already gone, which is the outcome the
  decision asked for.
- If the check also fails, the handler reports `failure` with the
  original delete error, and the finding stays open.

A guest is counted as fixed only when the directory confirms it is gone,
never on a bare 404.

### 3.3 Reversibility

**Reversible for 30 days.** Entra ID soft-deletes the user into
deleted items. The guest can be restored within 30 days with
`POST /directory/deletedItems/{guest-id}/restore`. The audit entry
records the restore path as
`Within 30 days: POST /directory/deletedItems/{guest-id}/restore`
(with the real guest id). After 30 days the deletion becomes permanent
under Entra ID retention rules, which Spectre does not control.

### 3.4 What it changes

The guest account is deleted and the guest loses access to the tenant.
No other user, group, or site is affected. The finding is marked
`actioned` only after the delete (or the deleted-items confirmation)
succeeds.

## 4. Archive a cold site

**Ghost type:** `cold-storage`.
**Decision that triggers it:** the owner (or the admin, from the
exceptions queue) taps Archive.
**Platform call:** none, from the service. Archiving runs through the
SharePoint admin surface under a delegated admin session.

### 4.1 Why there is no app-only path

No Graph endpoint archives a SharePoint site, and the SharePoint
TenantAdministration REST API rejects app-only tokens (verified during
development). The service therefore cannot archive a site with its own
credentials. This is a platform constraint, not a missing feature in
Spectre.

### 4.2 How it works

The handler first reads the site URL from Graph with
`GET /sites/{site-id}` and the `webUrl` field. The URL is read from
Graph, never built or guessed. If Graph returns no URL, the handler
reports `failure` and nothing is archived.

Then, in order:

- **With a delegated admin session:** the handler calls the session's
  `archiveSite(siteUrl)`. On success it reports `success` with the
  target set to the site URL and the restore path set to "Reactivate the
  archived site from the SharePoint admin center (Archived sites)." The
  dispatcher writes the audit entry and marks the finding `actioned`.
- **Without a delegated admin session:** the handler reports `queued`
  with the target set to the site URL and the error set to the exact
  command the admin must run. The dispatcher writes the audit entry with
  result `queued` and the finding stays `open`. Nothing is executed and
  no credential is guessed.

The exact command recorded on a queued entry is:

```powershell
Set-SPOSite -Identity "<site-url>" -Archive
```

with `<site-url>` replaced by the site URL read from Graph. The admin
runs it under their own delegated session (PnP PowerShell or the
equivalent admin surface), then the finding can be closed on the next
scan or by an admin decision.

### 4.3 Reversibility

**Reversible.** An archived site can be reactivated from the SharePoint
admin center (Archived sites). The audit entry records that restore path.
Archiving does not delete content; it makes the site read-only and
removes it from active use until reactivated.

### 4.4 Failure modes

| Failure | Handler result | Finding | Audit entry |
|---|---|---|---|
| Graph returns no site URL | `failure` | Stays `open` | Written, with the error |
| No delegated session | `queued` | Stays `open` | Written, result `queued`, error carries the exact command |
| Delegated session call fails | `failure` | Stays `open` | Written, with the error |

## 5. Audit log

Every executed action writes exactly one entry to the `audit_log` table.
The entry carries: finding id, action (`restrict`, `archive`, `revoke`),
target, approver UPN, timestamp, result (`success`, `failure`,
`queued`), error text, and restore path. The attestation loop never
writes to the audit log directly; only the dispatcher does, so an entry
always means an action was attempted.

The admin console reads the audit log with `GET /audit`, newest first,
and shows each entry with its result and restore path. A failed action is
shown as failed with the error attached. A queued action is shown as
queued with the command to run. Neither is ever shown as fixed, and the
finding stays open in both cases.

## 6. Live verification (planned, not done)

The remediation spec calls for live verification on the fixture tenant
(task 5.2): revoke one seeded anonymous link, delete one seeded guest,
archive one seeded cold site (the cold-site archive is queued for the
admin, because there is no delegated session in the demo), then re-scan
to confirm the findings clear. Unit tests for the dispatcher and the
audit entries exist (`src/remediation/__tests__/remediation.test.ts`).
The live verification has not been run. Until it is, the remediation
actions are proven by unit tests only, and the wiring gap in section 1.3
means no live remediation has been executed through the servers.

When live verification runs, it changes fixture counts: revoking a link
reduces the overshared count, deleting a guest reduces the stale-guest
count. Restore the fixtures afterwards (re-run the seeder) so the
verifier passes again. Back up the database file before the run.
