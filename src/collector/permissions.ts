/**
 * collector/permissions.ts
 *
 * Permissions fetcher — task 4.
 *
 * Fetches drive-root permissions for every site flagged as an overshared-site
 * finding, then patches the finding's `numbers.linkScope` with the value
 * returned by Graph.
 *
 * Key design constraints (from design.md, requirements.md, steering):
 *   - Permissions are fetched ONLY for items that the flagger already marked
 *     as candidates — never inside a list loop (Req 2.3, graph-conventions).
 *   - Results are cached by (itemId, scanTimestamp) in SQLite so a re-run
 *     does not re-fetch items that were already resolved (task 4.2).
 *   - 429 responses are retried with the Retry-After header; the same item
 *     is retried, never skipped silently (task 4.3, graph-conventions).
 *   - When a permissions call is unreadable (non-429 error), the finding is
 *     updated with linkScope = null and an `itemReadable: false` marker; the
 *     run continues (task 4.3, design.md → Errors).
 *   - No value is invented: linkScope is set only from the `link.scope` field
 *     returned by Graph, or left null when Graph does not return one.
 *
 * Graph endpoint used:
 *   GET /sites/{siteId}/drive/root/permissions
 *
 * This returns the permissions on the root drive item of the site.  For the
 * purposes of overshared-site detection the root is the canonical "item"
 * because sharing settings at that level propagate to all children by
 * inheritance.
 *
 * The `link` facet on a permission object has a `scope` field:
 *   "anonymous"    — anyone with the link
 *   "organization" — everyone in the tenant
 *   "users"        — specific users / groups
 *
 * Requirements traced:
 *   - Req 2.1: fetch permissions via …/permissions, record link facet scope.
 *   - Req 2.3: never fetch permissions in a list loop without a cache.
 */

import Database from "better-sqlite3";
import type { Client } from "@microsoft/microsoft-graph-client";
import type { FindingStore } from "../store/FindingStore.js";
import type { Finding } from "../store/types.js";
import { retryAfterDelay } from "./retry.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Link scope values returned by the Graph `link` facet. */
export type LinkScope = "anonymous" | "organization" | "users";

/** One permission object as returned by Graph. */
interface GraphPermission {
  id?: string;
  link?: {
    scope?: string;
    type?: string;
    webUrl?: string;
  } | null;
  inheritedFrom?: {
    driveId?: string;
    id?: string;
    path?: string;
  } | null;
  roles?: string[];
}

interface GraphPermissionsPage {
  value: GraphPermission[];
  "@odata.nextLink"?: string;
}

/** What we write into `numbers` for a permissions result. */
export interface PermissionNumbers {
  /** Link scope from Graph, or null if none was found. */
  linkScope: LinkScope | null;
  /**
   * Whether the permissions call succeeded.
   * false means the call failed (e.g. 403); true means it ran.
   * Absent (undefined) means no permissions call was attempted yet.
   */
  itemReadable?: boolean;
}

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * SQLite-backed item permissions cache (task 4.2).
 *
 * Keyed by (itemId, scanTimestamp) so each scan run has its own cache but
 * re-runs within the same scan timestamp skip already-resolved items.
 *
 * The same DB file as the findings store is used (passed in via `dbPath`)
 * so the demo stays single-file.
 */
export class PermissionsCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS permissions_cache (
        item_id         TEXT NOT NULL,
        scan_timestamp  TEXT NOT NULL,
        link_scope      TEXT,          -- null means none found or unreadable
        item_readable   INTEGER NOT NULL DEFAULT 1,  -- 0 = unreadable
        fetched_at      TEXT NOT NULL,
        PRIMARY KEY (item_id, scan_timestamp)
      );
    `);
  }

  /** Returns a cached entry or null if not yet fetched. */
  get(
    itemId: string,
    scanTimestamp: string
  ): { linkScope: LinkScope | null; itemReadable: boolean } | null {
    const row = this.db
      .prepare(
        `SELECT link_scope, item_readable
         FROM permissions_cache
         WHERE item_id = ? AND scan_timestamp = ?`
      )
      .get(itemId, scanTimestamp) as
      | { link_scope: string | null; item_readable: number }
      | undefined;

    if (!row) return null;

    return {
      linkScope: (row.link_scope as LinkScope | null) ?? null,
      itemReadable: row.item_readable === 1,
    };
  }

  /** Stores a resolved or unreadable permissions result in the cache. */
  set(
    itemId: string,
    scanTimestamp: string,
    linkScope: LinkScope | null,
    itemReadable: boolean
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO permissions_cache (item_id, scan_timestamp, link_scope, item_readable, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (item_id, scan_timestamp)
         DO UPDATE SET link_scope    = excluded.link_scope,
                       item_readable = excluded.item_readable,
                       fetched_at    = excluded.fetched_at`
      )
      .run(itemId, scanTimestamp, linkScope, itemReadable ? 1 : 0, now);
  }

  close(): void {
    this.db.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the strongest (most permissive) link scope from a permissions page.
 *
 * Priority: anonymous > organization > users > null.
 * Returns null when no permission has a `link` facet.
 */
function extractLinkScope(perms: GraphPermission[]): LinkScope | null {
  // Rank: higher index = more permissive.
  const RANK: Record<string, number> = { users: 1, organization: 2, anonymous: 3 };

  let best: LinkScope | null = null;
  let bestRank = 0;

  for (const perm of perms) {
    const scope = perm.link?.scope;
    if (!scope) continue;

    const rank = RANK[scope] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = scope as LinkScope;
    }
  }

  return best;
}

/**
 * Fetches all permissions pages for a single drive-root item,
 * honouring Retry-After on 429 (task 4.3).
 *
 * Returns the aggregated list of permissions, or throws for non-429 errors.
 */
async function fetchAllPermissionsPages(
  client: Client,
  siteId: string
): Promise<GraphPermission[]> {
  const allPerms: GraphPermission[] = [];

  // Start from the site's drive root permissions.
  let url: string | null =
    `/sites/${encodeURIComponent(siteId)}/drive/root/permissions?$select=id,link,inheritedFrom,roles&$top=200`;

  while (url !== null) {
    const page = await retryAfterDelay(() =>
      client.api(url as string).get() as Promise<GraphPermissionsPage>
    );

    allPerms.push(...(page.value ?? []));
    url = page["@odata.nextLink"] ?? null;
  }

  return allPerms;
}

// ── Main export ──────────────────────────────────────────────────────────────

export interface FetchPermissionsInput {
  /** Authenticated Graph client (app-only). */
  client: Client;
  /** Findings to process — only overshared-site findings are acted on. */
  findings: Finding[];
  /** Findings store, used to patch numbers.linkScope after each fetch. */
  store: FindingStore;
  /** SQLite DB path, used to open the permissions cache. */
  dbPath: string;
  /** Scan run timestamp, used as the cache key dimension. */
  scanTimestamp: string;
}

export interface FetchPermissionsResult {
  /** Number of items for which permissions were fetched from Graph. */
  fetched: number;
  /** Number of items served from cache (already resolved in this run). */
  cached: number;
  /**
   * Number of items recorded as unreadable (non-429 error).
   * These do NOT fail the run — they are recorded with itemReadable: false.
   */
  unreadable: number;
}

/**
 * Fetches permissions for all overshared-site findings and patches their
 * `numbers.linkScope` with the value returned by Graph.
 *
 * This is the entry point for task 4.  Call it after `runFlagging` has
 * persisted findings to the store.
 *
 * Graph convention: permissions are fetched only for items that were
 * flagged — never inside a list loop without a cache (Req 2.3).
 */
export async function fetchPermissions(
  input: FetchPermissionsInput
): Promise<FetchPermissionsResult> {
  const { client, findings, store, dbPath, scanTimestamp } = input;

  const cache = new PermissionsCache(dbPath);
  let fetched = 0;
  let cached = 0;
  let unreadable = 0;

  try {
    // Only overshared-site findings need a permissions call.
    const oversharedFindings = findings.filter((f) => f.type === "overshared-site");

    console.log(
      `[permissions] ${oversharedFindings.length} overshared-site finding(s) to process.`
    );

    for (const finding of oversharedFindings) {
      const siteId = finding.subjectId;
      const cacheKey = siteId; // scan_timestamp is the second cache dimension

      // ── Cache hit ─────────────────────────────────────────────────────────
      const hit = cache.get(cacheKey, scanTimestamp);
      if (hit !== null) {
        console.log(
          `[permissions] cache hit for site ${siteId} (scope=${hit.linkScope ?? "none"}).`
        );
        cached++;

        // Patch the finding if the numbers differ (idempotent update).
        const currentScope = finding.numbers.linkScope ?? null;
        const currentReadable = finding.numbers.itemReadable ?? true;
        if (currentScope !== hit.linkScope || currentReadable !== hit.itemReadable) {
          await store.updateNumbers(finding.id, {
            ...finding.numbers,
            linkScope: hit.linkScope,
            itemReadable: hit.itemReadable,
          });
        }
        continue;
      }

      // ── Graph fetch ───────────────────────────────────────────────────────
      let linkScope: LinkScope | null = null;
      let itemReadable = true;

      try {
        const perms = await fetchAllPermissionsPages(client, siteId);
        linkScope = extractLinkScope(perms);

        console.log(
          `[permissions] site ${siteId}: fetched ${perms.length} permission(s), ` +
            `scope=${linkScope ?? "none"}.`
        );
        fetched++;
      } catch (err: unknown) {
        // Non-429 errors (e.g. 403, 404): record as unreadable, continue.
        // The run is never aborted for a single unreadable item (task 4.3).
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[permissions] site ${siteId}: unreadable — ${msg}. ` +
            `Recording permission-missing and continuing.`
        );
        itemReadable = false;
        unreadable++;
      }

      // Write to cache (task 4.2).
      cache.set(cacheKey, scanTimestamp, linkScope, itemReadable);

      // Patch the finding's numbers in the store (task 4.1).
      await store.updateNumbers(finding.id, {
        ...finding.numbers,
        linkScope,
        itemReadable,
      });
    }

    console.log(
      `[permissions] done — fetched: ${fetched}, cached: ${cached}, unreadable: ${unreadable}.`
    );
  } finally {
    cache.close();
  }

  return { fetched, cached, unreadable };
}
