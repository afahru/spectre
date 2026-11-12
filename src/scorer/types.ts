/**
 * scorer/types.ts
 *
 * Input and output types for the deterministic readiness scorer (task 5).
 *
 * The scorer is a pure function: GhostCounts × ScorerConfig → ScorerResult.
 * No Graph calls, no network I/O, no invented numbers.
 * Every figure in the result traces directly to the finding counts supplied
 * by the caller, which in turn trace to the findings store (task 1–4 output).
 *
 * Invariants (narration-rule steering):
 *   - No count is invented; the caller must supply the exact finding counts.
 *   - `inputs` in ScorerResult carries the exact values used in the formula
 *     so the UI / admin console can show them beside the score.
 *   - The score is always in [0, 100] — never negative, never > 100.
 */

import type { GhostType } from "../store/types.js";

/**
 * Raw ghost counts fed into the scorer.
 * Each field is the number of *open* findings of that type for a given scan.
 * All counts must be non-negative integers; the caller is responsible for
 * querying the findings store.
 */
export interface GhostCounts {
  "overshared-site": number;
  "orphaned-site": number;
  "stale-guest": number;
  "idle-licence": number;
  "cold-storage": number;
}

/**
 * Configuration for the scorer.
 *
 * severityWeights: maps each ghost type to its per-finding penalty weight.
 *   These are the same weights used by the flagger (SEVERITY_WEIGHTS).
 *
 * maxPenalty: the total weighted-finding count at which the score reaches 0.
 *   Any penalty ≥ maxPenalty produces a score of 0.
 *   Chosen to represent a "fully compromised" tenant posture for the demo
 *   tenant scale (~50 findings at average weight 2 → maxPenalty = 100).
 *   This value is part of the formula and is shown in the scorer inputs.
 */
export interface ScorerConfig {
  severityWeights: Record<GhostType, number>;
  maxPenalty: number;
}

/**
 * One scored ghost entry — the per-type breakdown shown beside the score.
 */
export interface GhostScoreBreakdown {
  type: GhostType;
  count: number;
  weight: number;
  /** count × weight — the penalty contribution from this ghost type. */
  penalty: number;
}

/**
 * All the formula inputs, carried verbatim in the result so they can be
 * displayed beside the score (req 6.1) and verified in tests.
 */
export interface ScorerInputs {
  counts: GhostCounts;
  breakdown: GhostScoreBreakdown[];
  /** Sum of all per-type penalties. */
  totalPenalty: number;
  /** Config value used to normalise the penalty to [0, 100]. */
  maxPenalty: number;
}

/**
 * Output of the scorer for one scan.
 */
export interface ScorerResult {
  /**
   * Integer in [0, 100].
   * 100 = no open findings (tenant is fully clean).
   * 0   = penalty ≥ maxPenalty (tenant is severely exposed).
   * Never negative (req 6.2: zero count → zero penalty).
   */
  score: number;
  /** All inputs used to derive the score, for display and auditability. */
  inputs: ScorerInputs;
  /**
   * The scan timestamp this result was computed for.
   * Stored with the result so trend display works (req 6.3).
   */
  scanTimestamp: string;
  /** ISO 8601 timestamp when this score was computed. */
  computedAt: string;
}
