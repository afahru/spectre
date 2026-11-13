import type { FindingNumbers, GhostType } from "../../src/store/types";

export const TYPE_LABEL: Record<GhostType, string> = {
  "overshared-site": "Overshared site",
  "orphaned-site": "Orphaned site",
  "stale-guest": "Stale guest",
  "idle-licence": "Idle licence",
  "cold-storage": "Cold storage",
};
export const GHOST_TYPES = Object.keys(TYPE_LABEL) as GhostType[];

export const UNKNOWN = "unknown";

/** Dollar figure quoted as stored; null is "unknown", never 0. */
export const usd = (v: number | null | undefined): string => (v === null || v === undefined ? UNKNOWN : `$${v}`);

export const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : UNKNOWN);

const NUMBER_LABEL: Record<Exclude<keyof FindingNumbers, "anonymousLink">, string> = {
  reachableUserCount: "Reachable users",
  linkScope: "Link scope",
  lastSignInAt: "Last sign-in",
  monthlyCostUsd: "Monthly cost (USD)",
  storageSizeBytes: "Storage (bytes)",
  storageOverageCostUsd: "Storage overage cost (USD)",
  lastModifiedAt: "Last modified",
  skuPartNumber: "SKU",
  itemReadable: "Readable",
};

/** The numbers a finding carries, verbatim. A null value reads "unknown". */
export function numberRows(n: FindingNumbers): [label: string, value: string][] {
  return (Object.keys(NUMBER_LABEL) as (keyof typeof NUMBER_LABEL)[])
    .filter((k) => n[k] !== undefined)
    .map((k) => [NUMBER_LABEL[k], n[k] === null ? UNKNOWN : String(n[k])]);
}
