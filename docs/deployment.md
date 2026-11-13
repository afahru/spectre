# Spectre Deployment

This document covers a full deployment: prerequisites, the Entra app registration, the Teams bot registration, environment variables, build and run steps, and the public messaging endpoint. It is written for the person who installs Spectre in a tenant, and it assumes no prior knowledge of this codebase. All identifiers below are placeholders. Fill them from your own tenant and never commit a filled-in copy; this repository is public.

Spectre runs as three small processes that share one database file: a one-shot scan engine, a bot server that talks to Teams, and a console server that shows the admin the score and the findings. Nothing in the deployment needs a database server, a container platform, or an Azure subscription.

## 1. Prerequisites

### 1.1 Runtime

- Node.js 22 (the service targets Node 22; the console build uses TypeScript 5.6 and Vite 5).
- `npm` for dependency installation. The service has no system-level dependencies beyond Node.
- Outbound HTTPS access to Microsoft Graph (`https://graph.microsoft.com`), the Bot Framework (`https://api.botframework.com`), and the login endpoints used for token acquisition.

### 1.2 Tenant access

- A Microsoft 365 tenant where you hold the **Global Administrator** or **Application Administrator** role (to create the app registration and grant admin consent) and the **Teams Administrator** role (to install the Teams app org-wide).
- A SharePoint site collection or tenant where the scan is allowed to read sites, users, guests, licences, and drive permissions.

### 1.3 What the deployment consists of

Three processes, all in this repository:

| Process | Entry point | Default port | Purpose |
|---|---|---|---|
| Scan engine | `node dist/index.js` | none (one-shot, exits) | Inventory, flagging, permissions fetch, scoring |
| Bot server | `node dist/attestation/server.js` | 3978 | Teams messaging endpoint and decision handling |
| Console server | `node dist/console/server.js` | 3979 | Admin console read API and the React app |

The scan engine and the two servers share one SQLite file (see `DB_PATH`). The bot server and the console server must point at the same database file, or the console will not see the scan results and the bot will not see the findings.

## 2. Entra app registration (Graph client)

Create one app registration for the scan engine, remediation, and the bot endpoint's UPN lookup. An app registration is the identity the service uses to call Microsoft Graph; a UPN is a user's sign-in name, in email form. The service authenticates with the client credentials flow (application permissions only, no delegated token, no interactive sign-in). The Graph client is built in `src/graph/client.ts` with `ClientSecretCredential` and the `https://graph.microsoft.com/.default` scope.

### 2.1 Create the registration

1. In the Entra admin center, create an app registration of type **single tenant**.
2. Note the **Application (client) ID** and the **Directory (tenant) ID**. These become `CLIENT_ID` and `TENANT_ID`.
3. Under **Certificates and secrets**, create a client secret and copy its value immediately. It becomes `CLIENT_SECRET`. It is shown once; if it is lost, create a new one and rotate the environment variable.
4. Note the secret expiry date and put a renewal reminder in your calendar. The service has no secret rotation; an expired secret fails every Graph call at startup with a token error.

### 2.2 Permissions

Grant **application permissions** on the registration and admin-consent them. Application permissions let the service act on the tenant's data with its own identity, after an admin approves them once. The permissions the code names are:

| Permission | Used by | Why |
|---|---|---|
| `Sites.ReadWrite.All` | Remediation: revoke anonymous link | Deletes a drive item permission via Graph |
| `Files.ReadWrite.All` | Remediation: write scopes | Named in the Graph-conventions steering rule as a remediation write scope |
| `User.ReadBasic.All` | Bot endpoint: UPN lookup | Maps a Teams user's AAD object id to a user principal name so the bot can learn the 1:1 conversation |

The scan engine also reads sites, users, guests, licences, sign-in activity, and drive permissions through the Graph endpoints listed in section 2.3. The repository does **not** enumerate the complete read permission set in code, so this document does not invent one. Grant the application permissions that cover the endpoints below, admin-consent them, and verify the scan completes without permission errors before relying on the results. If a call fails for lack of permission, the scan records the item as unreadable and continues; it does not fail the run, so a missing read permission can look like a clean tenant. Check the scan log for unreadable items after the first run.

### 2.3 Graph endpoints the service calls

Read endpoints used by the scan engine and the seeder:

- `GET /sites/getAllSites` with `$select=id,displayName,webUrl,createdDateTime,lastModifiedDateTime` ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/site-list?view=graph-rest-1.0); the site resource has no owner field and no `sharingCapability` property: [Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/resources/site?view=graph-rest-1.0))
- `GET /users` (guest inventory, filtered by user type)
- `GET /subscribedSkus` with `$select=id,skuPartNumber,consumedUnits,prepaidUnits` ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0))
- `GET /reports/getOffice365ActiveUserDetail(period='D90')` ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/reportroot-getoffice365activeuserdetail?view=graph-rest-1.0); the call returns a 302 redirect to a CSV download with per-service last-activity dates and no single "last activity date" column)
- `GET /auditLogs/signIns` (last sign-in per guest)
- `GET /sites/{siteId}/drive` and `GET /groups/{groupId}/owners` (owner enrichment)
- `GET /drives/{drive-id}/items/{item-id}/permissions` (link scope, flagged items only)
- `GET /sites/{siteId}/drive/root/children` with `$top=50` (anonymous link detection)
- `GET /organization` (tenant domain lookup, seeder only)

Write endpoints used by remediation and the seeder:

- `DELETE /drives/{drive-id}/items/{item-id}/permissions/{permission-id}` (revoke anonymous link)
- `DELETE /users/{guest-id}` (expire stale guest; [Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/user-delete?view=graph-rest-1.0): deleted users are restorable within 30 days, then permanently deleted)
- `GET /directory/deletedItems/{guest-id}` (confirm a guest is gone)
- `POST /directory/deletedItems/{guest-id}/restore` (restore a guest within 30 days)
- `POST /groups`, `POST /invitations`, `POST /users/{id}/assignLicense` (seeder only)

Note: Graph does **not** expose `sharingCapability` on the site resource in v1.0 or beta ([Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/resources/site?view=graph-rest-1.0)). Do not add it to a `$select`; the call fails. Overshared detection goes through the permissions fetcher, not site metadata. Tenant-level sharing can be read and changed through Graph v1.0 via `sharepointSettings` (`GET`/`PATCH /admin/sharepoint/settings`, [Microsoft Learn](https://learn.microsoft.com/en-us/graph/api/resources/sharepointsettings?view=graph-rest-1.0)). Site archiving exists in Graph only as a beta endpoint (`POST /sites/{site-id}/archive`), which Microsoft says is not supported for production use, and the SharePoint TenantAdministration REST API rejects app-only tokens, so there is no supported production app-only path for archiving; see [remediation.md](remediation.md#4-archive-a-cold-site).

## 3. Teams bot registration

The bot is a Bot Framework bot, single-tenant, registered in the same tenant. Single-tenant means the bot serves one tenant only: the tenant that owns the app registration. The full manual runbook is `.kiro/specs/spectre-attestation-loop/bot-registration.md`. The steps below summarise it; the runbook governs where they differ.

### 3.1 Register the bot

1. Create the bot as a **Single Tenant** app. Azure Bot creation in the Azure portal requires an Azure subscription; if the tenant has none, register the bot through the Teams Developer Portal instead, which requires no Azure subscription. Either route produces the same bot App ID.
2. Note the bot App ID. It becomes `BOT_APP_ID`.
3. Create a client secret on the bot's app registration and copy its value immediately. It becomes `BOT_APP_SECRET`.
4. Set the **messaging endpoint** to `https://<your-tunnel>/api/messages`. See section 6 for the endpoint requirement.
5. Enable the **Microsoft Teams channel** on the bot registration. This step is easy to miss and the failure is silent: with the channel disabled, Teams accepts the user's messages but never delivers them to the bot, and nothing appears in the server log. Verify the channel is enabled before testing delivery. See [operations.md](operations.md#41-the-bot-delivers-nothing).

### 3.2 Build and install the Teams app package

1. Copy `teams/manifest.template.json` to `manifest.json` and fill the placeholders: `id` and `bots[0].botId` with `<BOT_APP_ID>`, `version` with the package version, developer name and URLs with your values. The template uses manifest version 1.17, bot scope `personal`, `isNotificationOnly` false, and accent color `#5B2A86`.
2. Add the two icons: `color.png` (192x192) and `outline.png` (32x32).
3. Zip `manifest.json`, `color.png`, and `outline.png` into the app package.
4. In the Teams admin center, go to Teams apps, Manage apps, Upload new app, and upload the package.
5. In Setup policies, Global (Org-wide default), Installed apps, add Spectre. This installs the bot for every user in the tenant, which is what the demo needs.
6. Each owner opens Spectre in Teams and sends any message once, so the bot learns the 1:1 conversation. Without that first message, the bot has no conversation reference for the owner and the finding goes to the admin queue as `owner unreachable`.

### 3.3 What the bot needs from the Graph app

The bot endpoint resolves a Teams user's AAD object id to a UPN with `GET /users/{aadObjectId}` and the `userPrincipalName` field. That call uses the Graph app registration (`CLIENT_ID`), which needs the `User.ReadBasic.All` application permission, admin-consented. Without it, the endpoint cannot learn conversations and every owner is unreachable.

## 4. Environment variables

All configuration is by environment variable. There are no defaults for credentials; the service fails fast at startup with a descriptive error when a required variable is missing.

| Variable | Required | Purpose | Example value |
|---|---|---|---|
| `TENANT_ID` | Yes | Directory (tenant) ID of the Entra tenant | `<TENANT_ID>` |
| `CLIENT_ID` | Yes | Application (client) ID of the Graph app registration | `<CLIENT_ID>` |
| `CLIENT_SECRET` | Yes | Client secret of the Graph app registration | (secret, never committed) |
| `BOT_APP_ID` | Yes, bot server | App ID of the Teams bot registration | `<BOT_APP_ID>` |
| `BOT_APP_SECRET` | Yes, bot server | Client secret of the bot registration | (secret, never committed) |
| `DB_PATH` | No | Path to the SQLite database file | `./spectre.db` (default) |
| `PORT` | No | Port the bot server listens on | `3978` (default) |
| `ADMIN_UPN` | No | UPN recorded as approver for console decisions; without it, decide returns 503 | `<ADMIN_UPN>` |
| `CONSOLE_HOST` | No | Host the console server binds to | `127.0.0.1` (default) |
| `CONSOLE_PORT` | No | Port the console server listens on | `3979` (default) |
| `SPECTRE_SKU_PRICES` | No | JSON object mapping SKU part numbers to monthly USD cost, for example `{"ENTERPRISEPACK":22}` | (see below) |
| `SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB` | No | Monthly storage overage rate in USD per GB | (see below) |

Notes:

- `SPECTRE_SKU_PRICES`: when absent or unparseable, the price table is empty and every idle-licence finding records `monthlyCostUsd` as null (unknown), never a guessed price. Non-numeric values for a SKU are skipped with a warning.
- `SPECTRE_STORAGE_OVERAGE_RATE_USD_PER_GB`: when absent or not a valid non-negative number, the overage rate is null and every cold-storage finding records `storageOverageCostUsd` as null.
- `DB_PATH` must be the same file for the scan engine, the bot server, and the console server. They share state only through this file.
- Never put secrets in a file that is committed to the repository. `.env` and `*.db` are gitignored. Store secrets in the environment of the host that runs the service, with the file permissions described in [security.md](security.md#2-secret-handling).

## 5. Build and run

### 5.1 Install and build

```bash
npm ci
npx tsc
```

`npm ci` installs the exact dependency versions from `package-lock.json`. `npx tsc` compiles TypeScript to `dist/`. The build must exit 0 before any run step. The repository scripts are `npm run build` (`tsc`), `npm test` (type-check plus the test suites, 62 tests), `npm run web:build` (installs and builds the React console into `web/dist`), and `npm run attest` (the daily delivery and nudge runner).

Note: the `package.json` scripts `npm run bot` and `npm run console` invoke `ts-node` directly on the TypeScript sources, and `ts-node` fails on the `.js` import specifiers used throughout the codebase. Run the compiled output instead, as shown below.

### 5.2 Run a scan

```bash
node dist/index.js
```

The scan is a one-shot process. It logs inventory counts, flagging counts, permissions fetch results, anonymous-link detection, and the readiness score with its breakdown, then exits. Exit code 0 means the scan completed; a non-zero exit means the process failed (usually missing configuration or an unrecoverable Graph error) and the log states the cause. To seed the fixture tenant first, run `npm run seed` (see `src/seeder/`); to verify a scan against the fixture expectations, run `npm run verify`.

### 5.3 Run the bot server

```bash
PORT=3978 node dist/attestation/server.js
```

Required variables: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `BOT_APP_ID`, `BOT_APP_SECRET`, plus optional `DB_PATH` and `PORT`. The server logs `Spectre bot listening on :3978/api/messages` on startup. Keep the process running: it must be alive to receive postbacks. It has no built-in restart, daemon, or scheduler; use the host's process supervisor (systemd, a container restart policy, or equivalent).

### 5.4 Run the console server

```bash
npm run web:build
CONSOLE_PORT=3979 ADMIN_UPN=<ADMIN_UPN> node dist/console/server.js
```

Required variables: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, plus optional `DB_PATH`, `CONSOLE_HOST`, `CONSOLE_PORT`, `ADMIN_UPN`. Build the React app first (`npm run web:build`); without `web/dist` the server returns 404 with "Not found. Build the console first: npm run web:build" for every page. The console binds to `127.0.0.1` by default: it has no sign-in of its own, so keep it on localhost or behind your access proxy. Set `ADMIN_UPN` to the UPN of the admin who will decide from the console; without it, the decide endpoint returns 503 and no decision is accepted.

### 5.5 Run the daily loop

```bash
npm run attest
```

The daily runner (`src/attestation/run.ts`) delivers cards for open findings, then runs the nudge check, and prints one JSON summary line (`sent`, `nudged`, `escalated`, `queued`, `skipped`). It exits 0 on success. Nothing invokes it on a timer yet, so schedule it with the host's scheduler or run it by hand once a day. It has not yet been run against the live database, because it would send real cards to owners.

### 5.6 Verify the deployment

1. Run a scan and confirm it exits 0 and logs a score.
2. Open the console at `http://127.0.0.1:3979` (or your configured host and port) and confirm the score, findings, and audit views load.
3. Confirm the bot server answers unauthenticated `POST` requests to `/api/messages` with 401 (proving the endpoint is reachable and the JWT check is active).
4. Send any message to Spectre in Teams and confirm the server log shows the conversation being learned.
5. Trigger a card send for one open finding and confirm the card arrives in the owner's Teams, the three buttons render, and a tap is recorded (the finding status changes to `dismissed` for Keep).

## 6. Public messaging endpoint

The bot server listens on plain HTTP on localhost. Teams cannot reach it directly; the messaging endpoint registered on the bot must be a public HTTPS URL. The URL is deployment configuration, never hardcoded: the endpoint code reads nothing about its own public address, and the bot registration holds the URL.

For development, a tunnel (for example a Cloudflare quick tunnel) that forwards a public HTTPS URL to `localhost:3978` is sufficient. For production, use a stable public endpoint: a named tunnel or a reverse proxy with a fixed hostname and a valid TLS certificate. The requirements are:

- HTTPS, with a certificate Teams trusts.
- The path must be exactly `/api/messages`. The server returns 404 for any other path or method.
- The URL must stay stable. If the tunnel restarts with a new random URL, the bot registration still points at the old URL and Teams delivery stops. Update the messaging endpoint on the bot registration whenever the public URL changes, and verify it is saved.
- Latency matters. The Bot Framework validates the JWT on every request by fetching the OpenID configuration and JWKS; a slow tunnel adds seconds to every postback. Keep the tunnel close to the server.

Known failure: a tunnel URL that changes after the host pauses or the tunnel restarts is the most common cause of "the bot stopped answering". See [operations.md](operations.md#43-the-public-endpoint-changed).

## 7. References

Microsoft Learn links first. All links below appear in the research report of 13 November 2026; pages marked (live) were opened live that day, the rest are cited from the report's search-index sources.

- Microsoft Learn (live): List sites: https://learn.microsoft.com/en-us/graph/api/site-list?view=graph-rest-1.0
- Microsoft Learn (live): Site resource (no owner field, no sharingCapability): https://learn.microsoft.com/en-us/graph/api/resources/site?view=graph-rest-1.0
- Microsoft Learn (live): sharepointSettings resource (tenant-level sharingCapability): https://learn.microsoft.com/en-us/graph/api/resources/sharepointsettings?view=graph-rest-1.0
- Microsoft Learn (live): List subscribed SKUs: https://learn.microsoft.com/en-us/graph/api/subscribedsku-list?view=graph-rest-1.0
- Microsoft Learn (live): getOffice365ActiveUserDetail (CSV, per-service last-activity dates): https://learn.microsoft.com/en-us/graph/api/reportroot-getoffice365activeuserdetail?view=graph-rest-1.0
- Microsoft Learn (live): Delete user (30-day restore window): https://learn.microsoft.com/en-us/graph/api/user-delete?view=graph-rest-1.0
- Microsoft Learn (live): Restore a deleted user: https://learn.microsoft.com/en-us/entra/fundamentals/users-restore
- Microsoft Learn (search-index citation): Archive a site, beta only: https://learn.microsoft.com/en-us/graph/api/site-archive?view=graph-rest-beta
- Microsoft Learn (search-index citation): Restore a deleted item: https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-restore?view=graph-rest-1.0
- Microsoft Learn (search-index citation): Delete a permission: https://learn.microsoft.com/en-us/onedrive/developer/rest-api/api/permission_delete?view=odsp-graph-online

Heuristics in this document: the scan thresholds behind the endpoints above (90-day activity window, 90-day stale guest, 365-day cold storage) are Spectre's choices, not Microsoft definitions; they are labelled "Heuristic" in [architecture.md](architecture.md).
