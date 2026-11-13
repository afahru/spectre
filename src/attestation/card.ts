/**
 * attestation/card.ts
 *
 * Task 1.3 (Requirements 1.1, 2.1, steering teams-cards): Adaptive Card with
 * the narration sentence and exactly three actions. Each Action.Submit posts
 * back the finding id and the chosen action.
 *
 * Button titles are plain English (user feedback 2026-11-13). The action
 * values sent back stay "Keep", "Restrict", "Archive" so the decision
 * handler keeps working unchanged.
 */

import type { Finding } from "../store/types.js";
import { narrate, ACTION_HELP } from "./narration.js";

export const ACTIONS = ["Keep", "Restrict", "Archive"] as const;
export type AttestationAction = (typeof ACTIONS)[number];

export interface AttestationPostback {
  findingId: string;
  action: AttestationAction;
}

const ACTION_TITLES: Record<AttestationAction, string> = {
  Keep: "Keep it shared",
  Restrict: "Remove the public link",
  Archive: "Archive this site",
};

/** Task 4.1: the nudge re-sends the same card, marked as a reminder. */
export function buildCard(f: Finding, opts: { reminder?: boolean } = {}) {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body: [
      { type: "TextBlock", text: (opts.reminder ? "Reminder: " : "") + narrate(f), wrap: true },
      { type: "TextBlock", text: ACTION_HELP, wrap: true, size: "Small", isSubtle: true },
    ],
    actions: ACTIONS.map((action) => ({
      type: "Action.Submit",
      title: ACTION_TITLES[action],
      data: { findingId: f.id, action } satisfies AttestationPostback,
    })),
  };
}
