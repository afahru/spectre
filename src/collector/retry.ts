/**
 * collector/retry.ts
 *
 * Graph 429 / Retry-After helper (design.md → Errors).
 *
 * When Graph responds with HTTP 429, it includes a `Retry-After` header
 * (integer seconds).  We honour it exactly and retry the SAME request —
 * the page is never skipped silently (graph-conventions steering).
 *
 * This module has no dependency on the Graph SDK so it can be unit-tested
 * independently.
 */

/** Maximum number of retry attempts before giving up on a single call. */
const MAX_RETRIES = 5;

/**
 * Shape of a Graph SDK error that includes a status code.
 * The SDK throws objects with this shape on HTTP errors.
 */
interface GraphError {
  statusCode?: number;
  headers?: Record<string, string> | { get?: (name: string) => string | null };
  message?: string;
}

function isGraphError(e: unknown): e is GraphError {
  return typeof e === "object" && e !== null && "statusCode" in e;
}

/**
 * Executes `fn` and retries on 429 responses, honouring the `Retry-After`
 * header.  Throws on any non-429 error or when retries are exhausted.
 *
 * @param fn  Async factory for the Graph call. Must be re-callable.
 */
export async function retryAfterDelay<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isGraphError(err) || err.statusCode !== 429) {
        throw err;
      }

      attempt++;
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `Graph 429: exhausted ${MAX_RETRIES} retries. Last error: ${err.message ?? "unknown"}`
        );
      }

      // Parse Retry-After — may be a number of seconds or an HTTP-date.
      // We only handle integer seconds; fall back to 60 s if unparseable.
      const retryAfterRaw = resolveRetryAfter(err);
      const waitMs = Math.max(retryAfterRaw * 1000, 1000); // at least 1 s

      console.warn(
        `Graph 429 (attempt ${attempt}/${MAX_RETRIES}): waiting ${waitMs / 1000} s before retry.`
      );
      await sleep(waitMs);
    }
  }
}

function resolveRetryAfter(err: GraphError): number {
  const headers = err.headers;
  if (!headers) return 60;

  let raw: string | null | undefined;
  if (typeof headers.get === "function") {
    raw = headers.get("Retry-After");
  } else {
    // Plain object header map (some SDK versions)
    raw = (headers as Record<string, string>)["Retry-After"] ??
      (headers as Record<string, string>)["retry-after"] ??
      null;
  }

  if (!raw) return 60;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
