/**
 * remediation/types.ts
 *
 * Types for the remediation dispatcher and audit log.
 * Owner is the approver recorded by the attestation loop; it is never
 * guessed, and null stays null.
 */

import type { Finding } from "../store/types.js";

export type RemediationAction = "restrict" | "archive" | "revoke";

/** A recorded owner approval, handed over by the attestation loop. */
export interface Decision {
  findingId: string;
  action: RemediationAction;
  /** Approver of the decision. */
  owner: string | null;
  /** ISO 8601 time of approval. Required: no approval, no action. */
  approvedAt: string;
}

export type AuditResult = "success" | "failure" | "queued";

export interface AuditEntry {
  id: string;
  findingId: string;
  action: RemediationAction;
  /** The link, site, or guest the action targeted. */
  target: string;
  owner: string | null;
  timestamp: string;
  result: AuditResult;
  error: string | null;
  /** How to undo the action, or null where the platform has none. */
  restorePath: string | null;
}

export interface ActionOutcome {
  result: AuditResult;
  target: string;
  error?: string;
  restorePath?: string | null;
}

export type ActionHandler = (
  finding: Finding,
  decision: Decision
) => Promise<ActionOutcome>;

export type DispatchResult =
  | { status: "refused"; reason: string }
  | { status: "executed"; entry: AuditEntry; finding: Finding | null };
