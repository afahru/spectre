# Spectre — the M365 tenant ghost hunter

**Kiroween 2026 entry (Frankenstein category). Status: scaffolding, week 1.**
**Deadline: 4 Dec 2026 14:00 PT = 5 Dec 2026 05:00 WIB.**

## The idea in one paragraph

Spectre scans an M365 tenant for the five ghosts that block Copilot — overshared
sites, orphaned sites, stale guests, idle licences, cold storage — and instead of
dumping a report on the admin, it messages each content owner in plain English
in Teams with one-tap **Keep / Restrict / Archive**, while the admin sees a live
Copilot-readiness score and a dollar figure. The haunted-house theme is the UI:
ghosts, zombies and vampires as finding types, exorcised one by one.

## Why it wins (evidence, not vibes)

- Varonis 2025: 99% of orgs have sensitive data exposed to AI tools; average
  tenant 27,000+ sharing links, half open to all employees.
- ShareGate State of M365, Sept 2026 (~1,800 IT pros): 77% had a governance
  incident in the past year; 38% left ex-employees/guests with access; only 1%
  uses a purpose-built tool.
- Gartner: 40% delayed Copilot rollouts 3+ months over oversharing.
- Microsoft native answers are capped (SAM DAG: 100 sites in UI, once per 24h;
  Purview DSPM item scan: 10 sites), expensive (SAM $3/user/mo), and
  read-only (SharePoint Admin Agent GA Aug 2026 recommends but does not act).
- Gap: nobody runs the owner-facing remediation loop. That is the product.

## Stack (boring on purpose)

- Node/TypeScript service (Microsoft Graph SDK) — scan engine + remediation.
- React admin console (or SPFx web part — author's home turf).
- Teams Adaptive Cards for the owner attestation loop.
- Entra app registration in the author's M365 developer tenant
  with admin consent; demo runs on that tenant.
- Kiro: specs, steering, agent hooks, Graph MCP, Kiro Crew for the
  plain-English narration drafts.

## Specs (Kiro spec-driven development)

- `.kiro/specs/spectre-scan-engine/` — tenant inventory + risk scoring.
- `.kiro/specs/spectre-attestation-loop/` — Teams owner messages + decisions.
- `.kiro/specs/spectre-remediation/` — one-click fixes + audit log.

## Steering

- `.kiro/steering/graph-conventions.md` — batching, delta queries, `$select`
  discipline, never call the permissions endpoint in a list loop without a cache.
- `.kiro/steering/narration-rule.md` — every number in an owner message must
  trace to a Graph response; never invent a number.
- `.kiro/steering/teams-cards.md` — Adaptive Card + SPFx patterns.

## Bonuses in play

- Best Startup Project $10,000 (founder, PT Optima Zetta Inovasi).
- Best Kiro Crew App $1,000 (separate Crew repo).
- Blog bonus (2,000 Kiro credits) + Social Blitz (#KiroweenHackathon26).

## Rules that bind this repo

- NEW project, created during the submission period. Do NOT reuse the SPFx
  oversharing-readiness sample as the project (its scoring heuristics may
  inform the design only).
- `/.kiro` is committed and never gitignored.
- Demo credentials/instructions ship with the submission (rules allow this).
- Free Kiro credits (4,000) must be requested by 1 Dec 2026 12:00 PT.

## Timeline (3 weeks, solo)

- Week 1: specs + scan engine + fixture tenant seeding.
- Week 2: attestation loop + remediation actions + admin console.
- Week 3: demo video (<3 min), README, submission form, Best Startup fields.

## Admin console

`npm run web:build` builds the React app (Fluent UI v9) into `web/dist`, then
`npm run console` serves it with the read API (`GET /score`, `/findings`,
`/exceptions`, `/audit`) on `http://127.0.0.1:3979`. The only write is
`POST /exceptions/{id}/decide`, which goes through the remediation dispatcher.
Set `ADMIN_UPN` to record the deciding admin; without it decisions return 503.
The service has no sign-in: keep it on localhost or behind your access proxy.
