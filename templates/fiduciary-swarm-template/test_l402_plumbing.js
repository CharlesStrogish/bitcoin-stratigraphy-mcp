#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This GET route protects the same stratigraphy product without requiring MCP's
// POST-only tools/call transport. No SDK, wallet credentials or dependencies.
export const DEFAULT_ENDPOINT =
  "https://bitcoinstratigraphy.com/api/v1/stratigraphy/l402?days=1";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const STATE_DIRECTORY = join(dirname(SCRIPT_PATH), ".l402-plumbing");

export class DiagnosticError extends Error {}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new DiagnosticError("Provide a valid HTTPS endpoint."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some((name) => /preimage|token|macaroon|authorization/i.test(name))) {
    throw new DiagnosticError("Use HTTPS without URL credentials, fragments or credential query parameters.");
  }
  return url.href;
}

export function parseL402Challenge(header) {
  if (typeof header !== "string" || header.length > 32_768 || /[\x00-\x1f\x7f]/.test(header)) {
    throw new DiagnosticError("Missing or malformed WWW-Authenticate header.");
  }
  const scheme = /^L402\s+(.+)$/i.exec(header);
  if (!scheme) throw new DiagnosticError("HTTP 402 did not contain an L402 payment challenge.");
  const fields = {};
  let remaining = scheme[1];
  while (remaining) {
    const match = /^\s*(macaroon|invoice)\s*=\s*"([^"\\]+)"\s*(,|$)/i.exec(remaining);
    if (!match || fields[match[1].toLowerCase()] || (match[3] && match[0].length === remaining.length)) {
      throw new DiagnosticError("Malformed or duplicate L402 challenge fields.");
    }
    fields[match[1].toLowerCase()] = match[2];
    remaining = remaining.slice(match[0].length);
  }
  if (!fields.macaroon || !/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(fields.invoice ?? "")) {
    throw new DiagnosticError("Challenge must contain a macaroon and a BOLT11 invoice.");
  }
  return fields;
}

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new DiagnosticError("Response exceeds the diagnostic's 1 MiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Plain HTTP GET. Fetch does not throw for 402, so inspect status explicitly. */
export async function requestChallenge(url = DEFAULT_ENDPOINT, {
  fetchImpl = globalThis.fetch, onResponse = () => {},
} = {}) {
  const target = endpoint(url);
  const response = await fetchImpl(target, {
    method: "GET", headers: { Accept: "application/json" },
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(45_000),
  });
  onResponse(response.status, [...response.headers]);
  if (response.status !== 402) {
    await response.body?.cancel();
    throw new DiagnosticError(`Expected HTTP 402 Payment Required; received HTTP ${response.status}.`);
  }
  const challenge = parseL402Challenge(response.headers.get("www-authenticate"));
  const text = await boundedText(response);
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if ((body.macaroon !== undefined && body.macaroon !== challenge.macaroon) ||
      (body.invoice !== undefined && body.invoice !== challenge.invoice)) {
    throw new DiagnosticError("Invoice or macaroon differs between HTTP header and JSON quote.");
  }
  return {
    version: 1, url: target, ...challenge, capturedAt: new Date().toISOString(),
    paymentHash: typeof body.payment_hash === "string" && /^[0-9a-f]{64}$/i.test(body.payment_hash)
      ? body.payment_hash.toLowerCase() : null,
    amountSats: Number.isSafeInteger(body.amount_sats) ? body.amount_sats : null,
  };
}

/** Call only after manual payment. Never pays, generates replacements or logs proof. */
export async function verifyPayment(challenge, preimage, { fetchImpl = globalThis.fetch } = {}) {
  const target = endpoint(challenge.url);
  if (typeof preimage !== "string" || !/^[0-9a-f]{64}$/i.test(preimage) ||
      typeof challenge.macaroon !== "string" || !/^[^\s"\\:\x00-\x1f\x7f]{1,24000}$/.test(challenge.macaroon)) {
    throw new DiagnosticError("Supply the original challenge and a 64-character hexadecimal payment preimage.");
  }
  if (challenge.paymentHash && createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== challenge.paymentHash) {
    throw new DiagnosticError("Preimage does not match this invoice's payment hash; no request was sent.");
  }
  const response = await fetchImpl(target, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `L402 ${challenge.macaroon}:${preimage.toLowerCase()}` },
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(45_000),
  });
  // Redact even if an unexpected server response reflects the supplied credential.
  const payload = (await boundedText(response)).replace(new RegExp(preimage, "gi"), "[REDACTED PREIMAGE]");
  return { unlocked: response.status === 200, status: response.status, payload };
}

/** Local terminal only: the preimage is not a CLI argument, env var, file or log. */
export function promptForPreimage(input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new DiagnosticError("Run --redeem in an interactive terminal for hidden preimage input.");
  }
  output.write("Paste the payment preimage (hidden), then press Enter: ");
  return new Promise((resolveInput, rejectInput) => {
    const wasRaw = Boolean(input.isRaw);
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) rejectInput(error);
      else resolveInput(value.trim());
    };
    const onEnd = () => finish(new DiagnosticError("Preimage entry cancelled."));
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") { onEnd(); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
        if (value.length > 128) { finish(new DiagnosticError("Preimage input is too long.")); return; }
      }
    };
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.resume();
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--redeem") {
    if (args.length !== 2) throw new DiagnosticError("Usage: node test_l402_plumbing.js --redeem CHALLENGE_FILE");
    const text = await readFile(resolve(args[1]), "utf8");
    if (text.length > 65_536) throw new DiagnosticError("Challenge file is too large.");
    let challenge;
    try { challenge = JSON.parse(text); } catch { throw new DiagnosticError("Invalid challenge JSON."); }
    if (!challenge || challenge.version !== 1) throw new DiagnosticError("Invalid challenge file version.");
    const preimage = await promptForPreimage();
    const result = await verifyPayment(challenge, preimage);
    console.log(`HTTP ${result.status}`);
    console.log(result.unlocked
      ? "PASS: Macaroon + preimage unlocked the protected payload."
      : "NOT UNLOCKED: server rejected access. Do not pay a replacement invoice automatically.");
    console.log(result.payload);
    if (!result.unlocked) process.exitCode = 1;
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== "--url")) {
    throw new DiagnosticError("Usage: node test_l402_plumbing.js [--url HTTPS_ENDPOINT]");
  }
  const url = args[1] ?? DEFAULT_ENDPOINT;
  console.log(`GET ${endpoint(url)} (no authorization headers; no automatic payment)`);
  const challenge = await requestChallenge(url, {
    onResponse: (status, headers) => {
      console.log(`HTTP ${status}${status === 402 ? " Payment Required" : ""}`);
      for (const [name, value] of headers) {
        console.log(`${name}: ${name === "set-cookie" ? "[REDACTED COOKIE]" : value}`);
      }
    },
  });
  console.log(`\nRAW LIGHTNING INVOICE (BOLT11):\n${challenge.invoice}\n`);
  if (challenge.amountSats !== null) console.log(`Server-quoted price: ${challenge.amountSats} sats.`);
  await mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  const challengePath = join(STATE_DIRECTORY, `challenge-${randomUUID()}.json`);
  await writeFile(challengePath, JSON.stringify(challenge, null, 2), { flag: "wx", mode: 0o600 });
  console.log(`Original challenge saved privately: ${challengePath}`);
  console.log(`After manual payment, run:\nnode ${SCRIPT_PATH} --redeem ${challengePath}`);
  console.log("The next step prompts for the preimage without echoing or storing it. No payment was made.");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof DiagnosticError ? error.message :
      "Diagnostic failed: check connectivity or the challenge file. Raw errors are hidden to protect credentials.");
    process.exitCode = 1;
  });
}
