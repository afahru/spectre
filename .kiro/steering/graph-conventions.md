# Steering: Microsoft Graph conventions

- Always batch Graph calls where the endpoint supports `$batch`; never call
  the permissions endpoint inside a list loop without a cache.
- Every list call uses `$select` with only the fields the feature needs.
- Prefer delta queries for inventory collections that support them.
- Respect `Retry-After` on 429 and resume the same page; never skip a page
  silently.
- Application permissions (admin-consented in the dev tenant) only. The
  write scopes (`Sites.ReadWrite.All`, `Files.ReadWrite.All`) are used solely
  by the remediation actions, and every write is recorded in the audit log.
- Never invent a permission, a user, or an owner. If Graph does not return
  it, the value is unknown or ownerless.
