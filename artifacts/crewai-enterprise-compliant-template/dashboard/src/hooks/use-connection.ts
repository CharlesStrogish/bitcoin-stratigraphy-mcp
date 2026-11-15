import { useCallback, useEffect, useState } from "react";

export type ConnStatus = "missing" | "unverified" | "verified" | "invalid" | "unavailable";
export interface ConnectionState {
  configured: boolean;
  status: ConnStatus;
  message: string;
  checkedAt: string;
}

const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

async function call(path: string, method: "GET" | "POST"): Promise<ConnectionState> {
  const res = await fetch(`${base}local-api/${path}`, { method, credentials: "include", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Local API responded ${res.status} ${res.statusText}`.trim());
  const json = (await res.json()) as ConnectionState;
  if (typeof json?.status !== "string") throw new Error("Local API returned an unexpected payload");
  return json;
}

/** Fetch on mount + manual refetch/verify only. No polling. */
export function useConnection() {
  const [data, setData] = useState<ConnectionState | undefined>();
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [isVerifying, setVerifying] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try { setData(await call("status", "GET")); setError(null); }
    catch (e) { setError(e as Error); }
    finally { setLoading(false); }
  }, []);

  const verify = useCallback(async (): Promise<ConnectionState> => {
    setVerifying(true);
    try { const d = await call("verify", "POST"); setData(d); setError(null); return d; }
    finally { setVerifying(false); }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);
  return { data, error, isLoading, isVerifying, refetch, verify };
}
