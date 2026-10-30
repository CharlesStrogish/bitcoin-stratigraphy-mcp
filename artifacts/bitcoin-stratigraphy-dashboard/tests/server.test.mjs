import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createFrontendApp } from "../server.mjs";

let server;
let directory;
let origin;
const pages = ["enterprise", "whitepaper", "compliance", "simulator", "standard"];
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "domain-routing-"));
  await writeFile(path.join(directory, "index.html"),
    '<link rel="canonical" href="https://bitcoinstratigraphy.com/" />');
  await writeFile(path.join(directory, "llms.txt"), "agent discovery");
  await writeFile(path.join(directory, "llms-full.txt"), "full discovery");
  await writeFile(path.join(directory, "asset.js"), "console.log('asset')");
  for (const page of pages) {
    await mkdir(path.join(directory, page));
    await writeFile(path.join(directory, page, "index.html"),
      `<link rel="canonical" href="https://bitcoinstratigraphy.com/${page}/" />`);
  }
  server = createFrontendApp({ publicDirectory: directory }).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
const request = (url, host, options = {}) => new Promise((resolve, reject) => {
  // Fetch implementations can rewrite Host to match the URL. Exercise the actual wire header.
  const req = httpRequest(origin + url, {
    ...options, headers: { Host: host, ...options.headers },
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({
      status: res.statusCode,
      headers: new Headers(res.headers),
      text: async () => body,
    }));
  });
  req.on("error", reject);
  req.end();
});

test("legacy hosts permanently redirect with the exact path and query before file serving", async () => {
  for (const host of [
    "old.replit.app", "old.replit.dev", "old.repl.co",
    "REPLIT.APP", "old.replit.app:443", "old.replit.dev.",
  ]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const result = await request("/enterprise/?ref=a%2Fb&x=1", host, { method });
      assert.equal(result.status, 301, host);
      assert.equal(result.headers.get("location"),
        "https://bitcoinstratigraphy.com/enterprise/?ref=a%2Fb&x=1");
      assert.equal(await result.text(), "");
    }
  }
});

test("canonical, loopback and lookalike hosts do not redirect or trust forwarding headers", async () => {
  for (const host of [
    "bitcoinstratigraphy.com", "www.bitcoinstratigraphy.com",
    "localhost", "localhost:20948", "127.0.0.1", "127.0.0.1:20948",
    "[::1]:20948", "old.replit.app.evil.example", "notreplit.app",
  ]) {
    const result = await request("/", host, {
      headers: { "X-Forwarded-Host": "old.replit.app" },
    });
    assert.equal(result.status, 200, host);
    assert.equal(result.headers.get("location"), null, host);
    assert.match(await result.text(), /rel="canonical"/);
  }
});

test("dedicated pages, SPA routes, static files, HEAD and security headers remain available", async () => {
  for (const page of pages) {
    for (const suffix of ["", "/"]) {
      const result = await request(`/${page}${suffix}`, "bitcoinstratigraphy.com");
      assert.equal(result.status, 200);
      assert.match(await result.text(), new RegExp(`${page}/`));
      assert.equal(result.headers.get("x-content-type-options"), "nosniff");
      assert.equal(result.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    }
  }
  const spa = await request("/dashboard/view", "localhost");
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /bitcoinstratigraphy\.com\/"/);
  const asset = await request("/asset.js", "localhost");
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  const head = await request("/asset.js", "localhost", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const file of ["llms.txt", "llms-full.txt"]) {
    const result = await request(`/${file}`, "localhost");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("access-control-allow-origin"), "*");
  }
});

test("frontend never substitutes the SPA for backend routes, missing assets or hidden files", async () => {
  for (const url of ["/api/healthz", "/mcp", "/invoice/request", "/agent-api/health", "/missing.js", "/.env"]) {
    const result = await request(url, "localhost");
    assert.equal(result.status, 404, url);
    assert.doesNotMatch(await result.text(), /rel="canonical"/);
  }
  assert.equal((await request("/", "localhost", { method: "POST" })).status, 405);
});

test("the original homepage retains exactly one canonical link", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.equal((html.match(/<link rel="canonical"/g) ?? []).length, 1);
  assert.ok(html.includes('<link rel="canonical" href="https://bitcoinstratigraphy.com/" />'));
});
