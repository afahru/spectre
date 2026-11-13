# Spectre Admin Console — Tasks

- [x] 1. Service read API
  - [x] 1.1 Add `GET /score` returning the latest score with counts,
    weights, and the cost rollup
    - _Requirements: 1.1, 1.3_
  - [x] 1.2 Add `GET /findings` with status and type filters, including
    decision history per finding
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 1.3 Add `GET /exceptions` and `GET /audit`
    - _Requirements: 3.1, 4.1, 4.2_
  - [x] 1.4 Add `POST /exceptions/{findingId}/decide` (Keep, Restrict,
    Archive); record the approval and hand Restrict/Archive to
    remediation
    - _Requirements: 3.2, 3.3_

- [x] 2. Score and findings views
  - [x] 2.1 Render the score with inputs beside it and the cost rollup;
    unknown figures shown as "unknown"
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 2.2 Render the findings list with filters and a detail view
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 3. Exceptions queue
  - [x] 3.1 Render the queue with the reason each finding is there
    - _Requirements: 3.1_
  - [x] 3.2 Wire the admin decision buttons to the decide endpoint
    - _Requirements: 3.2, 3.3_

- [x] 4. Audit log view
  - [x] 4.1 Render audit entries with result and restore path; failed
    actions shown as failed, never as fixed
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 5. Tests and demo wiring
  - [x] 5.1 Unit-test the read API and the decide endpoint
    - _Design: Testing strategy_
  - [x] 5.2 Wire the demo: fixture tenant findings, tenant-wide score
    0/100, and fixture score 73/100 shown side by side, labelled
    - _Design: Testing strategy_
