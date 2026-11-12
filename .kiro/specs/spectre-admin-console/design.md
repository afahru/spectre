# Spectre Admin Console — Design

## Overview

The admin console is a read view over the findings store plus the admin
side of the exceptions queue. It never calls Graph directly and never
executes a fix itself: every action goes through the remediation
dispatcher with a recorded approval, exactly as an owner decision does.

## Architecture

```
findings store + audit store (SQLite, written by scan engine,
attestation loop, remediation)
  -> service read API (score, findings, exceptions queue, audit log)
  -> React admin console (or SPFx web part — author's home turf)
```

## Components

### Service read API

- `GET /score`: latest readiness score with counts, weights, and the
  cost rollup. The score is computed by the scorer, never by the UI.
- `GET /findings?status=&type=`: open findings with type, owner,
  numbers, status, scan timestamp, and decision history.
- `GET /exceptions`: the admin exceptions queue (ownerless, unreachable,
  no-response) with the reason each finding is there.
- `GET /audit`: audit entries with finding id, action, target, approver,
  timestamp, result, and restore path.
- `POST /exceptions/{findingId}/decide`: the admin's decision on a queued
  finding (Keep, Restrict, Archive). It records the approval and hands
  Restrict/Archive to the remediation dispatcher. It is the only write
  endpoint the console has.

### Score view

- Shows the 0-100 score with the ghost counts and weights beside it, and
  the cost rollup (idle licences, cold storage). Unknown figures are
  shown as "unknown", never as zero and never as a guess.
- Refreshes when a scan completes (the service pushes the new score; the
  console polls as a fallback).

### Findings list

- One row per open finding: type, owner, the exact numbers, status.
  Filter by ghost type and by status. Opening a row shows the full
  detail: numbers, owner, scan timestamp, and decision history.
- Numbers are quoted verbatim from the store. The console never invents
  a number and never re-derives one from a different finding.

### Exceptions queue

- Lists ownerless, owner-unreachable, and no-response findings with the
  reason each is queued.
- The admin decides with the same three actions the owner would have
  had. A Restrict/Archive decision goes through the remediation
  dispatcher and writes one audit entry, exactly as for an owner
  decision. A Keep decision closes the finding as accepted risk for 30
  days, exactly as for an owner decision.

### Audit log view

- One row per remediation action: finding id, action, target, approver,
  timestamp, result, restore path where one exists.
- A failed action is shown as failed with the error attached; the
  finding stays open and is never shown as fixed.

### Deployment

- Standalone React app served by the service for the demo, or an SPFx
  web part in the dev tenant (the author's home turf). Both read the same
  service API; the UI holds no credentials and makes no Graph calls.

## Correctness properties

- The console displays only what the store holds; it never invents,
  rounds, or re-derives a number.
- No fix executes from the console except through a recorded approval
  plus the remediation dispatcher.
- A failed action is never displayed as fixed.

## Errors

- Service API down: the console shows an error state, never stale
  numbers presented as current.
- Decision on a finding that already has one: the console shows the
  recorded decision instead of recording a second one.

## Testing strategy

- Unit tests for the read API against a fixture store (score, findings,
  exceptions, audit).
- Unit tests for the admin decision endpoint (approval recorded,
  Restrict/Archive handed to remediation, duplicate decision rejected).
- Demo: the console shows the fixture tenant's 65 findings, score 0/100
  tenant-wide, and the verifier's 73/100 fixture score side by side,
  labelled so the two numbers are never confused.
