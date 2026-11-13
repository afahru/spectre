# Spectre Security

This document describes the security model of Spectre as built: the
permission model, secret handling, data handling, audit logging, and the
single-tenant bot design. It also states plainly what the system does not
do, so a security reviewer is not left guessing.

## 1. Permission model

### 1.1 Application permissions only

Spectre authenticates to Microsoft Graph with the client credentials flow
(`ClientSecretCredential` in `src/graph/client.ts`). It uses application
permissions, admin-consented, and no delegated token. No user ever signs
in to Spectre, and the service never acts as a user. The Graph client is
created once per process and its token is cached and refreshed
automatically by the SDK.

### 1.2 Which permissions, and why each is needed

The permissions the repository names are:

| Permission | Scope of use | Granted on |
|---|---|---|
| `Sites.ReadWrite.All` | Remediation only: deleting a drive item permission to revoke an anonymous link | Graph app registration |
| `Files.ReadWrite.All` | Remediation only: write scope named in the Graph-conventions steering rule | Graph app registration |
| `User.ReadBasic.All` | Bot endpoint only: resolving a Teams user's AAD object id to a UPN | Graph app registration |
| `User.ReadWrite.All` | Seeder only: creating and inviting users and assigning licences for the fixture tenant | Graph app registration (demo tenant only) |

The write scopes (`Sites.ReadWrite.All`, `Files.ReadWrite.All`) are used
solely by the remediation actions, and every write is recorded in the
audit log (steering: `graph-conventions.md`). The scan engine itself only
reads. The seeder writes only in the demo tenant, to create fixture
objects; it is not part of the production scan path.

The repository does **not** enumerate the complete read permission set in
code. Do not assume a list that is not written down. Grant the
application permissions that cover the Graph endpoints in
[deployment.md](deployment.md#23-graph-endpoints-the-service-calls),
admin-consent them, and verify the scan completes without unreadable
items. A missing read permission does not fail the scan; the affected item
is recorded as unreadable and the run continues, which can make a tenant
look cleaner than it is.

### 1.3 Least privilege, as built

- The scan engine needs read access to sites, users, guests, licences,
  sign-in activity, and drive permissions. It does not need, and does not
  use, mail, calendar, or chat data.
- The remediation handlers need write access only for the two destructive
  actions they perform: deleting a drive item permission and deleting a
  guest user. Archiving a site has no app-only path at all; it is queued
  for a delegated admin session instead of being executed by the service.
- The bot endpoint needs only `User.ReadBasic.All` for the UPN lookup.
  It does not read messages, files, or any other user data.
- The console server makes no Graph calls. It reads the local SQLite
  store and serves the React app. It holds no Graph credentials in the
  browser; the UI cannot reach Graph.

### 1.4 What the service cannot do

- It cannot archive a SharePoint site with its app-only token. The
  SharePoint TenantAdministration REST API rejects app-only tokens, and
  no Graph endpoint archives a site. Archive decisions are queued for a
  delegated admin session with the exact command, never executed by the
  service. See [remediation.md](remediation.md#archive-a-cold-site).
- It cannot read `sharingCapability` from Graph. The property does not
  exist on the site resource in v1.0 or beta. Overshared detection goes
  through per-item permissions, which is slower but is the only reliable
  signal.
- It cannot act without a recorded approval. The dispatcher refuses any
  action that has no recorded owner or admin approval, and the refusal is
  reported, not hidden.

## 2. Secret handling

### 2.1 Rules

- **Never commit a secret.** `.env` and `*.db` are gitignored. The
  repository is public; anything committed is visible to everyone. The
  snapshot push procedure excludes `.env` and `*.db` explicitly.
- **Secrets live in the environment of the host that runs the service.**
  The service reads `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`,
  `BOT_APP_ID`, and `BOT_APP_SECRET` from process environment variables
  at startup and fails fast when one is missing. There are no defaults
  for credentials and no fallback values.
- **File permissions.** Any file that holds a secret must be readable
  only by the service account: mode `600` (owner read and write only).
  This applies to `.env` files, database files that contain conversation
  references, and any file a deployment script writes.
- **Secrets are shown once.** Both the Graph client secret and the bot
  client secret are displayed only at creation. Copy them into the
  environment immediately. If one is lost, create a new secret and rotate
  the environment variable; do not try to recover the old value.
- **Secrets expire.** Note the expiry date of each client secret at
  creation and set a renewal reminder. The service has no rotation
  mechanism. An expired secret fails every Graph or Bot Framework call,
  and the failure surfaces as a token error at startup or at first use.
- **Never print a secret.** Secrets must not appear in logs, in chat
  transcripts, in screenshots, in documentation, or in error messages.
  The code never logs a credential value. Operators must follow the same
  rule when copying values between systems.

### 2.2 What to do when a secret leaks

1. Revoke the leaked secret immediately in the Entra admin center (or
   the bot registration) and create a replacement.
2. Update the environment variable on every host that runs the service.
3. Restart the bot server, the console server, and any scheduled scan.
4. Check the audit log for actions executed while the secret was exposed.
   A leaked Graph client secret could have been used to read tenant data
   and to execute the two destructive remediation actions; a leaked bot
   secret could have been used to send messages as the bot.
5. Record the incident, the rotation, and the audit review. Do not reuse
   the leaked value anywhere.

## 3. Data handling

### 3.1 What is stored

The SQLite database (`DB_PATH`, default `./spectre.db`) holds:

- **Findings**: site, item, user, and SKU identifiers from Graph,
  display names, owner UPNs, the raw numbers behind each finding, the
  severity weight, the lifecycle status, and scan timestamps.
- **Audit log**: finding id, action, target, approver UPN, timestamp,
  result, error text, and restore path for every remediation action.
- **Conversation references**: owner UPN, Bot Framework service URL, and
  conversation id, learned when an owner messages the bot.
- **Send log**: finding id, owner UPN, and send time for every card sent.
- **Permissions cache**: item id, scan timestamp, link scope, and a
  readable flag.
- **Collector progress**: collection name, scan timestamp, paging cursor,
  and completion flag.

All of this is tenant operational data, not end-user content. The service
does not store file contents, message bodies, or document text. The
`numbers` JSON on a finding holds Graph metadata (scopes, counts, dates,
costs, ids), not content.

### 3.2 What is never stored

- **Decisions are not persisted.** The decision store in both servers is
  in-memory (`InMemoryDecisionStore`). A restart loses every recorded
  decision, including Keep suppressions. This is a known limitation, not
  a design choice for production. See
  [operations.md](operations.md#known-limitations).
- **No credentials in the database.** Tokens are held in memory by the
  SDK credential objects. The database file contains no secret, token, or
  password.
- **No owner is ever guessed.** When Graph returns no owner, the finding
  stores `owner` as `null` and the finding goes to the admin exceptions
  queue. The service never assigns a finding to a guessed address, and
  the attestation loop never messages an address it did not get from the
  finding record.
- **No number is ever invented.** Where Graph does not provide a figure,
  the finding stores `null`. Costs are null when no price is on file.
  The console renders null as "unknown", never as zero and never as a
  guess.

### 3.3 Data retention and deletion

- The database file grows with every scan: one row per finding per scan
  run, plus audit, send, cache, and progress rows. There is no retention
  or purge job in the current code. Operators should plan retention for
  the deployment (for example, archive the file per scan run and keep a
  defined number of runs).
- Rows are never deleted by the service. Finding lifecycle changes are
  status transitions, not deletes.
- To remove fixture data from the demo tenant, delete the fixture objects
  in the tenant (the seeder creates objects with the `spectre-` prefix
  and the display names listed in `src/seeder/constants.ts`) and delete
  or replace the database file. Deleting the database file loses the
  audit log and the send history with it; back it up first if the audit
  trail matters.
- The database file contains owner UPNs and conversation references.
  Treat it as tenant data: restrict file access to the service account,
  include it in backups, and do not copy it to a public location.

## 4. Audit logging

Every remediation action writes exactly one audit log entry, in the
`audit_log` table, with: finding id, action (`restrict`, `archive`,
`revoke`), target (the link, site, or guest), approver UPN, timestamp,
result (`success`, `failure`, `queued`), error text, and restore path.
The dispatcher writes the entry for every executed action, including
failures. A refused action (no approval, no handler, wrong action for the
ghost type) writes no entry, because nothing was executed; the refusal
itself is returned to the caller and logged by the caller.

Properties the audit log guarantees:

- **One entry per action.** The dispatcher appends the entry after the
  handler returns and before it reports the result.
- **Failure never marks a finding fixed.** A finding is set to `actioned`
  only when the handler reports `success`. On `failure` or `queued`, the
  finding stays `open` and the error is on the entry.
- **The restore path is recorded where one exists.** Guest expiry records
  the 30-day restore path. Archive records the reactivation path. Link
  revocation records no restore path, and the entry says so plainly by
  having `restore_path` null: the link is gone and must be recreated by
  the owner.
- **The attestation loop never writes to the audit log directly.** Only
  the dispatcher writes it, so an entry always means an action was
  attempted.
- **The audit log is read-only from the console.** The console API
  exposes `GET /audit`; there is no endpoint that edits or deletes
  entries.

Limitations: the audit log lives in the same SQLite file as the findings,
so it shares the file's backup and access controls. There is no
tamper-evidence mechanism (no hash chain, no append-only enforcement at
the database level). For a production deployment, export the audit log to
an append-only store on a schedule.

## 5. Single-tenant bot design

The bot is registered as a **single-tenant** Bot Framework bot. It serves
one tenant only: the tenant that owns the app registration. The messaging
endpoint validates every request before parsing it:

- The request must be `POST /api/messages`. Any other path or method
  receives 404.
- The request must carry a `Bearer` JWT signed with RS256. The endpoint
  fetches the signing keys from the Bot Framework OpenID configuration
  (`https://login.botframework.com/v1/.well-known/openidconfiguration`)
  and its JWKS endpoint, caches the keys for 24 hours, and refreshes them
  on key rotation.
- The token must satisfy all of: issuer `https://api.botframework.com`,
  audience equal to the bot App ID, expiry in the future, and the
  `serviceurl` claim equal to the activity's `serviceUrl`. Anything else
  receives 401 and is not parsed.
- A request that fails validation is logged with `auth=false` and no
  further processing happens. A request that throws during handling
  receives 500, so Teams retries the submit and the owner can tap again.

The bot's own outbound sends use a client-credentials token for the
`https://api.botframework.com/.default` scope, acquired with the bot App
ID and secret. The bot sends only to conversation references it learned
from an authenticated activity by the owner. It never sends to an address
supplied by a caller.

The Teams app package declares the bot with scope `personal` and
`isNotificationOnly` false, so the bot can start a 1:1 conversation and
receive replies. The manifest declares no `validDomains`, because the bot
sends no links that need domain validation.

## 6. Console security

- The console server has **no sign-in of its own**. It binds to
  `127.0.0.1` by default. Keep it on localhost or behind the tenant's
  access proxy. Do not expose it directly to the internet.
- The only write endpoint is `POST /exceptions/{id}/decide`. It requires
  a JSON content type (a non-JSON content type receives 415, which also
  blocks blind cross-site posts), a known action, a finding that is in
  the exceptions queue, and `ADMIN_UPN` configured on the server.
  Without `ADMIN_UPN`, every decide request receives 503.
- The decide endpoint records the approval before dispatching, returns
  409 when a decision is already recorded, and returns 422 when the
  action is not allowed for the ghost type. It never executes a fix
  itself.
- The API responses set `cache-control: no-store`. The UI holds no
  credentials and makes no Graph calls.
