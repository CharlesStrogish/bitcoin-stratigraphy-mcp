// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { logger } from "../lib/logger";
import { buildProvenanceChain } from "../services/provenanceChain";
import {
  OtsCalendarsUnavailableError,
  OtsCliTimeoutError,
  STAMP_CALENDARS,
  type ProvenanceAnchor,
} from "../services/otsProvenance";
import { readDataset } from "./stratigraphy";
import { registerProvenanceRoutes } from "./provenance";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serve(app: ReturnType<typeof express>): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("public provenance endpoints expose the current chain and unanchored state", async () => {
  const records = await readDataset();
  const state = buildProvenanceChain(records);
  const app = express();
  registerProvenanceRoutes(app, {
    readRecords: async () => records,
    getAnchor: async () => undefined,
  });
  const baseUrl = await serve(app);

  const chainResponse = await fetch(`${baseUrl}/api/provenance/chain`);
  assert.equal(chainResponse.status, 200);
  assert.deepEqual(await chainResponse.json(), {
    totalDepth: state.totalDepth,
    merkleRoot: state.merkleRoot,
    latestOtsStatus: "not_anchored",
    genesisHash: state.genesisHash,
    headHash: state.headHash,
  });

  const anchorResponse = await fetch(`${baseUrl}/api/provenance/anchor`);
  assert.equal(anchorResponse.status, 200);
  assert.deepEqual(await anchorResponse.json(), {
    headHash: state.headHash,
    merkleRoot: state.merkleRoot,
    totalDepth: state.totalDepth,
    otsStatus: "not_anchored",
  });
});

test("operator anchor endpoint fails closed and requires the Bearer secret", async () => {
  const records = await readDataset();
  const state = buildProvenanceChain(records);
  const app = express();
  let anchored: ProvenanceAnchor | undefined;
  let anchorCalls = 0;
  registerProvenanceRoutes(app, {
    readRecords: async () => records,
    getAnchor: async () => anchored,
    anchor: async (input) => {
      anchorCalls += 1;
      anchored = {
        ...input,
        otsProof: Buffer.from("genuine-test-receipt").toString("base64"),
        otsStatus: "pending_calendar",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      return anchored;
    },
    operatorSecret: "test-operator-secret",
  });
  const baseUrl = await serve(app);

  const missingToken = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
  });
  assert.equal(missingToken.status, 401);
  assert.equal(anchorCalls, 0);

  const wrongToken = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
    headers: { authorization: "Bearer incorrect" },
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(anchorCalls, 0);

  const authorized = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
    headers: { authorization: "Bearer test-operator-secret" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), anchored);
  assert.equal(anchorCalls, 1);

  const publicAnchor = await fetch(`${baseUrl}/api/provenance/anchor`);
  assert.equal(publicAnchor.status, 200);
  const publicAnchorBody = (await publicAnchor.json()) as ProvenanceAnchor;
  assert.equal(publicAnchorBody.headHash, state.headHash);
  assert.equal(publicAnchorBody.merkleRoot, state.merkleRoot);
  assert.equal(publicAnchorBody.totalDepth, state.totalDepth);
  assert.equal(publicAnchorBody.otsStatus, "pending_calendar");
  assert.equal(publicAnchorBody.otsProof, anchored?.otsProof);
});

test("operator anchor endpoint returns 503 when no operator secret is configured", async () => {
  const records = await readDataset();
  const app = express();
  registerProvenanceRoutes(app, {
    readRecords: async () => records,
    operatorSecret: "",
  });
  const baseUrl = await serve(app);

  const response = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
    headers: { authorization: "Bearer anything" },
  });
  assert.equal(response.status, 503);
});

test("registration never stamps; scheduled anchoring starts once, after its delay, and stops", async () => {
  const records = await readDataset();
  const app = express();
  let anchorCalls = 0;
  const anchoring = registerProvenanceRoutes(app, {
    readRecords: async () => records,
    getAnchor: async () => undefined,
    anchor: async (input) => {
      anchorCalls += 1;
      return {
        ...input,
        otsProof: Buffer.from("genuine-test-receipt").toString("base64"),
        otsStatus: "pending_calendar",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
    },
  });
  // Startup registration must not reach OpenTimestamps calendars.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(anchorCalls, 0);

  const stop = anchoring.start(20);
  const duplicateStop = anchoring.start(0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    anchorCalls,
    0,
    "a second start must not schedule another stamp",
  );
  const deadline = Date.now() + 5_000;
  while (anchorCalls === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(anchorCalls, 1);
  duplicateStop();
  stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(anchorCalls, 1);
});

test("a calendar outage is a warning with one later retry, never an error", async (t) => {
  const records = await readDataset();
  const warnings = t.mock.method(logger, "warn", () => undefined);
  const errors = t.mock.method(logger, "error", () => undefined);
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) await sleep(5);
  };
  const register = (outages: number, retryDelayMs: number) => {
    const app = express();
    const state = { calls: 0 };
    const anchoring = registerProvenanceRoutes(app, {
      readRecords: async () => records,
      getAnchor: async () => undefined,
      operatorSecret: "operator-test-secret",
      retryDelayMs,
      anchor: async (input) => {
        state.calls += 1;
        if (state.calls <= outages) {
          throw new OtsCalendarsUnavailableError(
            STAMP_CALENDARS.map((calendar) => ({
              calendar,
              reason: "timed_out" as const,
            })),
          );
        }
        return {
          ...input,
          otsProof: Buffer.from("genuine-test-receipt").toString("base64"),
          otsStatus: "pending_calendar",
          updatedAt: "2025-01-01T00:00:00.000Z",
        };
      },
    });
    return { app, anchoring, state };
  };

  // Recovers on the single retry.
  const recovered = register(1, 20);
  let stop = recovered.anchoring.start(0);
  await waitFor(() => recovered.state.calls === 2);
  stop();
  assert.equal(recovered.state.calls, 2);
  assert.equal(warnings.mock.callCount(), 1);

  // A repeated outage waits for the next scheduled stamp, not another retry.
  const repeated = register(2, 20);
  stop = repeated.anchoring.start(0);
  await waitFor(() => warnings.mock.callCount() === 3);
  await sleep(100);
  stop();
  assert.equal(repeated.state.calls, 2);
  assert.equal(warnings.mock.callCount(), 3);

  // Stopping cancels a pending retry.
  const stopped = register(1, 100);
  stop = stopped.anchoring.start(0);
  await waitFor(() => warnings.mock.callCount() === 4);
  stop();
  await sleep(200);
  assert.equal(stopped.state.calls, 1);

  // An operator request during an outage still answers 503, with a warning.
  const operator = register(1, 20);
  const response = await fetch(
    `${await serve(operator.app)}/api/provenance/anchor`,
    {
      method: "POST",
      headers: { authorization: "Bearer operator-test-secret" },
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Unable to anchor current provenance state",
  });
  assert.equal(warnings.mock.callCount(), 5);
  assert.equal(errors.mock.callCount(), 0);
});

test("any failed scheduled stamp is retried once; CLI timeouts warn and other failures are errors", async (t) => {
  const records = await readDataset();
  const warnings = t.mock.method(logger, "warn", () => undefined);
  const errors = t.mock.method(logger, "error", () => undefined);
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) await sleep(5);
  };
  const retryInMs = (call: { arguments: unknown[] }) =>
    (call.arguments[0] as { retryInMs?: number }).retryInMs;
  const register = (failures: Error[]) => {
    const state = { calls: 0 };
    const anchoring = registerProvenanceRoutes(express(), {
      readRecords: async () => records,
      getAnchor: async () => undefined,
      retryDelayMs: 20,
      anchor: async (input) => {
        const failure = failures[state.calls];
        state.calls += 1;
        if (failure) throw failure;
        return {
          ...input,
          otsProof: Buffer.from("genuine-test-receipt").toString("base64"),
          otsStatus: "pending_calendar",
          updatedAt: "2025-01-01T00:00:00.000Z",
        };
      },
    });
    return { anchoring, state };
  };

  // A CLI timeout is transient: a warning, then a successful retry.
  const timedOut = register([new OtsCliTimeoutError()]);
  let stop = timedOut.anchoring.start(0);
  await waitFor(() => timedOut.state.calls === 2);
  stop();
  assert.equal(timedOut.state.calls, 2);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(retryInMs(warnings.mock.calls[0]!), 20);
  assert.equal(errors.mock.callCount(), 0);

  // Any other failure is an error, and is also retried once, not repeatedly.
  const failed = register([
    new Error("database offline"),
    new Error("database offline"),
  ]);
  stop = failed.anchoring.start(0);
  await waitFor(() => errors.mock.callCount() === 2);
  await sleep(100);
  stop();
  assert.equal(failed.state.calls, 2);
  assert.deepEqual(errors.mock.calls.map(retryInMs), [20, undefined]);
  assert.equal(warnings.mock.callCount(), 1);
});

test("start pre-warms the CLI once, primes the anchor read, and stop cancels a pending warm-up", async (t) => {
  const records = await readDataset();
  const state = buildProvenanceChain(records);
  const infos = t.mock.method(logger, "info", () => undefined);
  const warnings = t.mock.method(logger, "warn", () => undefined);
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) await sleep(5);
  };
  const register = (prewarmCli: () => Promise<void>, warmupDelayMs: number) => {
    const calls = { prewarm: 0, anchorReads: [] as string[], stamps: 0 };
    const anchoring = registerProvenanceRoutes(express(), {
      readRecords: async () => records,
      getAnchor: async (headHash) => {
        calls.anchorReads.push(headHash);
        return undefined;
      },
      anchor: async () => {
        calls.stamps += 1;
        throw new Error("stamping is not under test");
      },
      prewarmCli: async () => {
        calls.prewarm += 1;
        await prewarmCli();
      },
      warmupDelayMs,
    });
    return { anchoring, calls };
  };

  const warmed = register(async () => undefined, 20);
  let stop = warmed.anchoring.start(60_000);
  const duplicateStop = warmed.anchoring.start(0);
  await waitFor(() => warmed.calls.anchorReads.length === 1);
  await sleep(50);
  duplicateStop();
  stop();
  assert.equal(warmed.calls.prewarm, 1);
  assert.deepEqual(warmed.calls.anchorReads, [state.headHash]);
  assert.equal(warmed.calls.stamps, 0);
  assert.ok(
    infos.mock.calls.some(
      (call) => call.arguments[1] === "OpenTimestamps CLI pre-warmed",
    ),
  );

  // A failed warm-up is only a warning; nothing depends on it.
  const failing = register(async () => {
    throw new OtsCliTimeoutError();
  }, 0);
  stop = failing.anchoring.start(60_000);
  await waitFor(() => warnings.mock.callCount() === 1);
  stop();
  assert.equal(failing.calls.anchorReads.length, 0);
  assert.match(String(warnings.mock.calls[0]!.arguments[1]), /warm-up failed/);

  // Stopping before the delay cancels the warm-up.
  const cancelled = register(async () => undefined, 50);
  stop = cancelled.anchoring.start(60_000);
  stop();
  await sleep(120);
  assert.equal(cancelled.calls.prewarm, 0);
});
