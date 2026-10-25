// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {createHash} from "node:crypto";
import type {Express, Request, Response} from "express";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import type {EnterpriseContext, EnterpriseEconomics} from "./enterprise-economics";
import {canonical, issuerKeyId} from "./article12-signature";
import {loadToolIntegrityKey} from "./tool-integrity";
import {sign} from "node:crypto";
import {wholesaleSubVending} from "./wholesale-sub-vending";

const HEX = /^[0-9a-f]{64}$/;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function optionalProtocolKey(meta: unknown, header: unknown): string | undefined {
  for (const value of [meta, header]) {
    if (value !== undefined && (typeof value !== "string" || !HEX.test(value)))
      throw new RangeError("Protocol digest or pubkey must be 64 lowercase hexadecimal characters");
  }
  if (meta !== undefined && header !== undefined && meta !== header)
    throw new RangeError("Conflicting protocol metadata and header");
  return (meta ?? header) as string | undefined;
}

/** Fingerprints identify the actual verification statement, not a caller-selected beneficiary. */
export function verificationFingerprint(args: Record<string, unknown>): string | undefined {
  if (args.proofType === "ots" && typeof args.targetHash === "string" && /^[0-9a-fA-F]{64}$/.test(args.targetHash))
    return args.targetHash.toLowerCase();
  if (args.circuit === "zk.drift.v1" && args.proof && args.sessionContextHash && args.targetBlockHeight !== undefined)
    return digest({circuit: args.circuit, proof: args.proof, sessionContextHash: args.sessionContextHash,
      targetBlockHeight: args.targetBlockHeight, entropyThreshold: args.entropyThreshold});
  let proof = args.proof;
  if (typeof proof === "string") {
    try {proof = JSON.parse(Buffer.from(proof,"base64url").toString("utf8"));}
    catch {return undefined;}
  }
  if (proof && typeof proof === "object") {
    const p = proof as Record<string,unknown>;
    const pi_a=p.pi_a ?? p.piA, pi_b=p.pi_b ?? p.piB, pi_c=p.pi_c ?? p.piC;
    const inputs=args.publicInputs as Record<string,unknown> | undefined;
    const signals=args.publicSignals ?? (inputs ? [String(inputs.blockHeight),inputs.thermodynamicHash,
      String(inputs.timestamp),String(inputs.valuationSat),inputs.snapshotDigest] : undefined);
    if (Array.isArray(pi_a) && Array.isArray(pi_b) && Array.isArray(pi_c) && Array.isArray(signals))
      return digest({proofType:"groth16",proof:{pi_a,pi_b,pi_c},publicSignals:signals});
  }
  return undefined;
}

export class SwarmProtocol {
  constructor(readonly service: EnterpriseEconomics,
    readonly key = loadToolIntegrityKey,
    readonly keyRevoked: (key: string) => Promise<boolean> = async () => false) {}

  async revoked(pubkey: string): Promise<boolean> {
    return await this.keyRevoked(pubkey) ||
      this.service.store.transaction("oracle-crl", tx => tx.isRevoked(pubkey));
  }

  async solvency(pubkey: string) {
    if (!HEX.test(pubkey)) throw new RangeError("Invalid NIP-98 pubkey");
    const metrics = await this.service.store.transaction("solvency:" + pubkey, tx => tx.agentMetrics(pubkey));
    if (!/^\d+$/.test(metrics.volume_msats) || !Number.isSafeInteger(metrics.executions) || metrics.executions < 0)
      throw new Error("Invalid ledger telemetry");
    const revoked = await this.revoked(pubkey);
    const sats = BigInt(metrics.volume_msats) / 1000n;
    const key = this.key();
    const payload = {pubkey, settled_volume_sats: sats.toString(), verified_executions: metrics.executions,
      revoked, solvency_tier: revoked ? "REVOKED" :
        sats >= 100_000_000n && metrics.executions >= 100 ? "TIER_2_INSTITUTIONAL" :
        sats > 0n && metrics.executions > 0 ? "TIER_1_VERIFIED" : "UNRATED",
      as_of: new Date(this.service.now()).toISOString(), issuer_key_id: issuerKeyId(key)};
    return {...payload, signature: sign(null, Buffer.from(canonical(payload)), key).toString("base64")};
  }

  async prepare(req: Request, context: EnterpriseContext) {
    const meta = req.body?.params?._meta;
    optionalProtocolKey(meta?.agentContextSha256, req.get("X-Agent-Context-SHA256"));
    optionalProtocolKey(meta?.targetPubkey, req.get("X-Target-Pubkey"));
    const declaredOrigin = optionalProtocolKey(meta?.originPubkey, req.get("X-Origin-Agent-Pubkey"));
    const verifying = req.body?.method === "tools/call" && req.body.params?.name === "proof.verify";
    if (declaredOrigin && !verifying && declaredOrigin !== context.buyer)
      throw new RangeError("Origin pubkey must match the authenticated NIP-98 signer");
    if (req.body?.method !== "tools/call" || req.body.params?.name !== "proof.verify" || !context.buyer) return;
    const proofHash = verificationFingerprint(req.body.params.arguments ?? {});
    if (!proofHash) return;
    const origin = await this.service.store.transaction("proof-origin:" + proofHash,
      tx => tx.security("proof-origin:" + proofHash));
    if (declaredOrigin && origin?.origin_pubkey !== declaredOrigin)
      throw new RangeError("Origin pubkey does not match the recorded verification statement");
    if (!origin || typeof origin.origin_pubkey !== "string" || origin.origin_pubkey === context.buyer) return;
    if (await this.revoked(origin.origin_pubkey)) throw new RangeError("Proof originator is revoked");
    context.verificationAllocation = {proof_hash: proofHash, origin_pubkey: origin.origin_pubkey, caller_pubkey: context.buyer};
  }

  async registerOrigin(pubkey: string, proofHash: string) {
    if (!HEX.test(pubkey) || !HEX.test(proofHash) || await this.revoked(pubkey)) return;
    await this.service.store.transaction("proof-origin:" + proofHash, async tx => {
      if (!await tx.security("proof-origin:" + proofHash))
        await tx.putSecurity("proof-origin:" + proofHash, {proof_hash: proofHash, origin_pubkey: pubkey,
          recorded_at: new Date(this.service.now()).toISOString(), attribution: "authenticated_first_recorded_origin"});
    });
  }

  async credit(invoiceHash: string, caller: string, proofHash: string, delegate?: string) {
    if (!HEX.test(caller) || !HEX.test(proofHash)) return;
    await this.service.store.transaction("invoice:" + invoiceHash, async tx => {
      const invoice = await tx.invoice(invoiceHash);
      const allocation = invoice?.verification_allocation;
      if (!invoice?.settled_at || !allocation || (allocation.caller_pubkey !== caller && delegate !== caller) ||
          allocation.proof_hash !== proofHash) return;
      const origin = await tx.security("proof-origin:" + proofHash);
      if (origin?.origin_pubkey !== allocation.origin_pubkey ||
          await tx.isRevoked(allocation.origin_pubkey) || await tx.isRevoked(caller) ||
          await tx.isRevoked(allocation.caller_pubkey) ||
          await this.keyRevoked(allocation.origin_pubkey) || await this.keyRevoked(caller) ||
          await this.keyRevoked(allocation.caller_pubkey)) return;
      const key = "verification-credit:" + invoiceHash;
      if (await tx.security(key)) return;
      const gross = BigInt(invoice.amount_msats);
      const upstream = gross * 15n / 100n, direct = gross * 21n / 100n - upstream;
      if (upstream + direct > gross * 21n / 100n) throw new Error("Allocation exceeds invoice pool");
      await tx.putSecurity(key, {invoice_hash: invoiceHash, ...allocation,
        upstream_msats: upstream.toString(), caller_msats: direct.toString(),
        gross_msats: gross.toString(), state: "pending", payout_mode: "ledger_only_no_automatic_disbursement"});
    });
  }

  async finish(req: Request, res: Response, name: string, args: Record<string, unknown>,
    result: CallToolResult): Promise<CallToolResult> {
    if (result.isError) return result;
    const caller = res.locals.swarmContext?.buyer as string | undefined;
    const body = result.structuredContent as Record<string, unknown> | undefined;
    if (caller && body) {
      if (name === "proof.notarize" && typeof args.hash === "string")
        await this.registerOrigin(caller, args.hash.toLowerCase());
      if (name === "proof.ground") {
        // Register only issuer-emitted receipt digests; never caller-chosen origin keys.
        const receipt = (body.receipt ?? body) as Record<string, unknown>;
        for (const field of ["receiptHash", "receiptSha256", "contextHash", "digest"]) {
          const value = receipt[field];
          if (typeof value === "string" && HEX.test(value)) await this.registerOrigin(caller, value);
        }
      }
      if (name === "proof.submit" && body.status === "verified") {
        const proof = (body.proofPayload ?? body) as Record<string, unknown>;
        const fingerprint = verificationFingerprint(args) ?? verificationFingerprint(proof);
        if (fingerprint) await this.registerOrigin(caller, fingerprint);
        if (typeof body.proofHash === "string" && /^(?:sha256:|0x)[0-9a-f]{64}$/.test(body.proofHash))
          await this.registerOrigin(caller, body.proofHash.replace(/^(?:sha256:|0x)/,""));
      }
      if (name === "proof.verify" && body.valid === true) {
        const fingerprint = verificationFingerprint(args);
        if (fingerprint && typeof res.locals.l402?.paymentHash === "string")
          await this.credit(res.locals.l402.paymentHash, caller, fingerprint, res.locals.l402.delegatePubkey);
      }
    }
    if (name !== "payment.get_info" || !body) return result;
    const target = optionalProtocolKey(req.body?.params?._meta?.targetPubkey, req.get("X-Target-Pubkey")) ?? caller;
    const content = {...body, wholesaleSubVending,
      upstreamVerificationAllocations: await this.service.store.transaction("verification-summary", tx => tx.upstreamMetrics()),
      ...(target ? {agentSolvencyAttestation: await this.solvency(target)} : {})};
    return {...result, structuredContent: content, content: [{type: "text", text: JSON.stringify(content)}]};
  }
}

export function registerSwarmProtocolRoutes(app: Express, protocol: SwarmProtocol) {
  app.locals.swarmProtocol = protocol;
  app.get("/api/v1/compliance/agent-solvency", async (req,res) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.pubkey !== "string" || !HEX.test(req.query.pubkey)) {
      res.status(400).json({error: "Provide one 64-character lowercase pubkey"}); return;
    }
    try {res.json({agentSolvencyAttestation: await protocol.solvency(req.query.pubkey)});}
    catch {res.status(503).json({error: "Signed solvency telemetry unavailable"});}
  });
  app.use("/api/v1/cost", (_req,res,next) => {
    const json=res.json.bind(res);
    res.json=(body: unknown) => json(res.statusCode < 400 && body && typeof body === "object" ?
      {...body, wholesaleSubVending}:body);
    next();
  });
  app.use("/api/v1/escrow/stats", async (req,res,next) => {
    try {
      const target = req.query.pubkey;
      if (target !== undefined && (typeof target !== "string" || !HEX.test(target))) {
        res.status(400).json({error: "Invalid pubkey"}); return;
      }
      const extra = {upstreamVerificationAllocations: await protocol.service.store.transaction("verification-summary", tx => tx.upstreamMetrics()),
        ...(typeof target === "string" ? {agentSolvencyAttestation: await protocol.solvency(target)} : {})};
      const json=res.json.bind(res);
      res.json=(body: unknown)=>json(res.statusCode < 400 && body && typeof body === "object" ? {...body,...extra}:body);
      res.set("Cache-Control","no-store"); next();
    } catch {res.status(503).json({error:"Allocation telemetry unavailable"});}
  });
}
