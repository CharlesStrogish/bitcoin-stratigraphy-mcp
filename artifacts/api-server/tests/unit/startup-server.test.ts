// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  createStartupServer,
  type StartupServer,
} from "../../src/lib/startup-server";

const started: StartupServer[] = [];

after(async () => {
  for (const startup of started) {
    startup.server.closeAllConnections();
    await new Promise<void>((resolve) => startup.server.close(() => resolve()));
  }
});

async function listen(options?: Parameters<typeof createStartupServer>[0]) {
  const startup = createStartupServer(options);
  started.push(startup);
  await startup.listen(0, "127.0.0.1");
  const { port } = startup.server.address() as AddressInfo;
  return { startup, base: `http://127.0.0.1:${port}` };
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("holds requests until the application attaches, then replays them in arrival order", async () => {
  const { startup, base } = await listen();
  const first = fetch(`${base}/first`);
  await until(() => startup.heldRequests === 1, "the first held request");
  const second = fetch(`${base}/second`, {
    method: "POST",
    body: "held request body",
  });
  await until(() => startup.heldRequests === 2, "the second held request");

  const seen: string[] = [];
  startup.attach((req, res) => {
    seen.push(req.url ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          url: req.url,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  assert.equal(startup.heldRequests, 0);
  assert.deepEqual(seen, ["/first", "/second"]);
  const responses = await Promise.all([first, second]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.deepEqual(await responses[1]!.json(), {
    url: "/second",
    body: "held request body",
  });
  assert.deepEqual(await responses[0]!.json(), { url: "/first", body: "" });

  const direct = await fetch(`${base}/after-attach`);
  assert.equal(direct.status, 200);
  assert.deepEqual(seen, ["/first", "/second", "/after-attach"]);
});

test("answers 503 with Retry-After when the application does not attach in time", async () => {
  const { startup, base } = await listen({ maxHoldMs: 30 });
  const response = await fetch(`${base}/api/healthz`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "Server is starting; retry shortly",
  });
  assert.equal(startup.heldRequests, 0);
});

test("bounds the number of held requests", async () => {
  const { startup, base } = await listen({ maxHeldRequests: 1 });
  const held = fetch(`${base}/held`);
  await until(() => startup.heldRequests === 1, "the held request");
  const excess = await fetch(`${base}/excess`);
  assert.equal(excess.status, 503);
  startup.attach((_req, res) => res.end("served"));
  assert.equal(await (await held).text(), "served");
});

test("fail() answers held and later requests with 503", async () => {
  const { startup, base } = await listen();
  const held = fetch(`${base}/held`);
  await until(() => startup.heldRequests === 1, "the held request");
  startup.fail();
  assert.equal((await held).status, 503);
  assert.equal((await fetch(`${base}/later`)).status, 503);
  assert.throws(
    () => startup.attach((_req, res) => res.end()),
    /already failed/,
  );
});

test("forgets clients that disconnect while held", async () => {
  const { startup, base } = await listen();
  const controller = new AbortController();
  const abandoned = fetch(`${base}/abandoned`, {
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await until(() => startup.heldRequests === 1, "the held request");
  controller.abort();
  assert.ok((await abandoned) instanceof Error);
  await until(() => startup.heldRequests === 0, "the disconnect");
  let calls = 0;
  startup.attach((_req, res) => {
    calls += 1;
    res.end();
  });
  assert.equal(calls, 0);
});
