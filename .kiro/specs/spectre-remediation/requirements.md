# Spectre Remediation — Requirements (draft, week 2)

## Introduction

Remediation executes the owner's approved decision through Graph/SharePoint
and writes one audit log entry per action, so every fix is traceable and
reversible where the platform allows it.

## Requirements

### Requirement 1: Revoke an "anyone" link

**User Story:** As an admin, I want an approved Restrict decision to revoke
the anonymous link, so the content stops being public.

#### Acceptance Criteria

1. WHEN the owner approves Restrict on an overshared finding, THE System
   SHALL revoke the anonymous sharing link via the Graph permissions API.
2. WHEN the revocation succeeds, THE System SHALL write one audit log entry
   with the finding id, the link, the owner, and the timestamp.
3. WHEN the revocation fails, THE System SHALL leave the finding open and
   record the error, never marking it fixed.

### Requirement 2: Archive a cold site

**User Story:** As an admin, I want an approved Archive decision to archive
the site, so cold content stops costing storage.

#### Acceptance Criteria

1. WHEN the owner approves Archive on a cold-storage finding, THE System
   SHALL archive the site through the SharePoint admin surface.
2. WHEN the archive succeeds, THE System SHALL write one audit log entry
   with the finding id, the site, the owner, and the timestamp.

### Requirement 3: Expire a stale guest

**User Story:** As an admin, I want an approved Revoke decision to remove a
stale guest's access, so dormant external access ends.

#### Acceptance Criteria

1. WHEN the owner approves Revoke on a stale-guest finding, THE System SHALL
   remove the guest's access and record the removal in the audit log.
2. THE System SHALL keep the removal reversible for 30 days (soft-delete
   pattern) where the platform supports it.
