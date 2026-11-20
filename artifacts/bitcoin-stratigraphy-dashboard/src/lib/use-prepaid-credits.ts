import { useCallback, useEffect, useRef, useState } from "react";
import { mintScannerMacaroon, type ScannerCreditGrant } from "@workspace/api-client-react";
import { isHttpFailure, parseChallenge, type Challenge } from "./use-audit-scanner";

type Phase = "idle" | "quoting" | "awaiting_payment" | "checking" | "complete" | "error" | "expired" | "cleared";

export type ScannerPack = "standard" | "heavy_swarm_1000";
export const PACKS: Record<ScannerPack, { credits: number; usd: number; days: number; label: string }> = {
  standard: { credits: 100, usd: 450, days: 30, label: "Scanner Block" },
  heavy_swarm_1000: { credits: 1000, usd: 4000, days: 90, label: "Heavy Swarm Pack" },
};
type PricedChallenge = Challenge & { pack: ScannerPack; credits: number };

function validGrant(value: ScannerCreditGrant, quote: PricedChallenge): boolean {
  return value?.macaroon === quote.macaroon && value.credits === quote.credits &&
    value.amount_sats === quote.amountSats && value.scope === "/api/scanner" &&
    Number.isSafeInteger(value.valid_until) && value.valid_until > Date.now() / 1000;
}

function quoteExpiry(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const ms = value > 1e12 ? value : value * 1000;
  // Stop automatic polling slightly before the server-locked quote expires.
  return Math.min(fallback, ms - 30_000);
}

/** Credentials stay in this mounted component only, never in storage or logs. */
export function usePrepaidCredits() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [challenge, setChallenge] = useState<PricedChallenge | null>(null);
  const [pack, setPack] = useState<ScannerPack>("standard");
  const [grant, setGrant] = useState<ScannerCreditGrant | null>(null);
  const [error, setError] = useState("");
  const current = useRef<PricedChallenge | null>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const request = useCallback((selected: ScannerPack, authorization?: string) => {
    const abort = new AbortController();
    controller.current = abort;
    // Redemption must repeat the exact pack body used for the quote.
    return mintScannerMacaroon(selected === "standard" ? {} : { pack: selected }, {
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
      const result = await request(quote.pack, `Macaroon ${quote.macaroon}`);
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
    const selected = pack;
    const product = PACKS[selected];
    const version = generation.current;
    active.current = true; setPhase("quoting"); setError("");
    try {
      await request(selected);
      if (!alive.current || version !== generation.current) return;
      // A new purchase must begin with a validated 402, never an unbound 200.
      throw new Error("Missing funding challenge");
    } catch (failure) {
      if (!alive.current || version !== generation.current) return;
      if (isHttpFailure(failure) && failure.status === 402) {
        try {
          const quote = parseChallenge(failure);
          const body = failure.data as { credits?: unknown; quote_expires_at?: unknown };
          if (!Number.isSafeInteger(quote.amountSats) || body.credits !== product.credits) throw new Error("Wrong product");
          const priced: PricedChallenge = { ...quote, pack: selected, credits: product.credits, expiresAt: quoteExpiry(body.quote_expires_at, quote.expiresAt) };
          current.current = priced; setChallenge(priced); setPhase("awaiting_payment");
        } catch {
          setPhase("error"); setError("Invalid payment quote for the selected pack. Do not pay this invoice.");
        }
      } else if (isHttpFailure(failure) && failure.status === 503) {
        setPhase("error"); setError("The BTC/USD spot oracle is unavailable, so no quote was issued. No payment was initiated; try again shortly.");
      } else {
        setPhase("error"); setError("Unable to request prepaid access. No payment was initiated.");
      }
    } finally {
      if (version === generation.current) active.current = false;
    }
  }, [grant, pack, request]);

  /** Adopt the exact server outage challenge; never create a replacement invoice. */
  const acceptContinuity = useCallback((failure: unknown): boolean => {
    if (!alive.current || active.current || current.current || grant ||
        !isHttpFailure(failure) || failure.status !== 402) return false;
    try {
      const body = failure.data as Record<string, unknown>;
      const quote = parseChallenge(failure);
      if (body.error !== "fiat_gateway_offline" ||
          body.fallback !== "native_lightning_active" ||
          body.payment_endpoint !== "/api/mint-macaroon" ||
          !Number.isSafeInteger(quote.amountSats) || body.credits !== 100)
        throw new Error("Wrong continuity product");
      const priced: PricedChallenge = { ...quote, pack: "standard", credits: 100, expiresAt: quoteExpiry(body.quote_expires_at, quote.expiresAt) };
      current.current = priced;
      setChallenge(priced); setError(""); setPhase("awaiting_payment");
      return true;
    } catch {
      setPhase("error"); setError("Invalid continuity invoice. Do not pay.");
      return false;
    }
  }, [grant]);

  const clear = useCallback(() => {
    if ((challenge || grant) && !window.confirm(grant
      ? "Have you copied your Macaroon? It cannot be displayed again after you discard it."
      : "Discard this original invoice? If already paid, keep this page and check payment instead.")) return;
    erase();
  }, [challenge, grant, erase]);

  return { phase, challenge, grant, error, pack, setPack, run, checkNow, clear, acceptContinuity };
}
