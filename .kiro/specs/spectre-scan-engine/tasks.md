# Spectre Scan Engine — Tasks

- [ ] 1. Set up the project skeleton
  - [ ] 1.1 Create the Node/TypeScript service skeleton with the Graph SDK
    client, app-only auth (client credentials), and config from environment
    - _Requirements: 1.1, 1.3_
  - [ ] 1.2 Add the findings store (local JSON/SQLite for the demo; interface
    kept swappable) with scan-timestamped records
    - _Requirements: 1.3, 6.3_

- [ ] 2. Build the inventory collector
  - [ ] 2.1 Implement the sites inventory with paging and `$select`
    discipline
    - _Requirements: 1.1_
  - [ ] 2.2 Implement the guest inventory with last sign-in from audit logs
    - _Requirements: 3.1_
  - [ ] 2.3 Implement the licence inventory via `/subscribedSkus` plus
    per-user activity
    - _Requirements: 4.1_
  - [ ] 2.4 Make the collector resumable (persist the last page per
    collection)
    - _Design: Correctness properties_

- [ ] 3. Build the flagging heuristics (metadata only, no permission calls)
  - [ ] 3.1 Overshared and orphaned site candidates from site metadata
    - _Requirements: 1.2, 2.2_
  - [ ] 3.2 Stale guest flags (90+ days, sponsor-departed as ownerless)
    - _Requirements: 3.2, 3.3_
  - [ ] 3.3 Idle licence flags with cost lookup (unknown when no price)
    - _Requirements: 4.2, 4.3_
  - [ ] 3.4 Cold storage flags (365+ days, with storage size)
    - _Requirements: 5.1, 5.2_

- [ ] 4. Build the permissions fetcher (flagged items only, cached)
  - [ ] 4.1 Fetch permissions per flagged item and record the `link` facet
    - _Requirements: 2.1, 2.3_
  - [ ] 4.2 Add the item cache (keyed by item id + scan run)
    - _Design: Permissions fetcher_
  - [ ] 4.3 Handle 429 with `Retry-After` backoff and resume; record
    unreadable items as permission-missing, never fail the run
    - _Design: Errors_

- [ ] 5. Build the deterministic risk scorer
  - [ ] 5.1 Implement the 0–100 readiness score from ghost counts and
    severity weights, with inputs shown beside the score
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ] 5.2 Unit-test the scorer against the fixture tenant with known
    expected scores
    - _Design: Testing strategy_

- [ ] 6. Seed the fixture tenant
  - [ ] 6.1 Write the seeder that creates demo sites, guests, and licences
    with known numbers in the dev tenant
    - _Design: Testing strategy_
  - [ ] 6.2 Run a full scan against the fixture tenant and verify the
    findings match the expected counts by hand
    - _Requirements: 1.3, 6.1_
