import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { finalizeEvent, nip19, type EventTemplate } from "nostr-tools";

const REQUEST_TIMEOUT_MS = 30_000;
const DAILY_GOAL_SATS = 500_000;
const FORBIDDEN_AUDIT_KEYS = new Set([
  "preimage",
  "clientidentifier",
  "sessionsecret",
  "macaroon",
]);

type JsonRecord = Record<string, unknown>;
type VerifiedMacaroon = {
  paymentHash: string;
  amountMsats: number;
  paymentAsset: string;
  paymentProvider: string;
  allowedPaths: string[];
  maxRequests: number;
};
type CheckResult = {
  pillar: string;
  name: string;
  status: "PASS" | "FAIL";
  durationMs: number;
  details?: string;
  error?: string;
};

const results: CheckResult[] = [];
let nostrPublicKey: string | undefined;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(isRecord(value), `${label} must be a JSON object`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new TypeError(`${label} must be a number`);
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function resolveBaseUrl(): URL {
  const configured =
    process.env.E2E_BASE_URL ??
    process.env.NOSTR_API_BASE_URL ??
    process.env.MCP_BASE_URL;
  const developmentDomain = process.env.REPLIT_DEV_DOMAIN;
  const value =
    configured ??
    (developmentDomain
      ? `https://${developmentDomain}`
      : `http://127.0.0.1:${process.env.PORT ?? "5000"}`);
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")),
    "E2E base URL must use HTTPS unless it targets localhost",
  );
  return url;
}

const baseUrl = resolveBaseUrl();

async function requestJson(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned non-JSON HTTP ${response.status}`,
    );
  }
  return { response, body };
}

async function mcpRequest(
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRecord> {
  const { response, body } = await requestJson("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
  assert.equal(response.status, 200, `MCP ${method} must return HTTP 200`);
  return asRecord(body, `MCP ${method} response`);
}

async function runCheck(
  pillar: string,
  name: string,
  check: () => Promise<string | void>,
): Promise<void> {
  const startedAt = performance.now();
  try {
    const details = await check();
    results.push({
      pillar,
      name,
      status: "PASS",
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
      ...(details ? { details } : {}),
    });
    console.log(`PASS  ${pillar}: ${name}${details ? ` — ${details}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      pillar,
      name,
      status: "FAIL",
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
      error: message,
    });
    console.error(`FAIL  ${pillar}: ${name} — ${message}`);
  }
}

function assertHex64(value: unknown, label: string): asserts value is string {
  assert.ok(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    `${label} must be a lowercase 64-character hex value`,
  );
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function verifyMacaroon(
  encoded: string,
  secret: string,
  nowSeconds: number,
): VerifiedMacaroon | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(decoded)) return null;
    if (decoded.identifier !== "bitcoin-stratigraphy-subscription-v1") {
      return null;
    }
    if (
      !Array.isArray(decoded.caveats) ||
      !decoded.caveats.every((value) => typeof value === "string") ||
      typeof decoded.signature !== "string" ||
      !/^[0-9a-f]{64}$/.test(decoded.signature)
    ) {
      return null;
    }
    let signature = hmac(secret, decoded.identifier);
    const values = new Map<string, string>();
    const allowedPaths: string[] = [];
    const maxRequests: number[] = [];
    for (const caveat of decoded.caveats) {
      signature = hmac(signature, caveat);
      const separator = caveat.indexOf("=");
      if (separator <= 0) return null;
      const key = caveat.slice(0, separator);
      const value = caveat.slice(separator + 1);
      if (key === "allowed_path") allowedPaths.push(value);
      else if (key === "max_requests") maxRequests.push(Number(value));
      else {
        if (values.has(key)) return null;
        values.set(key, value);
      }
    }
    const supplied = Buffer.from(decoded.signature, "hex");
    if (
      supplied.length !== signature.length ||
      !timingSafeEqual(supplied, signature)
    ) {
      return null;
    }
    const validUntil = Number(values.get("valid_until"));
    const amountMsats = Number(values.get("amount_msats"));
    const paymentHash = values.get("payment_hash");
    const paymentAsset = values.get("payment_asset");
    const paymentProvider = values.get("payment_provider");
    if (
      !paymentHash ||
      !/^[0-9a-f]{64}$/.test(paymentHash) ||
      !Number.isSafeInteger(validUntil) ||
      validUntil <= nowSeconds ||
      !Number.isSafeInteger(amountMsats) ||
      amountMsats <= 0 ||
      paymentAsset !== "btc-lightning" ||
      !paymentProvider ||
      allowedPaths.length !== 1 ||
      maxRequests.length !== 1 ||
      maxRequests[0] !== 1
    ) {
      return null;
    }
    return {
      paymentHash,
      amountMsats,
      paymentAsset,
      paymentProvider,
      allowedPaths,
      maxRequests: maxRequests[0],
    };
  } catch {
    return null;
  }
}

function canonicalValue(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["bool", value ? 1 : 0];
  if (typeof value === "string") return ["str", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Payload numbers must be finite");
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return ["f64", bytes.toString("hex")];
  }
  if (Array.isArray(value)) return ["array", value.map(canonicalValue)];
  if (isRecord(value)) {
    return [
      "object",
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    ];
  }
  throw new TypeError("Payload must be JSON serializable");
}

function parsePrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error("NOSTR_PRIVATE_KEY must be hex or nsec");
}

function generateAttestation(payload: unknown, privateKey: string) {
  const timestamp = Date.now();
  const serialized = Buffer.from(JSON.stringify(canonicalValue(payload)));
  const blockHashes: string[] = [];
  for (let offset = 0; offset < serialized.length; offset += 1_024) {
    blockHashes.push(
      createHash("sha256")
        .update(serialized.subarray(offset, offset + 1_024))
        .digest("hex"),
    );
  }
  if (blockHashes.length === 0) {
    blockHashes.push(createHash("sha256").update("").digest("hex"));
  }
  let level = [...blockHashes].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        createHash("sha256")
          .update(level[index]! + (level[index + 1] ?? level[index]!))
          .digest("hex"),
      );
    }
    level = next;
  }
  const commitment = {
    schema: "bitcoin-stratigraphy/cryptographic-attestation/v1",
    algorithm: "sha256",
    payloadSha256: createHash("sha256").update(serialized).digest("hex"),
    blockSizeBytes: 1_024,
    blockHashes,
    merkleRoot: level[0]!,
    timestamp,
  };
  const content = JSON.stringify(commitment);
  const payloadSha256 = createHash("sha256").update(content).digest("hex");
  const template: EventTemplate = {
    kind: 30_078,
    created_at: Math.floor(timestamp / 1_000),
    tags: [
      ["d", `bitcoin-stratigraphy:${payloadSha256}`],
      ["t", "bitcoin-stratigraphy"],
      ["t", "telemetry"],
      ["x", payloadSha256],
    ],
    content,
  };
  return {
    schema: commitment.schema,
    payload,
    proof: {
      algorithm: commitment.algorithm,
      payloadSha256: commitment.payloadSha256,
      blockSizeBytes: commitment.blockSizeBytes,
      blockHashes: commitment.blockHashes,
      merkleRoot: commitment.merkleRoot,
      timestamp: commitment.timestamp,
    },
    signature: {
      protocol: "nostr",
      nip: 78,
      payload_sha256: payloadSha256,
      event: finalizeEvent(template, parsePrivateKey(privateKey)),
    },
  };
}

function assertNoSensitiveAuditKeys(value: unknown, path = "audit"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSensitiveAuditKeys(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !FORBIDDEN_AUDIT_KEYS.has(key.toLowerCase()),
      `${path}.${key} exposes a sensitive ledger field`,
    );
    assertNoSensitiveAuditKeys(nested, `${path}.${key}`);
  }
}

async function verifyL402Challenge(input: {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
}): Promise<{ amountSats: number; rateLimitRemaining: number }> {
  const sessionSecret = process.env.SESSION_SECRET;
  assert.ok(sessionSecret, "SESSION_SECRET is required to validate macaroons");
  const { response, body } = await requestJson(input.path, {
    method: input.method,
    ...(input.body === undefined
      ? {}
      : {
          body: JSON.stringify(input.body),
          headers: { "Content-Type": "application/json" },
        }),
  });
  assert.equal(
    response.status,
    402,
    `${input.method} ${input.path} must return HTTP 402`,
  );
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
    `${input.path} must prevent challenge caching`,
  );
  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  assert.ok(
    remainingHeader && /^\d+$/.test(remainingHeader),
    `${input.path} must include X-RateLimit-Remaining`,
  );
  const rateLimitRemaining = Number(remainingHeader);
  const challenge = asRecord(body, `${input.path} challenge`);
  assert.equal(challenge.error, "Payment required");
  const macaroon = asString(challenge.macaroon, `${input.path} macaroon`);
  const invoice = asString(challenge.invoice, `${input.path} invoice`);
  assertHex64(challenge.payment_hash, `${input.path} payment_hash`);
  const amountSats = asNumber(challenge.amount_sats, `${input.path} amount_sats`);
  assert.ok(Number.isSafeInteger(amountSats) && amountSats > 0);

  const authenticate = response.headers.get("www-authenticate");
  assert.ok(authenticate, `${input.path} must include WWW-Authenticate`);
  const headerMatch =
    /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(authenticate);
  assert.ok(headerMatch, `${input.path} has a malformed L402 challenge header`);
  assert.equal(headerMatch[1], macaroon);
  assert.equal(headerMatch[2], invoice);

  const verified = verifyMacaroon(
    macaroon,
    sessionSecret,
    Math.floor(Date.now() / 1_000),
  );
  assert.ok(verified, `${input.path} macaroon signature is invalid`);
  assert.equal(verified.paymentHash, challenge.payment_hash);
  assert.equal(verified.amountMsats, amountSats * 1_000);
  assert.equal(verified.paymentAsset, "btc-lightning");
  assert.ok(verified.paymentProvider, "Macaroon must bind a payment provider");
  assert.deepEqual(verified.allowedPaths, [new URL(input.path, baseUrl).pathname]);
  assert.equal(verified.maxRequests, 1);

  return { amountSats, rateLimitRemaining };
}

await runCheck("Pillars 1 & 3", "NIP-89 announcements and relay pool", async () => {
  const { response, body } = await requestJson("/api/v1/nostr/info");
  assert.equal(response.status, 200);
  const info = asRecord(body, "Nostr info");
  const publicKey = asRecord(info.public_key, "Nostr public_key");
  assertHex64(publicKey.hex, "Nostr public key");
  nostrPublicKey = publicKey.hex;
  assert.ok(
    typeof publicKey.npub === "string" && publicKey.npub.startsWith("npub1"),
    "Nostr npub is missing",
  );

  const announcements = asRecord(
    info.announcement_event_ids,
    "announcement_event_ids",
  );
  assertHex64(announcements.profile, "NIP-89 profile announcement ID");
  assert.ok(
    Array.isArray(announcements.nip89) && announcements.nip89.length > 0,
    "At least one NIP-89 announcement is required",
  );
  announcements.nip89.forEach((id, index) =>
    assertHex64(id, `NIP-89 announcement ${index}`),
  );

  assert.ok(Array.isArray(info.relays) && info.relays.length > 0);
  const activeRelays = info.relays.filter((entry) => {
    const relay = asRecord(entry, "relay");
    assert.equal(typeof relay.relay, "string");
    assert.ok(["pending", "connected", "failed"].includes(String(relay.status)));
    return relay.status === "connected";
  });
  assert.ok(activeRelays.length > 0, "No active Nostr relay is connected");
  return `${activeRelays.length}/${info.relays.length} relays connected; ${announcements.nip89.length} NIP-89 events`;
});

await runCheck("Pillar 2", "L402 challenges and macaroon signatures", async () => {
  const stratigraphy = await verifyL402Challenge({
    path: "/api/v1/stratigraphy/l402",
    method: "GET",
  });
  const proof = await verifyL402Challenge({
    path: "/api/v1/zk/attest",
    method: "POST",
    body: { payload: { e2e: "master-integration-test" } },
  });
  const grounding = await verifyL402Challenge({
    path: "/api/v1/zk/ground",
    method: "POST",
    body: {
      contextHash: "ab".repeat(32),
      agentId: "master-e2e-agent",
      metadata: { suite: "master-e2e" },
    },
  });
  assert.equal(grounding.amountSats, 5, "Grounding price must remain fixed at 5 sats");
  return `valid ${stratigraphy.amountSats}-sat dataset, ${proof.amountSats}-sat proof, and fixed 5-sat grounding challenges; rate-limit remaining ${grounding.rateLimitRemaining}`;
});

await runCheck("Pillar 2", "Attestation signature verification route", async () => {
  const privateKey = process.env.NOSTR_PRIVATE_KEY;
  assert.ok(privateKey, "NOSTR_PRIVATE_KEY is required for attestation E2E");
  assertHex64(nostrPublicKey, "Nostr info public key");
  const attestation = generateAttestation(
    { e2e: "master-integration-test", timestamp: Date.now() },
    privateKey,
  );
  assert.equal(
    attestation.signature.event.pubkey,
    nostrPublicKey,
    "Configured signing key does not match /api/v1/nostr/info",
  );
  const valid = await requestJson("/api/v1/zk/verify", {
    method: "POST",
    body: JSON.stringify({ attestation }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(valid.response.status, 200);
  assert.equal(asRecord(valid.body, "valid verification").valid, true);

  const tampered = await requestJson("/api/v1/zk/verify", {
    method: "POST",
    body: JSON.stringify({
      attestation: { ...attestation, payload: { e2e: "tampered" } },
    }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(tampered.response.status, 200);
  assert.equal(asRecord(tampered.body, "tampered verification").valid, false);
  return "valid signature accepted and payload tampering rejected";
});

await runCheck("Pillar 2", "Epistemic grounding discovery and verification", async () => {
  const listed = await mcpRequest("tools/list");
  const result = asRecord(listed.result, "MCP tools/list result");
  assert.ok(Array.isArray(result.tools), "MCP tools/list must return tools");
  const groundingTool = result.tools.find((value) => {
    const tool = asRecord(value, "MCP tool");
    return tool.name === "zk_ground_context";
  });
  const tool = asRecord(groundingTool, "zk_ground_context tool");
  const inputSchema = asRecord(tool.inputSchema, "grounding input schema");
  const properties = asRecord(inputSchema.properties, "grounding properties");
  for (const parameterName of ["contextHash", "agentId", "metadata"]) {
    const parameter = asRecord(
      properties[parameterName],
      `grounding parameter ${parameterName}`,
    );
    assert.ok(parameter.type, `${parameterName} must define type`);
    assert.equal(typeof parameter.description, "string");
    assert.ok(
      Array.isArray(parameter.examples) && parameter.examples.length > 0,
      `${parameterName} must define examples`,
    );
    assert.ok(
      Object.hasOwn(parameter, "default"),
      `${parameterName} must define default`,
    );
  }

  const contextHash = "ab".repeat(32);
  const routed = await mcpRequest("tools/call", {
    name: "zk_ground_context",
    arguments: {
      contextHash,
      agentId: "master-e2e-agent",
      metadata: { suite: "master-e2e" },
    },
  });
  const routedResult = asRecord(routed.result, "grounding tool result");
  assert.equal(routedResult.isError, true);
  const routing = asRecord(
    routedResult.structuredContent,
    "grounding routing response",
  );
  assert.equal(routing.status, 402);
  assert.equal(routing.endpoint, "/api/v1/zk/ground");
  assert.equal(routing.amountSats, 5);
  assert.equal(routing.verificationEndpoint, "/api/v1/zk/verify");

  const privateKey = process.env.NOSTR_PRIVATE_KEY;
  assert.ok(privateKey, "NOSTR_PRIVATE_KEY is required for grounding E2E");
  const timestamp = Date.now();
  const payload = {
    schema: "bitcoin-stratigraphy/epistemic-anchor/v1",
    contextHash,
    agentId: "master-e2e-agent",
    metadata: { suite: "master-e2e" },
    bitcoin: {
      blockHeight: 920001,
      blockHash: "cd".repeat(32),
      source: "master-e2e-fixture",
    },
    timestamp,
  };
  const attestation = generateAttestation(payload, privateKey);
  const receipt = {
    ...attestation,
    receiptSchema: payload.schema,
    contextHash,
    agentId: payload.agentId,
    blockHeight: payload.bitcoin.blockHeight,
    blockHash: payload.bitcoin.blockHash,
    merkleRoot: attestation.proof.merkleRoot,
    timestamp,
    nostrSignature: attestation.signature,
  };
  const verified = await requestJson("/api/v1/zk/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attestation: receipt }),
  });
  assert.equal(verified.response.status, 200);
  assert.equal(asRecord(verified.body, "grounding verification").valid, true);

  const tampered = await requestJson("/api/v1/zk/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attestation: {
        ...receipt,
        payload: { ...payload, contextHash: "ef".repeat(32) },
      },
    }),
  });
  assert.equal(tampered.response.status, 200);
  assert.equal(
    asRecord(tampered.body, "tampered grounding verification").valid,
    false,
  );
  return "tool routed exact 5-sat payment; signed receipt verified and tampering rejected";
});

await runCheck("Pillar 4", "Revenue metrics and sanitized audit ledger", async () => {
  const [revenueResult, auditResult] = await Promise.all([
    requestJson("/api/v1/analytics/revenue"),
    requestJson("/api/v1/analytics/audit?limit=50"),
  ]);
  assert.equal(revenueResult.response.status, 200);
  assert.equal(auditResult.response.status, 200);
  const revenue = asRecord(revenueResult.body, "revenue analytics");
  const total = asNumber(revenue.totalVolumeSats, "totalVolumeSats");
  const daily = asNumber(revenue.volume24hSats, "volume24hSats");
  assert.ok(total >= 0 && daily >= 0);
  const breakdown = asRecord(revenue.channelBreakdown, "channelBreakdown");
  Object.entries(breakdown).forEach(([channel, amount]) => {
    assert.ok(channel.length > 0);
    assert.ok(asNumber(amount, `channelBreakdown.${channel}`) >= 0);
  });
  const goal = asRecord(revenue.dailyGoal, "dailyGoal");
  assert.equal(goal.targetSats, DAILY_GOAL_SATS);
  assert.equal(goal.currentSats, daily);
  const remaining = asNumber(goal.remainingSats, "dailyGoal.remainingSats");
  const percentage = asNumber(goal.percentage, "dailyGoal.percentage");
  assert.equal(remaining, Math.max(0, DAILY_GOAL_SATS - daily));
  assert.ok(percentage >= 0);

  const audit = asRecord(auditResult.body, "revenue audit");
  assert.ok(Array.isArray(audit.transactions));
  assert.ok(audit.transactions.length <= 50);
  assertNoSensitiveAuditKeys(audit.transactions);
  return `${daily}/${DAILY_GOAL_SATS} sats today (${percentage}%); ${audit.transactions.length} sanitized audit records`;
});

await runCheck("Pillar 5", "System health, circuits, load, and rate limits", async () => {
  const { response, body } = await requestJson("/api/v1/system/health");
  assert.equal(response.status, 200);
  const health = asRecord(body, "system health");
  assert.ok(["ok", "degraded", "unhealthy"].includes(String(health.status)));
  const activeWorkers = asNumber(
    health.activeWorkerCount,
    "activeWorkerCount",
  );
  const queuedJobs = asNumber(health.queuedJobCount, "queuedJobCount");
  assert.ok(Number.isSafeInteger(activeWorkers) && activeWorkers >= 0);
  assert.ok(Number.isSafeInteger(queuedJobs) && queuedJobs >= 0);
  assert.ok(asNumber(health.dynamicFeeMultiplier, "dynamicFeeMultiplier") >= 1);
  const cpu = asNumber(health.cpuUtilization, "cpuUtilization");
  assert.ok(cpu >= 0 && cpu <= 1);

  const relayPool = asRecord(health.relayPool, "relayPool");
  const totalRelays = asNumber(relayPool.totalRelays, "relayPool.totalRelays");
  const healthyRelays = asNumber(
    relayPool.healthyRelays,
    "relayPool.healthyRelays",
  );
  assert.ok(totalRelays > 0 && healthyRelays >= 0 && healthyRelays <= totalRelays);
  assert.ok(Array.isArray(relayPool.relays));
  assert.equal(relayPool.relays.length, totalRelays);
  relayPool.relays.forEach((entry, index) => {
    const relay = asRecord(entry, `relayPool.relays[${index}]`);
    assert.ok(
      ["CLOSED", "OPEN", "HALF-OPEN"].includes(String(relay.circuitState)),
      `Relay ${index} has an invalid circuit state`,
    );
    assert.ok(
      asNumber(relay.consecutiveFailures, `relay ${index} failures`) >= 0,
    );
  });
  const memory = asRecord(health.memoryUsage, "memoryUsage");
  for (const key of [
    "rssBytes",
    "heapTotalBytes",
    "heapUsedBytes",
    "externalBytes",
  ]) {
    assert.ok(asNumber(memory[key], `memoryUsage.${key}`) > 0);
  }
  return `${String(health.status)}; ${healthyRelays}/${totalRelays} relays healthy; ${activeWorkers} active/${queuedJobs} queued`;
});

const passed = results.filter((result) => result.status === "PASS").length;
const failed = results.length - passed;
console.log("\nEnd-to-End Master Integration Summary");
console.table(
  results.map(({ pillar, name, status, durationMs, details, error }) => ({
    pillar,
    check: name,
    status,
    durationMs,
    summary: details ?? error ?? "",
  })),
);
console.log(
  `Overall: ${failed === 0 ? "PASS" : "FAIL"} — ${passed}/${results.length} checks passed`,
);
console.log(`Target: ${baseUrl.origin}`);
if (failed > 0) process.exitCode = 1;