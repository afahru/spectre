# Spectre Attestation Loop — Design

## Overview

The loop turns open findings into one plain-English Teams Adaptive Card per
owner, records the one-tap decision, and hands Restrict/Archive to
remediation. Ownerless findings never get a card; they go to the admin
exceptions queue.

## Architecture

```
open findings (store, status=open)
  -> owner resolution (finding.owner; null -> admin queue)
  -> narration (one sentence + numbers from the finding record only)
  -> Teams bot proactive message (Adaptive Card, 3 actions)
  -> Action.Submit postback -> decision record
       -> Keep: close as accepted risk for 30 days
       -> Restrict / Archive: hand to remediation
  -> no answer in 7 days -> one nudge -> 7 more days -> admin queue
```

## Components

### Owner resolution

- The recipient is `finding.owner`, the UPN from enrichment. `null` means
  ownerless.
- The bot must be installed for the owner (org-wide install in the dev
  tenant for the demo). If the bot has no conversation with the owner, the
  finding goes to the admin exceptions queue with reason "owner
  unreachable". It is never dropped silently and never messaged to a
  guessed address.

### Narration

- One sentence per finding: who can see what, how many people, and the one
  action being asked. Numbers are quoted verbatim from the finding record
  (Graph responses stored with the finding). Unknown figures are stated as
  unknown ("we could not confirm the price"). No legal or compliance
  verdict. No hardcoded numbers in templates (enforced by the commit hook).
- The card shows the sentence plus the numbers; the full detail lives in
  the admin console, not on the card.

### Card delivery (Teams bot)

- Bot Framework bot registered in the dev tenant (single-tenant),
  installed org-wide for the demo. The service sends a proactive 1:1
  message with the Adaptive Card via the Bot Framework Connector. The
  service exposes an HTTPS messaging endpoint for Action.Submit postbacks
  (dev: a tunnel; the endpoint URL is deployment config, never hardcoded).
- Exactly three actions: Keep, Restrict, Archive (wording varies by ghost
  type, the action set does not). Every button posts back the finding id
  and the chosen action.
- Each send is recorded with a timestamp in the store. The same finding is
  never sent twice to the same owner except under the nudge rule.

### Decision handling

- On postback, record the decision (finding id, owner, action, timestamp)
  before doing anything else.
- Keep: the finding closes as accepted risk, `acceptedUntil` = now + 30
  days; the loop will not re-ask before that date.
- Restrict / Archive: handed to remediation. The loop never executes the
  fix itself.
- An unknown or corrupt postback (no finding id, unknown action) is logged
  and ignored; the finding stays open.

### Nudge and escalation

- A daily scheduler checks open findings: no answer 7 days after the send
  means one nudge (the same card, marked as a reminder). At most two
  messages per finding per owner (initial + nudge).
- Still no answer 7 days after the nudge means the finding moves to the
  admin exceptions queue with reason "no response". The admin queue is
  visible in the admin console.

## Correctness properties

- No owner is messaged without a recorded owner UPN.
- No finding is messaged more than twice.
- A decision is recorded exactly once per finding (idempotent postback
  handling: a duplicate submit returns the recorded decision).
- Keep decisions expire after 30 days; the finding re-opens on the next
  scan if the exposure still exists.

## Errors

- Bot send fails (owner unreachable, bot not installed): the finding goes
  to the admin queue with the error attached; it is never retried silently
  in a loop.
- Postback endpoint down: Teams retries the submit; the service records
  the decision on the first successful receipt.
- Store write fails: the decision is not acknowledged, so the owner can
  tap again.

## Testing strategy

- Unit tests for narration templates against fixture findings (numbers
  quoted verbatim, unknown stated as unknown, no hardcoded numbers).
- Unit tests for the nudge/escalation clock (7 days, +7 days, max 2
  messages) with a fake clock.
- Unit tests for idempotent decision recording (duplicate postback gives
  one record).
- Demo: the fixture tenant's owners are the demo admin, so cards land in
  the admin's Teams in the video.
