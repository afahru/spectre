/**
 * attestation/delivery.ts
 *
 * Task 2.2 (Requirement 1.2): proactive card delivery through the Bot
 * Framework Connector.
 *   - The recipient comes from resolveRecipient; ownerless or unreachable
 *     findings go to the admin queue, never to a guessed address.
 *   - Every send is recorded in the SendLog with its timestamp. A ghost
 *     with any recorded send (under any finding row) is never sent again here; the second message
 *     belongs to the nudge rule (nudge.ts).
 *   - A failed send goes to the admin queue with the error attached and is
 *     not retried.
 * Conversation references are captured when the owner talks to the bot or
 * installs it (endpoint.ts), because a 1:1 message needs an existing
 * conversation. No reference means "owner unreachable".
 */

import Database from "better-sqlite3";
import { ClientSecretCredential } from "@azure/identity";
import type { Finding, GhostType } from "../store/types.js";
import type { FindingStore } from "../store/FindingStore.js";
import { buildCard } from "./card.js";
import { isDecisionActive, type DecisionStore } from "./decision.js";
import type { AdminQueue, SendLog, SendRecord } from "./nudge.js";
import { resolveRecipient } from "./recipient.js";

export interface BotConfig {
  /** Bot app (client) ID from the bot registration. */
  appId: string;
  appSecret: string;
  /** The dev tenant; the bot is single-tenant. */
  tenantId: string;
}

/** Deployment config only; no defaults, nothing hardcoded. */
export function loadBotConfig(tenantId: string): BotConfig {
  const appId = process.env["BOT_APP_ID"];
  const appSecret = process.env["BOT_APP_SECRET"];
  if (!appId || !appSecret) {
    throw new Error("Missing BOT_APP_ID and/or BOT_APP_SECRET for the Teams bot registration.");
  }
  return { appId, appSecret, tenantId };
}

export interface ConversationRef {
  upn: string;
  serviceUrl: string;
  conversationId: string;
}

/** Where the bot learned each owner's 1:1 conversation. Synchronous so it fits `isReachable`. */
export interface ConversationStore {
  get(upn: string): ConversationRef | null;
  put(ref: ConversationRef): void;
}

/** SQLite-backed conversation references and send log, in the findings database file. */
export class SqliteDeliveryStore implements ConversationStore, SendLog {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attestation_conversations (
        upn TEXT PRIMARY KEY, service_url TEXT NOT NULL, conversation_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attestation_sends (
        finding_id TEXT NOT NULL, owner TEXT NOT NULL, sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attestation_sends_finding ON attestation_sends (finding_id);
    `);
  }

  get(upn: string): ConversationRef | null {
    const r = this.db
      .prepare("SELECT upn, service_url, conversation_id FROM attestation_conversations WHERE upn = ?")
      .get(upn.toLowerCase()) as { upn: string; service_url: string; conversation_id: string } | undefined;
    return r ? { upn: r.upn, serviceUrl: r.service_url, conversationId: r.conversation_id } : null;
  }

  put(ref: ConversationRef): void {
    this.db
      .prepare(
        `INSERT INTO attestation_conversations (upn, service_url, conversation_id) VALUES (?, ?, ?)
         ON CONFLICT(upn) DO UPDATE SET service_url = excluded.service_url, conversation_id = excluded.conversation_id`,
      )
      .run(ref.upn.toLowerCase(), ref.serviceUrl, ref.conversationId);
  }

  async list(findingId: string): Promise<SendRecord[]> {
    const rows = this.db
      .prepare("SELECT finding_id, owner, sent_at FROM attestation_sends WHERE finding_id = ?")
      .all(findingId) as { finding_id: string; owner: string; sent_at: string }[];
    return rows.map((r) => ({ findingId: r.finding_id, owner: r.owner, sentAt: r.sent_at }));
  }

  /** Joins to findings (rows are never deleted), so superseded rows still resolve. */
  async listBySubject(type: GhostType, subjectId: string): Promise<SendRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.finding_id, s.owner, s.sent_at FROM attestation_sends s
         JOIN findings f ON f.id = s.finding_id WHERE f.type = ? AND f.subject_id = ?`,
      )
      .all(type, subjectId) as { finding_id: string; owner: string; sent_at: string }[];
    return rows.map((r) => ({ findingId: r.finding_id, owner: r.owner, sentAt: r.sent_at }));
  }

  async add(record: SendRecord): Promise<void> {
    this.db
      .prepare("INSERT INTO attestation_sends (finding_id, owner, sent_at) VALUES (?, ?, ?)")
      .run(record.findingId, record.owner, record.sentAt);
  }
}

/** Builds the `send` function used by delivery and by the nudge (NudgeDeps.send). */
export function createConnectorSender(bot: BotConfig, conversations: ConversationStore) {
  const credential = new ClientSecretCredential(bot.tenantId, bot.appId, bot.appSecret);
  return async function send(owner: string, card: ReturnType<typeof buildCard>): Promise<void> {
    const ref = conversations.get(owner);
    if (!ref) throw new Error(`no bot conversation with ${owner}`);
    const token = await credential.getToken("https://api.botframework.com/.default");
    const base = ref.serviceUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` },
      body: JSON.stringify({
        type: "message",
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
      }),
    });
    if (!res.ok) throw new Error(`connector responded ${res.status}`);
  };
}

export interface DeliveryDeps {
  findings: FindingStore;
  decisions: DecisionStore;
  sends: SendLog;
  queue: AdminQueue;
  conversations: ConversationStore;
  send: (owner: string, card: ReturnType<typeof buildCard>) => Promise<void>;
  now?: () => Date;
}

export interface DeliverySummary {
  sent: string[];
  queued: string[];
  skipped: string[];
}

/** Sends the initial card for every open finding that has not been sent yet. */
export async function deliverOpenFindings(deps: DeliveryDeps): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: [], queued: [], skipped: [] };
  for (const f of await deps.findings.listOpen()) {
    const outcome = await deliverFinding(deps, f);
    summary[outcome].push(f.id);
  }
  return summary;
}

async function deliverFinding(deps: DeliveryDeps, f: Finding): Promise<keyof DeliverySummary> {
  const now = (deps.now ?? (() => new Date()))();
  if ((await deps.sends.listBySubject(f.type, f.subjectId)).length > 0) return "skipped"; // second message is the nudge's
  if (isDecisionActive(await deps.decisions.getBySubject(f.type, f.subjectId), now)) return "skipped";
  if (await deps.queue.hasBySubject(f.type, f.subjectId)) return "skipped";

  const to = resolveRecipient(f, (upn) => deps.conversations.get(upn) !== null);
  if (to.kind === "admin-queue") {
    await deps.queue.enqueue({ findingId: f.id, reason: to.reason });
    return "queued";
  }
  try {
    await deps.send(to.upn, buildCard(f));
  } catch (err) {
    await deps.queue.enqueue({
      findingId: f.id,
      reason: "owner unreachable",
      error: err instanceof Error ? err.message : String(err),
    });
    return "queued";
  }
  await deps.sends.add({ findingId: f.id, owner: to.upn, sentAt: now.toISOString() });
  return "sent";
}
