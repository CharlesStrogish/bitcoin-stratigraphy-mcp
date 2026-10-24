// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress, webhookUrlProblem } from "./mcp-async-tasks";

/** Authority is the address/LNURL origin, never a caller-supplied key or URL. */
export function affiliateRecordUrl(agent: string): URL {
  let authority: URL;
  if (agent.includes("@")) {
    authority = new URL("https://" + agent.split("@")[1]);
  } else {
    const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let accumulator = 0,
      bits = 0;
    const bytes: number[] = [];
    for (const c of agent.slice(6, -6)) {
      const word = alphabet.indexOf(c);
      if (word < 0) throw new Error("Invalid LNURL encoding");
      accumulator = ((accumulator << 5) | word) & 0xffff;
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        bytes.push((accumulator >> bits) & 255);
      }
    }
    if (bits >= 5 || (accumulator & ((1 << bits) - 1)) !== 0)
      throw new Error("Noncanonical LNURL padding");
    authority = new URL(
      new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)),
    );
  }
  if (webhookUrlProblem(authority.href) || authority.port || authority.hash)
    throw new Error("Address provider must use public HTTPS on port 443");
  return new URL(
    "/.well-known/bitcoin-stratigraphy-affiliates.json",
    authority.origin,
  );
}

export type ProviderReader = (url: URL) => Promise<unknown>;

/** Bounded, pinned HTTPS: no redirects, rebinding, private DNS answers or unbounded bodies. */
export function createAffiliateProviderReader(
  options: {
    resolve?: typeof lookup;
    request?: typeof https.request;
  } = {},
): ProviderReader {
  return async (url) => {
    if (webhookUrlProblem(url.href) || url.port)
      throw new Error("Unsafe provider URL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await Promise.race([
        (options.resolve ?? lookup)(host, { all: true }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Provider lookup timed out")),
            { once: true },
          );
        }),
      ]);
      if (
        !addresses.length ||
        addresses.some((answer) => !isPublicAddress(answer.address))
      )
        throw new Error("Provider resolved to a nonpublic address");
      const pinned = addresses[0]!;
      return await new Promise((resolve, reject) => {
        const outgoing = (options.request ?? https.request)(
          {
            protocol: "https:",
            hostname: host,
            port: 443,
            path: url.pathname,
            method: "GET",
            agent: false,
            signal: controller.signal,
            headers: { Accept: "application/json" },
            ...(isIP(host) ? {} : { servername: host }),
            lookup: (_host, options, callback) => {
              if (options.all)
                callback(null, [
                  { address: pinned.address, family: pinned.family },
                ]);
              else callback(null, pinned.address, pinned.family);
            },
          },
          (response) => {
            if (
              response.statusCode !== 200 ||
              !/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(
                response.headers["content-type"] ?? "",
              )
            ) {
              response.destroy();
              reject(
                new Error(
                  "Provider must return HTTP 200 JSON without redirects",
                ),
              );
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65_536) {
                response.destroy();
                reject(new Error("Provider record exceeds 64 KiB"));
              } else chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("aborted", () =>
              reject(new Error("Provider response truncated")),
            );
            response.on("end", () => {
              if (!response.complete) {
                reject(new Error("Provider response truncated"));
                return;
              }
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch {
                reject(new Error("Invalid provider JSON"));
              }
            });
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Explicit per-address authorization. NIP-57's provider nostrPubkey is NOT ownership evidence. */
export async function providerOwnerKey(
  agent: string,
  read: ProviderReader,
): Promise<{ pubkey: string; url: string }> {
  const url = affiliateRecordUrl(agent);
  const record = (await read(url)) as {
    version?: unknown;
    affiliates?: Record<string, unknown>;
  };
  if (
    record?.version !== 1 ||
    !record.affiliates ||
    !Object.prototype.hasOwnProperty.call(record.affiliates, agent)
  )
    throw new Error("Provider has not authorized this address");
  const value = record.affiliates[agent] as { nostr_pubkey?: unknown };
  if (
    typeof value?.nostr_pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.nostr_pubkey)
  )
    throw new Error("Provider ownership key missing");
  return { pubkey: value.nostr_pubkey, url: url.href };
}
