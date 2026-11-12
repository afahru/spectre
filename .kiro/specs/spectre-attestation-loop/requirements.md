# Spectre Attestation Loop — Requirements (draft, week 2)

## Introduction

The attestation loop takes each open finding and asks its owner for a
decision in plain English in Teams, then records the answer and hands the
approved action to the remediation spec.

## Requirements

### Requirement 1: Owner message

**User Story:** As a content owner, I want one plain-English message telling
me what is exposed and what I am being asked, so I can decide without
opening an admin console.

#### Acceptance Criteria

1. WHEN a finding is open, THE System SHALL send its owner one Teams
   Adaptive Card with the finding in one sentence and the exact numbers.
2. WHEN the card is sent, THE System SHALL record the send timestamp and
   never send the same finding twice to the same owner without a nudge rule.
3. THE System SHALL NOT message a finding that has no owner; ownerless
   findings go to the admin exceptions queue instead.

### Requirement 2: One-tap decision

**User Story:** As a content owner, I want to answer Keep, Restrict, or
Archive with one tap, so the decision takes seconds.

#### Acceptance Criteria

1. WHEN the owner taps an action, THE System SHALL record the decision with
   the finding id, the owner, and the timestamp.
2. WHEN the decision is Restrict or Archive, THE System SHALL hand the action
   to the remediation spec and SHALL NOT execute it before the owner taps.
3. WHEN the owner taps Keep, THE System SHALL close the finding as accepted
   risk and SHALL NOT re-ask for 30 days.

### Requirement 3: Nudge and escalation

**User Story:** As an admin, I want unanswered findings to escalate to me
after 7 days, so nothing stalls silently.

#### Acceptance Criteria

1. WHEN a finding has no answer after 7 days, THE System SHALL send one
   nudge to the owner and SHALL NOT send more than two messages per finding.
2. WHEN a finding is still unanswered 7 days after the nudge, THE System
   SHALL move it to the admin exceptions queue.
