/**
 * remediation/dispatcher.ts
 *
 * Routes an approved decision to the injected handler for its ghost type.
 * Refuses (handlers never called, nothing audited) without a recorded
 * approval, an existing finding, a matching action, or a handler.
 * A finding is marked "actioned" only when the handler reports success.
 */

import type { FindingStore } from "../store/FindingStore.js";
import type { GhostType } from "../store/types.js";
import type { AuditLog } from "./audit.js";
import type {
  ActionHandler,
  ActionOutcome,
  Decision,
  DispatchResult,
  RemediationAction,
} from "./types.js";

/** Which action is allowed for which ghost type (design.md). */
export const ACTION_BY_GHOST_TYPE: Partial<Record<GhostType, RemediationAction>> = {
  "overshared-site": "restrict",
  "cold-storage": "archive",
  "stale-guest": "revoke",
};

export interface DispatcherDeps {
  store: FindingStore;
  audit: AuditLog;
  handlers: Partial<Record<RemediationAction, ActionHandler>>;
}

export function createDispatcher(deps: DispatcherDeps) {
  const refuse = (reason: string): DispatchResult => ({ status: "refused", reason });

  return {
    async dispatch(decision: Decision | null | undefined): Promise<DispatchResult> {
      if (!decision || !decision.findingId || !decision.approvedAt || !decision.owner) {
        return refuse("No recorded owner approval for this action.");
      }

      const finding = await deps.store.getById(decision.findingId);
      if (!finding) return refuse(`Finding ${decision.findingId} not found.`);

      if (ACTION_BY_GHOST_TYPE[finding.type] !== decision.action) {
        return refuse(`Action ${decision.action} is not allowed for ${finding.type}.`);
      }

      const handler = deps.handlers[decision.action];
      if (!handler) return refuse(`No handler registered for ${decision.action}.`);

      let outcome: ActionOutcome;
      try {
        outcome = await handler(finding, decision);
      } catch (err) {
        outcome = {
          result: "failure",
          target: finding.subjectId,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const entry = await deps.audit.append({
        findingId: finding.id,
        action: decision.action,
        target: outcome.target,
        owner: decision.owner,
        result: outcome.result,
        error: outcome.error ?? null,
        restorePath: outcome.restorePath ?? null,
      });

      const updated =
        outcome.result === "success"
          ? await deps.store.updateStatus(finding.id, "actioned")
          : finding;

      return { status: "executed", entry, finding: updated };
    },
  };
}
