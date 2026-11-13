# Spectre Scan Supersession — Design

## Overview

The fix has three parts that must land together, because each one alone
leaves a hole: (1) a supersession step at the end of every scan that
closes the previous scan's open findings; (2) decisions, suppression,
send history, and queue membership keyed by the ghost — (type,
subjectId) — instead of by finding row id; (3) a one-time backfill that
cleans the live database, which already holds 992 open rows for 98
ghosts. The attestation timer stays paused until the backfill is
verified; re-enabling it is a user decision, not part of this spec.

## Architecture

```
scan (index.ts / verify.ts)
  -> inventory -> flagging -> permissions fetch -> anonymous-link detection
  -> NEW: supersedePreviousFindings(store, newFindings, scanTimestamp)
  -> score (unchanged: counts only open findings)
  -> attestation loop (delivery / nudge)
       -> decisions by subject, suppression enforced, sends by subject
  -> console (latest-scan views == open set)
```

The supersession step runs after anonymous-link detection (step 6b) and
before scoring (step 7), in both entry points, through one shared
helper — the verifier duplicated the anonymous-link step once already
and drifted from the main scan (bug-hunt L1), so the step is written
once and called twice.

## Components

### Supersession step

A pure function over the existing `FindingStore` interface; no new
store method is needed.

```ts
supersedePreviousFindings(
  store: FindingStore,
  newFindings: Finding[],   // rows inserted by this scan
  scanTimestamp: string,
): Promise<{ superseded: number; resolved: number }>
```

- Build the set S of (type, subjectId) from `newFindings`.
- List all open findings (`store.listOpen()`).
- For each open row whose scanTimestamp is older than this scan:
  - (type, subjectId) in S → `updateStatus(id, "superseded")`.
  - (type, subjectId) not in S → `updateStatus(id, "resolved")`.
- Rows from this scan are never touched. Rows already `actioned` or
  `dismissed` are never listed (listOpen returns open only) and are
  never touched.
- The step is idempotent: a second run finds no open rows older than
  this scan and changes nothing. A crash mid-step leaves the
  unprocessed rows open; the next completed scan supersedes them, so
  the step is self-healing. (Resumable scans themselves remain broken
  by design, bug-hunt M6; this spec does not fix M6, it only guarantees
  a crashed scan cannot leave duplicates behind forever.)

### Status values

Two new statuses join `FindingStatus` (`"open" | "actioned" |
"dismissed"` becomes `"open" | "actioned" | "dismissed" |
"superseded" | "resolved"`).

- `superseded`: the ghost was re-found by a later scan; a newer row
  now carries it. The ghost is still live, only the row is retired.
- `resolved`: the ghost was NOT re-found by a later scan; the exposure
  is gone (site deleted, guest removed, licence reclaimed, link
  revoked, or the heuristic no longer fires).

Reusing `dismissed` was rejected: `dismissed` means a human accepted
the risk (Keep), and the console shows it as such. Reusing it for
scan-driven closure would corrupt the accepted-risk meaning and make
the dismissed filter lie. Reusing `actioned` was rejected for the same
reason: no fix ran. Two values, not one, because the admin must be
able to distinguish "still a live ghost, see the newer row" from
"gone".

Schema impact: none. The findings table stores status as TEXT;
`updateStatus` already accepts any `FindingStatus`. The console
`STATUSES` list in `src/console/api.ts` and the `STATUS_LABEL` record
in `web/src/views/FindingsView.tsx` (a `Record<FindingStatus,
string>`, so TypeScript forces the update) gain both values. The
findings filter options are built from `STATUS_LABEL` keys, so the
filter updates itself. The badge already renders any non-open status
as informative; no web change beyond the label record.

### Subject-keyed decisions

`DecisionRecord` gains `type: GhostType` and `subjectId: string`;
`findingId` stays as the row that captured the decision, for
traceability. `DecisionStore` gains:

```ts
getBySubject(type: GhostType, subjectId: string): Promise<DecisionRecord | null>
```

and `put` becomes an upsert by subject: one active decision per ghost.
The SQLite table migrates from `PRIMARY KEY (finding_id)` to
`PRIMARY KEY (type, subject_id)` via create-new-table, copy with a
join to findings for (type, subjectId), drop old, rename, inside one
transaction. `InMemoryDecisionStore` re-keys its Map by
`type + "|" + subjectId`. `INSERT OR IGNORE` is replaced by a plain
insert that throws on conflict (bug-hunt M7: the silent ignore is
what let two concurrent postbacks both dispatch).

Active-decision rule, used in exactly the same way by the Teams
decision handler, the console `decide()` 409 check, delivery, and
the nudge check:

```ts
isDecisionActive(record: DecisionRecord | null, at: Date): boolean
// Restrict / Archive: active whenever a record exists (no expiry).
// Keep: active while isSuppressed(record, at) is true.
```

This is the call site `isSuppressed()` was waiting for: it is finally
invoked, with expiry, instead of the old existence-only checks. An
expired Keep stops blocking delivery and the nudge clock, and a fresh
decision for the same subject may then be recorded. A Restrict or
Archive decision never expires and is never re-asked.

### Subject-keyed send history and queue membership

The send log and the admin queue stay keyed by finding id in storage
(no schema change), but delivery and the nudge look them up by
subject:

- `SendLog` gains `listBySubject(type, subjectId)`, implemented in
  `SqliteDeliveryStore` as a join from `attestation_sends` to
  `findings` on `finding_id` (rows are never deleted, so the join
  resolves even for superseded rows). Delivery's already-sent check
  and the nudge's message-count and age checks use it. The 2-message
  budget and 7-day cadence are unchanged; they now follow the ghost
  across scans instead of resetting on every new row.
- `AdminQueue` gains `hasBySubject(type, subjectId)`, same join
  pattern. Delivery and the nudge skip queued subjects under any row
  id. Removing queue entries after a decision (bug-hunt M2) is a
  separate follow-up and is NOT in this spec.

### Backfill script

`npm run backfill:supersede` (new entry point, e.g.
`src/store/backfill-supersede.ts`), run against `DB_PATH`:

1. Dry-run by default: print the counts it would change and exit
   without writing. `--apply` performs the writes.
2. Per (type, subjectId), keep the newest open row open; mark all
   older open rows `superseded`. Never mark anything `resolved` in
   the backfill: it cannot prove the latest scan completed (bug-hunt
   M6), so ghosts the latest scan did not find stay open until a
   completed post-fix scan resolves them through the normal step.
3. Migrate decision rows to the subject-keyed table (same
   create/copy/drop/rename as the code migration; the live database
   holds 1 decision row).
4. Print before/after counts: open rows, distinct subjects,
   superseded rows, migrated decisions. Expected on the current live
   database as of 2026-11-13: 992 open before, 98 open after, 894
   superseded, 1 decision migrated. The script verifies the invariant
   (open-after equals distinct subjects, superseded equals
   open-before minus open-after), not the literal numbers, and refuses
   to claim success if the invariant fails.
5. Idempotent: a second run (dry or applied) reports zero changes.
6. Run order, manual and user-gated: copy the live database, run
   the backfill against the copy, verify the counts, then run
   `--apply` against the live database on VM1
   (`/data/workspace/spectre/spectre.db`), verify the counts again,
   and only then re-enable the attestation timer. The timer
   re-enable is out of scope for the code in this spec.

The admin queue holds 0 rows on the live database today, so no queue
migration is needed; the script asserts that and aborts with a clear
message if the queue is non-empty when run, rather than guessing what
to do with it.

### Console agreement

After a completed scan, every open row carries the latest scan
timestamp (older open rows were superseded or resolved), so
`listOpen()` and `listByScan(latestScanTimestamp())` return the same
set of ids. The console's latest-scan views and the attestation
loop's open set therefore agree by construction; no console logic
changes beyond the two new statuses. The scorer is untouched: it
already counts only open findings.

## Correctness properties

- At most one open finding per (type, subjectId) after any completed
  scan, and after the backfill.
- A Keep decision suppresses re-asking for exactly 30 days from the
  tap, across scans, and stops suppressing the day it expires.
- A decision is recorded at most once per subject while active; a
  duplicate postback or console decide returns the recorded decision
  (or 409) and never dispatches twice.
- No finding is messaged more than twice per ghost; the nudge cadence
  survives re-scans.
- Actioned and dismissed rows are never modified by a scan or by the
  backfill.
- The backfill changes nothing on a second run and nothing at all in
  dry-run mode.

## Errors

- Backfill against a database whose admin queue is non-empty: abort
  with a clear message; do not guess.
- Backfill counts differ from the expected 992 → 98 on the live
  database: report the actual numbers, do not claim success.
- Decision-table migration finds a decision whose finding row is
  missing: abort; the row is evidence of a corrupt store, not
  something to invent a subject for.
- Supersession step throws mid-scan: the scan fails loudly (non-zero
  exit) rather than scoring a half-superseded store; the next scan
  heals it.

## Testing strategy

- Unit tests for the supersession step against an in-memory store:
  re-found → superseded, not re-found → resolved, actioned/dismissed
  untouched, idempotent second run, crash simulation (partial run
  then re-run heals).
- Unit tests for subject-keyed decisions and suppression: Keep on row
  1 suppresses a card for row 2 of the same subject while unexpired;
  expired Keep does not suppress; Restrict decision blocks a second
  decision on a new row; a different subject is unaffected.
- Unit tests for subject-keyed sends: a send recorded for row 1
  blocks a fresh initial card for row 2; the nudge still fires once
  at 7 days against the combined history.
- Backfill tests on a synthetic database with the live shape (13
  scans, duplicate subjects): dry-run changes nothing, applied run
  yields one open row per subject, second run changes nothing.
- Full suite green (`npm test`); fixture verifier run twice against
  the same database, ALL PASS both times.
