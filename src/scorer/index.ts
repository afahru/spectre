/**
 * scorer/index.ts
 *
 * Deterministic Copilot-readiness scorer — task 5.1.
 *
 * Formula
 * ───────
 *   penalty_i  = count_i × weight_i          (zero when count_i = 0, req 6.2)
 *   totalPenalty = Σ penalty_i
 *   score        = max(0, floor(100 × (1 − totalPenalty / maxPenalty)))
 *   score        = min(100, score)            (no-finding tenant → exactly 100)
 *
 * Properties
 * ──────────
 *   - Pure function: same inputs always produce the same output.
 *   - No Graph calls, no network I/O.
 *   - Every input number traces to a finding in the store (the caller
 *     queries the store and passes the counts in; nothing is invented here).
 *   - All formula inputs are returned in ScorerResult.inputs so the UI
 *     can show them beside the score (req 6.1).
 *   - Recomputed on every scan; previous scores must be stored by the
 *     caller for trend display (req 6.3).
 */

import type { GhostType } from "../store/types.js";
import type {
  GhostCounts,
  GhostScoreBreakdown,
  ScorerConfig,
  ScorerResult,
} from "./types.js";

export type { GhostCounts, ScorerConfig, ScorerResult };
export type { ScorerInputs, GhostScoreBreakdown } from "./types.js";

/** Ghost types in the fixed iteration order used by the breakdown. */
const GHOST_TYPES: GhostType[] = [
  "overshared-site",
  "orphaned-site",
  "stale-guest",
  "idle-licence",
  "cold-storage",
];

/**
 * Default scorer configuration.
 *
 * Weights match SEVERITY_WEIGHTS in flagger/types.ts:
 *   overshared-site: 3  (highest — anonymous links pose direct data-leak risk)
 *   orphaned-site:   2  (no accountability)
 *   stale-guest:     2  (dormant external access)
 *   idle-licence:    1  (cost waste, lower security impact)
 *   cold-storage:    1  (storage waste, lower security impact)
 *
 * maxPenalty: 100 — represents a "fully compromised" posture at demo-tenant
 * scale (~50 findings at average weight 2).  At maxPenalty the score is 0.
 */
export const DEFAULT_CONFIG: ScorerConfig = {
  severityWeights: {
    "overshared-site": 3,
    "orphaned-site": 2,
    "stale-guest": 2,
    "idle-licence": 1,
    "cold-storage": 1,
  },
  maxPenalty: 100,
};

/**
 * Compute the Copilot-readiness score from ghost finding counts.
 *
 * @param counts       Open finding counts per ghost type for this scan.
 *                     Every count must be a non-negative integer.
 * @param scanTimestamp ISO 8601 timestamp of the scan being scored.
 * @param config       Scorer configuration; defaults to DEFAULT_CONFIG.
 * @returns            ScorerResult with the integer score and all inputs.
 *
 * @throws {RangeError} If any count is negative or non-integer.
 */
export function computeScore(
  counts: GhostCounts,
  scanTimestamp: string,
  config: ScorerConfig = DEFAULT_CONFIG
): ScorerResult {
  // Validate inputs — negative counts would invert the penalty formula.
  for (const type of GHOST_TYPES) {
    const count = counts[type];
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(
        `computeScore: count for "${type}" must be a non-negative integer, got ${count}.`
      );
    }
  }

  // Build per-type breakdown and accumulate the total penalty.
  const breakdown: GhostScoreBreakdown[] = [];
  let totalPenalty = 0;

  for (const type of GHOST_TYPES) {
    const count = counts[type];
    const weight = config.severityWeights[type];
    const penalty = count * weight; // zero when count = 0 (req 6.2)
    breakdown.push({ type, count, weight, penalty });
    totalPenalty += penalty;
  }

  // Normalise to [0, 100].
  //   ratio = 1 − (totalPenalty / maxPenalty), clamped to [0, 1].
  //   score = floor(ratio × 100), then further clamped to [0, 100].
  const ratio = Math.max(0, 1 - totalPenalty / config.maxPenalty);
  const score = Math.min(100, Math.max(0, Math.floor(ratio * 100)));

  return {
    score,
    inputs: {
      counts,
      breakdown,
      totalPenalty,
      maxPenalty: config.maxPenalty,
    },
    scanTimestamp,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Build a GhostCounts object from an array of findings queried from the store.
 *
 * This helper keeps the scorer pure: the caller passes in pre-fetched counts
 * rather than a live store reference, so the scorer has no I/O dependency.
 *
 * Usage:
 *   const findings = await store.listByScan(scanTimestamp);
 *   const counts = countsFromFindings(findings);
 *   const result = computeScore(counts, scanTimestamp);
 */
export function countsFromFindings(
  findings: ReadonlyArray<{ type: GhostType }>
): GhostCounts {
  const counts: GhostCounts = {
    "overshared-site": 0,
    "orphaned-site": 0,
    "stale-guest": 0,
    "idle-licence": 0,
    "cold-storage": 0,
  };

  for (const finding of findings) {
    if (Object.prototype.hasOwnProperty.call(counts, finding.type)) {
      counts[finding.type] += 1;
    }
  }

  return counts;
}
