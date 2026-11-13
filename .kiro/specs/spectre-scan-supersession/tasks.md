# Spectre Scan Supersession — Tasks

- [ ] 1. Add the superseded and resolved statuses
  - [ ] 1.1 Extend `FindingStatus` in `src/store/types.ts` with
    `"superseded"` and `"resolved"`; add both to `STATUSES` in
    `src/console/api.ts` and to `STATUS_LABEL` in
    `web/src/views/FindingsView.tsx` (the `Record<FindingStatus,
    string>` type forces this; the filter options follow from its
    keys). No findings-table schema change: status is already TEXT.
    - _Requirements: 2.3, 7.2_
  - [ ] 1.2 Add a test that the console rejects no status in
    `STATUSES` and that the findings filter lists all five statuses
    - _Requirements: 7.2_

- [ ] 2. Build the supersession step and wire it into both scan entry points
  - [ ] 2.1 Implement `supersedePreviousFindings(store, newFindings,
    scanTimestamp)` as a pure function over the existing
    `FindingStore` interface (no new store method): re-found open
    rows from older scans become `superseded`, not re-found open rows
    become `resolved`, rows from this scan and rows that are
    `actioned` or `dismissed` are never touched
    - _Requirements: 1.1, 1.2, 1.3_
  - [ ] 2.2 Call the step from `src/index.ts` after anonymous-link
    detection (step 6b) and before scoring (step 7), and from
    `src/seeder/verify.ts` at the same point, through the one shared
    helper (do not duplicate the step)
    - _Requirements: 1.1, 7.3_
  - [ ] 2.3 Unit-test the step against an in-memory store: re-found
    becomes superseded, not re-found becomes resolved, actioned and
    dismissed untouched, second run changes nothing, a partial run
    followed by a re-run heals (idempotent and self-healing)
    - _Requirements: 1.4, 1.5_
  - [ ] 2.4 Add an invariant test: after a completed scan,
    `listOpen()` returns exactly the rows of
    `listByScan(latestScanTimestamp())`
    - _Requirements: 2.1, 2.2_

- [ ] 3. Key decisions and Keep suppression by subject
  - [ ] 3.1 Add `type` and `subjectId` to `DecisionRecord` in
    `src/attestation/decision.ts`; add `getBySubject(type,
    subjectId)` to the `DecisionStore` interface; add
    `isDecisionActive(record, now)` (Restrict/Archive always active,
    Keep active only while `isSuppressed(record, now)` is true) and
    use it in the Teams decision handler, in console `decide()`, in
    delivery, and in the nudge check, replacing the old
    existence-only checks
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 4.4_
  - [ ] 3.2 Migrate `SqliteDecisionStore` to `PRIMARY KEY (type,
    subject_id)` (create new table, copy with a join to findings for
    (type, subjectId), drop old, rename, in one transaction);
    replace `INSERT OR IGNORE` with a plain insert that throws on
    conflict; re-key `InMemoryDecisionStore` by subject; keep
    `findingId` on the record as the capturing row
    - _Requirements: 3.1, 3.2_
  - [ ] 3.3 Update the decision and console tests
    (`src/attestation/__tests__/attestation.test.ts`,
    `src/console/__tests__/api.test.ts`) for the new record shape
    and the new duplicate/409 behaviour
    - _Requirements: 3.2, 3.3_
  - [ ] 3.4 Unit-test suppression by subject with a fake clock: Keep
    on row 1 suppresses a card for row 2 of the same subject while
    unexpired; an expired Keep does not suppress; a Restrict decision
    blocks a second decision on a new row; a different subject is
    unaffected
    - _Requirements: 3.4, 4.1, 4.2, 4.3, 4.4_

- [ ] 4. Key send history and queue membership by subject
  - [ ] 4.1 Add `listBySubject(type, subjectId)` to `SendLog`
    (implemented in `SqliteDeliveryStore` as a join from
    `attestation_sends` to `findings` on `finding_id`; no schema
    change) and use it in delivery's already-sent check and in the
    nudge's message-count and age checks; add `hasBySubject(type,
    subjectId)` to `AdminQueue` (same join pattern) and use it in
    delivery and the nudge skip checks
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [ ] 4.2 Unit-test subject-keyed sends: a send recorded for row 1
    blocks a fresh initial card for row 2 of the same subject, and
    the nudge still fires once at 7 days against the combined
    history; a queued subject under an old row is not re-sent under
    its new row
    - _Requirements: 5.2, 5.3, 5.4_

- [ ] 5. Build the one-time backfill
  - [ ] 5.1 Implement `npm run backfill:supersede` (new entry point,
    e.g. `src/store/backfill-supersede.ts`) against `DB_PATH`:
    dry-run by default printing the counts it would change,
    `--apply` to write; per (type, subjectId) keep the newest open
    row and mark older open rows `superseded`; never mark anything
    `resolved`; migrate decision rows to the subject-keyed table;
    abort with a clear message if the admin queue is non-empty or if
    a decision's finding row is missing; verify the expected counts
    itself before claiming success
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - [ ] 5.2 Test the backfill on a synthetic database with the live
    shape (multiple scans, duplicate subjects): dry-run changes
    nothing, applied run leaves one open row per subject, second
    run changes nothing
    - _Requirements: 6.4, 6.5_

- [ ] 6. Verify end to end (no timer change, no Devpost change)
  - [ ] 6.1 Run the full suite (`npm test`) and the build; all green
    - _Design: Testing strategy_
  - [ ] 6.2 Run the fixture verifier twice against a copy of the
    database (never the live database, so the verification runs do
    not add scan rows and change the live open-row counts the
    backfill checks) and confirm ALL PASS both times, with fixture
    counts overshared 3, orphaned 2, stale-guest 5, idle-licence 4,
    cold-storage 0, and score 73/100
    - _Requirements: 7.3, 7.4_
  - [ ] 6.3 Run the backfill dry-run against a copy of the live
    database and confirm it reports 992 open before, 98 open after,
    894 superseded, 1 decision migrated (manual verification step)
    - _Requirements: 6.4, 6.6_
  - [ ] 6.4 Apply the backfill to the live database on VM1
    (`/data/workspace/spectre/spectre.db`) only after 6.3 passes,
    then re-check the counts on the live database (manual step,
    user-gated; the attestation timer stays paused until this is
    verified)
    - _Requirements: 6.6_
