# Spectre Attestation Loop — Tasks

- [ ] 1. Owner resolution and narration
  - [ ] 1.1 Resolve the card recipient from `finding.owner`; route
    ownerless or unreachable findings to the admin exceptions queue
    - _Requirements: 1.3_
  - [ ] 1.2 Build the one-sentence narration from the finding record only;
    unknown figures stated as unknown
    - _Steering: narration-rule; Requirements: 1.1_
  - [ ] 1.3 Render the Adaptive Card with exactly three actions (Keep,
    Restrict, Archive) posting back finding id + action
    - _Steering: teams-cards; Requirements: 1.1, 2.1_

- [ ] 2. Card delivery via the Teams bot
  - [ ] 2.1 Register the bot in the dev tenant and install it org-wide
    for the demo
    - _Design: Card delivery_
  - [ ] 2.2 Send the proactive card and record the send timestamp; never
    send the same finding twice without the nudge rule
    - _Requirements: 1.2_
  - [ ] 2.3 Expose the HTTPS messaging endpoint for Action.Submit
    postbacks
    - _Design: Card delivery_

- [x] 3. Decision handling
  - [x] 3.1 Record the decision (finding id, owner, action, timestamp)
    idempotently
    - _Requirements: 2.1_
  - [x] 3.2 Keep: close as accepted risk, suppress re-ask for 30 days
    - _Requirements: 2.3_
  - [x] 3.3 Restrict / Archive: hand to remediation, never execute in
    the loop
    - _Requirements: 2.2_

- [ ] 4. Nudge and escalation
  - [ ] 4.1 Daily scheduler: 7 days with no answer means one nudge, at
    most two messages per finding
    - _Requirements: 3.1_
  - [ ] 4.2 7 days after the nudge with no answer means the admin
    exceptions queue
    - _Requirements: 3.2_

- [ ] 5. Tests
  - [ ] 5.1 Unit-test narration, the nudge clock, and idempotent
    decision recording
    - _Design: Testing strategy_
