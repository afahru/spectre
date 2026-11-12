/**
 * store/types.ts
 *
 * Domain types for the findings store.
 *
 * Key invariants (from narration-rule and graph-conventions steering):
 *   - Every numeric field that may be unknown MUST use `null`, never 0 or -1.
 *   - `owner` is null when Graph did not return one — it is never guessed.
 *   - `numbers` holds the raw Graph-sourced values so the narration layer
 *     can quote them verbatim.
 */

/** The five ghost types Spectre detects. */
export type GhostType =
  | "overshared-site"
  | "orphaned-site"
  | "stale-guest"
  | "idle-licence"
  | "cold-storage";

/** Lifecycle status of a finding. */
export type FindingStatus = "open" | "actioned" | "dismissed";

/**
 * Raw numbers carried with a finding, sourced directly from Graph responses.
 * All fields are optional because they vary by ghost type.
 * `null` means "Graph did not provide this value" — it is never invented.
 */
export interface FindingNumbers {
  /** Number of users who can reach this resource via the detected link. */
  reachableUserCount?: number | null;
  /** Sharing link scope returned by Graph (anonymous | organization | users). */
  linkScope?: "anonymous" | "organization" | "users" | null;
  /**
   * Last sign-in timestamp for a stale guest (ISO 8601 string),
   * or null when the audit log has no sign-in record for this guest.
   */
  lastSignInAt?: string | null;
  /**
   * Monthly licence cost in USD from the tenant's SKU price table.
   * null means no price is on file — never guessed.
   */
  monthlyCostUsd?: number | null;
  /** Site storage in bytes, from Graph quota. */
  storageSizeBytes?: number | null;
  /** Monthly storage overage cost in USD. null when rate is not on file. */
  storageOverageCostUsd?: number | null;
  /**
   * Last modification date of the site (ISO 8601 string).
   * Used for cold-storage findings.
   */
  lastModifiedAt?: string | null;
  /** SKU part number, e.g. "ENTERPRISEPACK". */
  skuPartNumber?: string | null;
  /**
   * Whether the permissions call for this item succeeded (task 4).
   * false means the item was unreadable (e.g. 403); the run continued.
   * undefined means no permissions call has been attempted yet.
   * Never invented — set only from the actual Graph call result.
   */
  itemReadable?: boolean;
}

/**
 * One finding produced by the scan engine.
 * Maps 1-to-1 to a row in the findings store.
 */
export interface Finding {
  /** Stable UUID for this finding, generated at creation. */
  id: string;
  /** Category of oversharing risk detected. */
  type: GhostType;
  /**
   * Graph ID of the site, item, user, or SKU this finding refers to.
   * Never null — a finding without a subject is not persisted.
   */
  subjectId: string;
  /**
   * Human-readable label (site display name, user display name, SKU name).
   * May be null if Graph only returned the id.
   */
  subjectLabel: string | null;
  /**
   * UPN or object-id of the owner responsible for this resource.
   * null means Graph returned no owner — it is never guessed.
   */
  owner: string | null;
  /** Raw numbers from Graph, carried verbatim. */
  numbers: FindingNumbers;
  /** Severity weight used by the risk scorer (from the scorer config). */
  severityWeight: number;
  /** Current lifecycle status. */
  status: FindingStatus;
  /** ISO 8601 timestamp of the scan run that produced this finding. */
  scanTimestamp: string;
  /** ISO 8601 timestamp when this finding was last updated. */
  updatedAt: string;
}

/**
 * Minimal shape for creating a new finding.
 * `id`, `status`, `scanTimestamp`, and `updatedAt` are set by the store.
 */
export type NewFinding = Omit<Finding, "id" | "status" | "updatedAt">;
