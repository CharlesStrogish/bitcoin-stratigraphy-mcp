import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCoinosPayout } from "../../src/lib/coinos-payout";
import { parseYieldWithdrawalInvoice } from "../../src/lib/yield-withdrawal-invoice";

/** All CI claim HTTP traffic terminates here, even if real secrets are injected. */
export function mockCoinosPayout() {
  let mode: "success" | "failure" | "timeout" | "ambiguous" = "success";
  let calls = 0;
  let lastInvoice: ReturnType<typeof parseYieldWithdrawalInvoice> | undefined;
  let observer: ((invoice: ReturnType<typeof parseYieldWithdrawalInvoice>) => Promise<void>) | undefined;
  const transport: typeof fetch = async (input, init) => {
    assert.ok(String(input).startsWith("https://coinos.io/api/payments"));
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer mock-rest-token");
    if (init?.method === "POST") {
      calls++;
      lastInvoice = parseYieldWithdrawalInvoice(JSON.parse(String(init.body)).payreq, 0);
      await observer?.(lastInvoice);
      if (mode === "timeout") throw new DOMException("mock network timeout", "TimeoutError");
      if (mode === "failure") return Response.json({ error: "Insufficient balance" }, { status: 400 });
      if (mode === "ambiguous") return Response.json({ error: "unknown upstream state" }, { status: 502 });
    }
    if (!lastInvoice) return Response.json([]);
    const row = { uid: "coinos-mock-tx-" + lastInvoice.paymentHash, hash: lastInvoice.paymentHash,
      amount: -Number(lastInvoice.amountMsats) / 1000, status: "settled", pending: false };
    return Response.json(init?.method === "GET" ? [row] : row);
  };
  return { client: createCoinosPayout({ token: () => "mock-rest-token", fetch: transport }),
    observe(callback: typeof observer) { observer = callback; },
    setMode(value: typeof mode) { mode = value; }, get calls() { return calls; } };
}
export async function migratePayoutFixture(client: { query(text: string): Promise<unknown> }) {
  await client.query(await readFile("../../scripts/sql/mainnet-yield-payouts.sql", "utf8"));
}
