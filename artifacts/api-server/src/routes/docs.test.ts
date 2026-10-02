import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerDocsRoutes } from "./docs";

test("docs and cookbook routes serve only public assets and explicit examples", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stratigraphy-docs-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, "cookbooks"));
  await writeFile(path.join(root, "docs/index.html"), "<!doctype html><title>Developer portal</title>");
  await writeFile(path.join(root, "docs/portal.js"), "/* portal */");
  await writeFile(path.join(root, "cookbooks/l402_client.py"), "# Public client\n");
  await writeFile(path.join(root, "cookbooks/private.txt"), "Must never be served");
  await writeFile(path.join(root, "cookbooks/index.html"), "<!doctype html><title>Python SDK &amp; Integration Cookbooks</title>");
  const app = express();
  registerDocsRoutes(app, root);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const url of ["/docs", "/docs/"]) {
      const response = await fetch(base + url);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /text\/html/);
      assert.match(response.headers.get("content-security-policy")!, /script-src 'self'/);
      assert.match(await response.text(), /Developer portal/);
    }
    const asset = await fetch(base + "/docs/assets/portal.js");
    for (const url of ["/cookbooks", "/cookbooks/"]) {
      const directory = await fetch(base + url);
      assert.equal(directory.status, 200);
      assert.match(directory.headers.get("content-type")!, /text\/html/);
      assert.match(directory.headers.get("content-security-policy")!, /script-src 'self'/);
      assert.match(await directory.text(), /Python SDK &amp; Integration Cookbooks/);
    }
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /portal/);
    const source = await fetch(base + "/cookbooks/l402_client.py");
    assert.match(source.headers.get("content-type")!, /text\/plain/);
    assert.equal(await source.text(), "# Public client\n");
    const download = await fetch(base + "/cookbooks/l402_client.py?download=1");
    assert.match(download.headers.get("content-disposition")!, /attachment; filename="l402_client.py"/);
    assert.equal(await download.text(), "# Public client\n");
    for (const url of [
      "/cookbooks/private.txt", "/cookbooks/.env",
      "/cookbooks/%2e%2e%2fprivate.txt", "/docs/assets/.env",
    ]) {
      const response = await fetch(base + url);
      assert.equal(response.status, 404, url);
      assert.doesNotMatch(await response.text(), /Must never be served/);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});