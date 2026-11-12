/**
 * flagger/index.ts
 *
 * Flagging heuristics orchestrator — task 3.
 *
 * Runs all four flagging passes against the inventory result and
 * converts each candidate into a Finding that can be persisted in the
 * findings store.
 *
 * Ghost types produced:
 *   3.1  overshared-site — sharingCapability allows anonymous/external sharing
 *   3.1  orphaned-site   — no owner returned by Graph
 *   3.2  stale-guest     — last sign-in ≥ 90 days ago or never; sponsor-
 *                          departed guests are ownerless
 *   3.3  idle-licence    — no M365 activity in 90 days; cost from price table
 *   3.4  cold-storage    — not modified in 365+ days; storage size from drive
 *
 * Design invariants:
 *   - No permissions endpoint is called in this module (task 3 constraint).
 *   - No number is invented: every numeric field traces to a Graph response
 *     or is null (narration-rule and graph-conventions steering).
 *   - No owner is invented: a finding with no owner is recorded as ownerless
 *     (owner: null), never assigned to a guess.
 */

import type { Client } from "@microsoft/microsoft-graph-client";
import type { InventoryResult } from "../collector/index.js";
import type { FindingStore, NewFinding } from "../store/index.js";
import type { FlaggedCandidate } from "./types.js";
import { SEVERITY_WEIGHTS } from "./types.js";
import { flagOversharedSites, flagOrphanedSites } from "./sites.js";
import { flagStaleGuests } from "./guests.js";
import { flagIdleLicences } from "./licences.js";
import { flagColdStorage, type StorageOverageRate } from "./storage.js";

export { SEVERITY_WEIGHTS };
export type { FlaggedCandidate, StorageOverageRate };

export interface FlaggerInput {
  /** Authenticated Graph client (used for cold-storage drive-quota batch). */
  client: Client;
  /** Inventory result from the collector. */
  inventory: InventoryResult;
  /** Findings store for persisting new findings. */
  store: FindingStore;
  /** ISO 8601 timestamp identifying the current scan run. */
  scanTimestamp: string;
  /**
   * Monthly storage overage rate in USD per GB.
   * null means no rate on file; storageOverageCostUsd will be null (req 5.2).
   */
  storageOverageRateUsdPerGb?: StorageOverageRate;
  /**
   * Reference date for staleness calculations.
   * Defaults to now; set explicitly in tests for deterministic results.
   */
  referenceDate?: Date;
}

export interface FlaggerResult {
  /** All candidates produced by the four flagging passes. */
  candidates: FlaggedCandidate[];
  /** Findings persisted to the store (one per candidate). */
  findings: Awaited<ReturnType<FindingStore["insert"]>>[];
}

/**
 * Runs all flagging heuristics against the inventory and persists the
 * resulting findings.
 *
 * @returns All candidates and their corresponding persisted findings.
 */
export async function runFlagging(input: FlaggerInput): Promise<FlaggerResult> {
  const {
    client,
    inventory,
    store,
    scanTimestamp,
    storageOverageRateUsdPerGb = null,
    referenceDate = new Date(),
  } = input;

  // ── 3.1: Overshared and orphaned site candidates ───────────────────────
  const oversharedCandidates = flagOversharedSites(inventory.sites);
  const orphanedCandidates = flagOrphanedSites(inventory.sites);
  console.log(
    `[flagger] sites: ${oversharedCandidates.length} overshared, ` +
      `${orphanedCandidates.length} orphaned candidates.`
  );

  // ── 3.2: Stale guest candidates ────────────────────────────────────────
  const staleGuestCandidates = flagStaleGuests(inventory.guests, referenceDate);
  console.log(
    `[flagger] guests: ${staleGuestCandidates.length} stale candidates.`
  );

  // ── 3.3: Idle licence candidates ──────────────────────────────────────
  const idleLicenceCandidates = flagIdleLicences(inventory.licences, referenceDate);
  console.log(
    `[flagger] licences: ${idleLicenceCandidates.length} idle candidates.`
  );

  // ── 3.4: Cold storage candidates ──────────────────────────────────────
  const coldStorageCandidates = await flagColdStorage(
    inventory.sites,
    client,
    storageOverageRateUsdPerGb,
    referenceDate
  );
  console.log(
    `[flagger] storage: ${coldStorageCandidates.length} cold candidates.`
  );

  const candidates: FlaggedCandidate[] = [
    ...oversharedCandidates,
    ...orphanedCandidates,
    ...staleGuestCandidates,
    ...idleLicenceCandidates,
    ...coldStorageCandidates,
  ];

  // ── Persist candidates as findings ────────────────────────────────────
  const findings: FlaggerResult["findings"] = [];

  for (const candidate of candidates) {
    const newFinding: NewFinding = candidateToNewFinding(candidate, scanTimestamp);
    const finding = await store.insert(newFinding);
    findings.push(finding);
  }

  console.log(
    `[flagger] persisted ${findings.length} findings for scan ${scanTimestamp}.`
  );

  return { candidates, findings };
}

/**
 * Converts a FlaggedCandidate to a NewFinding for the store.
 *
 * All numbers are taken verbatim from the candidate (which got them from
 * Graph).  No value is invented here.
 */
function candidateToNewFinding(
  candidate: FlaggedCandidate,
  scanTimestamp: string
): NewFinding {
  const severityWeight = SEVERITY_WEIGHTS[candidate.type];

  switch (candidate.type) {
    case "overshared-site":
      return {
        type: "overshared-site",
        subjectId: candidate.siteId,
        subjectLabel: candidate.siteDisplayName,
        owner: candidate.owner,
        numbers: {
          // linkScope is not available from site-level metadata; it is
          // resolved by the permissions fetcher in task 4.  Record null
          // here — never invent a scope.
          linkScope: null,
        },
        severityWeight,
        scanTimestamp,
      };

    case "orphaned-site":
      return {
        type: "orphaned-site",
        subjectId: candidate.siteId,
        subjectLabel: candidate.siteDisplayName,
        owner: null,
        numbers: {},
        severityWeight,
        scanTimestamp,
      };

    case "stale-guest":
      return {
        type: "stale-guest",
        subjectId: candidate.guestId,
        subjectLabel: candidate.guestDisplayName,
        owner: candidate.owner, // null when sponsor departed (req 3.3)
        numbers: {
          lastSignInAt: candidate.lastSignInAt,
        },
        severityWeight,
        scanTimestamp,
      };

    case "idle-licence":
      return {
        type: "idle-licence",
        subjectId: candidate.userId,
        subjectLabel: candidate.userDisplayName,
        owner: candidate.owner,
        numbers: {
          skuPartNumber: candidate.skuPartNumber,
          monthlyCostUsd: candidate.monthlyCostUsd, // null when unknown (req 4.3)
        },
        severityWeight,
        scanTimestamp,
      };

    case "cold-storage":
      return {
        type: "cold-storage",
        subjectId: candidate.siteId,
        subjectLabel: candidate.siteDisplayName,
        owner: candidate.owner,
        numbers: {
          lastModifiedAt: candidate.lastModifiedAt,
          storageSizeBytes: candidate.storageUsedBytes, // null when unknown
          storageOverageCostUsd: candidate.storageOverageCostUsd, // null when unknown (req 5.2)
        },
        severityWeight,
        scanTimestamp,
      };
  }
}
