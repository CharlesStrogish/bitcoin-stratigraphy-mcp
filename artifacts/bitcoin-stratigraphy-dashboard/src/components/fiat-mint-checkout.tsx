import { useEffect, useRef, useState } from "react";
import {
  createFiatMintCheckout,
  getFiatMintStatus,
  claimFiatMintMacaroon,
  type ScannerCreditGrant,
} from "@workspace/api-client-react";

type Status =
  | "loading"
  | "none"
  | "checkout"
  | "paid"
  | "paying"
  | "ready"
  | "delivered"
  | "failed";

/** The only persistent browser state is a server-set HttpOnly ownership cookie. */
export default function FiatMintCheckout({
  lightningPending = false,
  onPendingChange,
}: {
  lightningPending?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<ScannerCreditGrant | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    onPendingChange?.(
      busy || ["checkout", "paid", "paying", "ready"].includes(status),
    );
  }, [busy, status, onPendingChange]);
  const options = () => ({
    credentials: "same-origin" as const,
    cache: "no-store" as const,
    signal: AbortSignal.timeout(25_000),
  });

  async function refresh() {
    try {
      const response = await getFiatMintStatus(options());
      if (alive.current) {
        setStatus(response.status);
        setError("");
      }
    } catch {
      if (alive.current) {
        setStatus((s) => (s === "loading" ? "none" : s));
        setError(
          "Stripe test Checkout is not configured or purchase recovery is unavailable. No new payment has been started.",
        );
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!["checkout", "paid", "paying"].includes(status)) return;
    let count = 0;
    const timer = setInterval(() => {
      if (++count >= 40) {
        clearInterval(timer);
        return;
      }
      void refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [status]);

  async function checkout() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await createFiatMintCheckout({}, options());
      if (!session.url.startsWith("https://checkout.stripe.com/"))
        throw new Error("Unexpected checkout URL");
      window.location.assign(session.url);
    } catch {
      setError(
        "Checkout could not be opened. Check the original purchase before trying again.",
      );
      setBusy(false);
      void refresh();
    }
  }
  async function claim() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await claimFiatMintMacaroon(options());
      if (alive.current) {
        setGrant(result);
        setStatus("delivered");
      }
    } catch {
      if (alive.current)
        setError(
          "Credential reveal was interrupted or already completed. Contact the operator; do not purchase again.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="fn-prepaid-mint"
      aria-labelledby="fiat-mint-title"
      data-testid="fiat-mint-checkout"
    >
      <h3 id="fiat-mint-title" className="fn-h3">
        Buy with Credit Card
      </h3>
      <p className="fn-hint">
        $500 Enterprise API Block · Stripe test mode · 100 scanner calls for 30
        days.
      </p>
      <p className="fn-note">
        No Lightning wallet required. Test charges move no fiat. Scanner credits
        are issued only after operator-enabled treasury funding is verified.
      </p>
      {!grant && (status === "none" || status === "checkout") && (
        <button
          type="button"
          className="fn-btn"
          disabled={busy || lightningPending}
          onClick={() => void checkout()}
          data-testid="button-card-checkout"
        >
          {busy
            ? "Opening Stripe…"
            : status === "checkout"
              ? "Resume Stripe Checkout"
              : "Buy with Credit Card — Test"}
        </button>
      )}
      {lightningPending && (
        <p className="fn-hint">
          Finish or dismiss the original Lightning invoice before starting a
          card purchase.
        </p>
      )}
      {(status === "paid" || status === "paying") && (
        <p className="fn-status" role="status">
          Card test payment confirmed. Treasury funding is pending. Do not pay
          again.
        </p>
      )}
      {status === "ready" && (
        <>
          <p className="fn-msg" role="status">
            Funding verified. Reveal only when you are ready to copy: this
            credential is shown once.
          </p>
          <button
            type="button"
            className="fn-btn fn-btn-primary"
            disabled={busy}
            onClick={() => void claim()}
          >
            Reveal funded Macaroon once
          </button>
        </>
      )}
      {grant && (
        <>
          <p className="fn-msg" role="alert">
            Copy immediately. This Macaroon will not be displayed again after
            you leave.
          </p>
          <textarea
            aria-label="Funded scanner Macaroon"
            className="fn-textarea"
            readOnly
            rows={4}
            value={grant.macaroon}
            autoComplete="off"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="fn-hint">
            100 calls · POST /api/scanner · expires{" "}
            {new Date(grant.valid_until * 1000).toLocaleString()}. Use{" "}
            <code>Authorization: Macaroon &lt;token&gt;</code>.
          </p>
          <button
            type="button"
            className="fn-btn"
            onClick={() => {
              if (!navigator.clipboard) {
                setError("Select and copy the credential manually.");
                return;
              }
              void navigator.clipboard.writeText(grant.macaroon).then(
                () => setCopied(true),
                () =>
                  setError(
                    "Clipboard unavailable. Select and copy the credential manually.",
                  ),
              );
            }}
          >
            {copied ? "Copied" : "Copy Macaroon"}
          </button>
          <button
            type="button"
            className="fn-btn"
            onClick={() => setGrant(null)}
          >
            Discard from page
          </button>
        </>
      )}
      {!grant && status === "delivered" && (
        <p className="fn-hint">
          This purchase's credential has already been revealed. It is not
          displayed again.
        </p>
      )}
      {status === "failed" && (
        <p role="alert" className="fn-msg fn-msg-error">
          Treasury funding failed. Contact the operator; do not pay again.
        </p>
      )}
      {status !== "none" && !grant && (
        <button
          type="button"
          className="fn-btn fn-btn-quiet"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Check original purchase
        </button>
      )}
      {error && (
        <p role="alert" className="fn-msg fn-msg-error">
          {error}
        </p>
      )}
    </section>
  );
}
