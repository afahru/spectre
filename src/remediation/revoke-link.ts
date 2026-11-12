/**
 * remediation/revoke-link.ts
 *
 * "restrict" handler (tasks 2.1, 2.2): deletes the anonymous sharing link
 * using the ids recorded on the finding during the scan
 * (numbers.anonymousLink). Needs Sites.ReadWrite.All (already granted).
 *
 * Never invents an id. If the scan did not record them, or Graph rejects
 * the call, it reports failure; the dispatcher then keeps the finding open
 * and audits the error. Only a successful DELETE reports success.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { ActionHandler } from "./types.js";

export function createRevokeLinkHandler(client: Client): ActionHandler {
  return async (finding) => {
    const link = finding.numbers.anonymousLink;
    if (!link?.driveId || !link.itemId || !link.permissionId) {
      return {
        result: "failure",
        target: finding.subjectId,
        error:
          "No permission id was recorded for this link during the scan; nothing was revoked.",
      };
    }

    const path =
      `/drives/${encodeURIComponent(link.driveId)}` +
      `/items/${encodeURIComponent(link.itemId)}` +
      `/permissions/${encodeURIComponent(link.permissionId)}`;

    try {
      await client.api(path).delete();
    } catch (err) {
      return {
        result: "failure",
        target: path,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // The link is gone and must be recreated by the owner.
    return { result: "success", target: path, restorePath: null };
  };
}
