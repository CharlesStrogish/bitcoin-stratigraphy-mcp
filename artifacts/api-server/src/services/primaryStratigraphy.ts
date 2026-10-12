// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const envelopeSchema = z.object({
  result: z.record(z.unknown()),
  targetHeights: z.array(z.number().int().nonnegative()),
}).strict();

export type PrimaryStratigraphyResult = z.infer<typeof envelopeSchema>;
export type PrimaryStratigraphyBackend = (
  tool: string, arguments_: Record<string, unknown>,
) => Promise<PrimaryStratigraphyResult>;

export class PrimaryStratigraphyUnavailable extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function createPrimaryStratigraphyBackend(input: {
  secret?: string;
  fetch?: typeof fetch;
} = {}): PrimaryStratigraphyBackend {
  return async (tool, arguments_) => {
    const secret = input.secret ?? process.env.SESSION_SECRET;
    if (!secret) throw new PrimaryStratigraphyUnavailable(503, "Live data bridge is not configured");
    const body = JSON.stringify({ tool, arguments: arguments_ });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}\n${nonce}\n${body}`).digest("hex");
    // Server-to-server loopback, not a browser URL or a public proxy dependency.
    const signal = AbortSignal.timeout(15_000);
    try {
      const response = await (input.fetch ?? fetch)(
        "http://127.0.0.1:8000/agent-api/internal/stratigraphy",
        {
          method: "POST", body, signal, redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-stratigraphy-time": timestamp,
            "x-stratigraphy-nonce": nonce,
            "x-stratigraphy-signature": signature,
          },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if ([404, 422].includes(response.status))
          throw new RangeError("No captured stratigraphy records match the requested real height/date");
        throw new PrimaryStratigraphyUnavailable(
          response.status === 409 ? 409 : 503,
          response.status === 409 ? "Archived proof is incomplete or invalid" : "Live stratigraphy or archive storage unavailable",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing data bridge response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error("Data bridge response exceeds size limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return envelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof RangeError || error instanceof PrimaryStratigraphyUnavailable) throw error;
      throw new PrimaryStratigraphyUnavailable(503, "Live stratigraphy data bridge unavailable; no legacy fallback");
    }
  };
}
