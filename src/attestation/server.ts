/**
 * attestation/server.ts
 *
 * Starts the messaging endpoint (task 2.3) wired to the decision handler,
 * and exposes the daily delivery + nudge run (tasks 2.2, 4.1) as one pass.
 * Run: `npm run bot`. Env: TENANT_ID, CLIENT_ID, CLIENT_SECRET (Graph, for
 * the UPN lookup), BOT_APP_ID, BOT_APP_SECRET, optional DB_PATH and PORT.
 */

import { loadConfig } from "../config.js";
import { createGraphClient } from "../graph/index.js";
import { SqliteFindingStore } from "../store/index.js";
import {
  createArchiveSiteHandler,
  createDispatcher,
  createExpireGuestHandler,
  createRevokeLinkHandler,
  SqliteAuditLog,
} from "../remediation/index.js";
import { createDecisionHandler } from "./decision.js";
import { SqliteDecisionStore } from "./SqliteDecisionStore.js";
import { createConnectorSender, loadBotConfig, SqliteDeliveryStore } from "./delivery.js";
import { createMessagingServer } from "./endpoint.js";

const config = loadConfig();
const bot = loadBotConfig(config.tenantId);
const graph = createGraphClient(config);
const delivery = new SqliteDeliveryStore(config.dbPath);
const findings = new SqliteFindingStore(config.dbPath);

// Archive takes no delegated session (null), so archive decisions are queued as designed.
const dispatcher = createDispatcher({
  store: findings,
  audit: new SqliteAuditLog(config.dbPath),
  handlers: {
    restrict: createRevokeLinkHandler(graph),
    archive: createArchiveSiteHandler(graph, null),
    revoke: createExpireGuestHandler(graph),
  },
});
const handlePostback = createDecisionHandler({
  findings,
  decisions: new SqliteDecisionStore(config.dbPath),
  dispatch: (d) => dispatcher.dispatch(d),
});

export const send = createConnectorSender(bot, delivery);

const server = createMessagingServer({
  appId: bot.appId,
  conversations: delivery,
  handlePostback,
  upnOf: async (aadObjectId) => {
    const u = (await graph.api(`/users/${aadObjectId}`).select("userPrincipalName").get()) as {
      userPrincipalName?: string;
    };
    return u.userPrincipalName ?? null;
  },
});

const port = Number(process.env["PORT"] ?? 3978);
server.listen(port, () => console.log(`Spectre bot listening on :${port}/api/messages`));
