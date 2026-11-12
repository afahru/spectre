# Spectre Remediation — Tasks

- [x] 1. Dispatcher
  - [x] 1.1 Route an approved decision to the right action by ghost
    type; refuse any action without a recorded approval
    - _Requirements: 1.1, 2.1, 3.1_
  - [x] 1.2 Write one audit log entry per action with finding id, target,
    owner, timestamp, and result
    - _Requirements: 1.2, 2.2, 3.1_

- [ ] 2. Revoke an "anyone" link
  - [ ] 2.1 DELETE the anonymous permission via Graph using the
    permission id from the scan
    - _Requirements: 1.1_
  - [ ] 2.2 On failure, keep the finding open and record the error; never
    mark fixed
    - _Requirements: 1.3_

- [ ] 3. Archive a cold site
  - [ ] 3.1 Archive through the SharePoint admin surface under a
    delegated admin session
    - _Requirements: 2.1_
  - [ ] 3.2 Without a delegated session, queue for the admin with the
    exact command; never execute blindly
    - _Design: Archive a cold site_

- [ ] 4. Expire a stale guest
  - [ ] 4.1 DELETE the guest user via Graph; record the 30-day restore
    path
    - _Requirements: 3.1, 3.2_

- [ ] 5. Tests and live verification
  - [ ] 5.1 Unit-test the dispatcher and audit entries
    - _Design: Testing strategy_
  - [ ] 5.2 Live-verify on the fixture tenant (revoke one link, delete
    one guest, archive one cold site), then re-scan
    - _Design: Testing strategy_
