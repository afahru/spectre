# Steering: plain-English narration rule

- Every number in an owner message must trace to a Graph response stored
  with the finding. No number is ever invented, rounded into a claim, or
  copied from a different finding.
- One sentence per finding: who can see what, how many people, and the one
  action being asked. No generic warnings.
- If a figure is unknown, the message says so ("we could not confirm the
  price") instead of guessing.
- A commit is blocked if a narration template contains a hardcoded number
  (enforced by the commit hook).
- The message never claims a legal or compliance verdict. It states the
  exposure and asks for a decision.
