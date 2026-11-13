/**
 * attestation/card.ts
 *
 * Task 1.3 (Requirements 1.1, 2.1, steering teams-cards): Adaptive Card with
 * the narration sentence and exactly three actions. Each Action.Submit posts
 * back the finding id and the chosen action.
 */

import type { Finding } from "../store/types.js";
import { narrate } from "./narration.js";

export const ACTIONS = ["Keep", "Restrict", "Archive"] as const;
export type AttestationAction = (typeof ACTIONS)[number];

export interface AttestationPostback {
  findingId: string;
  action: AttestationAction;
}

/** Task 4.1: the nudge re-sends the same card, marked as a reminder. */
export function buildCard(f: Finding, opts: { reminder?: boolean } = {}) {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [{ type: "TextBlock", text: (opts.reminder ? "Reminder: " : "") + narrate(f), wrap: true }],
    actions: ACTIONS.map((action) => ({
      type: "Action.Submit",
      title: action,
      data: { findingId: f.id, action } satisfies AttestationPostback,
    })),
  };
}
