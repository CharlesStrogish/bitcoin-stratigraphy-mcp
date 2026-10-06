import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import {
  createMemoryRevenueLedger,
  type RevenueLedgerEntry,
} from "../artifacts/api-server/src/services/ledger";
import { registerRevenueAnalyticsRoutes } from "../artifacts/api-server/src/routes/analytics";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

function entry(
  index: number,
  overrides: Partial<RevenueLedgerEntry> = {},
): RevenueLedgerEntry {
  const preimage = (index + 10_000).toString(16).padStart(64, "0");
  return {
    id: `entry-${index}`,
    timestamp: new Date(NOW - index * 60_000).toISOString(),
    channel: index % 2 === 0 ? "L402" : "NIP-90",
    requestKind: index % 2 === 0 ? "stratigraphy" : "zk-proof",
    satsReceived: index % 2 === 0 ? 5 : 21,
    paymentHash: createHash("sha256")
      .update(Buffer.from(preimage, "hex"))
      .digest("hex"),
    preimage,
    clientIdentifier: `client-${index}`,
    ...overrides,
  };
}

test("records events and calculates rolling daily, total, and channel volume", async () => {
  const ledger = createMemoryRevenueLedger({ now: () => NOW });
  await ledger.record(entry(1));
  await ledger.record(entry(2));
  await ledger.record(
    entry(3, {
      timestamp: new Date(NOW - 25 * 60 * 60 * 1_000).toISOString(),
      satsReceived: 100,
    }),
  );
  assert.equal(await ledger.getDailyVolume(), 26);
  assert.equal(await ledger.getTotalVolume(), 126);
  assert.deepEqual(await ledger.getChannelBreakdown(), {
    "NIP-90": 121,
    L402: 5,
  });
});

test("calculates accurate daily goal progress", async () => {
  const ledger = createMemoryRevenueLedger({ now: () => NOW });
  await ledger.record(entry(1, { satsReceived: 125_000 }));
  const progress = await ledger.getGoalProgress();
  assert.deepEqual(progress, {
    targetSats: 500_000,
    currentSats: 125_000,
    remainingSats: 375_000,
    percentage: 25,
  });
});

test("handles concurrent unique entries and idempotent duplicate settlements", async () => {
  const ledger = createMemoryRevenueLedger({ now: () => NOW });
  const unique = Array.from({ length: 100 }, (_, index) => entry(index + 1));
  const inserted = await Promise.all(
    unique.map((candidate) => ledger.record(candidate)),
  );
  assert.equal(inserted.filter(Boolean).length, 100);
  const duplicateResults = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      ledger.record({
        ...unique[0]!,
        id: `duplicate-${index}`,
      }),
    ),
  );
  assert.ok(duplicateResults.every((result) => result === false));
  assert.equal(
    await ledger.getTotalVolume(),
    unique.reduce((sum, candidate) => sum + candidate.satsReceived, 0),
  );
});

test("sanitizes recent audit records", async () => {
  const ledger = createMemoryRevenueLedger({ now: () => NOW });
  const original = entry(1);
  await ledger.record(original);
  const [audit] = await ledger.getRecent();
  assert.ok(audit);
  assert.match(audit.paymentReference, /^[0-9a-f]{12}$/);
  assert.equal("preimage" in audit, false);
  assert.equal("clientIdentifier" in audit, false);
  assert.equal("paymentHash" in audit, false);
});

test("serves aggregate revenue metrics and a sanitized audit log", async () => {
  const ledger = createMemoryRevenueLedger({ now: () => NOW });
  await ledger.record(entry(1));
  await ledger.record(entry(2));
  const app = express();
  registerRevenueAnalyticsRoutes(app, ledger);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const revenue = await fetch(`${baseUrl}/api/v1/analytics/revenue`);
    assert.equal(revenue.status, 200);
    const metrics = (await revenue.json()) as {
      totalVolumeSats: number;
      volume24hSats: number;
      channelBreakdown: Record<string, number>;
      dailyGoal: { percentage: number };
    };
    assert.equal(metrics.totalVolumeSats, 26);
    assert.equal(metrics.volume24hSats, 26);
    assert.deepEqual(metrics.channelBreakdown, { "NIP-90": 21, L402: 5 });
    assert.equal(metrics.dailyGoal.percentage, 0.0052);

    const audit = await fetch(`${baseUrl}/api/v1/analytics/audit?limit=10`);
    assert.equal(audit.status, 200);
    const auditBody = await audit.text();
    assert.equal(auditBody.includes("preimage"), false);
    assert.equal(auditBody.includes("clientIdentifier"), false);
    assert.equal(auditBody.includes(entry(1).preimage), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});
