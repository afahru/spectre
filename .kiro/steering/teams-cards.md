# Steering: Teams Adaptive Cards

- Owner messages are Teams Adaptive Cards with exactly three actions:
  Keep, Restrict, Archive (wording varies by ghost type, the action set
  does not).
- The card shows the finding in one sentence plus the numbers; the full
  detail lives in the admin console, not on the card.
- Every button posts back the finding id and the chosen action; the service
  applies the fix and writes one audit log entry per decision.
- No response in 7 days: one nudge, then escalation to the admin queue.
  The owner is never messaged more than twice per finding.
