/**
 * graph/client.ts
 *
 * Builds and exports a Microsoft Graph client that authenticates with
 * app-only credentials (client credentials flow) using @azure/identity.
 *
 * Graph conventions enforced here:
 *   - Application permissions only (no delegated token).
 *   - The client is reused across the scan run; it caches its own token.
 *   - Callers must add $select to every list call; this module does not
 *     enforce that — it is validated at the call site.
 */

import { ClientSecretCredential } from "@azure/identity";
import {
  Client,
  AuthenticationProvider,
  AuthenticationProviderOptions,
} from "@microsoft/microsoft-graph-client";
import type { Config } from "../config.js";

/**
 * Thin wrapper that lets @azure/identity drive Graph SDK authentication.
 * The token is cached by ClientSecretCredential and refreshed automatically.
 */
class AzureIdentityAuthProvider implements AuthenticationProvider {
  private readonly credential: ClientSecretCredential;

  constructor(credential: ClientSecretCredential) {
    this.credential = credential;
  }

  async getAccessToken(
    _options?: AuthenticationProviderOptions
  ): Promise<string> {
    const token = await this.credential.getToken(
      "https://graph.microsoft.com/.default"
    );
    if (!token) {
      throw new Error(
        "Graph auth: could not obtain a token from Azure AD. " +
          "Verify TENANT_ID, CLIENT_ID, and CLIENT_SECRET."
      );
    }
    return token.token;
  }
}

/**
 * Creates a ready-to-use Graph SDK client authenticated as the application.
 * Call once per scan run and pass the client down to collectors.
 */
export function createGraphClient(config: Config): Client {
  const credential = new ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.clientSecret
  );

  const authProvider = new AzureIdentityAuthProvider(credential);

  return Client.initWithMiddleware({
    authProvider,
    defaultVersion: "v1.0",
  });
}
