// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { createHash } from "node:crypto";

/** Regression client: solve the advertised admission, never bypass the gate. */
export const powFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  if (response.status !== 400) return response;
  type Challenge = { algorithm: string; challenge: string; difficulty: number };
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    proof_of_work?: Challenge;
    error?: { data?: { proof_of_work?: Challenge } };
  } | null;
  const pow = body?.proof_of_work ?? body?.error?.data?.proof_of_work;
  if (!pow) return response;
  if (
    pow.algorithm !== "sha256" ||
    !Number.isInteger(pow.difficulty) ||
    pow.difficulty < 2 ||
    pow.difficulty > 4
  )
    throw new Error("Invalid server PoW parameters");
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    if (
      createHash("sha256")
        .update(`${pow.challenge}:${nonce}`)
        .digest("hex")
        .startsWith("0".repeat(pow.difficulty))
    ) {
      const headers = new Headers(init?.headers);
      headers.set("X-L402-PoW-Challenge", pow.challenge);
      headers.set("X-L402-PoW-Nonce", String(nonce));
      return globalThis.fetch(input, { ...init, headers });
    }
  }
  throw new Error("Test proof-of-work budget exceeded");
};
