/**
 * attestation/run.ts
 *
 * Daily attestation runner: sends initial cards, then runs the nudge check.
 * Safe to run repeatedly (delivery skips already-sent findings; the nudge
 * enforces the 7-day and 2-message limits). Exits non-zero only when startup
 * fails, for example missing environment variables.
 */

import { loadConfig } from "../config.js";
import { SqliteFindingStore } from "../store/index.js";
import { SqliteDecisionStore } from "./SqliteDecisionStore.js";
import { SqliteAdminQueue } from "./SqliteAdminQueue.js";
import { SqliteDeliveryStore, createConnectorSender, loadBotConfig, deliverOpenFindings } from "./delivery.js";
import { runNudgeCheck } from "./nudge.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = loadBotConfig(config.tenantId);

  const findings = new SqliteFindingStore(config.dbPath);
  const decisions = new SqliteDecisionStore(config.dbPath);
  const deliveries = new SqliteDeliveryStore(config.dbPath);
  const queue = new SqliteAdminQueue(config.dbPath);
  const send = createConnectorSender(bot, deliveries);

  const delivery = await deliverOpenFindings({
    findings,
    decisions,
    sends: deliveries,
    queue,
    conversations: deliveries,
    send,
  });
  const nudge = await runNudgeCheck({ findings, decisions, sends: deliveries, queue, send });

  console.log(
    JSON.stringify({
      sent: delivery.sent.length,
      nudged: nudge.nudged.length,
      escalated: nudge.escalated.length,
      queued: delivery.queued.length,
      skipped: delivery.skipped.length,
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
