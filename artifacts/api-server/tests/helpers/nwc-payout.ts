import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Nip47WalletError } from "@getalby/sdk";
import { createNwcPayout, type PayoutNwcClient } from "../../src/lib/nwc-payout";
import { parseYieldWithdrawalInvoice } from "../../src/lib/yield-withdrawal-invoice";

export const mockNwcUri = `nostr+walletconnect://${"ab".repeat(32)}?relay=wss%3A%2F%2Frelay.invalid&secret=${"cd".repeat(32)}`;
const preimages = new Map<string, string>();
export function mockPayoutHash(): string {
  const preimage = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  preimages.set(hash, preimage);
  return hash;
}

/** All CI outbound NWC calls terminate here, even with real injected secrets. */
export function mockNwcPayout() {
  let mode: "success" | "failure" | "timeout" | "ambiguous" = "success";
  let calls = 0;
  let lastInvoice: ReturnType<typeof parseYieldWithdrawalInvoice> | undefined;
  let observer: ((invoice: ReturnType<typeof parseYieldWithdrawalInvoice>) => Promise<void>) | undefined;
  const clientFactory = (uri: string): PayoutNwcClient => {
    assert.equal(uri, mockNwcUri);
    return {
      async payInvoice({ invoice }) {
        calls++;
        lastInvoice = parseYieldWithdrawalInvoice(invoice, 0);
        await observer?.(lastInvoice);
        if (mode === "timeout") throw new DOMException("mock relay timeout", "TimeoutError");
        if (mode === "failure") throw new Nip47WalletError("mock insufficient balance", "INSUFFICIENT_BALANCE");
        if (mode === "ambiguous") throw new Nip47WalletError("mock unknown wallet state", "INTERNAL");
        const preimage = preimages.get(lastInvoice.paymentHash);
        assert.ok(preimage, "Test invoices must have a known preimage");
        return { preimage, fees_paid: 0 };
      },
      async lookupInvoice({ payment_hash }) {
        if (!lastInvoice || mode !== "success") throw new Nip47WalletError("unknown", "NOT_FOUND");
        assert.equal(payment_hash, lastInvoice.paymentHash);
        return { type: "outgoing", state: "settled", payment_hash,
          amount: Number(lastInvoice.amountMsats), preimage: preimages.get(payment_hash)!,
          settled_at: 1, created_at: 1, expires_at: 1, invoice: "", description: "",
          description_hash: "", fees_paid: 0 };
      },
      close() {},
    };
  };
  return { client: createNwcPayout({ uri: () => mockNwcUri, clientFactory }),
    observe(callback: typeof observer) { observer = callback; },
    setMode(value: typeof mode) { mode = value; }, get calls() { return calls; } };
}
export async function migratePayoutFixture(client: { query(text: string): Promise<unknown> }) {
  await client.query(await readFile("../../scripts/sql/mainnet-yield-payouts.sql", "utf8"));
  await client.query(await readFile("../../scripts/sql/yield-staking.sql", "utf8"));
}
