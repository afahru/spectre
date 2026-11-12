# Spectre Remediation — Design

## Overview

Remediation executes only owner-approved decisions, one audit log entry
per action, never marking a finding fixed on failure. Actions run through
Graph/SharePoint with the app's existing permissions where the platform
allows; where the platform requires a delegated admin session, the action
is queued for the admin with the exact command instead of failing
silently.

## Architecture

```
approved decision (attestation loop)
  -> remediation dispatcher (by ghost type + action)
  -> Graph / SharePoint call (app-only where allowed)
  -> audit log entry (finding id, action, target, owner, timestamp, result)
  -> finding status: fixed / open (on failure) / queued-for-admin
```

## Components

### Revoke an "anyone" link (Restrict, overshared)

- `DELETE /drives/{drive-id}/items/{item-id}/permissions/{permission-id}`
  removes the anonymous sharing link. It uses the permission id recorded
  by the permissions fetcher during the scan (the same id that detected
  the link). Requires Sites.ReadWrite.All (already granted).
- Success means an audit entry plus the finding fixed. Failure means the
  finding stays open, the error is recorded, and the admin queue is
  notified. A finding is never marked fixed on failure.

### Archive a cold site (Archive, cold-storage)

- No app-only Graph endpoint archives a SharePoint site, and the
  SharePoint TenantAdministration REST API rejects app-only tokens
  (verified 2026-11-12). The archive runs through the SharePoint admin
  surface under a delegated admin session (PnP PowerShell
  `Set-SPOSite -Archive` or the equivalent admin REST call).
- If no delegated session is available, the action is recorded as
  queued-for-admin with the exact command and the finding stays open. It
  is never marked fixed and never executed with a guessed credential.
- Archive is reversible (an archived site can be reactivated); the audit
  entry records the restore path.

### Expire a stale guest (Revoke, stale-guest)

- `DELETE /users/{guest-id}` removes the guest account. Entra ID
  soft-deletes the user: it lands in deletedItems and can be restored
  within 30 days via `POST /directory/deletedItems/{id}/restore`. That is
  the reversibility mechanism the requirement asks for.
- Success means an audit entry (finding id, guest, owner, timestamp,
  restore path) plus the finding fixed. Failure means the finding stays
  open with the error recorded.

### Audit log

- One entry per action in the audit store: finding id, action, target
  (link / site / guest), owner who approved, timestamp, result
  (success / failure / queued), and the restore path where one exists.
- The admin console reads the audit log; the attestation loop never
  writes to it directly.

## Correctness properties

- No action executes without a recorded owner approval.
- No finding is marked fixed unless the platform call succeeded.
- Every action is reversible where the platform supports it. Link
  revocation is the exception: the link is gone and must be recreated by
  the owner, and the audit entry says so plainly.
- Failed actions keep the finding open with the error attached.

## Errors

- Graph 403/404 on revoke: record the error, keep the finding open,
  admin queue.
- Archive without a delegated session: queued-for-admin, never executed
  blindly.
- Guest already deleted: treat as already fixed only if the directory
  confirms the guest is gone; otherwise keep open.

## Testing strategy

- Unit tests for the dispatcher (decision maps to the correct API call,
  no call without approval).
- Unit tests for the audit entries (one per action, failure never marks
  fixed).
- Live verification on the fixture tenant: revoke one seeded anonymous
  link, delete one seeded guest, archive one seeded cold site (the cs
  sites are fixtures, safe to archive in the demo), then re-scan to
  confirm the findings clear.
