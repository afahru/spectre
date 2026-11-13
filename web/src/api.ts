import { useCallback, useEffect, useState } from "react";
import type {
  ApiError, AuditResponse, DecideResponse, ExceptionsResponse, FindingsResponse, ScoreResponse,
} from "../../src/console/types";

export type { ExceptionView, FindingView } from "../../src/console/types";
export type { ScoreResponse, DecideResponse };

/** The service re-reads the store on every call; the console re-polls as the fallback for push (req 1.2). */
const POLL_MS = 15_000;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export interface Loaded<T> {
  data: T | null;
  /** Set when the service cannot be reached; `data` is cleared so stale numbers are never shown. */
  error: string | null;
  reload: () => void;
}

export function useApi<T>(path: string): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const load = useCallback(() => {
    get<T>(path).then(
      (data) => setState({ data, error: null }),
      (e: unknown) => setState({ data: null, error: e instanceof Error ? e.message : String(e) }),
    );
  }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  return { ...state, reload: load };
}

export const useScore = () => useApi<ScoreResponse>("/score");
export const useFindings = (type: string, status: string) => {
  const q = new URLSearchParams();
  if (type) q.set("type", type);
  if (status) q.set("status", status);
  return useApi<FindingsResponse>(`/findings?${q}`);
};
export const useExceptions = () => useApi<ExceptionsResponse>("/exceptions");
export const useAudit = () => useApi<AuditResponse>("/audit");

export async function decide(findingId: string, action: string): Promise<{ ok: boolean; body: DecideResponse | ApiError }> {
  const res = await fetch(`/exceptions/${encodeURIComponent(findingId)}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  return { ok: res.ok, body: (await res.json()) as DecideResponse | ApiError };
}
