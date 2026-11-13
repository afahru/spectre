/**
 * attestation/endpoint.ts
 *
 * Task 2.3 (Design: Card delivery): the HTTPS messaging endpoint for
 * Action.Submit postbacks. TLS terminates at the tunnel / host in front of
 * this server (dev: a tunnel); the public URL is deployment config and is
 * set on the bot registration, never in code.
 *
 * Every request must carry a valid Bot Framework JWT (RS256, issuer
 * api.botframework.com, audience = the bot app id, serviceUrl claim equal
 * to the activity's serviceUrl). Anything else gets 401 and is not parsed.
 *
 * Responses: 200 once the postback is handled (recorded, duplicate or
 * ignored); 500 when handling throws, e.g. the decision write failed, so
 * Teams retries and the owner can tap again (Design: Errors).
 */

import { createPublicKey, verify, type webcrypto } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ConversationStore } from "./delivery.js";
import type { DecisionOutcome } from "./decision.js";

export const MESSAGES_PATH = "/api/messages";
const OPENID_CONFIG = "https://login.botframework.com/v1/.well-known/openidconfig";
const BOT_ISSUER = "https://api.botframework.com";

interface Jwk extends webcrypto.JsonWebKey {
  kid?: string;
}

let keyCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function signingKeys(forceRefresh: boolean): Promise<Jwk[]> {
  if (!forceRefresh && keyCache && Date.now() - keyCache.fetchedAt < 86_400_000) return keyCache.keys;
  const cfg = (await (await fetch(OPENID_CONFIG)).json()) as { jwks_uri: string };
  const jwks = (await (await fetch(cfg.jwks_uri)).json()) as { keys: Jwk[] };
  keyCache = { keys: jwks.keys, fetchedAt: Date.now() };
  return jwks.keys;
}

const b64 = (s: string) => Buffer.from(s, "base64url");

/** True only for a valid Bot Framework token addressed to this bot for this serviceUrl. */
export async function isAuthentic(
  authHeader: string | undefined,
  appId: string,
  serviceUrl: unknown,
): Promise<boolean> {
  try {
    const token = authHeader?.match(/^Bearer (.+)$/)?.[1];
    const [h, p, s] = token?.split(".") ?? [];
    if (!h || !p || !s) return false;
    const header = JSON.parse(b64(h).toString()) as { alg?: string; kid?: string };
    if (header.alg !== "RS256") return false;

    let jwk = (await signingKeys(false)).find((k) => k.kid === header.kid);
    jwk ??= (await signingKeys(true)).find((k) => k.kid === header.kid); // key rotation
    if (!jwk) return false;
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64(s))) return false;

    const c = JSON.parse(b64(p).toString()) as {
      iss?: string; aud?: string; exp?: number; nbf?: number; serviceurl?: string;
    };
    const nowSec = Date.now() / 1000;
    return (
      c.iss === BOT_ISSUER &&
      c.aud === appId &&
      typeof c.exp === "number" && c.exp > nowSec &&
      (c.nbf === undefined || c.nbf <= nowSec) &&
      c.serviceurl === serviceUrl
    );
  } catch {
    return false;
  }
}

export interface Activity {
  type?: string;
  serviceUrl?: string;
  value?: unknown;
  from?: { aadObjectId?: string };
  conversation?: { id?: string };
}

export interface EndpointDeps {
  appId: string;
  conversations: ConversationStore;
  /** Resolves a Teams user's AAD object id to a UPN; null when unknown. */
  upnOf: (aadObjectId: string) => Promise<string | null>;
  handlePostback: (raw: unknown) => Promise<DecisionOutcome>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function createMessagingServer(deps: EndpointDeps): Server {
  return createServer(async (req, res) => {
    const end = (code: number) => res.writeHead(code).end();
    if (req.method !== "POST" || req.url !== MESSAGES_PATH) return end(404);
    try {
      const activity = JSON.parse(await readBody(req)) as Activity;
      if (!(await isAuthentic(req.headers.authorization, deps.appId, activity.serviceUrl))) return end(401);

      // Learn the owner's 1:1 conversation from any activity they send (install, hello, tap).
      const aad = activity.from?.aadObjectId;
      if (aad && activity.serviceUrl && activity.conversation?.id) {
        const upn = await deps.upnOf(aad);
        if (upn) {
          deps.conversations.put({ upn, serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id });
        }
      }

      // An Action.Submit arrives as a message activity whose value is the card's data.
      if (activity.type === "message" && activity.value !== undefined) {
        await deps.handlePostback(activity.value);
      }
      end(200);
    } catch (err) {
      console.error(`attestation: messaging endpoint error: ${err instanceof Error ? err.message : err}`);
      end(500);
    }
  });
}
