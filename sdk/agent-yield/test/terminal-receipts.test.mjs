import test from "node:test";
import assert from "node:assert/strict";
import { terminalReceipt } from "../dist/sdk/agent-yield/src/terminal-receipts.js";

test("receipts preserve fractional sats and large integer precision without reflecting invalid amounts", t => {
  const lines = [];
  t.mock.method(console, "error", line => lines.push(line));
  const prior = process.env.QUIET_STRATIGRAPHY;
  delete process.env.QUIET_STRATIGRAPHY;
  t.after(() => {
    if (prior === undefined) delete process.env.QUIET_STRATIGRAPHY;
    else process.env.QUIET_STRATIGRAPHY = prior;
  });
  for (const amount of ["1", "21010", "9007199254740993123"]) terminalReceipt("allocated", amount);
  assert.match(lines[0], /0\.001 Sats/);
  assert.match(lines[1], /21\.01 Sats/);
  assert.match(lines[2], /9007199254740993\.123 Sats/);
  for (const amount of ["0", "-1", "NaN", "1.2", "\x1b[31msecret"]) terminalReceipt("settled", amount);
  assert.equal(lines.length, 3);
  process.env.QUIET_STRATIGRAPHY = "TRUE";
  terminalReceipt("settled", "21000");
  assert.equal(lines.length, 3);
});
