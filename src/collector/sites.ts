/**
 * collector/sites.ts
 *
 * Sites inventory collector — task 2.1.
 *
 * Graph conventions enforced (from graph-conventions steering):
 *   - $select limited to only the fields this feature needs.
 *   - Every list call is paged; no call fetches unbounded results.
 *   - 429 Retry-After is honoured; the same page is retried, never skipped.
 *   - Application permissions only; the Graph client is passed in.
 *   - Never invent an owner: if Graph returns no owner, owner is null.
 *     owner === null is not enough to call a site orphaned; see ownerStatus.
 *
 * Requirements traced:
 *   - Req 1.1: list all SharePoint sites with $select = id,displayName,
 *              webUrl,createdDateTime,lastModifiedDateTime
 *   - Req 1.2: owner: null plus ownerStatus; only a group-connected site whose
 *              group has zero owners is 'orphaned'
 *   - Req 1.3: persist with scan timestamp (handled by the caller via
 *              CollectorProgressStore + the findings store)
 *
 * The collector yields one SiteRecord per page-item so the caller can
 * persist incrementally. It accepts an optional `startUrl` to resume a
 * previously interrupted run.
 *
 * sharingCapability:
 *   Microsoft Graph (v1.0 and beta) does not expose sharingCapability on the
 *   site resource — neither in the getAllSites list call nor in a per-site
 *   GET /sites/{id}.  Attempting to include it in $select causes Graph to
 *   return "Could not find a property named sharingCapability on type
 *   microsoft.graph.site."  All SiteRecords therefore carry
 *   sharingCapability: null, which the flagger treats as "data unavailable"
 *   and skips (narration-rule: unknown stays unknown).
 *
 * Owner enrichment (enrichSiteOwners):
 *   The /sites/getAllSites list endpoint does not return an owner field.
 *   For group-connected SharePoint team sites the owner is derived from the
 *   M365 group that backs the site:
 *     1. GET /sites/{id}/drive?$select=owner
 *        → drive.owner.group.id  (the backing M365 group for the site)
 *     2. GET /groups/{groupId}/owners?$select=id,userPrincipalName&$top=1
 *        → first owner UPN (the person who is an owner of the group)
 *   Sites without a drive (communication sites, the root site, etc.) return
 *   404 on step 1 — ownerStatus 'not-applicable'.
 *   A drive with no backing group is also 'not-applicable'.
 *   Groups with no owners are 'orphaned'. Fetch errors are 'unknown'.
 *   Both steps use retryAfterDelay (graph-conventions: honour Retry-After).
 *   Calls are made concurrently in a capped batch (OWNER_BATCH_SIZE) to
 *   avoid flooding Graph.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { SiteRecord } from "./types.js";
import { retryAfterDelay } from "./retry.js";

/**
 * Fields requested on the getAllSites list call.
 * sharingCapability is excluded: Graph does not expose it on the site resource
 * and returns a parse error when it is included in $select.
 */
const SITES_SELECT =
  "id,displayName,webUrl,createdDateTime,lastModifiedDateTime";

/**
 * Graph site page shape — only the fields we select.
 * Graph may return additional fields; we ignore them.
 */
interface GraphSitePage {
  value: Array<{
    id: string;
    displayName?: string | null;
    webUrl?: string | null;
    createdDateTime?: string | null;
    lastModifiedDateTime?: string | null;
  }>;
  "@odata.nextLink"?: string;
}

/**
 * Collects all SharePoint sites from the tenant.
 *
 * sharingCapability will be null on every returned record because Graph
 * does not expose that property.  See module-level comment.
 *
 * @param client  Authenticated Graph client (app-only).
 * @param onPage  Callback invoked with each batch of records + the next-link
 *                (or null on the last page). Use this to persist progress.
 * @param startUrl  Optional resume URL from a previous run.
 */
export async function collectSites(
  client: Client,
  onPage: (records: SiteRecord[], nextLink: string | null) => Promise<void>,
  startUrl?: string | null
): Promise<void> {
  // Build the initial URL.  If resuming, use the persisted next-link directly;
  // otherwise start from the root with $select discipline.
  let url: string =
    startUrl ?? `/sites/getAllSites?$select=${SITES_SELECT}&$top=200`;

  while (true) {
    const page = await retryAfterDelay(
      () => client.api(url).get() as Promise<GraphSitePage>
    );

    const records: SiteRecord[] = (page.value ?? []).map((s) => ({
      id: s.id,
      displayName: s.displayName ?? null,
      webUrl: s.webUrl ?? null,
      createdDateTime: s.createdDateTime ?? null,
      lastModifiedDateTime: s.lastModifiedDateTime ?? null,
      // Owner is not part of the site list response; it comes from the
      // enrichment step. We record null here so we never invent an owner
      // (req 1.2), and 'unknown' until enrichment has run.
      owner: null,
      ownerStatus: "unknown",
      // sharingCapability: Graph does not expose this property on the site
      // resource.  Set to null; flagger treats null as "data unavailable"
      // and does not produce a false-positive overshared-site candidate.
      sharingCapability: null,
      // storageUsedBytes not available from /sites list; set null until
      // the per-site drive call enriches it in task 3.4.
      storageUsedBytes: null,
    }));

    const nextLink = page["@odata.nextLink"] ?? null;
    await onPage(records, nextLink);

    if (!nextLink) {
      break;
    }
    url = nextLink;
  }
}

// ── Owner enrichment ──────────────────────────────────────────────────────────

/**
 * Maximum number of concurrent owner-enrichment calls.
 * Graph allows per-app rate limits; keeping this modest avoids early 429s.
 */
const OWNER_BATCH_SIZE = 10;

/**
 * Shape of the drive resource returned by GET /sites/{id}/drive?$select=owner.
 * For group-connected sites, owner.group.id is the backing M365 group.
 * For sites without a group (communication sites, root site), owner is absent.
 */
interface GraphDriveOwner {
  id?: string;
  owner?: {
    group?: { id?: string } | null;
    user?: { id?: string; userPrincipalName?: string } | null;
  } | null;
}

/**
 * Shape of the group owners list response.
 * GET /groups/{id}/owners?$select=id,userPrincipalName&$top=1
 */
interface GraphGroupOwnersPage {
  value: Array<{
    id?: string;
    userPrincipalName?: string | null;
  }>;
}

/** Result of the owner lookup for one site. */
interface SiteOwnerResult {
  owner: string | null;
  ownerStatus: SiteRecord["ownerStatus"];
}

/**
 * Fetches the owner for a single site using the two-step Graph lookup:
 *   1. GET /sites/{siteId}/drive?$select=owner  → backing group id
 *   2. GET /groups/{groupId}/owners?$select=id,userPrincipalName&$top=1 → owner UPN
 *
 * Returns:
 *   - 'not-applicable' when the site has no drive (404) or the drive has no
 *     backing group (not group-connected).
 *   - 'orphaned' when the group exists but has no owners.
 *   - 'unknown' when a fetch fails.
 *   - 'owned' with the owner UPN otherwise.
 *
 * Uses retryAfterDelay on both calls (graph-conventions: honour Retry-After).
 * Never invents an owner (narration-rule steering).
 */
async function fetchSiteOwnerUpn(
  client: Client,
  siteId: string
): Promise<SiteOwnerResult> {
  // Step 1: get the site's drive to find the backing group id.
  let groupId: string | null = null;
  try {
    const drive = await retryAfterDelay(() =>
      client
        .api(`/sites/${encodeURIComponent(siteId)}/drive`)
        .select("id,owner")
        .get() as Promise<GraphDriveOwner>
    );
    groupId = drive.owner?.group?.id ?? null;
  } catch (err: unknown) {
    const statusCode =
      (err as { statusCode?: number }).statusCode ??
      (err as { code?: number }).code;
    if (statusCode === 404) {
      // No drive (communication site / root site): no owner applies.
      return { owner: null, ownerStatus: "not-applicable" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[sites] Could not fetch drive for site ${siteId}: ${msg} — owner status unknown.`
    );
    return { owner: null, ownerStatus: "unknown" };
  }

  if (!groupId) {
    // Drive exists but has no backing group (e.g. personal drive).
    return { owner: null, ownerStatus: "not-applicable" };
  }

  // Step 2: get the first owner of the backing M365 group.
  try {
    const ownersPage = await retryAfterDelay(() =>
      client
        .api(`/groups/${groupId}/owners`)
        .select("id,userPrincipalName")
        .top(1)
        .get() as Promise<GraphGroupOwnersPage>
    );
    const firstOwner = ownersPage.value?.[0];
    if (!firstOwner) {
      // Group-connected and the group has zero owners: genuinely orphaned.
      return { owner: null, ownerStatus: "orphaned" };
    }
    const upn = firstOwner.userPrincipalName ?? null;
    if (upn === null) {
      // An owner exists but Graph gave no UPN. We cannot name it; do not
      // call the site orphaned and do not invent a value.
      return { owner: null, ownerStatus: "unknown" };
    }
    return { owner: upn, ownerStatus: "owned" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[sites] Could not fetch owners for group ${groupId} (site ${siteId}): ${msg} — owner status unknown.`
    );
    return { owner: null, ownerStatus: "unknown" };
  }
}

/**
 * Enriches a list of SiteRecords with owner UPNs fetched from Graph.
 *
 * For each site with ownerStatus === 'unknown', fetches the owner via the two-step
 * drive → group-owners lookup and mutates the record in place.
 *
 * Graph calls are batched OWNER_BATCH_SIZE at a time (concurrent within a
 * batch, sequential across batches) to stay within rate limits.
 *
 * Sets both owner and ownerStatus on each record. Only sites resolved to
 * 'orphaned' become orphaned-site candidates; lookup failures stay 'unknown'.
 *
 * @param client  Authenticated Graph client (app-only).
 * @param sites   Site records to enrich in place.
 */
export async function enrichSiteOwners(
  client: Client,
  sites: SiteRecord[]
): Promise<void> {
  // Only enrich sites whose owner status is not yet resolved.
  const toEnrich = sites.filter((s) => s.ownerStatus === "unknown");

  if (toEnrich.length === 0) {
    console.log("[sites] enrichSiteOwners: no sites to enrich.");
    return;
  }

  console.log(
    `[sites] enrichSiteOwners: enriching ${toEnrich.length} site(s) in batches of ${OWNER_BATCH_SIZE}.`
  );

  let enriched = 0;
  let stillNull = 0;

  // Process in batches to avoid flooding Graph.
  for (let i = 0; i < toEnrich.length; i += OWNER_BATCH_SIZE) {
    const batch = toEnrich.slice(i, i + OWNER_BATCH_SIZE);

    const results = await Promise.all(
      batch.map((site) => fetchSiteOwnerUpn(client, site.id))
    );

    for (let j = 0; j < batch.length; j++) {
      const { owner, ownerStatus } = results[j];
      batch[j].owner = owner;
      batch[j].ownerStatus = ownerStatus;
      if (ownerStatus === "owned") enriched++;
      else stillNull++;
    }
  }

  console.log(
    `[sites] enrichSiteOwners: complete — ` +
      `${enriched} site(s) now have an owner, ` +
      `${stillNull} site(s) have no owner (orphaned, not-applicable, or unknown).`
  );
}
