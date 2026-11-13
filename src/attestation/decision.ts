/**
 * attestation/decision.ts
 *
 * Tasks 3.1-3.3 (Requirements 2.1, 2.2, 2.3): handle an Action.Submit
 * postback.
 *   3.1 Record the decision (finding id, owner, action, timestamp) first,
 *       once per finding; a duplicate postback returns the recorded one.
 *   3.2 Keep: close the finding as accepted risk, suppress re-ask until
 *       `acceptedUntil`.
 *   3.3 Restrict / Archive: hand to the remediation dispatcher. The loop
 *       never executes the fix itself.
 * Decisions are keyed by the ghost, (type, subjectId), not by finding row,
 * so they survive re-scans (scan supersession, task group 3).
 * Unknown or corrupt postbacks are ignored; the finding stays open.
 */

import type { FindingStore } from "../store/FindingStore.js";
import type { GhostType } from "../store/types.js";
import type { DispatchResult, Decision as RemediationDecision } from "../remediation/types.js";
import { ACTIONS, type AttestationAction, type AttestationPostback } from "./card.js";

/** Requirement 2.3: Keep suppresses re-asking for 30 days. */
export const KEEP_SUPPRESS_DAYS = 30;

export interface DecisionRecord {
  /** The finding row that captured the decision (traceability only). */
  findingId: string;
  /** The ghost the decision is about; with `subjectId` it is the storage key. */
  type: GhostType;
  subjectId: string;
  /** Owner UPN from the finding; never guessed. */
  owner: string;
  action: AttestationAction;
  /** ISO 8601 time of the tap. */
  decidedAt: string;
  /** Keep only: no re-ask before this ISO 8601 time. */
  acceptedUntil: string | null;
}

/**
 * Swappable decision storage, one decision per ghost. A failed write must
 * throw (not acknowledged); so must a write for a subject that already has
 * an active decision. Only an expired Keep may be replaced.
 */
export interface DecisionStore {
  /** The decision captured by this finding row (console per-row view). */
  get(findingId: string): Promise<DecisionRecord | null>;
  getBySubject(type: GhostType, subjectId: string): Promise<DecisionRecord | null>;
  put(record: DecisionRecord): Promise<void>;
}

export class InMemoryDecisionStore implements DecisionStore {
  private readonly records = new Map<string, DecisionRecord>();
  private static key(type: GhostType, subjectId: string) {
    return `${type}|${subjectId}`;
  }
  async get(findingId: string) {
    return [...this.records.values()].find((r) => r.findingId === findingId) ?? null;
  }
  async getBySubject(type: GhostType, subjectId: string) {
    return this.records.get(InMemoryDecisionStore.key(type, subjectId)) ?? null;
  }
  async put(record: DecisionRecord) {
    const key = InMemoryDecisionStore.key(record.type, record.subjectId);
    const existing = this.records.get(key);
    if (existing && isDecisionActive(existing, new Date(record.decidedAt))) {
      throw new Error(`a decision is already recorded for ${record.type} ${record.subjectId}`);
    }
    this.records.set(key, record);
  }
}

export type DecisionOutcome =
  | { status: "ignored"; reason: string }
  | { status: "duplicate"; record: DecisionRecord }
  | { status: "recorded"; record: DecisionRecord; dispatch: DispatchResult | null };

export interface DecisionDeps {
  findings: FindingStore;
  decisions: DecisionStore;
  /** The remediation dispatcher's dispatch (PR #1). */
  dispatch: (decision: RemediationDecision) => Promise<DispatchResult>;
  now?: () => Date;
}

export function createDecisionHandler(deps: DecisionDeps) {
  const now = deps.now ?? (() => new Date());
  const ignore = (reason: string): DecisionOutcome => {
    console.warn(`attestation: postback ignored: ${reason}`);
    return { status: "ignored", reason };
  };

  return async function handlePostback(raw: unknown): Promise<DecisionOutcome> {
    const p = raw as Partial<AttestationPostback> | null | undefined;
    if (!p || typeof p.findingId !== "string" || !p.findingId) {
      return ignore("missing finding id");
    }
    if (!ACTIONS.includes(p.action as AttestationAction)) {
      return ignore("unknown action");
    }
    const action = p.action as AttestationAction;

    const finding = await deps.findings.getById(p.findingId);
    if (!finding) return ignore(`finding ${p.findingId} not found`);

    const at = now();
    const existing = await deps.decisions.getBySubject(finding.type, finding.subjectId);
    if (existing && isDecisionActive(existing, at)) return { status: "duplicate", record: existing };

    if (!finding.owner) return ignore(`finding ${p.findingId} has no owner`);

    const record: DecisionRecord = {
      findingId: finding.id,
      type: finding.type,
      subjectId: finding.subjectId,
      owner: finding.owner,
      action,
      decidedAt: at.toISOString(),
      acceptedUntil:
        action === "Keep"
          ? new Date(at.getTime() + KEEP_SUPPRESS_DAYS * 86_400_000).toISOString()
          : null,
    };
    await deps.decisions.put(record); // record before anything else

    if (action === "Keep") {
      await deps.findings.updateStatus(finding.id, "dismissed");
      return { status: "recorded", record, dispatch: null };
    }

    const dispatch = await deps.dispatch({
      findingId: finding.id,
      action: action === "Restrict" ? "restrict" : "archive",
      owner: record.owner,
      approvedAt: record.decidedAt,
    });
    return { status: "recorded", record, dispatch };
  };
}

/** True while a Keep decision still suppresses re-asking (Requirement 2.3). */
export function isSuppressed(record: DecisionRecord | null, at: Date): boolean {
  return !!record?.acceptedUntil && at.getTime() < Date.parse(record.acceptedUntil);
}

/**
 * True while a decision still blocks asking again: Restrict and Archive
 * always (no expiry), Keep only while it suppresses (Requirements 4.1-4.4).
 */
export function isDecisionActive(record: DecisionRecord | null, at: Date): boolean {
  if (!record) return false;
  return record.action === "Keep" ? isSuppressed(record, at) : true;
}
