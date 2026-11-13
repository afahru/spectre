# Task 2.1: Bot registration runbook (manual, dev tenant)

Needs a human with Azure portal and Teams admin access. Fill the `<...>`
placeholders in `teams/manifest.template.json` and never commit secrets.

1. Azure portal > Azure Bot > Create. Type of app: **Single Tenant**; create
   a new Microsoft App ID in the dev tenant. Note the App ID (BOT_APP_ID).
2. Bot > Configuration: set the **Messaging endpoint** to
   `https://<public-host>/api/messages` (dev: your tunnel URL).
3. Bot > Channels: add **Microsoft Teams**.
4. App registration of the bot > Certificates & secrets: create a client
   secret (BOT_APP_SECRET). Store it in the environment only.
5. App registration of the Graph client (CLIENT_ID): grant the application
   permission **User.ReadBasic.All** and admin-consent it. The endpoint uses
   it to map a Teams user to a UPN.
6. Build the Teams app package: fill `teams/manifest.template.json` as
   `manifest.json`, add `color.png` (192x192) and `outline.png` (32x32), zip
   the three files.
7. Teams admin center > Teams apps > Manage apps > Upload new app. Then
   Setup policies > Global (Org-wide default) > Installed apps > add Spectre
   (org-wide install for the demo).
8. Start the service (`npm run bot` with TENANT_ID, CLIENT_ID,
   CLIENT_SECRET, BOT_APP_ID, BOT_APP_SECRET). Each demo owner opens Spectre
   in Teams and sends any message once, so the bot learns the 1:1
   conversation. Without that the finding goes to the admin queue as
   "owner unreachable".
