/**
 * console/api.ts
 *
 * Admin console API (spectre-admin-console tasks 1.1-1.4). Pure request
 * handling over injected stores, so it is testable without HTTP or Graph.
 *
 * Reads: score, findings, exceptions, audit. The score is computed by the
 * scorer from the store, never by the UI.
 * The only write is `decide`: it records the admin's approval, then hands
 * Restrict/Archive to the remediation dispatcher. It executes nothing itself.
 */

import { ACTIONS, type AttestationAction } from "../attestation/card.js";
import { KEEP_SUPPRESS_DAYS, type DecisionRecord, type DecisionStore } from "../attestation/decision.js";
import { resolveRecipient, type ExceptionReason } from "../attestation/recipient.js";
import { ACTION_BY_GHOST_TYPE } from "../remediation/dispatcher.js";
import type { AuditEntry, Decision, DispatchResult } from "../remediation/types.js";
import { computeScore, countsFromFindings } from "../scorer/index.js";
import type { FindingStore } from "../store/FindingStore.js";
import type { Finding, FindingStatus, GhostType } from "../store/types.js";
import type {
  ApiError, AuditResponse, CostRollup, DecideResponse, ExceptionsResponse,
  ExceptionView, FindingsResponse, FindingView, ScoreResponse,
} from "./types.js";

const GHOST_TYPES: GhostType[] = ["overshared-site", "orphaned-site", "stale-guest", "idle-licence", "cold-storage"];
const STATUSES: FindingStatus[] = ["open", "actioned", "dismissed", "superseded", "resolved"];

/** Findings the attestation loop queued for the admin (no response / unreachable). */
export interface QueuedException {
  findingId: string;
  reason: ExceptionReason;
  error?: string;
}

export interface ConsoleDeps {
  findings: FindingStore;
  audit: { listAll(): Promise<AuditEntry[]> };
  decisions: DecisionStore;
  /** The remediation dispatcher's dispatch. */
  dispatch: (decision: Decision) => Promise<DispatchResult>;
  /** Queue entries written by the nudge loop; omitted when none is persisted. */
  queued?: () => Promise<QueuedException[]>;
  /** UPN of the admin using the console. Without it no decision is accepted. */
  adminUpn: string | null;
  now?: () => Date;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const fail = (status: number, error: string, extra: Partial<ApiError> = {}): ApiResult => ({
  status,
  body: { error, ...extra } satisfies ApiError,
});

/**
 * True for a Spectre fixture object, by display-name prefix (same rule as
 * seeder/verify.ts; a null label is never a fixture).
 */
const isFixture = (f: Finding): boolean => {
  const label = f.subjectLabel ?? "";
  return label.startsWith("Spectre Fixture ") || label.startsWith("Spectre Ghost ") || label.startsWith("Spectre Idle User ");
};

/** Sum of `pick` over findings; null as soon as one price is not on file. */
function sumOrUnknown(findings: Finding[], pick: (f: Finding) => number | null | undefined): number | null {
  let total = 0;
  for (const f of findings) {
    const v = pick(f);
    if (v === null || v === undefined) return null;
    total += v;
  }
  return total;
}

export function createConsoleApi(deps: ConsoleDeps) {
  const now = deps.now ?? (() => new Date());

  /** Findings of the latest scan; empty when no scan is recorded. */
  async function latest(): Promise<{ scan: string | null; all: Finding[] }> {
    const scan = await deps.findings.latestScanTimestamp();
    return { scan, all: scan ? await deps.findings.listByScan(scan) : [] };
  }

  async function views(all: Finding[]): Promise<FindingView[]> {
    const audit = await deps.audit.listAll();
    return Promise.all(
      all.map(async (finding) => ({
        finding,
        decision: await deps.decisions.get(finding.id),
        audit: audit.filter((e) => e.findingId === finding.id),
      })),
    );
  }

  const allowedActions = (type: GhostType): AttestationAction[] => {
    const mapped = ACTION_BY_GHOST_TYPE[type];
    return ACTIONS.filter((a) => a === "Keep" || a.toLowerCase() === mapped);
  };

  async function exceptionList(): Promise<ExceptionView[]> {
    const { all } = await latest();
    const queued = new Map((await deps.queued?.() ?? []).map((q) => [q.findingId, q]));
    const queuedViews = await views(all.filter((f) => queued.has(f.id) || resolveRecipient(f).kind === "admin-queue"));
    return queuedViews.map((v) => {
      const q = queued.get(v.finding.id);
      const recipient = resolveRecipient(v.finding);
      const reason: ExceptionReason = q?.reason ?? (recipient.kind === "admin-queue" ? recipient.reason : "ownerless");
      return { ...v, reason, error: q?.error ?? null, allowedActions: allowedActions(v.finding.type) };
    });
  }

  return {
    async score(): Promise<ApiResult> {
      const { scan, all } = await latest();
      if (!scan) return ok({ scanTimestamp: null, tenant: null, fixture: null, cost: null } satisfies ScoreResponse);
      const open = all.filter((f) => f.status === "open");
      const cost: CostRollup = {
        idleLicencesUsd: sumOrUnknown(open.filter((f) => f.type === "idle-licence"), (f) => f.numbers.monthlyCostUsd),
        coldStorageUsd: sumOrUnknown(open.filter((f) => f.type === "cold-storage"), (f) => f.numbers.storageOverageCostUsd),
      };
      return ok({
        scanTimestamp: scan,
        tenant: computeScore(countsFromFindings(open), scan),
        fixture: computeScore(countsFromFindings(open.filter(isFixture)), scan),
        cost,
      } satisfies ScoreResponse);
    },

    async findings(query: URLSearchParams): Promise<ApiResult> {
      const type = query.get("type");
      const status = query.get("status");
      if (type && !GHOST_TYPES.includes(type as GhostType)) return fail(400, `Unknown type "${type}".`);
      if (status && !STATUSES.includes(status as FindingStatus)) return fail(400, `Unknown status "${status}".`);
      const { all } = await latest();
      const list = all.filter((f) => (!type || f.type === type) && (!status || f.status === status));
      return ok({ findings: await views(list) } satisfies FindingsResponse);
    },

    async exceptions(): Promise<ApiResult> {
      return ok({ exceptions: await exceptionList() } satisfies ExceptionsResponse);
    },

    async audit(): Promise<ApiResult> {
      return ok({ entries: await deps.audit.listAll() } satisfies AuditResponse);
    },

    async decide(findingId: string, body: unknown): Promise<ApiResult> {
      const action = (body as { action?: unknown } | null)?.action;
      if (!ACTIONS.includes(action as AttestationAction)) return fail(400, "Unknown action.");
      const chosen = action as AttestationAction;

      if (!deps.adminUpn) return fail(503, "Admin identity is not configured (ADMIN_UPN); decisions are disabled.");

      const existing = await deps.decisions.get(findingId);
      if (existing) return fail(409, "A decision is already recorded for this finding.", { record: existing });

      const queued = (await exceptionList()).find((e) => e.finding.id === findingId);
      if (!queued) return fail(404, "Finding is not in the exceptions queue.");
      if (!queued.allowedActions.includes(chosen)) {
        return fail(422, `${chosen} is not allowed for ${queued.finding.type}.`);
      }

      const at = now();
      const record: DecisionRecord = {
        findingId,
        owner: deps.adminUpn,
        action: chosen,
        decidedAt: at.toISOString(),
        acceptedUntil: chosen === "Keep" ? new Date(at.getTime() + KEEP_SUPPRESS_DAYS * 86_400_000).toISOString() : null,
      };
      await deps.decisions.put(record); // record before anything else

      if (chosen === "Keep") {
        await deps.findings.updateStatus(findingId, "dismissed");
        return ok({ record, dispatch: null } satisfies DecideResponse);
      }

      const result = await deps.dispatch({
        findingId,
        action: chosen === "Restrict" ? "restrict" : "archive",
        owner: record.owner,
        approvedAt: record.decidedAt,
      });
      const dispatch =
        result.status === "executed"
          ? ({ status: "executed", entry: result.entry } as const)
          : ({ status: "refused", reason: result.reason } as const);
      return ok({ record, dispatch } satisfies DecideResponse);
    },
  };
}

export type ConsoleApi = ReturnType<typeof createConsoleApi>;
