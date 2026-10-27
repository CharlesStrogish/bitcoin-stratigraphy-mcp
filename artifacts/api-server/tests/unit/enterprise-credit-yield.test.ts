import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  createCreditHarness,
  identity,
  rpc,
  tabPath,
} from "../helpers/credit-harness";

after(async () => {
  await pool.end();
});

test("a 2000-sat payment opens a -420-sat balance and discounts the next 2000-sat tab to 1580", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker(),
      commander = identity();
    await h.seed(commander, 51);
    const fill = async () => {
      for (let i = 0; i < 8; i++) {
        const call = await h.request(i % 2 ? a : b, rpc(), commander);
        assert.equal(call.status, 200, JSON.stringify(call.body));
      }
    };
    const close = () =>
      h.request(a, {}, commander, { path: tabPath + "/close" });
    const settle = (url: string, auth: string) =>
      h.request(url, {}, commander, { path: tabPath + "/settle", auth });
    await fill();
    const first = await close();
    assert.equal(first.status, 402);
    assert.equal(first.body.amount_sats, 2000);
    assert.equal(first.body.yield_applied_msats, 0);
    const firstInvoice = h.invoices.get(first.body.payment_hash)!;
    const firstAuth = `L402 ${first.body.macaroon}:${firstInvoice.preimage}`;
    assert.equal(
      (await settle(a, firstAuth)).status,
      409,
      "unpaid invoice cannot mint yield",
    );
    assert.equal((await h.tabs.status(commander.pubkey)).yield_credit_msats, 0);
    firstInvoice.paid = true;
    h.unavailable(true);
    assert.equal((await settle(a, firstAuth)).status, 503);
    assert.equal((await h.tabs.status(commander.pubkey)).yield_credit_msats, 0);
    h.unavailable(false);
    const record = h.ledger.record;
    h.ledger.record = async () => {
      throw new Error("ledger offline");
    };
    assert.equal((await settle(a, firstAuth)).status, 503);
    assert.equal((await h.tabs.status(commander.pubkey)).yield_credit_msats, 0);
    h.ledger.record = record;
    const settled = await Promise.all(
      [a, b].map((url) => settle(url, firstAuth)),
    );
    assert.deepEqual(settled.map((r) => r.body.status).sort(), [
      "already_settled",
      "settled",
    ]);
    for (const result of settled) {
      assert.equal(result.body.balance_sats, -420);
      assert.equal(result.body.yield_credit_msats, 420000);
      assert.equal(
        result.body.unpaid_sats,
        0,
        "gross usage counter remains unchanged for fleet admission",
      );
    }
    const persisted = await pool.query(
      "SELECT yield_credit_msats,balance_msats FROM enterprise_credit_accounts WHERE pubkey=$1",
      [commander.pubkey],
    );
    assert.deepEqual(persisted.rows[0], {
      yield_credit_msats: 420000,
      balance_msats: -420000,
    });
    await fill();
    const second = await close();
    assert.equal(second.body.gross_amount_sats, 2000);
    assert.equal(second.body.amount_sats, 1580);
    assert.equal(second.body.yield_applied_msats, 420000);
    assert.equal(second.body.balance_sats, 1580);
    const secondInvoice = h.invoices.get(second.body.payment_hash)!;
    assert.equal(
      secondInvoice.amount,
      1580000,
      "wallet invoice must be the discounted amount",
    );
    assert.equal(
      (await close()).body.payment_hash,
      second.body.payment_hash,
      "quotes reuse the same discount",
    );
    const session = second.body.session_id;
    await settle(b, firstAuth);
    const unchanged = await h.tabs.status(commander.pubkey);
    assert.equal(unchanged.session_id, session);
    assert.equal(
      unchanged.yield_credit_msats,
      420000,
      "old proof cannot duplicate or spend treasury yield",
    );
    secondInvoice.paid = true;
    const paid = await settle(
      b,
      `L402 ${second.body.macaroon}:${secondInvoice.preimage}`,
    );
    assert.equal(paid.status, 200);
    assert.equal(
      paid.body.yield_earned_msats,
      331800,
      "21% is calculated on cash paid, not the pre-discount gross",
    );
    assert.equal(paid.body.balance_sats, -331.8);
    assert.equal(
      await h.ledger.getTotalVolume(),
      3580,
      "credits are never counted as cash revenue",
    );
    assert.equal(paid.body.trust_score, 53);
  } finally {
    await h.cleanup();
  }
});

test("fractional yield is exact in millisats and survives whole-sat invoice rounding", async () => {
  const h = createCreditHarness();
  try {
    const base = await h.worker(),
      commander = identity();
    await h.seed(commander, 51);
    const payOne = async (expectedSats: number) => {
      assert.equal((await h.request(base, rpc(), commander)).status, 200);
      const quote = await h.request(base, {}, commander, {
        path: tabPath + "/close",
      });
      assert.equal(quote.body.amount_sats, expectedSats);
      const invoice = h.invoices.get(quote.body.payment_hash)!;
      invoice.paid = true;
      return h.request(base, {}, commander, {
        path: tabPath + "/settle",
        auth: `L402 ${quote.body.macaroon}:${invoice.preimage}`,
      });
    };
    const first = await payOne(250);
    assert.equal(first.body.yield_credit_msats, 52500);
    assert.equal(first.body.balance_sats, -52.5);
    const second = await payOne(198);
    assert.equal(second.body.yield_earned_msats, 41580);
    assert.equal(
      second.body.yield_credit_msats,
      42080,
      "retain the previous half-sat plus new yield",
    );
    assert.equal(second.body.balance_msats, -42080);
    assert.equal(await h.ledger.getTotalVolume(), 448);
  } finally {
    await h.cleanup();
  }
});

test("treasury-covered tabs consume yield without zero invoices, new yield, or extra reputation", async () => {
  const h = createCreditHarness();
  try {
    const base = await h.worker(),
      commander = identity();
    await h.seed(commander, 51);
    for (let i = 0; i < 8; i++) await h.request(base, rpc(), commander);
    const quote = await h.request(base, {}, commander, {
      path: tabPath + "/close",
    });
    const invoice = h.invoices.get(quote.body.payment_hash)!;
    invoice.paid = true;
    await h.request(base, {}, commander, {
      path: tabPath + "/settle",
      auth: `L402 ${quote.body.macaroon}:${invoice.preimage}`,
    });
    await h.request(base, rpc(), commander);
    const covered = await h.request(base, {}, commander, {
      path: tabPath + "/close",
    });
    assert.equal(covered.status, 200);
    assert.equal(covered.body.status, "credit_applied");
    assert.equal(covered.body.yield_applied_msats, 250000);
    assert.equal(covered.body.balance_sats, -170);
    assert.equal(covered.body.trust_score, 52);
    assert.equal(h.invoices.size, 1);
    assert.equal(await h.ledger.getTotalVolume(), 2000);
    const again = await h.request(base, {}, commander, {
      path: tabPath + "/close",
    });
    assert.equal(
      again.body.yield_credit_msats,
      170000,
      "repeated close cannot spend yield twice",
    );
    await h.request(base, rpc(), commander);
    const discounted = await h.request(base, {}, commander, {
      path: tabPath + "/close",
    });
    assert.equal(discounted.body.amount_sats, 80);
    assert.equal(discounted.body.yield_applied_msats, 170000);
  } finally {
    await h.cleanup();
  }
});
