#!/usr/bin/env node
import { request } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Intentionally public: the domain must serve this exact token to verify ownership.
export const INDEXNOW_KEY = "dda40963db91d1bc282dd6756b30829c";

export function buildIndexNowPayload() {
  return {
    host: "bitcoinstratigraphy.com",
    key: INDEXNOW_KEY,
    keyLocation: `https://bitcoinstratigraphy.com/${INDEXNOW_KEY}.txt`,
    urlList: [
      "https://bitcoinstratigraphy.com/",
      "https://bitcoinstratigraphy.com/openapi.json",
      "https://bitcoinstratigraphy.com/.well-known/ai-plugin.json",
      "https://bitcoinstratigraphy.com/.well-known/mcp-configuration.json",
      "https://bitcoinstratigraphy.com/yield-proofs.json",
      "https://bitcoinstratigraphy.com/sitemap.xml",
    ],
  };
}

/** Exactly one POST: no retries, redirects, or automatic startup submissions. */
export function pingIndexNow() {
  const body = JSON.stringify(buildIndexNowPayload());
  return new Promise((resolvePing, reject) => {
    const req = request({
      hostname: "api.indexnow.org",
      path: "/indexnow",
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      },
      signal: AbortSignal.timeout(20_000),
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        responseBody += chunk;
        if (responseBody.length > 8192) {
          res.destroy(new Error("IndexNow response exceeded 8192 characters"));
        }
      });
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status !== 200 && status !== 202) {
          reject(new Error(`IndexNow HTTP ${status}: ${responseBody || res.statusMessage}`));
          return;
        }
        resolvePing({ status, responseBody });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { status, responseBody } = await pingIndexNow();
    console.log(`IndexNow HTTP ${status}: submitted 6 URLs (not a guarantee of indexing).`);
    if (responseBody) console.log(responseBody);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
