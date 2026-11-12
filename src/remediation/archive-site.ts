/**
 * remediation/archive-site.ts
 *
 * "archive" handler (tasks 3.1, 3.2). No app-only endpoint archives a
 * SharePoint site (design.md), so the archive runs only through an injected
 * delegated admin session.
 *
 * Without a session the handler reports "queued" with the exact command for
 * the admin; nothing is executed and the dispatcher keeps the finding open.
 * The site URL is read from Graph (webUrl), never built or guessed.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { ActionHandler } from "./types.js";

/** A delegated SharePoint admin session. Absent means none is available. */
export interface AdminSession {
  archiveSite(siteUrl: string): Promise<void>;
}

/** The exact command an admin runs under their own delegated session. */
export const archiveCommand = (siteUrl: string): string =>
  `Set-SPOSite -Identity "${siteUrl}" -Archive`;

export function createArchiveSiteHandler(
  client: Client,
  session?: AdminSession | null
): ActionHandler {
  return async (finding) => {
    const path = `/sites/${encodeURIComponent(finding.subjectId)}`;

    let siteUrl: string | undefined;
    try {
      const site = await client.api(path).select("webUrl").get();
      siteUrl = site?.webUrl;
    } catch (err) {
      return {
        result: "failure",
        target: finding.subjectId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!siteUrl) {
      return {
        result: "failure",
        target: finding.subjectId,
        error: "Graph returned no site URL; nothing was archived.",
      };
    }

    if (!session) {
      return {
        result: "queued",
        target: siteUrl,
        error:
          "Queued for admin: no delegated admin session is available. " +
          `Run: ${archiveCommand(siteUrl)}`,
      };
    }

    try {
      await session.archiveSite(siteUrl);
    } catch (err) {
      return {
        result: "failure",
        target: siteUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      result: "success",
      target: siteUrl,
      restorePath:
        "Reactivate the archived site from the SharePoint admin center (Archived sites).",
    };
  };
}
