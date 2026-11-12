# Spectre Admin Console — Requirements (draft, week 2)

## Introduction

The admin console is the one screen where the tenant admin sees the
Copilot-readiness score, every open finding, the exceptions queue, and the
audit log. It reads from the findings store only and never calls Graph
directly. For findings with no owner, the admin decides here instead of
the owner.

## Requirements

### Requirement 1: Readiness score

**User Story:** As an admin, I want the live readiness score with its
inputs beside it, so I can see why the tenant scores what it scores.

#### Acceptance Criteria

1. WHEN the console loads, THE System SHALL show the latest readiness
   score (0-100) with the ghost counts and severity weights beside it.
2. WHEN a new scan completes, THE System SHALL update the score without
   a page reload.
3. THE System SHALL show the cost rollup (idle licences, cold storage)
   next to the score, and SHALL state "unknown" for any figure it cannot
   confirm instead of guessing.

### Requirement 2: Findings list

**User Story:** As an admin, I want every open finding in one list with
its numbers, so I can triage without opening Teams.

#### Acceptance Criteria

1. WHEN the console loads, THE System SHALL list open findings with type,
   owner, the exact numbers, and status.
2. THE System SHALL let the admin filter by ghost type and by status.
3. THE System SHALL show the full detail of one finding (numbers, owner,
   scan timestamp, decision history) when the admin opens it.

### Requirement 3: Exceptions queue

**User Story:** As an admin, I want the findings no owner could answer
in one queue, so nothing stalls silently.

#### Acceptance Criteria

1. THE System SHALL list ownerless, owner-unreachable, and no-response
   findings in the exceptions queue with the reason each one is there.
2. WHEN the admin opens a queued finding, THE System SHALL offer the
   same three decisions (Keep, Restrict, Archive) the owner would have
   had.
3. WHEN the admin decides Restrict or Archive on a queued finding, THE
   System SHALL hand the action to the remediation spec and write one
   audit log entry, exactly as for an owner decision.

### Requirement 4: Audit log

**User Story:** As an admin, I want one audit entry per remediation
action, so every fix is traceable.

#### Acceptance Criteria

1. THE System SHALL list audit entries with finding id, action, target,
   owner or admin who approved, timestamp, and result.
2. THE System SHALL show the restore path for any action that has one.
3. THE System SHALL never show a finding as fixed when its action
   failed.
