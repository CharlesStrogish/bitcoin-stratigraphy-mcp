import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MCP_URL = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp";

/** Exercise only the two free sandbox tools. No wallet or credentials are used. */
export async function freeSandbox(url = MCP_URL, fetcher = fetch) {
  const target = new URL(url);
  if (target.username || target.password || target.search || target.hash ||
      (target.protocol !== "https:" &&
       !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))) {
    throw new Error("Use a credential-free HTTPS URL or loopback HTTP URL.");
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  let id = 0;
  async function rpc(method, params, notification = false) {
    const response = await fetcher(url, {
      method: "POST", headers: { ...headers }, redirect: "error",
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params,
      }),
    });
    if (response.status === 402) {
      throw new Error("Unexpected payment challenge for a free sandbox request; no payment attempted.");
    }
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const session = response.headers.get("mcp-session-id");
    if (session) headers["Mcp-Session-Id"] = session;
    if (notification) return;
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("This quickstart expects the endpoint's JSON response mode.");
    }
    const envelope = await response.json();
    if (envelope.error || envelope.result?.isError || !Object.hasOwn(envelope, "result")) {
      throw new Error("MCP returned an error or invalid result.");
    }
    return envelope.result;
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "bitcoin-stratigraphy-free-sandbox", version: "1.1.0" },
  });
  headers["MCP-Protocol-Version"] = initialized.protocolVersion;
  await rpc("notifications/initialized", {}, true);
  const results = {};
  for (const name of ["stratigraphy.list", "proof.list"]) {
    results[name] = await rpc("tools/call", { name, arguments: {} });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--url")) {
    console.error("Usage: node examples/free-sandbox.mjs [--url https://host/mcp]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await freeSandbox(args[1] ?? MCP_URL), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}