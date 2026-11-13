/**
 * attestation/narration.ts
 *
 * Task 1.2 (Requirement 1.1, steering narration-rule): one sentence per
 * finding, built from the finding record only. Numbers are quoted verbatim
 * from finding.numbers; unknown figures are stated as unknown. Templates
 * contain no digits, and no legal or compliance verdict.
 *
 * Plain-English rule (user feedback 2026-11-13): the owner reading this
 * card is not an engineer. No jargon ("scope", "anonymous", "SKU"), no
 * fixture names as the headline, and the three actions are explained in
 * plain words so the owner can choose without guessing.
 */

import type { Finding } from "../store/types.js";

const UNKNOWN = "unknown";

function num(v: number | null | undefined, unit = ""): string {
  return v === null || v === undefined ? UNKNOWN : `${v}${unit}`;
}

function money(v: number | null | undefined): string {
  return v === null || v === undefined
    ? "an unknown monthly cost (we could not confirm the price)"
    : `$${v} per month`;
}

function when(v: string | null | undefined): string {
  return v === null || v === undefined ? "an unknown date" : v;
}

export function narrate(f: Finding): string {
  const label = f.subjectLabel ?? f.subjectId;
  const n = f.numbers;
  switch (f.type) {
    case "overshared-site":
      return n.linkScope === "anonymous"
        ? `${label} can be opened by anyone with the link, even people outside your company. No sign-in is needed.`
        : `${label} is shared through a link that more people can open than it should be.`;
    case "orphaned-site":
      return `${label} has no owner. Nobody is responsible for what happens to it.`;
    case "stale-guest":
      return n.lastSignInAt === null || n.lastSignInAt === undefined
        ? `Guest ${label} still has access, and we have no record of them signing in.`
        : `Guest ${label} still has access and last signed in on ${n.lastSignInAt}.`;
    case "idle-licence":
      return `${label} holds a licence (${n.skuPartNumber ?? UNKNOWN}) that nobody has used recently. It costs ${money(n.monthlyCostUsd)}.`;
    case "cold-storage":
      return `${label} was last changed on ${when(n.lastModifiedAt)} and uses ${num(n.storageSizeBytes, " bytes")}. Keeping it costs ${money(n.storageOverageCostUsd)} extra.`;
  }
}

/** Plain-English explanation of the three actions, shown under the narration. */
export const ACTION_HELP =
  "Keep: leave it as it is. Restrict: remove the public link so only your team can open it. Archive: archive this site, it is no longer used.";
