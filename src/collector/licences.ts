/**
 * collector/licences.ts
 *
 * Licence inventory collector — task 2.3.
 *
 * Graph conventions enforced:
 *   - /subscribedSkus called once (small list, no paging needed).
 *   - /reports/getOffice365ActiveUserDetail fetched for activity data.
 *   - $select on /users limited to fields this feature needs.
 *   - 429 Retry-After honoured.
 *   - Never invent a price: if no price is in the SKU price table, record null.
 *
 * Requirements traced:
 *   - Req 4.1: read assigned licences via /subscribedSkus + per-user activity,
 *              flag licences with no activity in 90 days.
 *   - Req 4.2: attach monthly cost from SKU price table (never guessed).
 *   - Req 4.3: cost is null when no price is on file for a SKU.
 *
 * Strategy:
 *   1. GET /subscribedSkus — returns all SKUs with consumed/enabled counts.
 *   2. GET /reports/getOffice365ActiveUserDetail(period='D90') — CSV report
 *      with per-user last-activity date and assigned products.
 *      Parsed in-memory; no paging (Graph returns a single CSV blob).
 *   3. Cross-join: for each (user, assignedSku) pair that appears in the
 *      report, record the last-activity date.  Users absent from the report
 *      (no activity at all in 90 days) get lastActivityDateTime = null.
 *   4. Cost lookup from the price table passed in by the caller.
 *
 * The collector pages through users to get the full list of licence
 * assignments, then joins against the activity report.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { SkuRecord, UserLicenceRecord } from "./types.js";
import { retryAfterDelay } from "./retry.js";

/** Fields we need on the user object. */
const USERS_SELECT = "id,displayName,userPrincipalName,assignedLicenses";

/** Graph user shape for licence collection. */
interface GraphUserLicencePage {
  value: Array<{
    id: string;
    displayName?: string | null;
    userPrincipalName?: string | null;
    assignedLicenses?: Array<{ skuId: string }>;
  }>;
  "@odata.nextLink"?: string;
}

/** Graph subscribedSku shape. */
interface GraphSku {
  id: string;
  skuPartNumber: string;
  consumedUnits: number;
  prepaidUnits?: {
    enabled?: number;
  };
}

interface GraphSkuPage {
  value: GraphSku[];
}

/**
 * Optional SKU price table supplied by the caller.
 * Keys are SKU part numbers (e.g. "ENTERPRISEPACK").
 * Values are monthly cost in USD.
 * When a SKU is not in the table, cost is recorded as null (req 4.3).
 */
export type SkuPriceTable = Record<string, number>;

/**
 * Collects the full licence inventory: SKUs + per-user assignments + activity.
 *
 * @param client       Authenticated Graph client.
 * @param priceTable   Optional price table (SKU part number → monthly USD).
 * @param onPage       Callback per page of UserLicenceRecords + nextLink.
 * @param startUrl     Optional resume URL for the users list page.
 */
export async function collectLicences(
  client: Client,
  priceTable: SkuPriceTable,
  onPage: (records: UserLicenceRecord[], nextLink: string | null) => Promise<void>,
  startUrl?: string | null
): Promise<{ skus: SkuRecord[] }> {
  // Step 1: Fetch all SKUs (small list, single call).
  const skuPage = await retryAfterDelay(
    () => client.api("/subscribedSkus?$select=id,skuPartNumber,consumedUnits,prepaidUnits").get() as Promise<GraphSkuPage>
  );

  const skus: SkuRecord[] = (skuPage.value ?? []).map((s) => ({
    id: s.id,
    skuPartNumber: s.skuPartNumber,
    consumedUnits: s.consumedUnits ?? 0,
    enabledUnits: s.prepaidUnits?.enabled ?? 0,
  }));

  // Build a skuId → SkuRecord map for the join below.
  const skuById = new Map<string, SkuRecord>(skus.map((s) => [s.id, s]));

  // Step 2: Fetch the 90-day active-user detail report (CSV, single blob).
  // The report returns one row per user with columns including:
  //   User Principal Name, Last Activity Date, Assigned Products
  // We parse it into a map: UPN → lastActivityDate (ISO string or null).
  const activityByUpn = await fetchActivityReport(client);

  // Step 3: Page through users with their assigned licences.
  let url: string =
    startUrl ??
    `/users?$select=${USERS_SELECT}&$top=200`;

  while (true) {
    const page = await retryAfterDelay(
      () => client.api(url).get() as Promise<GraphUserLicencePage>
    );

    const records: UserLicenceRecord[] = [];

    for (const user of page.value ?? []) {
      for (const assignment of user.assignedLicenses ?? []) {
        const sku = skuById.get(assignment.skuId);
        // If Graph returned a skuId we do not have in /subscribedSkus, skip it.
        if (!sku) continue;

        // Activity lookup: match on UPN (the report uses UPN as the key).
        const lastActivity = user.userPrincipalName
          ? (activityByUpn.get(user.userPrincipalName.toLowerCase()) ?? null)
          : null;

        // Cost lookup from the price table — never guessed (req 4.3).
        const monthlyCostUsd = priceTable[sku.skuPartNumber] ?? null;

        records.push({
          userId: user.id,
          userDisplayName: user.displayName ?? null,
          userPrincipalName: user.userPrincipalName ?? null,
          skuId: assignment.skuId,
          skuPartNumber: sku.skuPartNumber,
          lastActivityDateTime: lastActivity,
          monthlyCostUsd,
        });
      }
    }

    const nextLink = page["@odata.nextLink"] ?? null;
    await onPage(records, nextLink);

    if (!nextLink) {
      break;
    }
    url = nextLink;
  }

  return { skus };
}

/**
 * Fetches the Office 365 active-user detail report for the last 90 days
 * and returns a map of lowercase UPN → last activity date (ISO 8601 string
 * or null for users with no recorded activity).
 *
 * Graph endpoint: GET /reports/getOffice365ActiveUserDetail(period='D90')
 * Response: CSV text (not JSON).
 */
async function fetchActivityReport(
  client: Client
): Promise<Map<string, string | null>> {
  const activityByUpn = new Map<string, string | null>();

  try {
    // The reports endpoint returns CSV text; we request it as text.
    const csv: string = await retryAfterDelay(
      () =>
        client
          .api("/reports/getOffice365ActiveUserDetail(period='D90')")
          .header("Accept", "text/csv")
          .get() as Promise<string>
    );

    // Parse CSV: first row is the header.
    const lines = csv.split(/\r?\n/);
    if (lines.length < 2) return activityByUpn;

    const header = parseCsvRow(lines[0]);
    const upnIdx = findColumn(header, "User Principal Name");
    const actIdx = findColumn(header, "Last Activity Date");

    if (upnIdx < 0 || actIdx < 0) {
      // Column names may vary by locale/version; log and return empty map.
      console.warn(
        "collectLicences: could not find expected columns in activity report. " +
          `Headers found: ${header.join(", ")}`
      );
      return activityByUpn;
    }

    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]);
      if (row.length <= Math.max(upnIdx, actIdx)) continue;

      const upn = row[upnIdx]?.trim().toLowerCase();
      const rawDate = row[actIdx]?.trim();

      if (!upn) continue;

      // rawDate is "YYYY-MM-DD" or empty.  Convert to ISO 8601 or null.
      const lastActivity =
        rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
          ? `${rawDate}T00:00:00.000Z`
          : null;

      activityByUpn.set(upn, lastActivity);
    }
  } catch (err: unknown) {
    // If the report endpoint is not accessible (e.g. insufficient permissions),
    // log the error and continue.  All users will have lastActivityDateTime = null,
    // which is the conservative assumption (candidate idle-licence findings).
    console.warn(
      `collectLicences: could not fetch activity report — ${
        err instanceof Error ? err.message : String(err)
      }. All users will be treated as having no activity record.`
    );
  }

  return activityByUpn;
}

/** Case-insensitive column index lookup. */
function findColumn(header: string[], name: string): number {
  const lower = name.toLowerCase();
  return header.findIndex((h) => h.trim().toLowerCase() === lower);
}

/**
 * Minimal RFC-4180 CSV row parser.
 * Handles quoted fields with embedded commas but not embedded newlines.
 */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        // Peek for escaped quote.
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}
