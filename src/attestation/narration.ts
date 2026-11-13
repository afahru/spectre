/**
 * attestation/narration.ts
 *
 * Task 1.2 (Requirement 1.1, steering narration-rule): one sentence per
 * finding, built from the finding record only. Numbers are quoted verbatim
 * from finding.numbers; unknown figures are stated as unknown. Templates
 * contain no digits, and no legal or compliance verdict.
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
  const ask = "Please choose Keep, Restrict or Archive.";
  switch (f.type) {
    case "overshared-site":
      return `${label} can be reached through a link (scope: ${n.linkScope ?? UNKNOWN}) by ${num(n.reachableUserCount)} people. ${ask}`;
    case "orphaned-site":
      return `${label} has no owner on record. ${ask}`;
    case "stale-guest":
      return n.lastSignInAt === null || n.lastSignInAt === undefined
        ? `Guest ${label} still has access and we have no sign-in record for them. ${ask}`
        : `Guest ${label} still has access and last signed in on ${n.lastSignInAt}. ${ask}`;
    case "idle-licence":
      return `${label} holds a licence (SKU: ${n.skuPartNumber ?? UNKNOWN}) with no recent activity, at ${money(n.monthlyCostUsd)}. ${ask}`;
    case "cold-storage":
      return `${label} was last modified on ${when(n.lastModifiedAt)} and uses ${num(n.storageSizeBytes, " bytes")}, with an overage cost of ${money(n.storageOverageCostUsd)}. ${ask}`;
  }
}
