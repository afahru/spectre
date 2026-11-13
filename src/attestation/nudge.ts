/**
 * attestation/nudge.ts
 *
 * Tasks 4.1-4.2 (Requirements 3.1, 3.2): daily nudge and escalation clock.
 *   4.1 No answer 7 days after the send: one nudge (the same card marked as
 *       a reminder). At most two messages per finding (initial + nudge).
 *   4.2 Still no answer 7 days after the nudge: admin exceptions queue,
 *       reason "no response".
 * A finding with a recorded decision is never nudged. A finding with no
 * recorded send is left to card delivery (task 2.2). A failed nudge goes to
 * the queue with the error attached and is not retried.
 */

import type { FindingStore } from "../store/FindingStore.js";
import { buildCard } from "./card.js";
import type { DecisionStore } from "./decision.js";
import type { ExceptionReason } from "./recipient.js";

/** Requirements 3.1 and 3.2. */
export const NUDGE_AFTER_DAYS = 7;
export const ESCALATE_AFTER_NUDGE_DAYS = 7;
/** Requirement 3.1: initial + nudge. */
export const MAX_MESSAGES_PER_FINDING = 2;

const DAY_MS = 86_400_000;

/** One message sent by card delivery (task 2.2). */
export interface SendRecord {
  findingId: string;
  owner: string;
  /** ISO 8601 send time. */
  sentAt: string;
}

/** Send log written by card delivery; the nudge appends to it. */
export interface SendLog {
  /** Sends for a finding, in any order. */
  list(findingId: string): Promise<SendRecord[]>;
  add(record: SendRecord): Promise<void>;
}

/** Admin exceptions queue (visible in the admin console). */
export interface AdminQueue {
  has(findingId: string): Promise<boolean>;
  enqueue(entry: { findingId: string; reason: ExceptionReason; error?: string }): Promise<void>;
}

export interface NudgeDeps {
  findings: FindingStore;
  decisions: DecisionStore;
  sends: SendLog;
  queue: AdminQueue;
  /** Delivers a card to the owner UPN (card delivery, task 2). Throws on failure. */
  send: (owner: string, card: ReturnType<typeof buildCard>) => Promise<void>;
  now?: () => Date;
}

export interface NudgeSummary {
  nudged: string[];
  escalated: string[];
}

/** Run once a day. */
export async function runNudgeCheck(deps: NudgeDeps): Promise<NudgeSummary> {
  const at = (deps.now ?? (() => new Date()))();
  const summary: NudgeSummary = { nudged: [], escalated: [] };

  for (const f of await deps.findings.listOpen()) {
    if (!f.owner) continue; // ownerless findings are routed by recipient resolution
    if (await deps.decisions.get(f.id)) continue; // answered: never nudge
    if (await deps.queue.has(f.id)) continue; // already escalated

    const sends = (await deps.sends.list(f.id)).sort(
      (a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt),
    );
    if (sends.length === 0) continue; // not yet sent
    const age = (r: SendRecord) => at.getTime() - Date.parse(r.sentAt);

    if (sends.length >= MAX_MESSAGES_PER_FINDING) {
      if (age(sends[1]) >= ESCALATE_AFTER_NUDGE_DAYS * DAY_MS) {
        await deps.queue.enqueue({ findingId: f.id, reason: "no response" });
        summary.escalated.push(f.id);
      }
      continue;
    }

    if (age(sends[0]) < NUDGE_AFTER_DAYS * DAY_MS) continue;
    try {
      await deps.send(f.owner, buildCard(f, { reminder: true }));
    } catch (err) {
      await deps.queue.enqueue({
        findingId: f.id,
        reason: "owner unreachable",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    await deps.sends.add({ findingId: f.id, owner: f.owner, sentAt: at.toISOString() });
    summary.nudged.push(f.id);
  }
  return summary;
}
