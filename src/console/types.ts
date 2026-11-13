/**
 * console/types.ts
 *
 * Wire types of the admin console read API (spectre-admin-console design).
 * The React app imports these as types only, so the UI and the service
 * cannot drift. Every figure is quoted from the store or the scorer; an
 * unconfirmable figure is `null`, never 0 and never a guess.
 */

import type { ExceptionReason } from "../attestation/recipient.js";
import type { AttestationAction } from "../attestation/card.js";
import type { DecisionRecord } from "../attestation/decision.js";
import type { ScorerResult } from "../scorer/types.js";
import type { AuditEntry } from "../remediation/types.js";
import type { Finding } from "../store/types.js";

/** Cost rollup over open findings. null = at least one price is not on file. */
export interface CostRollup {
  idleLicencesUsd: number | null;
  coldStorageUsd: number | null;
}

export interface ScoreResponse {
  /** Latest scan the figures come from; null when no scan is recorded. */
  scanTimestamp: string | null;
  /** Tenant-wide score; null when no scan is recorded. */
  tenant: ScorerResult | null;
  /** Score over the Spectre fixture objects only; null when no scan is recorded. */
  fixture: ScorerResult | null;
  cost: CostRollup | null;
}

export interface FindingView {
  finding: Finding;
  decision: DecisionRecord | null;
  audit: AuditEntry[];
}

export interface FindingsResponse {
  findings: FindingView[];
}

export interface ExceptionView extends FindingView {
  reason: ExceptionReason;
  /** Delivery error attached by the nudge loop, if any. */
  error: string | null;
  /** Decisions the admin may take; Keep plus what the remediation spec allows. */
  allowedActions: AttestationAction[];
}

export interface ExceptionsResponse {
  exceptions: ExceptionView[];
}

export interface AuditResponse {
  entries: AuditEntry[];
}

export interface DecideResponse {
  record: DecisionRecord;
  /** Present for Restrict/Archive: the audit entry, or why remediation refused. */
  dispatch: { status: "executed"; entry: AuditEntry } | { status: "refused"; reason: string } | null;
}

export interface ApiError {
  error: string;
  /** Present on 409: the decision already on record. */
  record?: DecisionRecord;
}
