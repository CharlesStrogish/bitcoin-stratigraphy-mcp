import { useCallback, useEffect, useRef, useState } from "react";
import { scanArticle12Prompt, type ScannerReport } from "@workspace/api-client-react";

type Phase = "idle" | "quoting" | "awaiting_payment" | "checking" | "complete" | "error" | "expired";
type Challenge = { invoice: string; macaroon: string; amountSats: number; expiresAt: number };
type HttpFailure = { status: number; headers: Headers; data: unknown };

function isHttpFailure(error: unknown): error is HttpFailure {
  return typeof error === "object" && error !== null &&
    "status" in error && typeof error.status === "number" &&
    "headers" in error && error.headers instanceof Headers && "data" in error;
}

function parseChallenge(error: HttpFailure): Challenge {
  const header = error.headers.get("www-authenticate") ?? "";
  if (header.length > 32768 || /[\x00-\x1f\x7f]/.test(header)) throw new Error("Invalid challenge");
  const scheme = /^L402\s+(.+)$/i.exec(header);
  if (!scheme) throw new Error("Missing L402 challenge");
  let rest = scheme[1]!;
  const fields: Record<string, string> = {};
  while (rest) {
    const match = /^\s*(macaroon|invoice)\s*=\s*"([^"\\]+)"\s*(,|$)/i.exec(rest);
    if (!match || fields[match[1]!.toLowerCase()]) throw new Error("Ambiguous challenge");
    fields[match[1]!.toLowerCase()] = match[2]!;
    rest = rest.slice(match[0].length);
    if (match[3] && !rest.trim()) throw new Error("Invalid challenge");
  }
  if (!fields.macaroon || !/^[^\s:"\\]{1,24000}$/.test(fields.macaroon) ||
      !/^ln(?:bc|tb|bcrt)[a-z0-9]+$/i.test(fields.invoice ?? "")) throw new Error("Invalid challenge");
  const body = error.data as Record<string, unknown> | null;
  if (!body || typeof body !== "object" ||
      body.invoice !== fields.invoice || body.macaroon !== fields.macaroon ||
      typeof body.amount_sats !== "number" || !Number.isFinite(body.amount_sats) ||
      body.amount_sats <= 0) throw new Error("Inconsistent payment quote");
  return {
    invoice: fields.invoice!, macaroon: fields.macaroon, amountSats: body.amount_sats,
    // Scanner capabilities and invoices are issued for 900 seconds. Stop
    // polling slightly early; backend remains authoritative about expiry.
    expiresAt: Date.now() + 14 * 60_000,
  };
}

function validReport(value: ScannerReport): boolean {
  return value?.schema === "article12-heuristic/v1" &&
    ["Low", "Medium", "High"].includes(value.overall_risk_level) &&
    /^[0-9a-f]{64}$/.test(value.compliance_hash) &&
    /^[0-9a-f]{64}$/.test(value.prompt_sha256) &&
    value.receipt_type === "simulated_zk_receipt" &&
    typeof value.limitations === "string" &&
    Array.isArray(value.flagged_categories) &&
    value.flagged_categories.every((flag) =>
      ["pii_biometric", "financial_execution", "autonomous_deployment"].includes(flag.category) &&
      flag.risk_level === "High" && typeof flag.label === "string" && typeof flag.rationale === "string");
}

/** Keep prompts/capabilities only in memory; never persist or log them. */
export function useAuditScanner() {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [report, setReport] = useState<ScannerReport | null>(null);
  const [error, setError] = useState("");
  const current = useRef<Challenge | null>(null);
  const originalPrompt = useRef("");
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => () => {
    generation.current++;
    controller.current?.abort();
  }, []);

  const request = async (text: string, authorization?: string) => {
    const abort = new AbortController();
    controller.current = abort;
    return scanArticle12Prompt({ prompt: text }, {
      credentials: "omit", redirect: "error", cache: "no-store",
      headers: authorization ? { Authorization: authorization } : {},
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]),
    });
  };

  const checkNow = useCallback(async () => {
    const quoted = current.current;
    if (!quoted || active.current) return;
    if (Date.now() >= quoted.expiresAt) { setPhase("expired"); return; }
    active.current = true;
    const version = generation.current;
    setPhase("checking"); setError("");
    try {
      const result = await request(originalPrompt.current, `L402 ${quoted.macaroon}:NWC_LOOKUP`);
      if (version !== generation.current) return;
      if (!validReport(result)) throw new Error("Invalid report");
      setReport(result); setPhase("complete");
    } catch (failure) {
      if (version !== generation.current) return;
      if (isHttpFailure(failure) && failure.status === 409 &&
          (failure.data as { verification_pending?: boolean } | null)?.verification_pending === true) {
        setPhase("awaiting_payment");
      } else if (isHttpFailure(failure) && failure.status === 401) {
        setPhase("expired");
      } else {
        setPhase("error");
        setError("Payment verification or report retrieval failed. Your original invoice is retained. Do not pay again; check the same payment or contact the operator if a paid report is unavailable.");
      }
    } finally {
      if (version === generation.current) active.current = false;
    }
  }, []);

  useEffect(() => {
    if (phase !== "awaiting_payment" || !challenge) return;
    const timer = setInterval(() => {
      if (Date.now() >= challenge.expiresAt) setPhase("expired");
      else if (!document.hidden) void checkNow();
    }, 20_000);
    const onVisible = () => { if (!document.hidden) void checkNow(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [phase, challenge, checkNow]);

  useEffect(() => {
    if (!challenge || phase === "complete") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [challenge, phase]);

  const run = async () => {
    if (active.current || current.current || prompt.trim().length < 20 || prompt.length > 20000) return;
    active.current = true;
    const version = generation.current;
    originalPrompt.current = prompt;
    setPhase("quoting"); setError(""); setReport(null);
    try {
      const result = await request(prompt);
      if (version !== generation.current) return;
      if (!validReport(result)) throw new Error("Invalid report");
      setReport(result); setPhase("complete");
    } catch (failure) {
      if (version !== generation.current) return;
      if (isHttpFailure(failure) && failure.status === 402) {
        try {
          const quoted = parseChallenge(failure);
          current.current = quoted; setChallenge(quoted); setPhase("awaiting_payment");
        } catch {
          setError("The server returned an invalid payment challenge. No payment should be made.");
          setPhase("error");
        }
      } else {
        setError("Unable to request a scan. No payment was initiated. Please try again later.");
        setPhase("error");
      }
    } finally {
      if (version === generation.current) active.current = false;
    }
  };

  const reset = () => {
    if (current.current && phase !== "complete" &&
        !window.confirm("This discards your pending invoice from this browser. If you already paid, keep this session and check payment instead. Discard it?")) return;
    generation.current++; controller.current?.abort(); active.current = false;
    current.current = null; originalPrompt.current = "";
    setChallenge(null); setReport(null); setError(""); setPhase("idle"); setPrompt("");
  };

  return { prompt, setPrompt, phase, challenge, report, error, run, checkNow, reset };
}
