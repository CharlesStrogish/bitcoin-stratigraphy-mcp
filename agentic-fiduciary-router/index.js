import { resolve } from "node:path";
import { decodeInvoice, parseChallenge, sha256, verifyPreimage } from "./lib/invoice.js";
import { createNwcWallet } from "./lib/nwc-wallet.js";
import { FileState } from "./lib/state.js";

const ENGINE = "https://bitcoinstratigraphy.com";
const CLAIM_URL = `${ENGINE}/api/claim-yield`;
const sats = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("INTEGER_SATOSHI_LIMIT_REQUIRED");
  return BigInt(value) * 1000n;
};

/** Opt-in, budgeted native-fetch interceptor. Never installs a global monkeypatch. */
export class BitcoinStratigraphyRouter {
  #wallet;
  #fetch;
  #state;
  #pending = new Set();
  #perPayment;
  #total;
  #feeReserve;
  #timeout;
  #origins;
  #onYieldClaim;
  #onError;
  #identityHeaders;

  constructor({
    nwcUri, maxPaymentSats, maxTotalSats, feeReserveSats = 10,
    stateDirectory = resolve(".router-state"), timeoutMs = 65_000,
    allowedOrigins = [ENGINE], fetch: fetchImpl = globalThis.fetch,
    wallet, onYieldClaim = () => {}, onError = () => {},
    identityHeaders = async () => ({}),
  } = {}) {
    this.#perPayment = sats(maxPaymentSats);
    this.#total = sats(maxTotalSats);
    this.#feeReserve = sats(feeReserveSats);
    if (!this.#perPayment || !this.#total || !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 || timeoutMs > 120_000 || typeof fetchImpl !== "function") throw new Error("INVALID_ROUTER_POLICY");
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error("INVALID_ORIGIN_POLICY");
    this.#origins = new Set(allowedOrigins.map(origin => {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) throw new Error("HTTPS_ORIGIN_REQUIRED");
      return origin;
    }));
    this.#timeout = timeoutMs;
    this.#wallet = wallet ?? createNwcWallet(nwcUri, timeoutMs);
    this.#fetch = fetchImpl;
    this.#state = new FileState(stateDirectory);
    this.#onYieldClaim = onYieldClaim;
    this.#onError = onError;
    this.#identityHeaders = identityHeaders;
    this.fetch = this.fetch.bind(this);
  }

  async #request(request) {
    // Never follow a paid request or credential to another destination.
    return this.#fetch(new Request(request, { redirect: "error" }));
  }

  #notify(callback, value) {
    // Callbacks cannot turn a completed operation into a failure.
    try { Promise.resolve(callback(value)).catch(() => {}); } catch { /* Observer only. */ }
  }

  async fetch(input, init) {
    const request = new Request(input, init);
    // Callers' pre-existing credentials are not replaced or repurchased.
    const response = await this.#request(request.clone());
    if (response.status !== 402 || !this.#origins.has(new URL(request.url).origin) ||
        /^L402\s/i.test(request.headers.get("authorization") ?? "")) return response;
    const header = response.headers.get("www-authenticate");
    // Pass admission/x402/ordinary errors back to the framework unchanged.
    if (!header || !/^L402\s/i.test(header)) return response;
    const challenge = parseChallenge(header);
    const invoice = decodeInvoice(challenge.invoice);
    const bytes = Buffer.from(await request.clone().arrayBuffer());
    if (bytes.length > 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
    const binding = sha256(Buffer.concat([
      Buffer.from(`${request.method}\n${request.url}\n`), bytes,
      // Bind purchased batch/range context without persisting raw headers.
      Buffer.from(JSON.stringify([...request.headers].filter(([name]) =>
        !["authorization", "x-nostr-authorization"].includes(name)))),
    ]));
    if (response.headers.get("content-type")?.includes("application/json")) {
      let quote;
      try { quote = await response.clone().json(); } catch { throw new Error("INVALID_QUOTE"); }
      if (quote.macaroon !== challenge.macaroon || quote.invoice !== challenge.invoice ||
          quote.payment_hash !== invoice.paymentHash || !Number.isSafeInteger(quote.amount_sats) ||
          BigInt(quote.amount_sats) * 1000n !== invoice.amountMsats) throw new Error("QUOTE_MISMATCH");
    } else if (new URL(request.url).origin === ENGINE) {
      throw new Error("ENGINE_JSON_QUOTE_REQUIRED");
    }
    if (request.signal.aborted) throw new Error("REQUEST_ABORTED");
    if (invoice.expiresAt <= Date.now() + this.#timeout + 5000) throw new Error("INVOICE_EXPIRED_OR_TOO_CLOSE");
    const record = await this.#state.transaction(state => {
      const prior = state.invoices[invoice.paymentHash];
      if (prior) {
        if (prior.binding !== binding || prior.invoice !== challenge.invoice ||
            prior.macaroon !== challenge.macaroon) throw new Error("PAYMENT_SCOPE_MISMATCH");
        if (prior.status !== "paid") throw new Error("PAYMENT_PENDING_DO_NOT_REPAY");
        if (!verifyPreimage(prior.preimage, invoice.paymentHash)) throw new Error("STORED_PROOF_INVALID");
        return { ...prior, reused: true };
      }
      const reserve = invoice.amountMsats + this.#feeReserve;
      if (state.blocked || invoice.amountMsats > this.#perPayment ||
          BigInt(state.reservedMsats) + reserve > this.#total) throw new Error("SPENDING_LIMIT_EXCEEDED");
      state.reservedMsats = (BigInt(state.reservedMsats) + reserve).toString();
      state.invoices[invoice.paymentHash] = {
        status: "pending", binding, ...challenge,
        amountMsats: invoice.amountMsats.toString(),
      };
      return { reused: false };
    });
    let preimage = record.preimage;
    if (!record.reused) {
      let payment;
      try { payment = await this.#wallet.payInvoice(challenge.invoice); }
      catch { throw new Error("PAYMENT_UNCERTAIN_DO_NOT_REPAY"); }
      if (!verifyPreimage(payment?.preimage, invoice.paymentHash)) throw new Error("PAYMENT_PROOF_INVALID_DO_NOT_REPAY");
      preimage = payment.preimage.toLowerCase();
      await this.#state.transaction(state => {
        const entry = state.invoices[invoice.paymentHash];
        if (!entry || entry.status !== "pending" || entry.binding !== binding) throw new Error("STATE_CONFLICT");
        entry.status = "paid";
        entry.preimage = preimage;
        // NIP-47 does not standardize a sender-side fee ceiling. Fail closed
        // for future spending if the wallet reports more than our allowance.
        if (payment.fees_paid !== undefined &&
            (!Number.isSafeInteger(payment.fees_paid) || payment.fees_paid < 0 ||
             BigInt(payment.fees_paid) > this.#feeReserve)) state.blocked = true;
      });
    }
    if (invoice.expiresAt <= Date.now()) throw new Error("PAID_INVOICE_EXPIRED_RECOVER_PROOF");
    const headers = new Headers(request.headers);
    const nostr = headers.get("authorization");
    if (/^Nostr\s/i.test(nostr ?? "")) headers.set("X-Nostr-Authorization", nostr);
    const fresh = new Headers(await this.#identityHeaders(request.url, request.method, bytes));
    for (const [key, value] of fresh) headers.set(key, value);
    headers.set("Authorization", `L402 ${challenge.macaroon}:${preimage}`);
    const result = await this.#request(new Request(request, { headers }));
    // Data execution and yield payment are separate. Never buy another invoice.
    if (result.ok && new URL(request.url).origin === ENGINE) {
      const evidence = result.clone();
      let requestId;
      try { requestId = JSON.parse(bytes.toString()).id; } catch { /* Non-MCP JSON request. */ }
      const task = Promise.resolve().then(async () => {
        if (await this.#executionSucceeded(evidence, requestId)) await this.#claim(invoice.paymentHash);
      })
        .catch(() => this.#notify(this.#onError, { code: "YIELD_CLAIM_REQUIRES_RECOVERY" }));
      this.#pending.add(task);
      void task.finally(() => this.#pending.delete(task));
    }
    return result;
  }

  async #executionSucceeded(response, requestId) {
    const type = response.headers.get("content-type") ?? "";
    const success = body => {
      if (!body || typeof body !== "object" || body.error || body.isError === true ||
          body.result?.isError === true) return false;
      if (requestId !== undefined && body.id !== requestId) return false;
      if (response.status === 202 || body.result?.task ||
          (body.jsonrpc && !Object.hasOwn(body, "result"))) return false;
      return true;
    };
    try {
      const isJson = type.includes("application/json");
      if ((!isJson && (!type.includes("text/event-stream") || requestId === undefined)) ||
          !response.body) return false;
      // Observe a bounded clone in the background; do not delay the framework's
      // stream or mistake notifications/task handles for a completed tool result.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", size = 0, timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE_OBSERVATION_TIMEOUT")), this.#timeout);
      });
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done) return isJson ? success(JSON.parse(buffer + decoder.decode())) : false;
          size += value.byteLength;
          if (size > 1024 * 1024) return false;
          buffer += decoder.decode(value, { stream: true });
          if (isJson) continue;
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = event.split("\n").filter(line => line.startsWith("data:"))
              .map(line => line.slice(5).replace(/^ /, "")).join("\n");
            if (!data) continue;
            let payload;
            try { payload = JSON.parse(data); } catch { continue; }
            if (payload?.id === requestId) return success(payload);
          }
        }
      } finally {
        clearTimeout(timer);
        // Do not await tee cancellation: the caller may still own the other leg.
        void reader.cancel().catch(() => {});
      }
    } catch { return false; }
  }

  async #claim(paymentHash) {
    const entry = await this.#state.transaction(state => {
      const record = state.invoices[paymentHash];
      if (!record || record.status !== "paid" || record.claim) return null;
      record.claim = { status: "preparing" };
      return { ...record };
    });
    if (!entry) return;
    const amountMsats = BigInt(entry.amountMsats) * 21n / 100n;
    if (amountMsats <= 0n) throw new Error("CLAIM_TOO_SMALL");
    const made = await this.#wallet.makeInvoice(Number(amountMsats));
    const invoiceText = typeof made === "string" ? made : made?.invoice;
    const receiving = decodeInvoice(invoiceText);
    if (receiving.amountMsats !== amountMsats || receiving.expiresAt <= Date.now() + 30_000) {
      throw new Error("RECEIVING_INVOICE_MISMATCH");
    }
    const body = JSON.stringify({ macaroons: [entry.macaroon], bolt11_invoice: invoiceText });
    await this.#state.transaction(state => {
      state.invoices[paymentHash].claim = { status: "prepared", body };
    });
    await this.#postClaim(paymentHash, body);
  }

  async #postClaim(paymentHash, body) {
    const response = await this.#request(new Request(CLAIM_URL, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body, signal: AbortSignal.timeout(this.#timeout),
    }));
    let claim;
    try { claim = await response.json(); } catch { throw new Error("CLAIM_RESPONSE_INVALID"); }
    const settled = response.status === 200 && claim?.status === "SETTLED" && claim.payment_sent === true;
    const pending = response.status === 202 && claim?.status === "PENDING";
    const status = settled ? "settled" : pending ? "pending" : "recovery_required";
    const principal = await this.#state.transaction(state => {
      state.invoices[paymentHash].claim = { status, body, httpStatus: response.status, response: claim };
      return state.invoices[paymentHash].amountMsats;
    });
    this.#notify(this.#onYieldClaim, {
      status, claimId: claim?.claim_id, amountMsats: (BigInt(principal) * 21n / 100n).toString(),
    });
  }

  /** Replays only the already-persisted withdrawal body; never sends a payment. */
  async recoverClaim(paymentHash) {
    if (!/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error("INVALID_PAYMENT_HASH");
    const claim = await this.#state.transaction(state => state.invoices[paymentHash]?.claim);
    if (!claim?.body) throw new Error("NO_PREPARED_CLAIM_OPERATOR_RECOVERY_REQUIRED");
    if (claim.status === "settled") return;
    await this.#postClaim(paymentHash, claim.body);
  }

  /** Await best-effort claims before an orderly worker shutdown. */
  async drain() { while (this.#pending.size) await Promise.all([...this.#pending]); }
}
