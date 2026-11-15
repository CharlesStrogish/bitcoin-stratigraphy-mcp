import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionService, connectionMiddleware, VERIFICATION_URL } from "../server/connection.mjs";

const KEY = "test_only_capability";
const NOW = 1_800_000_000_000;
const grant = () => ({ macaroon: KEY, credits: 100, amount_sats: 100_000, valid_until: NOW / 1_000 + 30, scope: "/api/scanner" });

test("missing credential stays locked without making any upstream request", async () => {
  const connection = createConnectionService({ key: () => "", fetcher: () => assert.fail("no requests without a credential") });
  assert.equal(connection.status().status, "missing");
  assert.equal((await connection.verify()).configured, false);
});

test("credential presence alone is unverified and no secret reaches the client", () => {
  const connection = createConnectionService({ key: () => KEY });
  const status = connection.status();
  assert.equal(status.status, "unverified");
  assert.ok(!JSON.stringify(status).includes(KEY));
});

test("verification uses only the fixed issuer's non-consuming entitlement route, with redirects refused", async () => {
  let calls = 0;
  let clock = NOW;
  const connection = createConnectionService({
    key: () => KEY, now: () => clock,
    fetcher: async (url, init) => {
      calls++;
      assert.equal(url, VERIFICATION_URL);
      assert.equal(init.headers.Authorization, `Macaroon ${KEY}`);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.body, undefined);
      return Response.json(grant());
    },
  });
  const result = await connection.verify();
  assert.equal(result.status, "verified");
  assert.ok(!JSON.stringify(result).includes(KEY));
  await connection.verify();
  assert.equal(calls, 1, "verification requests are throttled");
  clock += 31_000;
  assert.equal(connection.status().status, "invalid", "expired grant cannot stay connected");
});

test("wrong scope, mismatched credential, expired grant and malformed grants never connect", async () => {
  for (const data of [
    {...grant(), scope: "/other"}, {...grant(), macaroon: "impostor"},
    {...grant(), valid_until: NOW / 1_000 - 1}, {...grant(), credits: 0},
    {...grant(), valid_until: "2030-01-01"}, {},
  ]) {
    const connection = createConnectionService({key: () => KEY, now: () => NOW, fetcher: async () => Response.json(data)});
    assert.equal((await connection.verify()).status, "invalid");
  }
});

test("upstream failures and malformed credentials fail closed without leaking errors", async () => {
  for (const status of [401, 402, 403, 409, 429, 500, 503]) {
    const connection = createConnectionService({key: () => KEY, fetcher: async () => new Response(KEY, {status})});
    const result = await connection.verify();
    assert.ok(["invalid", "unavailable"].includes(result.status));
    assert.ok(!JSON.stringify(result).includes(KEY));
  }
  const failure = createConnectionService({key: () => KEY, fetcher: async () => {throw new Error(KEY);}});
  assert.equal((await failure.verify()).status, "unavailable");
  const malformed = createConnectionService({key: () => "bad\r\nkey", fetcher: () => assert.fail("invalid header must never be sent")});
  assert.equal((await malformed.verify()).status, "invalid");
});

test("connection middleware rejects cross-site verification and never accepts client-supplied keys", async () => {
  const service = createConnectionService({key: () => ""});
  const middleware = connectionMiddleware(service, "/viewer/");
  let body = "";
  const headers = {};
  const res = {setHeader: (key, value) => {headers[key] = value;}, end: value => {body = value;}};
  await middleware({url: "/viewer/local-api/verify", method: "POST", headers: {host: "localhost:4173", origin: "https://attacker.example"}}, res, () => assert.fail("must handle"));
  assert.equal(res.statusCode, 403);
  await middleware({url: "/viewer/local-api/status", method: "GET", headers: {}}, res, () => assert.fail("must handle"));
  assert.equal(JSON.parse(body).status, "missing");
  assert.equal(headers["Cache-Control"], "no-store");
});
