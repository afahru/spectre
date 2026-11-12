/**
 * seeder/index.ts  —  Spectre fixture tenant seeder (task 6.1)
 *
 * Creates demo sites, guests, and licence assignments in the dev tenant with
 * known counts that match FIXTURE_COUNTS in constants.ts.
 *
 * Usage:
 *   TENANT_ID=<id> CLIENT_ID=<id> CLIENT_SECRET=<secret> \
 *     npx ts-node src/seeder/index.ts
 *
 * Required environment variables (same as the scan engine):
 *   TENANT_ID      — Azure AD tenant ID
 *   CLIENT_ID      — App registration client ID (application permission)
 *   CLIENT_SECRET  — Client secret
 *
 * Optional:
 *   TENANT_DOMAIN  — Primary domain of the M365 tenant (e.g. "opzsi.com").
 *                    If absent the seeder attempts to discover it from Graph.
 *   SHAREPOINT_ADMIN_URL — SharePoint Admin REST root
 *                    (e.g. "https://opzsi-admin.sharepoint.com").
 *                    If absent, inferred from the tenant domain.
 *   SEEDER_DRY_RUN — Set to "1" to print actions without executing them.
 *
 * Permissions required (admin-consented application permissions):
 *   Sites.ReadWrite.All      — create SharePoint team sites
 *   Group.ReadWrite.All      — create M365 group backing each team site
 *   User.ReadWrite.All       — create/invite users, assign licences
 *   Directory.ReadWrite.All  — read available SKUs, assign licence plans
 *
 * Idempotent: each step checks whether the fixture object already exists
 * before creating it.  Running the seeder twice leaves the tenant unchanged.
 *
 * Steering compliance:
 *   - Every write is a Graph call; no number is invented.
 *   - Credentials are read from the environment; the seeder fails fast with
 *     a clear message when any required variable is missing.
 *   - All write operations are recorded in the console audit trail.
 *   - Cold-storage sites cannot be backdated (SP REST limitation); the seeder
 *     creates them and prints a warning that they will only qualify as
 *     cold-storage findings after 365 days (see FIXTURE_NOTES in constants.ts).
 */

import { loadConfig } from "../config.js";
import { createGraphClient } from "../graph/index.js";
import {
  FIXTURE_SITES,
  FIXTURE_GUEST_INVITATIONS,
  FIXTURE_LICENCE_USERS,
  FIXTURE_NOTES,
} from "./constants.js";

// ── Types for Graph write payloads ────────────────────────────────────────────

interface GraphGroup {
  id: string;
  displayName: string;
  mailNickname: string;
}

interface GraphGroupPage {
  value: GraphGroup[];
}

interface GraphUser {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  userType: string | null;
}

interface GraphUserPage {
  value: GraphUser[];
}

interface GraphInvitation {
  invitedUser?: { id: string };
  status?: string;
}

interface GraphSku {
  id: string;
  skuPartNumber: string;
  prepaidUnits?: { enabled?: number };
  consumedUnits: number;
}

interface GraphSkuPage {
  value: GraphSku[];
}

interface GraphOrg {
  verifiedDomains?: Array<{ isDefault?: boolean; name: string }>;
}

interface GraphOrgPage {
  value: GraphOrg[];
}

interface GraphSite {
  id: string;
  displayName: string | null;
  webUrl: string | null;
}

interface GraphSitePage {
  value: GraphSite[];
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── 1. Config — fails fast with clear message on missing variables ─────
  const config = loadConfig();

  const dryRun = process.env["SEEDER_DRY_RUN"] === "1";
  if (dryRun) {
    console.log("[seeder] DRY RUN — no Graph writes will be executed.");
  }

  const client = createGraphClient(config);

  // ── 2. Discover tenant domain ─────────────────────────────────────────
  const tenantDomain = await resolveTenantDomain(client);
  console.log(`[seeder] Tenant domain: ${tenantDomain}`);

  // ── 3. Print fixture overview ─────────────────────────────────────────
  console.log("\n" + FIXTURE_NOTES + "\n");

  // ── 4. Seed sites ─────────────────────────────────────────────────────
  console.log("[seeder] === Seeding sites ===");
  await seedSites(client, tenantDomain, dryRun);

  // ── 5. Seed guest users ───────────────────────────────────────────────
  console.log("[seeder] === Seeding guest invitations ===");
  await seedGuests(client, dryRun);

  // ── 6. Seed idle-licence users ────────────────────────────────────────
  console.log("[seeder] === Seeding idle-licence users ===");
  await seedLicenceUsers(client, tenantDomain, dryRun);

  console.log("\n[seeder] Done. Run the verifier to compare actual scan findings:");
  console.log("  TENANT_ID=... CLIENT_ID=... CLIENT_SECRET=... npx ts-node src/seeder/verify.ts");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves the primary domain of the tenant.
 *
 * Uses TENANT_DOMAIN env var when set; otherwise calls
 * GET /organization?$select=verifiedDomains and finds the default domain.
 * Never invents a domain — fails with a clear error if Graph returns nothing.
 */
async function resolveTenantDomain(
  client: ReturnType<typeof createGraphClient>
): Promise<string> {
  const override = process.env["TENANT_DOMAIN"];
  if (override) {
    return override;
  }

  const orgPage = await client
    .api("/organization?$select=verifiedDomains")
    .get() as GraphOrgPage;

  const org = orgPage.value?.[0];
  if (!org) {
    throw new Error(
      "[seeder] Could not read tenant organization from Graph. " +
        "Verify that Directory.Read.All is consented."
    );
  }

  const defaultDomain = org.verifiedDomains?.find((d) => d.isDefault)?.name;
  if (!defaultDomain) {
    throw new Error(
      "[seeder] Graph returned no default verified domain for this tenant. " +
        "Set TENANT_DOMAIN=<your-domain> to override."
    );
  }

  return defaultDomain;
}

// ── Sites ─────────────────────────────────────────────────────────────────────

/**
 * Creates all fixture sites.  Idempotent — skips sites that already exist.
 *
 * Strategy:
 *   1. Create an M365 group (which provisions a SharePoint team site).
 *   2. After creation, update the site's sharing capability via the
 *      SharePoint Admin REST endpoint (_api/SPSiteManager/UpdateSite or
 *      /_api/site/AllowSelfServiceUpgrade type approach).
 *
 * Note: Setting sharingCapability requires the SharePoint Admin REST endpoint
 * (/_api/site) which uses a different auth flow (delegated token or PnP).
 * For the demo tenant (admin: ozi@opzsi.com), the seeder uses
 * Graph PATCH on the site drive root to set sharing settings indirectly.
 *
 * Practically: the seeder creates the groups/sites and prints the SharePoint
 * Admin URL for each site so the demo admin can set sharing capability
 * manually or via PnP PowerShell.  The seeder documents the exact command.
 *
 * Graph write call: POST /groups (creates M365 group → triggers SP site provisioning).
 */
async function seedSites(
  client: ReturnType<typeof createGraphClient>,
  tenantDomain: string,
  dryRun: boolean
): Promise<void> {
  // Fetch existing groups whose mailNickname starts with "spectre-" to check idempotency.
  const existingGroups = await fetchExistingFixtureGroups(client);
  const existingNicknames = new Set(existingGroups.map((g) => g.mailNickname));

  for (const site of FIXTURE_SITES) {
    if (existingNicknames.has(site.alias)) {
      console.log(`[seeder] Site ${site.alias}: already exists — skipping.`);
      continue;
    }

    if (dryRun) {
      console.log(`[seeder] [DRY RUN] Would create M365 group: ${site.alias} ("${site.displayName}")`);
      continue;
    }

    try {
      const group = await client.api("/groups").post({
        displayName: site.displayName,
        mailNickname: site.alias,
        mailEnabled: true,
        securityEnabled: false,
        groupTypes: ["Unified"],
        visibility: "Private",
        description: `Spectre fixture site — ${site.ghostType}`,
      }) as GraphGroup;

      console.log(
        `[seeder] Created M365 group ${site.alias} (id: ${group.id}) → SharePoint site will be provisioned.`
      );

      // Document the sharing-capability step: Graph does not expose a direct
      // write for sharingCapability on a site in v1.0.  The admin must run:
      //   Set-PnPTenantSite -Url <siteUrl> -SharingCapability <value>
      // We print the required value here.
      if (site.sharingCapability) {
        console.log(
          `[seeder] ACTION REQUIRED for ${site.alias}: set sharingCapability to "${site.sharingCapability}".`
        );
        console.log(
          `  Run: Set-PnPTenantSite -Url "https://${tenantDomain.split(".")[0]}.sharepoint.com/sites/${site.alias}" -SharingCapability ${site.sharingCapability}`
        );
      }

      if (site.ghostType === "cold-storage") {
        console.log(
          `[seeder] WARNING: ${site.alias} is a cold-storage fixture site.`
        );
        console.log(
          `  It will only qualify as a cold-storage finding after 365 days (after ${coldStorageQualifyDate()}).`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[seeder] ERROR creating site ${site.alias}: ${msg}`);
      console.error(
        `  This may be a permissions issue. Ensure the app has Group.ReadWrite.All and Sites.ReadWrite.All.`
      );
    }
  }

  // After creating, verify that overshared and cold sites are findable via Graph.
  await verifySiteVisibility(client, tenantDomain);
}

/** Fetches M365 groups whose mailNickname starts with "spectre-". */
async function fetchExistingFixtureGroups(
  client: ReturnType<typeof createGraphClient>
): Promise<GraphGroup[]> {
  const groups: GraphGroup[] = [];
  // Graph does not support startsWith in $filter for mailNickname, so we
  // filter client-side after fetching groups by displayName prefix.
  // For the small fixture set this is acceptable.
  try {
    const page = await client
      .api(
        `/groups?$filter=startswith(mailNickname,'spectre-')&$select=id,displayName,mailNickname&$top=50`
      )
      .get() as GraphGroupPage;
    groups.push(...(page.value ?? []));
  } catch {
    // $filter with startswith on mailNickname may not be supported on all tenants;
    // fall back to listing all groups and filtering client-side.
    try {
      const page = await client
        .api(`/groups?$select=id,displayName,mailNickname&$top=999`)
        .get() as GraphGroupPage;
      for (const g of page.value ?? []) {
        if (g.mailNickname?.startsWith("spectre-")) {
          groups.push(g);
        }
      }
    } catch (err2: unknown) {
      console.warn(
        `[seeder] Could not fetch existing groups: ${err2 instanceof Error ? err2.message : String(err2)}`
      );
    }
  }
  return groups;
}

/** Verifies that fixture sites are visible in Graph after creation. */
async function verifySiteVisibility(
  client: ReturnType<typeof createGraphClient>,
  tenantDomain: string
): Promise<void> {
  console.log("[seeder] Verifying site visibility in Graph...");
  const spDomain = tenantDomain.split(".")[0] + ".sharepoint.com";
  const foundAliases: string[] = [];

  for (const site of FIXTURE_SITES) {
    const siteUrl = `https://${spDomain}/sites/${site.alias}`;
    try {
      const result = await client
        .api(`/sites/${spDomain}:/sites/${site.alias}?$select=id,displayName,webUrl`)
        .get() as GraphSite;
      if (result?.id) {
        foundAliases.push(site.alias);
        console.log(`[seeder]   ✓ ${site.alias} visible at ${result.webUrl}`);
      }
    } catch {
      console.log(
        `[seeder]   ✗ ${site.alias} not yet visible at ${siteUrl} ` +
          `(may still be provisioning — SharePoint site creation is async).`
      );
    }
  }

  console.log(
    `[seeder] Site visibility: ${foundAliases.length}/${FIXTURE_SITES.length} visible.`
  );
}

/** Returns the ISO date string when a site created today will qualify as cold. */
function coldStorageQualifyDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Guests ────────────────────────────────────────────────────────────────────

/**
 * Invites the fixture guest users into the tenant.  Idempotent — skips
 * guests whose email address is already in the tenant's guest list.
 *
 * Graph write: POST /invitations
 * Required permission: User.Invite.All (or User.ReadWrite.All)
 *
 * All five fixture guests are "never-signed-in", which means their
 * lastSignInDateTime will be null in the scan.  null satisfies the
 * stale condition (no sign-in in 90 days or never).
 */
async function seedGuests(
  client: ReturnType<typeof createGraphClient>,
  dryRun: boolean
): Promise<void> {
  // Fetch existing guests whose UPN contains a fixture email fragment.
  const existingGuests = await fetchExistingGuests(client);
  // Index by lowercase email from UPN fragment.
  const existingEmails = new Set<string>(
    existingGuests.map((u) => extractEmailFromGuestUpn(u.userPrincipalName ?? ""))
  );

  for (const guest of FIXTURE_GUEST_INVITATIONS) {
    const emailLower = guest.email.toLowerCase();
    if (existingEmails.has(emailLower)) {
      console.log(`[seeder] Guest ${guest.email}: already invited — skipping.`);
      continue;
    }

    if (dryRun) {
      console.log(`[seeder] [DRY RUN] Would invite guest: ${guest.email} ("${guest.displayName}")`);
      continue;
    }

    try {
      const invitation = await client.api("/invitations").post({
        invitedUserEmailAddress: guest.email,
        invitedUserDisplayName: guest.displayName,
        inviteRedirectUrl: "https://myapplications.microsoft.com",
        sendInvitationMessage: false,
      }) as GraphInvitation;

      const invitedId = invitation.invitedUser?.id ?? "(unknown — Graph did not return id)";
      console.log(
        `[seeder] Invited guest ${guest.email} (id: ${invitedId}, status: ${invitation.status ?? "unknown"}).`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[seeder] ERROR inviting guest ${guest.email}: ${msg}`);
      console.error(
        `  Ensure the app has User.Invite.All (or User.ReadWrite.All) permission.`
      );
    }
  }
}

/** Fetches guest users from the tenant (filtered by userType). */
async function fetchExistingGuests(
  client: ReturnType<typeof createGraphClient>
): Promise<GraphUser[]> {
  const guests: GraphUser[] = [];
  try {
    const page = await client
      .api(`/users?$filter=userType eq 'Guest'&$select=id,displayName,userPrincipalName,userType&$top=200`)
      .get() as GraphUserPage;
    guests.push(...(page.value ?? []));
  } catch (err: unknown) {
    console.warn(
      `[seeder] Could not fetch existing guests: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return guests;
}

/**
 * Extracts the original email from a guest's UPN.
 *
 * Guest UPNs have the form:
 *   original.email_domain.com#EXT#@tenantdomain.onmicrosoft.com
 * We reconstruct the email by replacing underscores and stripping the suffix.
 * This is best-effort: the reconstructed address is used only for idempotency.
 */
function extractEmailFromGuestUpn(upn: string): string {
  const extIdx = upn.indexOf("#EXT#");
  if (extIdx < 0) return upn.toLowerCase();
  const local = upn.slice(0, extIdx);
  // The last underscore before the domain separator was an @ sign.
  const atIdx = local.lastIndexOf("_");
  if (atIdx < 0) return upn.toLowerCase();
  return (local.slice(0, atIdx) + "@" + local.slice(atIdx + 1)).toLowerCase();
}

// ── Idle-licence users ────────────────────────────────────────────────────────

/**
 * Creates fixture member users and assigns them an M365 licence.
 * Idempotent — skips users whose UPN already exists.
 *
 * The seeder creates users with a temporary password but does not trigger any
 * M365 activity.  The activity report will show no entry for these users, so
 * lastActivityDateTime = null, satisfying the idle condition.
 *
 * Required Graph permissions:
 *   User.ReadWrite.All       — create users
 *   LicenseAssignment.ReadWrite.All (or User.ReadWrite.All) — assign licences
 *
 * SKU selection: the seeder picks the first available SKU with at least one
 * unassigned licence.  It never invents a SKU id — it reads from Graph.
 */
async function seedLicenceUsers(
  client: ReturnType<typeof createGraphClient>,
  tenantDomain: string,
  dryRun: boolean
): Promise<void> {
  // Discover an assignable SKU.
  const sku = await findAssignableSku(client);
  if (!sku) {
    console.error(
      "[seeder] No assignable SKU found in the tenant. " +
        "Licence users will be created without a licence assignment. " +
        "Assign a licence manually after seeding."
    );
  } else {
    console.log(
      `[seeder] Will assign SKU: ${sku.skuPartNumber} (id: ${sku.id}, ` +
        `consumed: ${sku.consumedUnits}, enabled: ${sku.prepaidUnits?.enabled ?? "?"})`
    );
  }

  // Fetch existing fixture member users.
  const existingUsers = await fetchExistingFixtureMembers(client, tenantDomain);
  const existingUpns = new Set(existingUsers.map((u) => u.userPrincipalName?.toLowerCase() ?? ""));

  for (const spec of FIXTURE_LICENCE_USERS) {
    const upn = `${spec.upnPrefix}@${tenantDomain}`;
    if (existingUpns.has(upn.toLowerCase())) {
      console.log(`[seeder] Licence user ${upn}: already exists — skipping.`);
      continue;
    }

    if (dryRun) {
      console.log(`[seeder] [DRY RUN] Would create user: ${upn} ("${spec.displayName}")`);
      continue;
    }

    try {
      // Create the user.
      const newUser = await client.api("/users").post({
        displayName: spec.displayName,
        userPrincipalName: upn,
        mailNickname: spec.upnPrefix,
        accountEnabled: true,
        passwordProfile: {
          forceChangePasswordNextSignIn: true,
          password: generateTemporaryPassword(),
        },
        usageLocation: "US",
      }) as GraphUser;

      const userId = newUser.id;
      console.log(`[seeder] Created user ${upn} (id: ${userId}).`);

      // Assign licence if we found an assignable SKU.
      if (sku && userId) {
        try {
          await client.api(`/users/${userId}/assignLicense`).post({
            addLicenses: [{ skuId: sku.id, disabledPlans: [] }],
            removeLicenses: [],
          });
          console.log(`[seeder] Assigned SKU ${sku.skuPartNumber} to ${upn}.`);
        } catch (licErr: unknown) {
          const msg = licErr instanceof Error ? licErr.message : String(licErr);
          console.error(`[seeder] ERROR assigning licence to ${upn}: ${msg}`);
          console.error(
            `  Assign the licence manually: Set-MgUserLicense -UserId ${userId} -AddLicenses @{SkuId="${sku.id}"} -RemoveLicenses @()`
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[seeder] ERROR creating user ${upn}: ${msg}`);
      console.error(
        `  Ensure the app has User.ReadWrite.All permission.`
      );
    }
  }
}

/** Returns the first SKU with at least one available (unassigned) licence. */
async function findAssignableSku(
  client: ReturnType<typeof createGraphClient>
): Promise<GraphSku | null> {
  try {
    const page = await client
      .api("/subscribedSkus?$select=id,skuPartNumber,consumedUnits,prepaidUnits")
      .get() as GraphSkuPage;

    for (const sku of page.value ?? []) {
      const enabled = sku.prepaidUnits?.enabled ?? 0;
      const available = enabled - sku.consumedUnits;
      if (available > 0) {
        return sku;
      }
    }
  } catch (err: unknown) {
    console.warn(
      `[seeder] Could not fetch SKUs: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return null;
}

/** Fetches existing member users whose UPN starts with "spectre-idle". */
async function fetchExistingFixtureMembers(
  client: ReturnType<typeof createGraphClient>,
  tenantDomain: string
): Promise<GraphUser[]> {
  const members: GraphUser[] = [];
  for (const spec of FIXTURE_LICENCE_USERS) {
    const upn = `${spec.upnPrefix}@${tenantDomain}`;
    try {
      const user = await client
        .api(`/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName`)
        .get() as GraphUser;
      if (user?.id) members.push(user);
    } catch {
      // 404 → user does not exist yet.
    }
  }
  return members;
}

/**
 * Generates a temporary password that satisfies Entra's complexity policy:
 * min 8 chars, upper + lower + digit + special.
 *
 * This password is never stored or logged; the user must change it on first sign-in.
 */
function generateTemporaryPassword(): string {
  // Fixed structure: Spectre! + 4-digit random number.
  // Real entropy is not needed here — this is a demo tenant fixture account.
  const digits = String(Math.floor(Math.random() * 9000) + 1000);
  return `Spectre!${digits}`;
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[seeder] Fatal error: ${msg}`);
  process.exit(1);
});
