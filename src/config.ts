/**
 * config.ts
 *
 * Reads and validates all required environment variables at startup.
 * Throws a descriptive error immediately if any required variable is missing
 * so the process never starts in a half-configured state.
 *
 * No default values are provided for auth credentials — there is no safe
 * fallback and inventing one would violate the graph-conventions steering rule.
 */

export interface Config {
  /** Azure AD tenant ID */
  tenantId: string;
  /** App registration client ID (application permission, admin-consented) */
  clientId: string;
  /** Client secret for the app registration */
  clientSecret: string;
  /**
   * Path to the SQLite database file used by the findings store.
   * Defaults to ./spectre.db so the demo works out of the box.
   */
  dbPath: string;
}

/**
 * Validates and returns the runtime configuration.
 * Call once at process startup; fail fast on missing variables.
 */
export function loadConfig(): Config {
  const missing: string[] = [];

  function require(name: string): string {
    const value = process.env[name];
    if (!value) {
      missing.push(name);
      return "";
    }
    return value;
  }

  const tenantId = require("TENANT_ID");
  const clientId = require("CLIENT_ID");
  const clientSecret = require("CLIENT_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `Spectre startup failed — missing required environment variable(s): ${missing.join(", ")}.\n` +
        `Set them before starting the service:\n` +
        missing.map((n) => `  export ${n}=<value>`).join("\n")
    );
  }

  return {
    tenantId,
    clientId,
    clientSecret,
    dbPath: process.env["DB_PATH"] ?? "./spectre.db",
  };
}
