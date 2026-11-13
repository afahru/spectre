# Spectre Documentation

Spectre is a Microsoft 365 tenant ghost hunter. It scans a tenant for the
five exposures that block a Copilot rollout, asks each content owner for a
decision in plain English in Microsoft Teams, executes the approved fix, and
shows the tenant admin a live Copilot-readiness score with an audit trail.
This directory is the enterprise documentation set for the project. It is
written for the people who deploy, operate, secure, and use Spectre, and it
describes the system as it is built in this repository.

## How to use this set

Start with the document that matches your role, then follow its
cross-references. Every document states which parts of the system it covers
and which parts are not yet implemented, so a reader can tell what is real
from what is planned.

| Document | Read it if you | Covers |
|---|---|---|
| [architecture.md](architecture.md) | Design, review, or extend the system | Components, data flow, storage schema, scoring model |
| [deployment.md](deployment.md) | Install or deploy Spectre | Prerequisites, Entra app and bot registration, environment variables, build and run steps |
| [security.md](security.md) | Approve, audit, or harden the deployment | Permission model, secret handling, data handling, audit logging, single-tenant design |
| [api.md](api.md) | Integrate with the console or the bot | Console read API, the admin decide endpoint, the Teams messaging endpoint |
| [operations.md](operations.md) | Run Spectre day to day | Runbook, monitoring, backup and restore, troubleshooting |
| [user-guide.md](user-guide.md) | Are a tenant admin or a site owner who receives a card | The five ghosts, the card, the three buttons, the admin console |
| [remediation.md](remediation.md) | Need to know exactly what each fix does | Revoke link, expire guest, archive site, reversibility, dispatcher safety rules |

## Conventions used in this set

- **Placeholders, never real values.** This repository is public. No
  document in this set contains a real tenant ID, client ID, bot App ID,
  email address, site ID, or URL. Where a value is needed, the document
  uses a placeholder such as `<TENANT_ID>`, `<CLIENT_ID>`,
  `<BOT_APP_ID>`, `<ADMIN_UPN>`, or `https://<your-tunnel>/api/messages`.
  Fill each placeholder from your own deployment. Never commit a filled-in
  copy.
- **Unknown stays unknown.** Spectre never invents a number, a permission,
  a user, or an owner. Where the system cannot confirm a figure, it records
  and displays `null`, rendered as "unknown". This set follows the same rule:
  where the code does not show something, the document says so instead of
  guessing.
- **Implemented versus planned.** A feature that exists only in a spec file
  is labelled **planned, not implemented**. A feature that exists in code
  but is not wired into a running server is labelled **implemented, not
  wired**. The known gaps are collected in
  [operations.md](operations.md#known-limitations) and in the per-document
  notes.
- **Source of truth.** The code in `src/`, the specs in `.kiro/specs/`,
  and the steering rules in `.kiro/steering/` are authoritative. If this
  documentation and the code disagree, the code governs and the document
  should be corrected.

## Project context

Spectre is a Kiroween 2026 entry in the Frankenstein category. It is a new
project, built during the submission period, and it is developed
spec-first: every component has a requirements, design, and tasks file
under `.kiro/specs/`. The four specs are:

- `spectre-scan-engine`: tenant inventory, flagging, permissions fetch,
  deterministic scoring, fixture seeding.
- `spectre-attestation-loop`: owner resolution, plain-English narration,
  Teams Adaptive Card delivery, decision handling, nudge and escalation.
- `spectre-remediation`: the dispatcher, the three remediation actions,
  and the audit log.
- `spectre-admin-console`: the service read API and the React admin
  console.

The demo runs against the author's Microsoft 365 developer tenant. The
service is a Node.js and TypeScript application that uses the Microsoft
Graph SDK with application permissions, a SQLite findings store, a Teams
Bot Framework bot for the owner loop, and a React admin console built with
Fluent UI v9.

## Related files outside this directory

- `README.md` (repository root): product summary, evidence base, stack,
  timeline.
- `AGENTS.md` (repository root): the rules that bind work in this repo,
  including spec-first development and the never-invent rule.
- `.kiro/specs/*/requirements.md`, `design.md`, `tasks.md`: the
  authoritative specifications.
- `.kiro/specs/spectre-attestation-loop/bot-registration.md`: the manual
  bot registration runbook.
- `.kiro/steering/graph-conventions.md`, `narration-rule.md`,
  `teams-cards.md`: the steering rules the code follows.
- `WEEK2-IMPLEMENTATION-PLAN.md` (repository root): the Week 2 build
  sequence and credit budget. This is a project planning note, not
  product documentation.
