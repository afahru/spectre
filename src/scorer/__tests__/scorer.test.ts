/**
 * scorer/__tests__/scorer.test.ts
 *
 * Unit tests for the deterministic readiness scorer (task 5.2).
 *
 * Tests use Node's built-in `node:test` module — no new dependency required.
 *
 * Fixture tenant
 * ──────────────
 * The "fixture tenant" below mirrors the demo data seeded in task 6.
 * Every expected score is computed by hand so this test acts as the
 * ground-truth reference:
 *
 *   Ghost type       count  weight  penalty
 *   ─────────────    ─────  ──────  ───────
 *   overshared-site    3      3        9
 *   orphaned-site      2      2        4
 *   stale-guest        5      2       10
 *   idle-licence       4      1        4
 *   cold-storage       0      1        0
 *                                    ───
 *   totalPenalty                      27
 *
 *   score = floor((1 − 27/100) × 100) = floor(73) = 73
 *
 * All other cases are computed inline in each test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeScore,
  countsFromFindings,
  DEFAULT_CONFIG,
} from "../index.js";
import type { GhostCounts, ScorerConfig } from "../index.js";
import type { GhostType } from "../../store/types.js";

// ── Fixture tenant data ───────────────────────────────────────────────────────

/** The fixture ghost counts, matching the demo seeder (task 6). Cold-storage
 *  is 0 by design: the cs fixture sites were created in Nov 2026 and cannot
 *  be 365 days old until Nov 2027 (see constants.ts). */
const FIXTURE_COUNTS: GhostCounts = {
  "overshared-site": 3,
  "orphaned-site": 2,
  "stale-guest": 5,
  "idle-licence": 4,
  "cold-storage": 0,
};

const FIXTURE_SCAN_TS = "2026-11-12T00:00:00.000Z";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Finding-like object with just the type field. */
function makeFinding(type: GhostType): { type: GhostType } {
  return { type };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeScore", () => {
  // ── 5.1 core formula ──────────────────────────────────────────────────────

  it("returns 100 for a tenant with zero findings (perfect posture)", () => {
    const counts: GhostCounts = {
      "overshared-site": 0,
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const result = computeScore(counts, FIXTURE_SCAN_TS);
    assert.equal(result.score, 100);
  });

  it("returns 0 when total penalty equals maxPenalty", () => {
    // penalty = 100 × 1 × weight_per_type to hit exactly maxPenalty=100
    // Use only overshared-site (weight 3): ceil(100/3)≈34 → 34×3=102 ≥ 100.
    // Cleaner: use a custom config with maxPenalty=10 and penalty exactly 10.
    const config: ScorerConfig = {
      severityWeights: { ...DEFAULT_CONFIG.severityWeights },
      maxPenalty: 10,
    };
    const counts: GhostCounts = {
      "overshared-site": 0,
      "orphaned-site": 5, // 5 × 2 = 10
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const result = computeScore(counts, FIXTURE_SCAN_TS, config);
    assert.equal(result.score, 0);
  });

  it("clamps to 0 when total penalty exceeds maxPenalty", () => {
    const config: ScorerConfig = {
      severityWeights: { ...DEFAULT_CONFIG.severityWeights },
      maxPenalty: 10,
    };
    const counts: GhostCounts = {
      "overshared-site": 4, // 4 × 3 = 12 > 10
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const result = computeScore(counts, FIXTURE_SCAN_TS, config);
    assert.equal(result.score, 0, "score must not go negative");
  });

  it("never produces a negative score", () => {
    // maxPenalty = 1, any finding produces penalty ≥ 1 → score must be 0.
    const config: ScorerConfig = {
      severityWeights: {
        "overshared-site": 3,
        "orphaned-site": 2,
        "stale-guest": 2,
        "idle-licence": 1,
        "cold-storage": 1,
      },
      maxPenalty: 1,
    };
    const counts: GhostCounts = {
      "overshared-site": 100,
      "orphaned-site": 100,
      "stale-guest": 100,
      "idle-licence": 100,
      "cold-storage": 100,
    };
    const result = computeScore(counts, FIXTURE_SCAN_TS, config);
    assert.ok(result.score >= 0, `score ${result.score} must be >= 0`);
    assert.equal(result.score, 0);
  });

  it("zero count for a ghost type contributes zero penalty (req 6.2)", () => {
    // Only stale-guest has findings; other counts are 0.
    const counts: GhostCounts = {
      "overshared-site": 0,
      "orphaned-site": 0,
      "stale-guest": 10, // 10 × 2 = 20
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const result = computeScore(counts, FIXTURE_SCAN_TS);

    // Verify each zero-count type has zero penalty in the breakdown.
    for (const entry of result.inputs.breakdown) {
      if (entry.type !== "stale-guest") {
        assert.equal(
          entry.penalty,
          0,
          `expected 0 penalty for ${entry.type}, got ${entry.penalty}`
        );
      }
    }

    // Expected: totalPenalty = 20, score = floor((1-20/100)×100) = 80
    assert.equal(result.inputs.totalPenalty, 20);
    assert.equal(result.score, 80);
  });

  it("single overshared-site finding yields score 97", () => {
    // penalty = 1 × 3 = 3
    // score = floor((1 - 3/100) × 100) = floor(97) = 97
    const counts: GhostCounts = {
      "overshared-site": 1,
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const result = computeScore(counts, FIXTURE_SCAN_TS);
    assert.equal(result.inputs.totalPenalty, 3);
    assert.equal(result.score, 97);
  });

  // ── 5.2 fixture tenant ────────────────────────────────────────────────────

  describe("fixture tenant (task 5.2)", () => {
    it("produces score 73 for the fixture ghost counts", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      // Hand-computed: totalPenalty = 3×3 + 2×2 + 5×2 + 4×1 + 0×1 = 9+4+10+4+0 = 27
      // score = floor((1 - 27/100) × 100) = 73
      assert.equal(result.score, 73);
    });

    it("totalPenalty for fixture tenant is 27", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      assert.equal(result.inputs.totalPenalty, 27);
    });

    it("breakdown matches per-type hand-computed penalties", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      const byType = Object.fromEntries(
        result.inputs.breakdown.map((e) => [e.type, e])
      );

      // overshared-site: 3 × 3 = 9
      assert.equal(byType["overshared-site"].count, 3);
      assert.equal(byType["overshared-site"].weight, 3);
      assert.equal(byType["overshared-site"].penalty, 9);

      // orphaned-site: 2 × 2 = 4
      assert.equal(byType["orphaned-site"].count, 2);
      assert.equal(byType["orphaned-site"].weight, 2);
      assert.equal(byType["orphaned-site"].penalty, 4);

      // stale-guest: 5 × 2 = 10
      assert.equal(byType["stale-guest"].count, 5);
      assert.equal(byType["stale-guest"].weight, 2);
      assert.equal(byType["stale-guest"].penalty, 10);

      // idle-licence: 4 × 1 = 4
      assert.equal(byType["idle-licence"].count, 4);
      assert.equal(byType["idle-licence"].weight, 1);
      assert.equal(byType["idle-licence"].penalty, 4);

      // cold-storage: 0 × 1 = 0 (0 by design — fixtures too young, see constants.ts)
      assert.equal(byType["cold-storage"].count, 0);
      assert.equal(byType["cold-storage"].weight, 1);
      assert.equal(byType["cold-storage"].penalty, 0);
    });

    it("inputs.counts exactly reflect the values passed in", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      assert.deepEqual(result.inputs.counts, FIXTURE_COUNTS);
    });

    it("inputs.maxPenalty reflects DEFAULT_CONFIG.maxPenalty", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      assert.equal(result.inputs.maxPenalty, DEFAULT_CONFIG.maxPenalty);
    });

    it("scanTimestamp in result matches the value passed in", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      assert.equal(result.scanTimestamp, FIXTURE_SCAN_TS);
    });

    it("score is an integer in [0, 100]", () => {
      const result = computeScore(FIXTURE_COUNTS, FIXTURE_SCAN_TS);
      assert.ok(Number.isInteger(result.score), "score must be an integer");
      assert.ok(result.score >= 0 && result.score <= 100, "score must be in [0, 100]");
    });
  });

  // ── Trend — previous score preserved separately (req 6.3) ────────────────

  it("two successive scans produce independent results (no state mutation)", () => {
    const counts1: GhostCounts = {
      "overshared-site": 1,
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const counts2: GhostCounts = {
      "overshared-site": 0,
      "orphaned-site": 0,
      "stale-guest": 2,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    const r1 = computeScore(counts1, "2026-11-11T00:00:00.000Z");
    const r2 = computeScore(counts2, "2026-11-12T00:00:00.000Z");

    // r1: penalty = 3, score = floor((1-3/100)×100) = 97
    assert.equal(r1.score, 97);
    // r2: penalty = 4, score = floor((1-4/100)×100) = 96
    assert.equal(r2.score, 96);
    // The two results are independent — r1 is not mutated by computing r2.
    assert.equal(r1.score, 97);
    assert.notEqual(r1.scanTimestamp, r2.scanTimestamp);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it("throws RangeError for a negative count", () => {
    const counts: GhostCounts = {
      "overshared-site": -1, // invalid
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    assert.throws(
      () => computeScore(counts, FIXTURE_SCAN_TS),
      { name: "RangeError" }
    );
  });

  it("throws RangeError for a fractional count", () => {
    const counts: GhostCounts = {
      "overshared-site": 1.5, // invalid
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    };
    assert.throws(
      () => computeScore(counts, FIXTURE_SCAN_TS),
      { name: "RangeError" }
    );
  });
});

// ── countsFromFindings ────────────────────────────────────────────────────────

describe("countsFromFindings", () => {
  it("returns all-zero counts for an empty findings array", () => {
    const counts = countsFromFindings([]);
    assert.deepEqual(counts, {
      "overshared-site": 0,
      "orphaned-site": 0,
      "stale-guest": 0,
      "idle-licence": 0,
      "cold-storage": 0,
    });
  });

  it("counts each ghost type correctly", () => {
    const findings = [
      makeFinding("overshared-site"),
      makeFinding("overshared-site"),
      makeFinding("overshared-site"),
      makeFinding("orphaned-site"),
      makeFinding("orphaned-site"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("idle-licence"),
      makeFinding("idle-licence"),
      makeFinding("idle-licence"),
      makeFinding("idle-licence"),
    ];
    const counts = countsFromFindings(findings);
    assert.deepEqual(counts, FIXTURE_COUNTS);
  });

  it("produces the same score as passing FIXTURE_COUNTS directly", () => {
    const findings = [
      makeFinding("overshared-site"),
      makeFinding("overshared-site"),
      makeFinding("overshared-site"),
      makeFinding("orphaned-site"),
      makeFinding("orphaned-site"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("stale-guest"),
      makeFinding("idle-licence"),
      makeFinding("idle-licence"),
      makeFinding("idle-licence"),
      makeFinding("idle-licence"),
    ];
    const counts = countsFromFindings(findings);
    const result = computeScore(counts, FIXTURE_SCAN_TS);
    assert.equal(result.score, 73);
  });
});
