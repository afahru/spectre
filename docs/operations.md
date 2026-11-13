# Spectre Operations

This is the runbook for running Spectre day to day: the daily run, the nudge schedule, monitoring, backup and restore, troubleshooting, and the known limitations of the current build. It assumes the deployment in [deployment.md](deployment.md) is complete.

The daily routine is short: scan once, send the cards, check the nudges, and glance at the console. Everything else in this document is for when something looks wrong.

## 1. Daily run

Spectre has no built-in timer. The daily run is one command, `npm run attest`, which does the delivery and the nudge check in order. All three steps below read and write the same SQLite file (`DB_PATH`).

### 1.1 Scan

```bash
node dist/index.js
```

Run once a day, or on the schedule the tenant needs. The scan is a one-shot process that exits when it finishes. Confirm exit code 0 and read the log lines: inventory counts (sites, guests, licence assignments, SKUs), flagging counts (candidates to findings persisted), permissions fetch results (`fetched`, `cached`, `unreadable`), the anonymous-link detection count, and the readiness score with its breakdown. A non-zero exit means the process failed; the log states the cause (usually missing configuration or an unrecoverable Graph error).

The scan is resumable: if it stops mid-run, the next run resumes from the last persisted page in `collector_progress` instead of restarting the inventory. A scan that is interrupted does not leave partial findings in an inconsistent state, because findings are inserted as they are flagged and each insert is a single row write.

### 1.2 Card delivery and nudge check

```bash
npm run attest
```

The daily runner (`src/attestation/run.ts`) does both steps in order: it delivers cards for open findings (`deliverOpenFindings` in `src/attestation/delivery.ts`), then runs the nudge check (`runNudgeCheck` in `src/attestation/nudge.ts`). It prints one JSON summary line (`sent`, `nudged`, `escalated`, `queued`, `skipped`) and exits 0 on success. Nothing invokes it on a timer yet, so schedule it with the host's scheduler or run it by hand once a day. It has not yet been run against the live database, because it would send real cards to owners.

Delivery rules, enforced by the function:

- A finding with any recorded send is skipped. The second message belongs to the nudge rule.
- A finding with a recorded decision is skipped.
- A finding already in the admin queue is skipped.
- A finding with no owner goes to the admin queue with reason `ownerless`.
- A finding whose owner has no learned bot conversation goes to the admin queue with reason `owner unreachable`, with the error attached. It is never retried in a loop and never sent to a guessed address.
- A failed send goes to the admin queue with the error attached.

### 1.3 Nudge check

The nudge check runs once a day, after delivery, as the second step of `npm run attest`. It is the `runNudgeCheck` function in `src/attestation/nudge.ts`.

### 1.4 Nudge schedule

| Elapsed time | Action |
|---|---|
| Day 0 | Initial card sent to the owner |
| Day 7 with no answer | One nudge: the same card, marked as a reminder |
| Day 14 with no answer (7 days after the nudge) | Finding moves to the admin exceptions queue with reason `no response` |

Limits, enforced in code:

- At most **two messages per finding** (initial plus nudge). The nudge never sends a third message.
- A finding with a recorded decision is never nudged.
- A finding with no recorded send is left to card delivery; the nudge does not send a first card.
- A failed nudge goes to the admin queue with reason `owner unreachable` and the error attached, and is not retried.

## 2. Monitoring

### 2.1 What to check

| Check | How | Healthy when |
|---|---|---|
| Bot server alive | Process is running; an unauthenticated `POST` to `/api/messages` returns 401 | Process up, 401 on unauthenticated request |
| Tunnel alive | The public messaging endpoint URL answers (401 on unauthenticated `POST`) | 401 in under a few seconds |
| Bot registration endpoint matches the tunnel | The messaging endpoint on the bot registration equals the live tunnel URL | URLs match |
| Console server alive | `GET /score` returns 200 | 200 with a score object |
| Scan exit code | Last scan run log | Exit code 0 |
| Scan findings | Last scan log line and `GET /findings` | Findings persisted, score computed |
| Verifier (fixture tenant) | `npm run verify` | All ghost types PASS against `src/seeder/constants.ts` |
| Audit log | `GET /audit` | One entry per executed action; no action without an entry |

### 2.2 What to watch in the logs

- `Spectre bot listening on :3978/api/messages`: the bot server started and is listening.
- `attestation: POST /api/messages auth=present` followed by `auth=true`: an authenticated activity arrived. `auth=false` means a request failed JWT validation and was rejected with 401.
- `attestation: learned conversation upn=<ADMIN_UPN>`: an owner's 1:1 conversation was learned. If this never appears for an owner, that owner cannot receive cards.
- `attestation: postback ignored: <reason>`: a postback was ignored. Common reasons: missing finding id, unknown action, finding not found, finding has no owner. The finding stays open.
- `attestation: messaging endpoint error: ...`: the endpoint threw during handling and returned 500. Teams retries the submit.
- Scan log `unreadable=N` greater than 0: N items could not be read (usually a missing permission). Investigate; a tenant can look clean when items are unreadable.
- Console log `console: ...`: an API error. The console returns 500 with `{ "error": "Internal error." }` and never serves stale numbers as current.

### 2.3 Alerting

There is no built-in alerting, metrics export, or health endpoint in the current code. If the deployment needs alerting, add an external check that: the bot server process is running, the public endpoint answers 401 to an unauthenticated `POST`, the console `GET /score` returns 200, and the last scan exited 0 within the expected window. Alert on any of those failing, and on a scan that reports unreadable items.

## 3. Backup and restore

### 3.1 What to back up

The entire state of Spectre is the SQLite file at `DB_PATH` (default `./spectre.db`). Back it up as a file copy. The file contains findings, decisions, the admin queue, the audit log, conversation references, the send log, the permissions cache, and the collector progress. There is no separate backup command; copy the file while the services are stopped, or copy it and verify it opens, because SQLite allows a hot copy but a copy taken mid-write can be inconsistent.

Back up on this schedule at minimum:

- Before every scan that follows a seeder run or a remediation live verification, because those change fixture counts.
- Before any upgrade of the service or the database schema.
- Daily, alongside the scan, so the audit trail is preserved.

### 3.2 Restore

1. Stop the bot server, the console server, and any scheduled scan.
2. Replace the database file with the backup copy.
3. Restart the services.
4. Confirm `GET /score` returns the expected scan timestamp and `GET /audit` returns the expected entries.

A restore brings back everything in the file, including recorded decisions and the admin queue, because decisions and queue entries are stored in the database. Findings recorded after the backup was taken are lost with it, as expected from a file restore.

### 3.3 Retention

There is no retention or purge job in the current code. The file grows with every scan: one row per finding per scan run, plus audit, decision, queue, send, cache, and progress rows. Plan retention for the deployment (for example, archive the file per scan run and keep a defined number of runs). Do not delete the file while a service is running.

## 4. Troubleshooting

### 4.1 The bot delivers nothing

Symptoms: the owner sends messages in Teams, the bot never replies, no card arrives, and the server log shows no `POST /api/messages` at all.

Check in order:

1. **Microsoft Teams channel not enabled.** This is the most common cause and the failure is silent: Teams accepts the user's messages but never delivers them to the bot. Open the bot registration, go to Channels, and confirm the Microsoft Teams channel is enabled. Enable it and save.
2. **Messaging endpoint mismatch.** Confirm the messaging endpoint on the bot registration equals the live public URL. A tunnel that restarted with a new random URL breaks delivery until the endpoint is updated.
3. **Bot server down.** Confirm the process is running and an unauthenticated `POST` to the public URL returns 401. If the host paused or restarted, restart the server.
4. **Tunnel down.** Confirm the tunnel process is running and the public URL answers. A tunnel dies when its host pauses or the tunnel process stops.
5. **App not installed for the owner.** Confirm the Teams app is installed org-wide (Setup policies, Global) or at least for the owner. Without the install, the owner has no conversation with the bot.

### 4.2 The bot receives messages but authentication fails

Symptoms: the server log shows `POST /api/messages auth=present` then `auth=false`, and the response is 401.

Causes:

- **Wrong OpenID configuration URL.** The endpoint fetches signing keys from `https://login.botframework.com/v1/.well-known/openidconfiguration`. The shorter path `openidconfig` returns 404 with an empty body, which makes key fetching throw and every token fail validation. Confirm the constant in `src/attestation/endpoint.ts` is the full `openidconfiguration` path.
- **Wrong bot App ID.** The token audience must equal `BOT_APP_ID`. If the environment variable holds a different app id than the bot registration, every token fails. Confirm the value matches the registration.
- **Clock skew.** The token expiry and not-before checks use the server clock. A host clock that is far off rejects valid tokens. Confirm the host clock is correct.

### 4.3 The public endpoint changed

Symptoms: the bot worked, then stopped delivering after the host paused, restarted, or the tunnel restarted.

Cause: the public URL changed (a quick tunnel issues a new random URL on every start) and the bot registration still points at the old URL. Fix: start the tunnel, copy the new public URL, set it as the messaging endpoint on the bot registration (path `/api/messages`), save, and verify the save persisted by reloading the registration. For a durable fix, use a named tunnel or a reverse proxy with a fixed hostname instead of a quick tunnel.

### 4.4 A tap is ignored: "finding has no owner"

Symptoms: the owner taps a card button, Teams shows "Your response was sent to the app", but the finding stays open and the log shows `postback ignored: finding <id> has no owner`.

Cause: the finding record has `owner` null. The decision handler refuses to record a decision without an owner UPN from the finding, because the record needs an owner and the owner is never guessed. This happens when a card was sent for an ownerless finding (for example, a demo card sent by hand bypassing recipient resolution). Fix: set the correct owner on the finding, send a fresh card, and have the owner tap again. Do not edit the decision handler to accept ownerless postbacks; the refusal is the safety rule working.

### 4.5 A Restrict tap reports "No permission id was recorded"

Symptoms: the owner taps Restrict, the decision is recorded, but the remediation fails with "No permission id was recorded for this link during the scan; nothing was revoked", and the finding stays open.

Cause: the finding's `numbers.anonymousLink` is absent. The revoke handler needs the `driveId`, `itemId`, and `permissionId` recorded by the permissions fetcher during the scan. Findings created by a scan that ran before the fetcher recorded link ids, or findings whose permissions call was unreadable, have no link ids to revoke. Fix: re-run the scan so the fetcher records the link ids, then have the owner tap Restrict again on a fresh card. The failure is audited and the finding stays open, which is the correct behaviour.

### 4.6 The console decide endpoint returns 503

Cause: `ADMIN_UPN` is not configured on the console server. Set the environment variable to the deciding admin's UPN and restart the console server. There is no other way to enable decisions.

### 4.7 The console shows no findings

Causes, in order: no scan has run yet (`GET /score` returns all nulls); the console server points at a different `DB_PATH` than the scan engine; or `web/dist` was not built (the page returns 404 with "Not found. Build the console first: npm run web:build"). Confirm the database path matches on all three processes and rebuild the console.

### 4.8 The scan reports unreadable items

The permissions fetch records an item as unreadable when its permissions call fails with a non-429 error, usually a missing Graph permission. Confirm the app registration has the read permissions for the endpoints in [deployment.md](deployment.md#23-graph-endpoints-the-service-calls) and that admin consent is granted. Re-run the scan after fixing the permission; the cache is keyed by item and scan run, so a new scan re-fetches.

## 5. Known limitations

These are true of the current code. Do not work around them silently; plan them as follow-up work.

1. **No timer on the daily run.** The runner exists (`npm run attest`), but nothing invokes it on a schedule. The operator (or an external scheduler) must run it daily. It has also not yet been run against the live database.
2. **No score trend storage.** The scorer returns each result with its timestamps but does not persist previous scores. Trend display needs a caller that stores each scan's result.
3. **No alerting, metrics, or health endpoint.** Monitoring is external.
4. **No retention or purge job.** The database file grows with every scan.
5. **No tamper evidence on the audit log.** The audit log is a plain SQLite table in the same file as the findings. Export it to an append-only store for production use.
6. **The SPFx web part is a stretch goal, not implemented.** The admin console is a standalone React app served by the service. A SharePoint Framework web part is planned only if capacity remains.
7. **The admin console spec task list is partly out of date.** The console task 5.2 is done; task 5.1 (unit-test the read API and the decide endpoint) is still open. The code governs over the checkboxes.

Resolved since the first draft of this document: decisions are now persisted in SQLite (`attestation_decisions`), the remediation handlers are wired into both servers, the admin queue is persisted (`attestation_admin_queue`) and served by the console, the attestation unit tests exist (23 tests, 62 tests total), and live remediation verification has been run on the fixture tenant (anonymous link deleted, guest deleted, cold-site archive queued; the fixture score moved from 73 to 78 across the two actions, then fixtures were re-seeded back to 73).

Heuristics the runbook relies on: the 90-day stale-guest and idle-licence thresholds and the 365-day cold-storage threshold are Spectre's choices, not Microsoft definitions; the 0 to 100 readiness score is Spectre's own design, not a Microsoft score. The thresholds are labelled "Heuristic" in [architecture.md](architecture.md).

## 6. References

Microsoft Learn links first. All links below appear in the research report of 13 November 2026; pages marked (live) were opened live that day.

- Microsoft Learn (live): Monitor and clean up stale guest accounts: https://learn.microsoft.com/en-us/entra/identity/users/clean-up-stale-guest-accounts
- Microsoft Learn (live): Restore a deleted user: https://learn.microsoft.com/en-us/entra/fundamentals/users-restore
- Microsoft Learn (live): Copilot readiness report (counts, no score): https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness
- Microsoft Learn (live): Data access governance reports: https://learn.microsoft.com/en-us/sharepoint/data-access-governance-reports
