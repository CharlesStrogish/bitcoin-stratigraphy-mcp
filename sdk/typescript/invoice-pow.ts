// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
/** Bounded, one-retry solver for the pre-invoice Hashcash admission challenge.
 * It never pays invoices, changes request bodies, or retries failed payments.
 */
export function withInvoicePow(
  fetcher: typeof fetch,
  sha256: (input: string) => string | Promise<string> = async (input) => {
    const bytes = new TextEncoder().encode(input);
    const api = globalThis.crypto ?? (await import("node:crypto")).webcrypto;
    const digest = await api.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  },
): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (
      response.status !== 400 ||
      (init?.body != null && typeof init.body !== "string")
    )
      return response;
    let body;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    const details = body.proof_of_work ?? body.error?.data?.proof_of_work;
    if (!details) return response;
    if (
      details.algorithm !== "sha256" ||
      details.hash_input !== "challenge:nonce" ||
      typeof details.challenge !== "string" ||
      details.challenge.length > 1024 ||
      !Number.isInteger(details.difficulty) ||
      details.difficulty < 2 ||
      details.difficulty > 4
    )
      throw new Error("Unsupported invoice proof-of-work challenge");
    const expires = Date.parse(details.expires_at);
    if (!Number.isFinite(expires) || expires <= Date.now())
      throw new Error("Expired invoice proof-of-work challenge");
    const deadline = Math.min(expires, Date.now() + 20_000);
    const prefix = "0".repeat(details.difficulty);
    for (let nonce = 0; nonce < 1_000_000; nonce++) {
      if (nonce % 256 === 0) {
        init?.signal?.throwIfAborted();
        if (Date.now() >= deadline) break;
        // Yield even with a synchronous hash implementation.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if ((await sha256(`${details.challenge}:${nonce}`)).startsWith(prefix)) {
        const headers = new Headers(init?.headers);
        headers.set("X-L402-PoW-Challenge", details.challenge);
        headers.set("X-L402-PoW-Nonce", String(nonce));
        return fetcher(input, { ...init, headers });
      }
    }
    throw new Error("Invoice proof-of-work computation budget exceeded");
  };
}
