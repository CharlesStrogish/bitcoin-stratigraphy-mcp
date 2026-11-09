import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [css, page, qr] = await Promise.all([
  readFile(new URL("../src/pages/funnel.css", import.meta.url), "utf8"),
  readFile(new URL("../src/pages/audit.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/invoice-qr.tsx", import.meta.url), "utf8"),
]);
const rule = (selector) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];

test("payment QR is centered without an extra frame and retains its scanning quiet zone", () => {
  assert.match(rule(".fn-pay-qr"), /width: min\(100%, 256px\)/);
  assert.match(rule(".fn-pay-qr"), /margin: 8px auto 0/);
  assert.match(rule(".fn-pay-qr"), /padding: 0; border: 0; background: transparent/);
  assert.match(qr, /marginSize=\{4\}/);
  assert.match(rule(".fn-pay"), /padding: 32px/);
});

test("wallet actions follow the QR in one centered, uniform-width stack", () => {
  const qrStart = page.indexOf('<div className="fn-pay-qr">');
  const actionsStart = page.indexOf('<div className="fn-pay-actions">');
  assert.ok(qrStart > 0 && actionsStart > qrStart);
  const actions = page.slice(actionsStart, page.indexOf("</div>", actionsStart));
  for (const action of ["link-wallet", "button-copy-invoice", "button-check-payment"]) {
    assert.ok(actions.includes(`data-testid="${action}"`));
  }
  assert.match(rule(".fn-pay-actions"), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rule(".fn-pay-actions"), /gap: 12px/);
  assert.match(rule(".fn-pay-actions"), /width: min\(100%, 320px\)/);
  assert.match(rule(".fn-pay-actions .fn-btn"), /width: 100%/);
  assert.match(rule(".fn-pay-actions .fn-btn"), /min-height: 48px/);
});

test("retail fee is disclosed before submission and the quoted amount precedes the QR", () => {
  assert.match(page, /Fixed fee: 5,000 sats per scan/);
  assert.ok(page.indexOf('data-testid="text-scan-price"') < page.indexOf('data-testid="button-run-scan"'));
  assert.ok(page.indexOf("challenge.amountSats.toLocaleString") < page.indexOf('<InvoiceQr invoice='));
});
