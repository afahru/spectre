/**
 * remediation/expire-guest.ts
 *
 * "revoke" handler (task 4.1): deletes the stale guest user via Graph.
 * Entra ID soft-deletes the user into deletedItems, restorable within
 * 30 days (design.md); that restore path is recorded on the audit entry.
 *
 * The guest id is the finding's subjectId and is never guessed. If Graph
 * rejects the delete, it reports failure and the dispatcher keeps the
 * finding open. A 404 counts as already fixed only when deletedItems
 * confirms the guest is gone; otherwise it stays a failure.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { ActionHandler } from "./types.js";

/** Reversibility mechanism recorded in the audit log. */
export const guestRestorePath = (guestId: string): string =>
  `Within 30 days: POST /directory/deletedItems/${guestId}/restore`;

export function createExpireGuestHandler(client: Client): ActionHandler {
  return async (finding) => {
    const guestId = finding.subjectId;
    const path = `/users/${encodeURIComponent(guestId)}`;
    const restorePath = guestRestorePath(guestId);

    try {
      await client.api(path).delete();
      return { result: "success", target: path, restorePath };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if ((err as { statusCode?: number })?.statusCode === 404) {
        try {
          await client
            .api(`/directory/deletedItems/${encodeURIComponent(guestId)}`)
            .get();
          return { result: "success", target: path, restorePath };
        } catch {
          // Not confirmed gone: fall through to failure.
        }
      }
      return { result: "failure", target: path, error };
    }
  };
}
