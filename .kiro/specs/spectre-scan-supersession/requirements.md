# Spectre Scan Supersession — Requirements

## Introduction

Every scan inserts a fresh finding row per candidate and nothing ever
closes the previous scan's open findings. The live database proves it:
13 scans left 992 open findings for only 98 distinct (type, subjectId)
pairs. The attestation loop iterates `listOpen()` across all scans while
the console score and findings read only the latest scan, so the two views
disagree and the first attestation run would have sent 23 duplicate cards
to the owner plus about 969 admin-queue entries. The attestation timer is
paused until this fix lands.

A second defect rides on the same root cause: decisions and Keep
suppression are keyed by finding row id. Every re-scan mints new ids, so
a Kept ghost is re-asked on the next scan anyway, and `isSuppressed()` is
never called anywhere. Requirement 2.3 of the attestation loop ("SHALL
NOT re-ask for 30 days") is unenforced.

This spec fixes both: a scan supersedes the previous scan's open
findings, and decisions, suppression, send history, and queue membership
are keyed by the ghost itself — (type, subjectId) — not by the row that
happened to record it.

## Requirements

### Requirement 1: Scan supersession

**User Story:** As an admin, I want each scan to close the previous
scan's open findings for ghosts it re-finds or no longer finds, so the
open set always describes the current tenant, not the history of scans.

#### Acceptance Criteria

1. WHEN a scan completes flagging (including anonymous-link detection),
   THE System SHALL close every previously open finding for the same
   (type, subjectId) that the scan re-found, with status `superseded`.
2. WHEN a scan completes flagging, THE System SHALL close every
   previously open finding whose (type, subjectId) the scan did NOT
   re-find, with status `resolved`.
3. THE System SHALL touch only findings whose status is `open`.
   Findings with status `actioned` or `dismissed` are history and SHALL
   NOT be changed by any scan.
4. WHEN the supersession step runs a second time for the same scan, THE
   System SHALL change nothing (the step is idempotent).
5. WHEN a scan crashes before the supersession step finishes, THE System
   SHALL leave the unprocessed old rows open, and the next completed
   scan SHALL supersede them (the step is self-healing).

### Requirement 2: One open row per ghost

**User Story:** As an admin, I want at most one open finding per ghost,
so the attestation loop and the console never disagree about what is
open.

#### Acceptance Criteria

1. WHEN a scan completes, THE System SHALL leave exactly one open
   finding per distinct (type, subjectId) found by that scan, and zero
   open findings for ghosts the scan did not find.
2. WHEN a scan completes, THE System SHALL satisfy the invariant
   `listOpen()` returns exactly the rows of `listByScan(latestScan)`.
3. THE System SHALL count only findings with status `open` in the
   scorer and in the attestation loop; `superseded` and `resolved`
   rows SHALL NOT receive cards, nudges, or score penalty.

### Requirement 3: Decisions survive re-scan (keyed by subject)

**User Story:** As a content owner, I want a decision I already made
about a ghost to still count after a new scan, so I am never asked
twice about the same ghost.

#### Acceptance Criteria

1. THE System SHALL key every decision by (type, subjectId), not by
   finding row id, and SHALL record the finding row that captured the
   decision for traceability.
2. WHEN a postback or a console decision arrives for a finding whose
   subject already has a decision, THE System SHALL treat it as a
   duplicate of that decision while the decision is active, and SHALL
   NOT dispatch remediation a second time.
3. WHEN a decision exists for a subject, THE System SHALL NOT record a
   second decision for the same subject while the first is active.
4. WHEN the same ghost is re-found by a later scan, THE System SHALL
   NOT ask the owner again while an active decision exists for that
   subject.

### Requirement 4: Keep suppression enforced with expiry

**User Story:** As a content owner who tapped Keep, I want the loop to
stay quiet for 30 days and to ask again only after that, so accepted
risk is respected but not forgotten.

#### Acceptance Criteria

1. WHEN the owner taps Keep, THE System SHALL suppress re-asking for
   that (type, subjectId) until `acceptedUntil` (now + 30 days).
2. THE System SHALL enforce suppression by calling `isSuppressed()` in
   delivery and in the nudge check; a decision's mere existence SHALL
   NOT suppress anything.
3. WHEN a Keep decision's `acceptedUntil` has passed, THE System SHALL
   treat the ghost as unanswered again: delivery MAY send a fresh card
   and the nudge clock MAY run.
4. WHEN a Restrict or Archive decision exists for a subject, THE System
   SHALL treat it as active with no expiry; it is never re-asked.

### Requirement 5: Send history and queue membership survive re-scan

**User Story:** As a content owner, I want the two-message limit and
the 7-day nudge cadence to follow the ghost, not the row, so a new scan
does not restart the messaging clock.

#### Acceptance Criteria

1. THE System SHALL look up send history by (type, subjectId), not by
   finding row id, when deciding whether a finding has already been
   sent.
2. WHEN a ghost was already sent its initial card, THE System SHALL NOT
   send a second initial card for the same ghost after a re-scan; the
   second message remains the nudge's, under the 7-day rule.
3. THE System SHALL look up admin-queue membership by (type,
   subjectId), so a ghost already queued under an older row is not
   re-sent or re-queued under its new row.
4. THE System SHALL NOT change the nudge timing itself (7 days, +7
   days, at most two messages per ghost).

### Requirement 6: Backfill of the live database

**User Story:** As an admin, I want the existing 992 open rows cleaned
up once, safely, so the first attestation run after the fix does not
spam.

#### Acceptance Criteria

1. THE System SHALL provide a one-time backfill that, per (type,
   subjectId), keeps the newest open row open and marks all older open
   rows `superseded`.
2. THE Backfill SHALL NOT mark any row `resolved`: it cannot prove the
   latest scan completed, so ghosts the latest scan did not find stay
   open until a completed post-fix scan resolves them.
3. THE Backfill SHALL migrate existing decision rows to the
   subject-keyed table, resolving (type, subjectId) from the finding
   each decision points at.
4. THE Backfill SHALL print before/after counts (open rows, distinct
   subjects, superseded rows, migrated decisions) and SHALL change
   nothing unless explicitly told to apply (dry-run by default).
5. WHEN the backfill runs a second time, THE System SHALL change
   nothing (idempotent).
6. WHEN run against a database, THE Backfill SHALL report open rows
   after equal to the number of distinct (type, subjectId) pairs among
   the open rows before, and superseded rows equal to open rows before
   minus open rows after. On the live database as of 2026-11-13 this
   means 992 open before, 98 open after, 894 superseded; the script
   SHALL check this invariant, not the literal numbers, so a scan that
   lands between drafting and running does not fail it.

### Requirement 7: Console agreement and fixture verifier

**User Story:** As an admin, I want the console and the attestation
loop to agree, and the fixture checks to keep passing, after this fix.

#### Acceptance Criteria

1. WHEN a scan completes, THE Console's latest-scan findings view and
   the attestation loop's open set SHALL describe the same findings.
2. THE Console SHALL accept and display the `superseded` and
   `resolved` statuses in its status filter and in finding rows.
3. WHEN the fixture verifier runs, THE System SHALL still report
   fixture counts overshared 3, orphaned 2, stale-guest 5,
   idle-licence 4, cold-storage 0, and score 73/100.
4. WHEN the fixture verifier runs twice against the same database,
   THE System SHALL still report ALL PASS on the second run.
