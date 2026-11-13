# Spectre: the Microsoft 365 tenant ghost hunter

**Kiroween 2026 entry (Frankenstein category). Status: built and validated on a Microsoft 365 developer tenant. Demo video published.**
**Deadline: 4 Dec 2026 14:00 PT, which is 5 Dec 2026 05:00 WIB.**

## The problem Spectre solves

Microsoft Copilot follows the permissions already in your tenant. If a site can be opened by anyone with a link, if a guest who left months ago still has access, or if a site has no owner at all, Copilot can show that content to people who should never see it. Most organisations discover this the hard way, after Copilot is already switched on.

Spectre finds those exposures before Copilot does. It scans a Microsoft 365 tenant for the five risks that block a safe Copilot rollout: overshared sites, orphaned sites, stale guests, idle licences, and cold storage. Instead of handing the admin another report, Spectre sends each finding to the person who owns it, in plain English, in Microsoft Teams, with one tap to fix it: Keep it shared, Remove the public link, or Archive this site. The admin watches a live readiness score move as the tenant gets cleaner.

Demo video (1 minute 14 seconds): https://youtu.be/n7L3BMcbMEA
Repository: https://github.com/afahru/spectre

## Why this matters (evidence, not hype)

- Varonis 2025: 99% of organisations have sensitive data exposed to AI tools; the average tenant holds more than 27,000 sharing links, half of them open to all employees.
- ShareGate State of Microsoft 365, September 2026 (about 1,800 IT professionals): 77% had a governance incident in the past year; 38% left former employees or guests with access; only 1% uses a purpose-built tool.
- Gartner: 40% of Copilot rollouts were delayed three months or more over oversharing.
- Microsoft's own answers are limited: the SharePoint Admin Agent recommends but does not act, native governance scans are capped and read-only, and the paid options charge per user per month.
- The gap Spectre fills: nobody runs the owner-facing fix loop. Reporting an exposure is not the same as removing it. That loop is the product.

## Validated on a live tenant, not a slide deck

Spectre runs against the author's Microsoft 365 developer tenant. The latest full scan covered 40 sites and produced 91 findings. The fixture scenario scores 73 out of 100 by design (penalty 27). The fixes were verified live against Microsoft Graph: an anonymous link was actually deleted (Graph confirms the permission is gone), a stale guest was actually deleted (restorable within 30 days), and one owner action moved the fixture score from 73 to 76. The test suite passes 62 out of 62 tests.

This is a working product validated on a developer tenant. It is not a production enterprise deployment yet. The honest limits are listed in [docs/operations.md](docs/operations.md#5-known-limitations).

## Stack (boring on purpose)

- Node.js and TypeScript service (Microsoft Graph SDK) for the scan engine and remediation.
- React admin console (Fluent UI v9).
- Teams Adaptive Cards for the owner attestation loop. An Adaptive Card is the interactive message format Teams uses for buttons and forms.
- Entra app registration in the author's Microsoft 365 developer tenant with admin consent; the demo runs on that tenant.
- Kiro: specs, steering rules, agent hooks, and Kiro Crew for the plain-English narration drafts.

## Specs (Kiro spec-driven development)

Every component was specified before it was built, under `.kiro/specs/`:

- `spectre-scan-engine`: tenant inventory, flagging, permissions fetch, deterministic scoring.
- `spectre-attestation-loop`: Teams owner messages, decisions, nudges, and escalation.
- `spectre-remediation`: the dispatcher, the three remediation actions, and the audit log.
- `spectre-admin-console`: the read API and the React admin console.

## Steering

- `.kiro/steering/graph-conventions.md`: batching, delta queries, `$select` discipline, never call the permissions endpoint in a list loop without a cache.
- `.kiro/steering/narration-rule.md`: every number in an owner message must trace to a Graph response; never invent a number.
- `.kiro/steering/teams-cards.md`: Adaptive Card and SharePoint Framework patterns.

## Bonuses in play

- Best Startup Project $10,000 (founder, PT Optima Zetta Inovasi).
- Best Kiro Crew App $1,000 (separate Crew repo).
- Blog bonus (2,000 Kiro credits) and Social Blitz (#KiroweenHackathon26).

## Rules that bind this repo

- NEW project, created during the submission period. Do NOT reuse the SPFx oversharing-readiness sample as the project (its scoring heuristics may inform the design only).
- `/.kiro` is committed and never gitignored.
- Demo credentials and instructions ship with the submission (the rules allow this).
- Free Kiro credits (4,000) must be requested by 1 Dec 2026 12:00 PT.

## Timeline (3 weeks, solo)

- Week 1: specs, scan engine, fixture tenant seeding. Done.
- Week 2: attestation loop, remediation actions, admin console. Done.
- Week 3: demo video (published), documentation, submission form, Best Startup fields. In progress.

## Admin console

`npm run web:build` builds the React app (Fluent UI v9) into `web/dist`, then the console server serves it with the read API (`GET /score`, `/findings`, `/exceptions`, `/audit`) on `http://127.0.0.1:3979`. The only write is `POST /exceptions/{id}/decide`, which goes through the remediation dispatcher. Set `ADMIN_UPN` to record the deciding admin; without it, decisions return 503. The service has no sign-in of its own, so keep it on localhost or behind your access proxy. Full details are in [docs/](docs/README.md).
