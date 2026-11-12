/**
 * attestation/recipient.ts
 *
 * Task 1.1 (Requirement 1.3): resolve the card recipient from finding.owner.
 * Ownerless or unreachable findings go to the admin exceptions queue.
 * The recipient is never guessed.
 */

import type { Finding } from "../store/types.js";

export type ExceptionReason = "ownerless" | "owner unreachable";

export type Recipient =
  | { kind: "owner"; upn: string }
  | { kind: "admin-queue"; reason: ExceptionReason };

/**
 * @param isReachable Whether the bot has a conversation with the owner.
 *   Supplied by card delivery (task 2); omitted means not yet known and the
 *   owner is treated as resolvable.
 */
export function resolveRecipient(
  finding: Pick<Finding, "owner">,
  isReachable?: (upn: string) => boolean,
): Recipient {
  const upn = finding.owner?.trim();
  if (!upn) return { kind: "admin-queue", reason: "ownerless" };
  if (isReachable && !isReachable(upn)) {
    return { kind: "admin-queue", reason: "owner unreachable" };
  }
  return { kind: "owner", upn };
}
