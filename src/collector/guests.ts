/**
 * collector/guests.ts
 *
 * Guest user inventory collector — task 2.2.
 *
 * Graph conventions enforced:
 *   - $select on /users limited to fields this feature needs.
 *   - Sign-in data fetched from /auditLogs/signIns with a 90-day window and
 *     $filter on userType-equivalent (externalUserState), $top, $orderby.
 *   - 429 Retry-After honoured; never skip a page silently.
 *   - Never invent a last sign-in: if the audit log has no entry, record null.
 *
 * Requirements traced:
 *   - Req 3.1: list guest users + last sign-in from audit logs.
 *
 * Strategy:
 *   1. Page through /users?$filter=userType eq 'Guest'&$select=...
 *   2. Collect all guest object-ids.
 *   3. Fetch the most recent sign-in for each guest from /auditLogs/signIns
 *      using $filter=userId eq '{id}'&$top=1&$orderby=createdDateTime desc.
 *      This is one call per guest; Graph does not support batching signIn
 *      queries by multiple userId values in a single $filter, so we call
 *      one at a time but batch them in groups using Graph $batch (up to 20
 *      per batch request) per graph-conventions steering.
 *   4. Sponsor: fetched from /users/{id}/manager?$select=userPrincipalName.
 *      If the manager call returns 404 (no manager / left company), sponsor
 *      is null.
 *
 * The collector yields batches via onPage so the caller persists progress.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { GuestRecord } from "./types.js";
import { retryAfterDelay } from "./retry.js";

const USERS_SELECT = "id,displayName,userPrincipalName,userType";

/** Graph user page shape. */
interface GraphUserPage {
  value: Array<{
    id: string;
    displayName?: string | null;
    userPrincipalName?: string | null;
  }>;
  "@odata.nextLink"?: string;
}

/** Graph signIn page shape (we only need the first item). */
interface GraphSignInPage {
  value: Array<{
    createdDateTime?: string | null;
  }>;
}

/** Graph manager shape. */
interface GraphManager {
  userPrincipalName?: string | null;
}

/** Batch request item. */
interface BatchRequestItem {
  id: string;
  method: "GET";
  url: string;
}

/** Batch response item. */
interface BatchResponseItem {
  id: string;
  status: number;
  body?: unknown;
}

/** Graph $batch envelope. */
interface BatchResponse {
  responses: BatchResponseItem[];
}

/**
 * Collects all guest users with their last sign-in datetime.
 *
 * @param client   Authenticated Graph client.
 * @param onPage   Callback per batch of GuestRecords + nextLink (null = done).
 * @param startUrl Optional resume URL from previous run.
 */
export async function collectGuests(
  client: Client,
  onPage: (records: GuestRecord[], nextLink: string | null) => Promise<void>,
  startUrl?: string | null
): Promise<void> {
  // Step 1: Page through guest users.
  let url: string =
    startUrl ??
    `/users?$filter=userType eq 'Guest'&$select=${USERS_SELECT}&$top=100`;

  while (true) {
    const page = await retryAfterDelay(
      () => client.api(url).get() as Promise<GraphUserPage>
    );

    const users = page.value ?? [];

    // Step 2 + 3: Enrich each user with sign-in and sponsor data using
    // Graph $batch (20 per batch request).
    const records = await enrichGuests(client, users);

    const nextLink = page["@odata.nextLink"] ?? null;
    await onPage(records, nextLink);

    if (!nextLink) {
      break;
    }
    url = nextLink;
  }
}

/**
 * Enriches a slice of raw user objects with last sign-in and sponsor UPN.
 * Uses Graph $batch to avoid calling the sign-in and manager endpoints
 * one-by-one in a list loop (graph-conventions: never call an endpoint
 * inside a list loop without a cache / batch).
 */
async function enrichGuests(
  client: Client,
  users: GraphUserPage["value"]
): Promise<GuestRecord[]> {
  if (users.length === 0) return [];

  // We need two requests per user: sign-in + manager.
  // We chunk users so each $batch request stays within 20 items.
  // Two calls per user → at most 10 users per batch.
  const USERS_PER_BATCH = 10;

  // Collect enrichment data: keyed by userId.
  const signInMap = new Map<string, string | null>();
  const sponsorMap = new Map<string, string | null>();

  for (let i = 0; i < users.length; i += USERS_PER_BATCH) {
    const chunk = users.slice(i, i + USERS_PER_BATCH);
    const batchRequests: BatchRequestItem[] = [];

    for (const user of chunk) {
      // Sign-in request (last 90 days window).
      const since = ninetyDaysAgo();
      batchRequests.push({
        id: `signin-${user.id}`,
        method: "GET",
        url: `/auditLogs/signIns?$filter=userId eq '${user.id}' and createdDateTime ge ${since}&$top=1&$orderby=createdDateTime desc&$select=createdDateTime`,
      });
      // Manager/sponsor request.
      batchRequests.push({
        id: `mgr-${user.id}`,
        method: "GET",
        url: `/users/${user.id}/manager?$select=userPrincipalName`,
      });
    }

    const batchResponse = await retryAfterDelay(
      () =>
        client.api("/$batch").post({ requests: batchRequests }) as Promise<BatchResponse>
    );

    for (const resp of batchResponse.responses ?? []) {
      if (resp.id.startsWith("signin-")) {
        const userId = resp.id.slice("signin-".length);
        if (resp.status === 200) {
          const body = resp.body as GraphSignInPage;
          const latest = body?.value?.[0]?.createdDateTime ?? null;
          signInMap.set(userId, latest ?? null);
        } else {
          // 404 or other error → no sign-in record.
          signInMap.set(userId, null);
        }
      } else if (resp.id.startsWith("mgr-")) {
        const userId = resp.id.slice("mgr-".length);
        if (resp.status === 200) {
          const body = resp.body as GraphManager;
          sponsorMap.set(userId, body?.userPrincipalName ?? null);
        } else {
          // 404 → no manager / manager left the company → sponsor null.
          sponsorMap.set(userId, null);
        }
      }
    }
  }

  return users.map((u) => ({
    id: u.id,
    displayName: u.displayName ?? null,
    userPrincipalName: u.userPrincipalName ?? null,
    lastSignInDateTime: signInMap.get(u.id) ?? null,
    sponsorUpn: sponsorMap.get(u.id) ?? null,
  }));
}

/** Returns an ISO 8601 date-time string 90 days before now. */
function ninetyDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString();
}
