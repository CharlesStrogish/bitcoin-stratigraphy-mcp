import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import {
  createGroth16Verifier, ZkVerifierBusyError,
} from "../artifacts/api-server/src/services/zkVerifierWorker";
import { withComputeContext, computeContext, computeRequestContext } from "../artifacts/api-server/src/lib/compute-context";
import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools";

class FakeWorker extends EventEmitter {
  sent: { id: number; proof: unknown }[] = [];
  terminated = false;
  ref() { return this; }
  unref() { return this; }
  postMessage(job: { id: number; proof: unknown }) { this.sent.push(job); }
  async terminate() { this.terminated = true; this.emit("exit", 1); return 1; }
  reply(valid = true) {
    this.emit("message", { id: this.sent.at(-1)!.id, valid });
  }
}
const input = (proof = "proof") => ({ verificationKey: {}, publicSignals: [], proof });
function fixture(options: { maxPending?: number; maxPerIdentity?: number; timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const verifier = createGroth16Verifier({
    ...options,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { verifier, workers };
}

test("bounds total and per-identity admissions without starting extra workers", async () => {
  const { verifier, workers } = fixture({ maxPending: 3, maxPerIdentity: 2 });
  const a = verifier.verify(input(), "a");
  const b = verifier.verify(input(), "a");
  await assert.rejects(verifier.verify(input(), "a"), ZkVerifierBusyError);
  const c = verifier.verify(input(), "b");
  await assert.rejects(verifier.verify(input(), "c"), ZkVerifierBusyError);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.sent.length, 1);
  workers[0]!.reply(); workers[0]!.reply(); workers[0]!.reply(false);
  assert.deepEqual(await Promise.all([a, b, c]), [true, false, true]);
  await verifier.terminate();
});

test("round-robins queued identities and reuses the warm worker", async () => {
  const { verifier, workers } = fixture();
  const jobs = [
    verifier.verify(input("a1"), "a"),
    verifier.verify(input("a2"), "a"),
    verifier.verify(input("a3"), "a"),
    verifier.verify(input("b1"), "b"),
    verifier.verify(input("b2"), "b"),
  ];
  for (let i = 0; i < jobs.length; i++) workers[0]!.reply();
  assert.deepEqual(workers[0]!.sent.map(job => job.proof), ["a1", "b1", "a2", "b2", "a3"]);
  assert.deepEqual(await Promise.all(jobs), [true, true, true, true, true]);
  await verifier.terminate();
});

test("an active timeout replaces only that job's worker and preserves queued jobs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { verifier, workers } = fixture({ timeoutMs: 100 });
  const first = assert.rejects(verifier.verify(input(), "a"), /exceeded/);
  t.mock.timers.tick(50);
  const next = verifier.verify(input(), "b");
  t.mock.timers.tick(50);
  await first;
  await turn();
  assert.equal(workers[0]!.terminated, true);
  assert.equal(workers.length, 2);
  workers[0]!.reply(false); // A stale message cannot complete the replacement's job.
  workers[1]!.reply();
  assert.equal(await next, true);
  await verifier.terminate();
});

test("a queued timeout does not terminate the active worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { verifier, workers } = fixture({ timeoutMs: 200 });
  const a = verifier.verify(input("a"), "a");
  const b = verifier.verify(input("b1"), "b");
  t.mock.timers.tick(10);
  const expired = assert.rejects(verifier.verify(input("b2"), "b"), /exceeded/);
  t.mock.timers.tick(10);
  const c = verifier.verify(input("c"), "c");
  workers[0]!.reply(); // a -> b1; b's bucket rotates behind c.
  workers[0]!.reply(); // b1 -> c, which has a later deadline than b2.
  t.mock.timers.tick(190);
  await expired;
  assert.equal(workers[0]!.terminated, false);
  assert.equal(workers[0]!.sent.at(-1)!.proof, "c");
  workers[0]!.reply();
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  await verifier.terminate();
});

test("queued cancellation frees capacity without killing another identity's active proof", async () => {
  const { verifier, workers } = fixture({ maxPending: 2 });
  const controller = new AbortController();
  const a = verifier.verify(input(), "a");
  const b = assert.rejects(verifier.verify(input(), "b", controller.signal), /aborted/);
  controller.abort();
  await b;
  assert.equal(workers[0]!.terminated, false);
  const c = verifier.verify(input(), "c");
  workers[0]!.reply(); workers[0]!.reply();
  assert.deepEqual(await Promise.all([a, c]), [true, true]);
  await verifier.terminate();
});

test("worker exceptions and postMessage errors do not discard queued callers or leak admission", async () => {
  const { verifier, workers } = fixture({ maxPerIdentity: 1 });
  const a = assert.rejects(verifier.verify(input(), "a"), /worker failed/);
  const b = verifier.verify(input(), "b");
  workers[0]!.emit("error", new Error("synthetic failure"));
  await a; await turn();
  workers[1]!.reply();
  assert.equal(await b, true);
  workers[1]!.postMessage = () => { throw new Error("DataCloneError"); };
  await assert.rejects(verifier.verify(input(), "a"), /could not accept/);
  await turn();
  const retry = verifier.verify(input(), "a");
  workers[2]!.reply();
  assert.equal(await retry, true);
  await verifier.terminate();
});

test("shutdown rejects active and queued jobs and permits clean later startup", async () => {
  const { verifier, workers } = fixture();
  const a = assert.rejects(verifier.verify(input(), "a"), /stopped/);
  const b = assert.rejects(verifier.verify(input(), "b"), /stopped/);
  await verifier.terminate();
  await Promise.all([a, b]);
  const retry = verifier.verify(input(), "a");
  workers[1]!.reply();
  assert.equal(await retry, true);
  await verifier.terminate();
});

test("deferred work retains its own verified compute context, not the queue pump's identity", () => {
  const work = withComputeContext({ identity: "verified-a" },
    () => AsyncResource.bind(() => computeContext()?.identity));
  assert.equal(withComputeContext({ identity: "verified-b" }, work), "verified-a");
});

function requestContext(signed = false, tamper = false) {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "proof.verify", arguments: {} } };
  const origin = new URL(process.env.NIP98_PUBLIC_ORIGIN ?? "https://compute.example").origin;
  const event = finalizeEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
    tags: [["u", `${origin}/mcp`], ["method", "POST"],
      ["payload", createHash("sha256").update(JSON.stringify(body)).digest("hex")]],
  }, Buffer.from("01".padStart(64, "0"), "hex"));
  const req = Object.assign(new EventEmitter(), {
    body: tamper ? { ...body, id: 2 } : body,
    protocol: "https", originalUrl: "/mcp", method: "POST",
    header(name: string) {
      if (name.toLowerCase() === "host") return "compute.example";
      if (name.toLowerCase() === "x-nostr-authorization" && signed)
        return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
      // A claimed identity or arbitrary L402 header must not grant a bucket.
      if (name.toLowerCase() === "x-agent-id") return "spoofed";
      if (name.toLowerCase() === "authorization") return "L402 unverified:unverified";
      return undefined;
    },
    get(name: string) { return this.header(name); },
  });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, locals: {} as Record<string, unknown>,
  });
  let captured: ReturnType<typeof computeContext>;
  computeRequestContext(req as unknown as Parameters<typeof computeRequestContext>[0],
    res as unknown as Parameters<typeof computeRequestContext>[1], () => { captured = computeContext(); });
  return { req, res, context: captured!, pubkey: event.pubkey };
}

test("compute scheduling uses verified NIP-98 only and does not change authentication or payment headers", () => {
  const valid = requestContext(true);
  assert.equal(valid.context.identity, valid.pubkey);
  assert.equal(valid.req.header("Authorization"), "L402 unverified:unverified");
  assert.equal(requestContext(true, true).context.identity, "anonymous");
  assert.equal(requestContext().context.identity, "anonymous");
});

test("legacy L402 callers get a bucket only after server-confirmed settlement", () => {
  const { context, res } = requestContext();
  res.locals.l402 = { paymentHash: "test-root" };
  assert.equal(context.identity, "anonymous");
  res.locals.l402 = { paymentHash: "test-root", settledAt: 1 };
  assert.equal(context.identity, "l402:test-root");
});

test("request disconnect cancels compute, but successful async acknowledgement does not", () => {
  const disconnected = requestContext();
  disconnected.res.emit("close");
  assert.equal(disconnected.context.signal?.aborted, true);
  assert.equal(disconnected.req.listenerCount("aborted"), 0);
  const acknowledged = requestContext();
  acknowledged.res.writableEnded = true;
  acknowledged.res.emit("close");
  assert.equal(acknowledged.context.signal?.aborted, false);
});
