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
 *   Group.ReadWrite.All      — create M365 group backing each team site;
 *                              add the tenant admin as owner of the six
 *                              non-orphaned fixture groups
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
  assignedLicenses?: Array<{ skuId: string }>;
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

interface GraphDrive {
  id: string;
}

interface GraphPermission {
  id?: string;
  link?: {
    scope?: string;
    type?: string;
    webUrl?: string;
  } | null;
  roles?: string[];
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

  // ── 4b. Seed anonymous sharing links on overshared fixture sites ───────
  //  This uploads a demo file into each overshared fixture site's library
  //  and creates an anonymous view link on that file, so the permissions
  //  fetcher detects them as overshared.  The link is on a FILE, not the
  //  drive root: Graph returns 400 notSupported for createLink on
  //  /drive/root even when the site's sharing is Anyone (verified
  //  2026-11-12).  Requires the site's sharing to be "Anyone"
  //  (ExternalUserAndGuestSharing), set in the SharePoint admin center.
  console.log("[seeder] === Seeding anonymous links on overshared fixture sites ===");
  await seedAnonymousLinks(client, tenantDomain, dryRun);

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
  const existingByNickname = new Map(existingGroups.map((g) => [g.mailNickname, g]));

  // The demo tenant admin owns the six non-orphaned fixture groups, so the
  // scanner's owner enrichment finds a real owner for them and only the two
  // spectre-or1/or2 sites stay ownerless by design (see FIXTURE_NOTES).
  // Without this, every fixture group is ownerless and the orphaned count
  // reads 8 instead of the intended 2. The admin UPN is the tenant admin
  // named in the project AGENTS.md; it is resolved to a user id via Graph,
  // never invented.
  const adminUpn = `ozi@${tenantDomain}`;
  const adminUserId = await resolveAdminUserId(client, adminUpn);

  for (const site of FIXTURE_SITES) {
    const existing = existingByNickname.get(site.alias);
    let groupId: string | undefined = existing?.id;

    if (existing) {
      console.log(`[seeder] Site ${site.alias}: already exists — skipping creation.`);
    } else {
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

        groupId = group.id;
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

    // Non-orphaned fixture sites get the tenant admin as group owner so the
    // scanner's owner enrichment resolves a real owner. Orphaned fixtures
    // (spectre-or1/or2) intentionally keep no owner.
    if (site.ghostType !== "orphaned-site" && groupId && adminUserId) {
      await ensureFixtureGroupOwner(client, groupId, site.alias, adminUserId, adminUpn);
    }
  }

  // After creating, verify that overshared and cold sites are findable via Graph.
  await verifySiteVisibility(client, tenantDomain);
}

/** Resolves the demo tenant admin's user id from their UPN. Returns null (with a warning) when the user cannot be found, so the seeder never invents an id. */
async function resolveAdminUserId(
  client: ReturnType<typeof createGraphClient>,
  adminUpn: string
): Promise<string | null> {
  try {
    const user = (await client
      .api(`/users/${encodeURIComponent(adminUpn)}?$select=id,userPrincipalName`)
      .get()) as GraphUser;
    if (user?.id) {
      console.log(`[seeder] Admin user resolved: ${adminUpn} (id: ${user.id})`);
      return user.id;
    }
    console.warn(`[seeder] Admin user ${adminUpn} has no id — owner assignment skipped.`);
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[seeder] Could not resolve admin user ${adminUpn}: ${msg} — owner assignment skipped.`);
    return null;
  }
}

/**
 * Ensures the tenant admin is an owner of a fixture group (idempotent).
 * Groups created by the app have no owners by default, so without this step
 * every fixture site looks ownerless to the scanner. Orphaned fixtures are
 * never passed here.
 */
async function ensureFixtureGroupOwner(
  client: ReturnType<typeof createGraphClient>,
  groupId: string,
  alias: string,
  adminUserId: string,
  adminUpn: string
): Promise<void> {
  try {
    const owners = (await client
      .api(`/groups/${groupId}/owners?$select=id,userPrincipalName&$top=50`)
      .get()) as GraphUserPage;
    if ((owners.value ?? []).some((o) => o.id === adminUserId)) {
      console.log(`[seeder] Site ${alias}: admin ${adminUpn} is already a group owner — skipping.`);
      return;
    }
    await client.api(`/groups/${groupId}/owners/$ref`).post({
      "@odata.id": `https://graph.microsoft.com/v1.0/users/${adminUserId}`,
    });
    console.log(`[seeder] Site ${alias}: added admin ${adminUpn} as group owner.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[seeder] Could not set group owner for ${alias}: ${msg} — site will stay ownerless.`);
  }
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

// ── Anonymous links ───────────────────────────────────────────────────────────

const DEMO_FILE_NAME = "SpectreDemo.txt";
const DEMO_FILE_CONTENT =
  "Spectre demo file. This file exists so the scanner has an anonymous " +
  "sharing link to detect on this fixture site.";

/**
 * Creates anonymous view links on a demo file inside each overshared
 * fixture site (spectre-os1, spectre-os2, spectre-os3).
 *
 * The link is created on a FILE, not on the drive root: Graph returns
 * 400 notSupported ("The operation failed because the object does not
 * support sharing", inner code objectNotSupported) for createLink on
 * /drive/root, even when the site's sharing is set to Anyone. Verified
 * 2026-11-12: the same call on a file in the same library succeeds and
 * returns an anonymous link. The drive root simply does not support
 * sharing links.
 *
 * Idempotent: the demo file is uploaded with PUT (overwrite), then the
 * file's permissions are checked; if a link with scope "anonymous"
 * already exists, the site is skipped.
 *
 * Graph writes: PUT /sites/{siteId}/drive/root:/SpectreDemo.txt:/content,
 * POST /sites/{siteId}/drive/root:/SpectreDemo.txt:/createLink
 * Required permission: Sites.ReadWrite.All (application).
 *
 * Prerequisite: the site's SharePoint sharing must be set to "Anyone"
 * (ExternalUserAndGuestSharing) in the SharePoint admin center. The app
 * cannot set this itself: the SharePoint TenantAdministration REST API
 * rejects app-only tokens, and Graph has no write endpoint for
 * SharingCapability.
 */
async function seedAnonymousLinks(
  client: ReturnType<typeof createGraphClient>,
  tenantDomain: string,
  dryRun: boolean
): Promise<void> {
  const oversharedSites = FIXTURE_SITES.filter((s) => s.ghostType === "overshared-site");

  let linkFailed = false;

  for (const site of oversharedSites) {
    // 1. Resolve the site id via the backing M365 group.
    //    The group mailNickname matches the site alias.
    let siteId: string | null = null;
    let siteWebUrl: string | null = null;
    try {
      // Find the backing group for this site alias.
      const groupsPage = await client
        .api(`/groups?$filter=mailNickname eq '${site.alias}'&$select=id,mailNickname`)
        .get() as { value: Array<{ id: string }> };

      const group = groupsPage.value?.[0];
      if (!group?.id) {
        console.error(
          `[seeder] No group with mailNickname=${site.alias} found — skipping anonymous link.`
        );
        continue;
      }

      // Get the SharePoint root site for the group.
      const groupSite = await client
        .api(`/groups/${group.id}/sites/root?$select=id,webUrl`)
        .get() as { id: string; webUrl: string | null };
      siteId = groupSite?.id ?? null;
      siteWebUrl = groupSite?.webUrl ?? null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[seeder] Could not look up site for ${site.alias} via group: ${msg} — skipping anonymous link.`
      );
      continue;
    }

    if (!siteId) {
      console.error(
        `[seeder] Site ${site.alias} not resolvable via group — skipping anonymous link.`
      );
      continue;
    }

    const encSiteId = encodeURIComponent(siteId);
    const filePath = `/sites/${encSiteId}/drive/root:/${DEMO_FILE_NAME}:`;

    if (dryRun) {
      console.log(
        `[seeder] [DRY RUN] Would upload ${DEMO_FILE_NAME} and create an anonymous view link on it for ${site.alias}.`
      );
      continue;
    }

    // 2. Upload (or overwrite) the demo file in the site's default library.
    try {
      await client
        .api(`${filePath}/content`)
        .header("Content-Type", "text/plain")
        .put(DEMO_FILE_CONTENT);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      linkFailed = true;
      console.error(
        `[seeder] ERROR uploading ${DEMO_FILE_NAME} for ${site.alias}: ${msg}`
      );
      continue;
    }

    // 3. Check whether an anonymous link already exists on the file.
    let hasAnonymousLink = false;
    try {
      const permsPage = await client
        .api(`${filePath}/permissions`)
        .select("id,link,roles")
        .top(50)
        .get() as { value: GraphPermission[] };

      for (const perm of permsPage.value ?? []) {
        if (perm.link?.scope === "anonymous") {
          hasAnonymousLink = true;
          break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[seeder] Could not check permissions for ${site.alias}: ${msg} — will attempt createLink.`
      );
    }

    if (hasAnonymousLink) {
      console.log(`[seeder] ${site.alias}: anonymous link already exists — skipping.`);
      continue;
    }

    // 4. Create the anonymous view link on the file.
    try {
      const link = await client
        .api(`${filePath}/createLink`)
        .post({ type: "view", scope: "anonymous" }) as GraphPermission;

      const webUrl = link.link?.webUrl ?? "(no webUrl in response)";
      console.log(
        `[seeder] ${site.alias}: anonymous link created — ${webUrl}`
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      const msg = err instanceof Error ? err.message : String(err);
      linkFailed = true;
      console.error(
        `[seeder] ERROR creating anonymous link for ${site.alias} ` +
          `(${siteWebUrl ?? site.alias}): [${statusCode ?? "?"}] ${msg}`
      );
    }
  }

  if (linkFailed) {
    console.error(
      `\n[seeder] NOTE: anonymous link seeding failed for one or more sites.\n` +
      `  The site's SharePoint sharing must be "Anyone" (ExternalUserAndGuestSharing),\n` +
      `  set in the SharePoint admin center — the app cannot set it itself.\n` +
      `  Until the links exist, the scan engine will find 0 overshared-site findings.\n`
    );
  }
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
 * Idempotent — skips users whose UPN already exists, but still ensures the
 * licence is assigned for existing users that lack it.
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
      `[seeder] Will assign SKU: ${sku.skuPartNumber} (guid: ${skuGuid(sku.id)}, ` +
        `consumed: ${sku.consumedUnits}, enabled: ${sku.prepaidUnits?.enabled ?? "?"})`
    );
  }

  // Fetch existing fixture member users (with their assigned licences).
  const existingUsers = await fetchExistingFixtureMembers(client, tenantDomain);
  const existingByUpn = new Map(
    existingUsers.map((u) => [(u.userPrincipalName ?? "").toLowerCase(), u])
  );

  for (const spec of FIXTURE_LICENCE_USERS) {
    const upn = `${spec.upnPrefix}@${tenantDomain}`;
    const existing = existingByUpn.get(upn.toLowerCase());

    if (existing) {
      // User exists: make sure the licence is assigned. The first seeder run
      // created the users but the assignment failed (it passed the composite
      // /subscribedSkus id instead of the bare SKU GUID), so existence alone
      // is not enough — check the assignment and repair it when missing.
      if (sku) {
        const hasLicence = (existing.assignedLicenses ?? []).some(
          (a) => a.skuId === skuGuid(sku.id)
        );
        if (hasLicence) {
          console.log(`[seeder] Licence user ${upn}: already exists with SKU ${sku.skuPartNumber} — skipping.`);
        } else if (dryRun) {
          console.log(`[seeder] [DRY RUN] Would assign SKU ${sku.skuPartNumber} to existing user ${upn}.`);
        } else {
          await assignLicenceToUser(client, existing.id, upn, sku);
        }
      } else {
        console.log(`[seeder] Licence user ${upn}: already exists — skipping (no assignable SKU).`);
      }
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
        await assignLicenceToUser(client, userId, upn, sku);
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

/**
 * Assigns a SKU to a user. The skuId passed to assignLicense must be the bare
 * SKU GUID; /subscribedSkus returns a composite id ("<tenantId>_<skuGuid>"),
 * and passing the composite id fails the assignment. The first seeder run
 * passed the composite id, so the four fixture users were created without
 * any licence; the existing-user check in seedLicenceUsers repairs that.
 */
async function assignLicenceToUser(
  client: ReturnType<typeof createGraphClient>,
  userId: string,
  upn: string,
  sku: GraphSku
): Promise<void> {
  const guid = skuGuid(sku.id);
  try {
    await client.api(`/users/${userId}/assignLicense`).post({
      addLicenses: [{ skuId: guid, disabledPlans: [] }],
      removeLicenses: [],
    });
    console.log(`[seeder] Assigned SKU ${sku.skuPartNumber} (${guid}) to ${upn}.`);
  } catch (licErr: unknown) {
    const msg = licErr instanceof Error ? licErr.message : String(licErr);
    console.error(`[seeder] ERROR assigning licence to ${upn}: ${msg}`);
    console.error(
      `  Assign the licence manually: Set-MgUserLicense -UserId ${userId} -AddLicenses @{SkuId="${guid}"} -RemoveLicenses @()`
    );
  }
}

/**
 * Extracts the SKU GUID from a /subscribedSkus id, which is composite
 * ("<tenantId>_<skuGuid>"). Returns the input unchanged when it has no "_".
 */
function skuGuid(subscribedSkuId: string): string {
  const parts = subscribedSkuId.split("_");
  return parts[parts.length - 1] ?? subscribedSkuId;
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
        .api(`/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName,assignedLicenses`)
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
