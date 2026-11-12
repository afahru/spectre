/**
 * collector/types.ts
 *
 * Domain types for raw inventory records produced by the collectors.
 * These types carry exactly what Graph returned — no invented values.
 *
 * Invariants (from narration-rule and graph-conventions steering):
 *   - null means Graph did not return a value. It is never guessed.
 *   - Numeric fields that may be absent are `number | null`.
 *   - Owner/UPN fields that may be absent are `string | null`.
 */

/** A SharePoint site record from GET /sites. */
export interface SiteRecord {
  /** Graph site id. */
  id: string;
  /** Display name returned by Graph, or null if absent. */
  displayName: string | null;
  /** Absolute URL of the site. */
  webUrl: string | null;
  /** ISO 8601 creation timestamp, or null if absent. */
  createdDateTime: string | null;
  /**
   * ISO 8601 last modification timestamp, or null if absent.
   * Used for cold-storage detection (task 3).
   */
  lastModifiedDateTime: string | null;
  /**
   * UPN or object-id of the site owner returned by Graph.
   * null means Graph returned no owner — the site is a candidate orphan.
   */
  owner: string | null;
  /**
   * SharePoint sharing capability at the site level, as returned by Graph.
   * Possible values from Graph: "disabled", "existingExternalUserSharingOnly",
   * "externalUserSharingOnly", "externalUserAndGuestSharing" (anonymous links).
   * null means Graph did not return this field.
   * Used for overshared-site candidate detection (task 3.1) without calling
   * the permissions endpoint.
   */
  sharingCapability: string | null;
  /**
   * Storage used in bytes from the site's drive quota, or null if absent.
   * Used for cold-storage findings (task 3.4).
   */
  storageUsedBytes: number | null;
}

/** A guest user record from GET /users filtered by userType. */
export interface GuestRecord {
  /** Graph user object-id. */
  id: string;
  /** Display name, or null if absent. */
  displayName: string | null;
  /** User Principal Name, or null if absent. */
  userPrincipalName: string | null;
  /** ISO 8601 of the most recent sign-in from audit logs. null = never signed in (no log entry). */
  lastSignInDateTime: string | null;
  /**
   * UPN of the guest's sponsor/manager returned by Graph.
   * null means Graph returned no sponsor (sponsor may have left the company).
   */
  sponsorUpn: string | null;
}

/** One assigned SKU from GET /subscribedSkus. */
export interface SkuRecord {
  /** Graph SKU id. */
  id: string;
  /** SKU display name. */
  skuPartNumber: string;
  /** Number of consumed (assigned) units. */
  consumedUnits: number;
  /** Number of enabled (purchased) units. */
  enabledUnits: number;
}

/**
 * Per-user licence assignment with activity information.
 * One row per (userId, skuId) pair.
 */
export interface UserLicenceRecord {
  /** Graph user object-id. */
  userId: string;
  /** Display name, or null if absent. */
  userDisplayName: string | null;
  /** UPN, or null if absent. */
  userPrincipalName: string | null;
  /** SKU id this assignment belongs to. */
  skuId: string;
  /** SKU part number, e.g. "ENTERPRISEPACK". */
  skuPartNumber: string;
  /**
   * ISO 8601 of the last Graph activity signal for this user.
   * null means no activity record — user is a candidate idle-licence finding.
   */
  lastActivityDateTime: string | null;
  /**
   * Monthly cost in USD from the tenant's SKU price table.
   * null means no price on file — never guessed (requirement 4.3).
   */
  monthlyCostUsd: number | null;
}

/**
 * State persisted by the progress store so a scan is resumable.
 * One row per collection name + scan run.
 */
export interface CollectorProgress {
  /** Logical name of the collection, e.g. "sites", "guests", "licences". */
  collection: string;
  /** Scan run timestamp that owns this progress entry. */
  scanTimestamp: string;
  /**
   * The `@odata.nextLink` URL to resume from.
   * null means the collection is complete.
   */
  nextLink: string | null;
  /** Whether this collection has fully completed for this scan run. */
  completed: boolean;
}
