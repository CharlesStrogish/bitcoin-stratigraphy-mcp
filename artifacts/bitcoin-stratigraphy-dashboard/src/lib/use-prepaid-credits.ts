import { useCallback, useEffect, useRef, useState } from "react";
import { mintScannerMacaroon, type ScannerCreditGrant } from "@workspace/api-client-react";
import { isHttpFailure, parseChallenge, type Challenge } from "./use-audit-scanner";

type Phase = "idle" | "quoting" | "awaiting_payment" | "checking" | "complete" | "error" | "expired" | "cleared";

function validGrant(value: ScannerCreditGrant, quote: Challenge): boolean {
  return value?.macaroon === quote.macaroon && value.credits === 100 &&
    value.amount_sats === 100_000 && value.scope === "/api/scanner" &&
    Number.isSafeInteger(value.valid_until) && value.valid_until > Date.now() / 1000;
}

/** Credentials stay in this mounted component only, never in storage or logs. */
export function usePrepaidCredits() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [grant, setGrant] = useState<ScannerCreditGrant | null>(null);
  const [error, setError] = useState("");
  const current = useRef<Challenge | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const request = useCallback((authorization?: string) => {
    const abort = new AbortController();
    controller.current = abort;
    return mintScannerMacaroon({
      credentials: "omit", redirect: "error", cache: "no-store",
      headers: authorization ? { Authorization: authorization } : {},
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]),
    });
  }, []);

  const erase = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    current.current = null;
    active.current = false;
    setChallenge(null); setGrant(null); setError(""); setPhase("cleared");
  }, []);

  useEffect(() => {
    alive.current = true;
    // A page restored from the back/forward cache must not reveal the token.
    window.addEventListener("pagehide", erase);
    return () => {
      alive.current = false;
      generation.current++;
      controller.current?.abort();
      current.current = null;
      window.removeEventListener("pagehide", erase);
    };
  }, [erase]);

  const checkNow = useCallback(async () => {
    const quote = current.current;
    if (!quote || active.current) return;
    // Automatic polling stops at the invoice window, but an explicit check
    // can still recover a payment confirmed near or after that boundary.
    const version = generation.current;
    active.current = true; setPhase("checking"); setError("");
    try {
      const result = await request(`Macaroon ${quote.macaroon}`);
      if (!alive.current || version !== generation.current) return;
      if (!validGrant(result, quote)) throw new Error("Invalid grant");
      // Remove the unpaid challenge and stop polling before revealing the grant.
      current.current = null;
      setChallenge(null); setGrant(result); setPhase("complete");
    } catch (failure) {
      if (!alive.current || version !== generation.current) return;
      if (isHttpFailure(failure) && failure.status === 409 &&
          (failure.data as { verification_pending?: boolean } | null)?.verification_pending === true) {
        setPhase("awaiting_payment");
      } else if (isHttpFailure(failure) && failure.status === 401) {
        setPhase("expired");
      } else {
        setPhase("error");
        setError("Payment could not be confirmed. Your original invoice is retained. Do not pay again; check the same payment or contact the operator.");
      }
    } finally {
      if (version === generation.current) active.current = false;
    }
  }, [request]);

  useEffect(() => {
    if (!challenge || !["awaiting_payment", "error"].includes(phase)) return;
    const tick = () => {
      if (Date.now() >= challenge.expiresAt) setPhase("expired");
      else if (!document.hidden) void checkNow();
    };
    const timer = window.setInterval(tick, 20_000);
    const visible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [phase, challenge, checkNow]);

  useEffect(() => {
    if (!challenge && !grant) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [challenge, grant]);

  const run = useCallback(async () => {
    if (active.current || current.current || grant) return;
    const version = generation.current;
    active.current = true; setPhase("quoting"); setError("");
    try {
      await request();
      if (!alive.current || version !== generation.current) return;
      // A new purchase must begin with a validated 402, never an unbound 200.
      throw new Error("Missing funding challenge");
    } catch (failure) {
      if (!alive.current || version !== generation.current) return;
      if (isHttpFailure(failure) && failure.status === 402) {
        try {
          const quote = parseChallenge(failure);
          if (quote.amountSats !== 100_000 ||
              (failure.data as { credits?: unknown }).credits !== 100) throw new Error("Wrong product");
          current.current = quote; setChallenge(quote); setPhase("awaiting_payment");
        } catch {
          setPhase("error"); setError("Invalid 100,000-sat payment quote. Do not pay this invoice.");
        }
      } else {
        setPhase("error"); setError("Unable to request prepaid access. No payment was initiated.");
      }
    } finally {
      if (version === generation.current) active.current = false;
    }
  }, [grant, request]);

  const clear = useCallback(() => {
    if ((challenge || grant) && !window.confirm(grant
      ? "Have you copied your Macaroon? It cannot be displayed again after you discard it."
      : "Discard this original invoice? If already paid, keep this page and check payment instead.")) return;
    erase();
  }, [challenge, grant, erase]);

  return { phase, challenge, grant, error, run, checkNow, clear };
}
