import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

type TelemetryRecord = {
  day: number;
  title: string;
  video_id: string;
  transcript_summary: string;
  quantitative_alpha: { target_multiplier: number };
};
type Proof = {
  proof: string;
  publicInputs: {
    blockHeight: number; snapshotDigest: string; thermodynamicHash: string;
    timestamp: number; valuationSat: number;
  };
  verificationKeyId: string;
};
type AuditClient = {
  listStratigraphy(): Promise<{ totalSnapshots: number; newestBlock: number }>;
  getTelemetry(args: { blockHeight: number }): Promise<{ records: TelemetryRecord[] }>;
  verifyProof(args: Proof & { data: unknown[] }): Promise<{ valid: boolean; verifiedAt: string }>;
};

// Resolve TypeScript source at runtime with tsx; the scripts package does not
// need to compile the API package's cryptography or depend on its build output.
const { StratigraphyClient } = await import(
  new URL("../sdk/typescript/client.ts", import.meta.url).href
) as { StratigraphyClient: new (url: string, options: {
  wallet: (invoice: string) => Promise<string>; fetcher: typeof fetch;
}) => AuditClient };
const { generateZkProof, verifyZkProofForSnapshot, shutdownZkVerifier } = await import(
  new URL("../artifacts/api-server/src/services/zkProofService.ts", import.meta.url).href
) as {
  generateZkProof(input: { snapshot: unknown; blockHeight: number; timestamp: number; valuationMultiplier: number }): Promise<Proof>;
  verifyZkProofForSnapshot(proof: Proof, snapshot: unknown): Promise<boolean>;
  shutdownZkVerifier(): Promise<void>;
};

const ENDPOINT = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp";
const SATS_PER_TOOL = 250;
type Rpc = { jsonrpc: "2.0"; id: number; method: string; params?: { name?: string; arguments?: unknown } };
type Challenge = { invoice: string; macaroon: string; paymentHash: string; requestHash: string; preimage: string; tool: string; used: boolean };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (id: number, structuredContent: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { structuredContent } }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

async function main() {
  // In mock mode the only production request is the free catalog lookup.
  // Paid calls go to the in-process L402 harness; no wallet funds are spent.
  const secret = randomBytes(32);
  const challenges = new Map<string, Challenge>();
  const requests = new Map<string, number>();
  const completed = new Set<string>();
  const challengeLog: Array<{ tool: string; status: number; amountSats: number }> = [];
  const raw = JSON.parse(await readFile(
    new URL("../artifacts/api-server/data/stratigraphy.json", import.meta.url), "utf8",
  )) as Array<{ day: number; title: string; video_id: string; transcript_summary: string }>;
  assert.ok(Array.isArray(raw) && raw.length > 0, "Local indexed dataset has no records");
  const latestRaw = raw.at(-1)!;
  const multiplier = /(\d+(?:\.\d+)?)\s*[x×]\s*away/i.exec(latestRaw.title);
  assert.ok(multiplier, "Local record has no target multiplier");
  const localRecords: TelemetryRecord[] = [{
    ...latestRaw,
    quantitative_alpha: { target_multiplier: Number(multiplier[1]) },
  }];

  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), ENDPOINT, "Agent contacted an unexpected endpoint");
    const rpc = JSON.parse(String(init?.body)) as Rpc;
    const tool = rpc.params?.name;
    assert.equal(rpc.method, "tools/call");
    if (tool === "stratigraphy.list") {
      return fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    }
    assert.ok(tool === "stratigraphy.get" || tool === "proof.verify", `Unexpected paid tool: ${tool}`);
    const requestHash = sha(String(init?.body));
    requests.set(tool, (requests.get(tool) ?? 0) + 1);
    const authorization = new Headers(init?.headers).get("authorization");
    if (!authorization) {
      assert.ok(!challenges.has(tool), `Duplicate unpaid attempt for ${tool}`);
      const preimage = randomBytes(32).toString("hex");
      const paymentHash = sha(Buffer.from(preimage, "hex"));
      const invoice = `lnmock${paymentHash}`;
      const tokenBody = Buffer.from(JSON.stringify({ tool, requestHash, paymentHash })).toString("base64url");
      const signature = createHmac("sha256", secret).update(tokenBody).digest("hex");
      const macaroon = `${tokenBody}.${signature}`;
      challenges.set(tool, { invoice, macaroon, paymentHash, requestHash, preimage, tool, used: false });
      challengeLog.push({ tool, status: 402, amountSats: SATS_PER_TOOL });
      return new Response(JSON.stringify({
        error: "Payment required", invoice, macaroon, payment_hash: paymentHash, amount_sats: SATS_PER_TOOL,
      }), {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `L402 macaroon="${macaroon}", invoice="${invoice}"`,
        },
      });
    }

    const expected = challenges.get(tool);
    assert.ok(expected, `No pending L402 challenge for ${tool}`);
    assert.equal(authorization, `L402 ${expected.macaroon}:${expected.preimage}`);
    const [tokenBody, signature] = expected.macaroon.split(".");
    assert.ok(tokenBody && signature);
    const validSignature = createHmac("sha256", secret).update(tokenBody).digest();
    const suppliedSignature = Buffer.from(signature, "hex");
    assert.ok(suppliedSignature.length === validSignature.length &&
      timingSafeEqual(suppliedSignature, validSignature), "Invalid mock macaroon HMAC");
    assert.deepEqual(JSON.parse(Buffer.from(tokenBody, "base64url").toString("utf8")), {
      tool, requestHash, paymentHash: expected.paymentHash,
    });
    assert.equal(sha(Buffer.from(expected.preimage, "hex")), expected.paymentHash);
    assert.equal(expected.requestHash, requestHash, "Paid retry changed the request body");
    assert.equal(expected.used, false, "Mock macaroon was replayed");
    expected.used = true;
    completed.add(tool);
    if (tool === "stratigraphy.get") {
      const args = rpc.params?.arguments as { blockHeight?: number };
      assert.equal(args.blockHeight, 920_000, "Requested block does not match the selected catalog entry");
      return json(rpc.id, { records: localRecords });
    }
    const args = rpc.params?.arguments as {
      proof: string; publicInputs: Record<string, unknown>; verificationKeyId: string;
      data: Array<{ sourceRecordHash?: string }>;
    };
    assert.equal(args.data.length, 1);
    assert.equal(args.data[0]?.sourceRecordHash, sha(JSON.stringify(localRecords[0])), "Proof input is not bound to the fetched record");
    const started = performance.now();
    const valid = await verifyZkProofForSnapshot({
      proof: args.proof, publicInputs: args.publicInputs as Proof["publicInputs"],
      verificationKeyId: args.verificationKeyId,
    }, args.data);
    return json(rpc.id, {
      valid, verifiedAt: new Date().toISOString(),
      computationTimeMs: Number((performance.now() - started).toFixed(3)),
    });
  };

  const wallet = async (invoice: string): Promise<string> => {
    const challenge = [...challenges.values()].find((entry) => entry.invoice === invoice);
    assert.ok(challenge && !challenge.used, "Unknown or settled mock invoice");
    // This is a local simulated payment. The SDK separately binds this
    // preimage to the challenged payment hash before its paid retry.
    return challenge.preimage;
  };

  const client = new StratigraphyClient(ENDPOINT, { wallet, fetcher });
  const catalog = await client.listStratigraphy();
  assert.ok(catalog.totalSnapshots > 0 && Number.isSafeInteger(catalog.newestBlock));
  const latest = catalog.newestBlock;
  assert.equal(localRecords[0]?.day, catalog.totalSnapshots, "Local fixture differs from the live catalog");
  assert.equal(latest, 920_000, "Mock paid dataset cannot match the live indexed height");
  console.log(`[1/4] Free discovery: ${catalog.totalSnapshots} snapshots; selected indexed height ${latest}.`);

  const telemetry = await client.getTelemetry({ blockHeight: latest });
  assert.equal(telemetry.records.length, 1);
  const record = telemetry.records[0]!;
  const recordHash = sha(JSON.stringify(record));
  assert.ok(completed.has("stratigraphy.get"));
  console.log(`[2/4] stratigraphy.get: 402 -> mock L402 verification -> paid retry; record SHA-256 ${recordHash}.`);

  // MCP stratigraphy.get supplies no proof. Generate a *new local* Groth16
  // proof over the local fixture record plus its fingerprint; do not present it as
  // a server-issued proof or a Bitcoin block hash.
  const createdAt = Math.floor(Date.now() / 1_000);
  const snapshot = [{
    ...record,
    sourceRecordHash: recordHash,
    attestation: { event: { created_at: createdAt } },
  }];
  const proofMultiplier = record.quantitative_alpha.target_multiplier;
  assert.ok(typeof proofMultiplier === "number" && proofMultiplier >= 0);
  const generated = await generateZkProof({
    snapshot, blockHeight: 0, timestamp: createdAt * 1_000, valuationMultiplier: proofMultiplier,
  });
  console.log("[3/4] Generated a local Groth16 proof bound to the fixture record fingerprint.");
  const verification = await client.verifyProof({ ...generated, data: snapshot });
  assert.equal(verification.valid, true, "Local Groth16 proof failed verification");
  assert.ok(completed.has("proof.verify"));
  for (const tool of ["stratigraphy.get", "proof.verify"]) {
    assert.equal(requests.get(tool), 2, `${tool} must have one challenge and one paid retry`);
  }
  console.log("[4/4] proof.verify: 402 -> mock L402 verification -> paid retry; Groth16 valid.");
  console.log("\nTHERMODYNAMIC AUDIT SETTLEMENT RECEIPT");
  console.log("======================================");
  console.log("Mode                 : MOCK L402 settlement (no Lightning funds spent)");
  console.log(`Catalog              : live free discovery; ${catalog.totalSnapshots} records`);
  console.log("Paid record source   : local dataset fixture (mock MCP response, not live paid retrieval)");
  console.log(`Selected snapshot    : indexed height ${latest}, day ${record.day}`);
  console.log(`Record SHA-256       : ${recordHash} (fingerprint, not a Bitcoin block hash)`);
  console.log(`Paid tool challenges : ${challengeLog.map(({ tool, status, amountSats }) => `${tool} HTTP ${status} / ${amountSats} sats`).join("; ")}`);
  console.log("Mock settlements     : 2 HMAC-bound macaroons, 2 hash-bound preimages, 2 one-time retries");
  console.log(`Groth16 verification : VALID (locally generated and verified, bound to fixture SHA-256)`);
  console.log(`Proof key ID         : ${generated.verificationKeyId}`);
  console.log(`Proof verified at    : ${verification.verifiedAt}`);
  console.log("Production payment   : NOT VERIFIED; no production-issued proof was supplied by stratigraphy.get");
}

main().catch((error: unknown) => {
  console.error("Audit agent failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await shutdownZkVerifier();
});