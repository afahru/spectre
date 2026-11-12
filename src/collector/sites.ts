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
 *
 * Requirements traced:
 *   - Req 1.1: list all SharePoint sites with $select = id,displayName,
 *              webUrl,createdDateTime,lastModifiedDateTime
 *   - Req 1.2: sites with no owner → owner: null (orphan candidate)
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
      // Owner is not part of the site list response; it comes from a separate
      // /sites/{id}?$expand=owner call deferred to the flagging step.
      // We record null here so we never invent an owner (req 1.2).
      owner: null,
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
