/**
 * console/server.ts
 *
 * Task 1.1 / 1.2: HTTP wrapper for the admin console API plus the static
 * React app (web/dist). Run: `npm run console`.
 * Env: TENANT_ID, CLIENT_ID, CLIENT_SECRET (as the scan engine), optional
 * DB_PATH, CONSOLE_HOST (default 127.0.0.1), CONSOLE_PORT (default 3979) and
 * ADMIN_UPN (the admin recorded as approver; without it decisions return 503).
 * The service has no sign-in of its own: keep it on localhost or behind the
 * tenant's access proxy. The UI holds no credentials and makes no Graph calls.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { SqliteFindingStore } from "../store/index.js";
import { SqliteDecisionStore } from "../attestation/SqliteDecisionStore.js";
import { SqliteAdminQueue } from "../attestation/SqliteAdminQueue.js";
import { createGraphClient } from "../graph/index.js";
import {
  createArchiveSiteHandler,
  createDispatcher,
  createExpireGuestHandler,
  createRevokeLinkHandler,
  SqliteAuditLog,
} from "../remediation/index.js";
import { createConsoleApi, type ConsoleApi, type ApiResult } from "./api.js";

const WEB_ROOT = resolve(__dirname, "../../web/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
      if (body.length > 100_000) rej(new Error("body too large"));
    });
    req.on("end", () => res(body));
    req.on("error", rej);
  });
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname);
  const file = join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT)) return void res.writeHead(404).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found. Build the console first: npm run web:build");
  }
}

/** Routes one request to the API; null when the path is not an API path. */
export async function route(api: ConsoleApi, req: IncomingMessage): Promise<ApiResult | null> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const decide = url.pathname.match(/^\/exceptions\/([^/]+)\/decide$/);
  if (req.method === "GET") {
    if (url.pathname === "/score") return api.score();
    if (url.pathname === "/findings") return api.findings(url.searchParams);
    if (url.pathname === "/exceptions") return api.exceptions();
    if (url.pathname === "/audit") return api.audit();
  }
  if (req.method === "POST" && decide) {
    // A JSON content type forces a CORS preflight, so other sites cannot post blindly.
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      return { status: 415, body: { error: "Content-Type must be application/json." } };
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return { status: 400, body: { error: "Body must be JSON." } };
    }
    return api.decide(decodeURIComponent(decide[1]), body);
  }
  return null;
}

export function createConsoleServer(api: ConsoleApi) {
  return createServer(async (req, res) => {
    try {
      const result = await route(api, req);
      if (result) {
        return void res
          .writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(result.body));
      }
      if (req.method === "GET") return await serveStatic(new URL(req.url ?? "/", "http://localhost").pathname, res);
      res.writeHead(404).end();
    } catch (err) {
      console.error(`console: ${err instanceof Error ? err.message : err}`);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "Internal error." }));
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  const findings = new SqliteFindingStore(config.dbPath);
  const audit = new SqliteAuditLog(config.dbPath);
  // As in attestation/server.ts: archive takes no delegated session (null), so it is queued.
  const graph = createGraphClient(config);
  const dispatcher = createDispatcher({
    store: findings,
    audit,
    handlers: {
      restrict: createRevokeLinkHandler(graph),
      archive: createArchiveSiteHandler(graph, null),
      revoke: createExpireGuestHandler(graph),
    },
  });
  const api = createConsoleApi({
    findings,
    audit,
    decisions: new SqliteDecisionStore(config.dbPath),
    queued: () => new SqliteAdminQueue(config.dbPath).list(),
    dispatch: (d) => dispatcher.dispatch(d),
    adminUpn: process.env["ADMIN_UPN"] || null,
  });
  const host = process.env["CONSOLE_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["CONSOLE_PORT"] ?? 3979);
  createConsoleServer(api).listen(port, host, () => console.log(`Spectre console on http://${host}:${port}`));
}
