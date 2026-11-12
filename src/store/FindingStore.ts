/**
 * store/FindingStore.ts
 *
 * The swappable store interface.  All code that reads or writes findings
 * depends only on this interface, not on a concrete implementation.
 * Swapping from SQLite to a cloud database in production requires only a
 * new class that implements this interface.
 */

import type { Finding, FindingStatus, NewFinding } from "./types.js";

export interface FindingStore {
  /**
   * Persist a new finding.  The store assigns the `id`, sets `status` to
   * "open", and stamps `updatedAt`.
   */
  insert(finding: NewFinding): Promise<Finding>;

  /**
   * Update the status of a finding by id.
   * Returns the updated finding, or null if the id is not found.
   */
  updateStatus(
    id: string,
    status: FindingStatus
  ): Promise<Finding | null>;

  /**
   * Return all findings for a given scan run, identified by its timestamp.
   */
  listByScan(scanTimestamp: string): Promise<Finding[]>;

  /**
   * Return all open findings, optionally filtered by ghost type.
   */
  listOpen(type?: string): Promise<Finding[]>;

  /**
   * Return a single finding by id, or null if not found.
   */
  getById(id: string): Promise<Finding | null>;

  /**
   * Return the most recent completed scan timestamp, or null if no scan has
   * been recorded yet.
   */
  latestScanTimestamp(): Promise<string | null>;

  /**
   * Close the underlying store connection.  Called on graceful shutdown.
   */
  close(): Promise<void>;
}
