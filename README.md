# Spectre: the Microsoft 365 tenant ghost hunter

**Kiroween 2026 entry (Frankenstein category). Status: built and validated on a Microsoft 365 developer tenant. Demo video published.**
**Deadline: 4 Dec 2026 14:00 PT, which is 5 Dec 2026 05:00 WIB.**

## The problem Spectre solves

Microsoft Copilot follows the permissions already in your tenant. Copilot only surfaces data the user has at least view permission to ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy)), so if a site can be opened by anyone with a link, if a guest who left months ago still has access, or if a site has no owner at all, Copilot can show that content to people who should never see it. Most organisations discover this the hard way, after Copilot is already switched on.

Spectre finds those exposures before Copilot does. It scans a Microsoft 365 tenant for the five risks that block a safe Copilot rollout: overshared sites, orphaned sites, stale guests, idle licences, and cold storage. Instead of handing the admin another report, Spectre sends each finding to the person who owns it, in plain English, in Microsoft Teams, with one tap to fix it: Keep it shared, Remove the public link, or Archive this site. The admin watches a live readiness score move as the tenant gets cleaner.

Demo video (1 minute 14 seconds): https://youtu.be/n7L3BMcbMEA
Repository: https://github.com/afahru/spectre

## Why this matters (evidence, not hype)

- Varonis, 2025 State of Data Security Report (1,000 real-world IT environments): 99% of organisations have exposed sensitive data that can easily be surfaced by AI. ([Varonis](https://www.varonis.com/blog/state-of-data-security-report))
- ShareGate, State of Microsoft 365, September 2026 (IT operations survey, n=943, May 2026; self-reported, vendor-funded survey): 77% had at least one governance incident in the past 12 months; 38% reported stale access, a former employee or partner who kept access they should not have; only 1% use a tool built to prevent one. ([ShareGate](https://sharegate.com/state-of-microsoft-365/chap-3))
- Gartner survey of 132 IT leaders (June 2024), as reported by Computerworld: oversharing concerns caused 40% to delay Copilot rollouts by three months or more. ([Computerworld](https://www.computerworld.com/article/3542000/microsoft-365-copilot-rollouts-slowed-by-data-security-roi-concerns.html))
- Microsoft's own tools can find the exposure but do not run the fix loop. Purview Data Security Posture Management runs a weekly data risk assessment for the top 100 SharePoint sites, with item-level scanning capped at 10 sites and no OneDrive item-level scanning. SharePoint Advanced Management data access governance reports cover activity from the last 28 days, and without SharePoint Advanced Management an E5 tenant sees activity reports only, for at most 10,000 sites, with no snapshot reports or remedial actions. Restricted SharePoint Search, the old allow-list guardrail, is retiring (new enablement blocked 31 July 2026); Microsoft now points to Restricted Content Discovery. ([Purview DSPM](https://learn.microsoft.com/en-us/purview/data-security-posture-management-oversharing), [data access governance reports](https://learn.microsoft.com/en-us/sharepoint/data-access-governance-reports), [Restricted SharePoint Search](https://learn.microsoft.com/en-us/sharepoint/restricted-sharepoint-search))
- The gap Spectre fills: nobody runs the owner-facing fix loop. Reporting an exposure is not the same as removing it. That loop is the product.

## Validated on a live tenant, not a slide deck

Spectre runs against the author's Microsoft 365 developer tenant. The latest full scan covered 40 sites and produced 91 findings. The fixture scenario scores 73 out of 100 by design (penalty 27). Heuristic: the 0 to 100 score is Spectre's own design. Microsoft publishes no Copilot readiness score; its Copilot readiness report shows counts only, such as eligible users and assigned licences. ([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness)) The fixes were verified live against Microsoft Graph: an anonymous link was actually deleted (Graph confirms the permission is gone), a stale guest was actually deleted (restorable within 30 days), and one owner action moved the fixture score from 73 to 76. The test suite passes 62 out of 62 tests.

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

## References

Microsoft Learn links first. All links below appear in the research report of 13 November 2026; pages marked (live) were opened live that day.

- Microsoft Learn (live): Copilot privacy, Copilot only surfaces data the user has at least view permission to: https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy
- Microsoft Learn (live): Configure a secure and governed data foundation for Microsoft 365 Copilot: https://learn.microsoft.com/en-us/microsoft-365/copilot/configure-secure-governed-data-foundation-microsoft-365-copilot
- Microsoft Learn (live): Data Security Posture Management for oversharing: https://learn.microsoft.com/en-us/purview/data-security-posture-management-oversharing
- Microsoft Learn (live): Data access governance reports: https://learn.microsoft.com/en-us/sharepoint/data-access-governance-reports
- Microsoft Learn (live): Restricted SharePoint Search (retiring, new enablement blocked 31 July 2026): https://learn.microsoft.com/en-us/sharepoint/restricted-sharepoint-search
- Microsoft Learn (live): Copilot readiness report (counts, no score): https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-readiness
- Varonis, 2025 State of Data Security Report: https://www.varonis.com/blog/state-of-data-security-report
- ShareGate, State of Microsoft 365, chapter 3: https://sharegate.com/state-of-microsoft-365/chap-3
- Computerworld, reporting a June 2024 Gartner survey of 132 IT leaders: https://www.computerworld.com/article/3542000/microsoft-365-copilot-rollouts-slowed-by-data-security-roi-concerns.html

Heuristics in this document: the 0 to 100 readiness score is Spectre's own design, not a Microsoft score.
