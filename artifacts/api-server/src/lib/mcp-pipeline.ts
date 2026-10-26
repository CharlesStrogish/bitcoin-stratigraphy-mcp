// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import { createHash, randomUUID, type KeyObject } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { ZodIssue, ZodTypeAny } from "zod";
import { pool } from "@workspace/db";
import { canonical, issuerKeyId, signIssuerPayload } from "./article12-signature";
import { canonicalToolName, mcpToolPrices, MCP_INVOICE_EXPIRY_SECONDS } from "./mcp-pricing";
import { createL402Middleware } from "../middleware/l402";
import { invoicePow } from "./invoice-pow";
import type { SettlementRouter } from "../services/settlement";
import type { MacaroonUsageStore } from "./macaroon-usage-store";
import type { MacaroonRevocationStore } from "./macaroon-revocation-store";
import type { RevenueLedger } from "../services/ledger";
import type { McpTaskOutcome } from "./mcp-async-tasks";

export const PIPELINE_DOMAIN = "bitcoin-stratigraphy/mcp-pipeline/v1\n";
export const MAX_PIPELINE_CALLS = 100;
const MAX_BYTES = 4 * 1024 * 1024;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export const pipelineDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
type Call = { jsonrpc: "2.0"; id: string | number; method: "tools/call";
  params: { name: string; arguments?: Record<string, unknown> } };
type Plan = { calls: Call[]; digest: string; amountSats: number };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** References use an earlier zero-based step and RFC 6901 pointer into its MCP result. */
function reference(value: unknown): { step: number; path: string[] } | undefined {
  if (!record(value) || !Object.hasOwn(value, "$ref")) return;
  if (Object.keys(value).length !== 1 || typeof value.$ref !== "string")
    throw new RangeError("A pipeline reference must contain only a string $ref");
  const match = /^(0|[1-9]\d*)#(\/.*|)$/.exec(value.$ref);
  if (!match || /~(?![01])/.test(match[2]))
    throw new RangeError("Use $ref: '<earlier-step>#/structuredContent/field'");
  const path = match[2] === "" ? [] : match[2].slice(1).split("/")
    .map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (path.some(part => forbidden.has(part))) throw new RangeError("Unsafe pipeline reference");
  return { step: Number(match[1]), path };
}

function referencePaths(value: unknown, step: number, path: (string | number)[] = [],
  paths: (string | number)[][] = [], depth = 0): (string | number)[][] {
  if (depth > 64) throw new RangeError("Pipeline arguments exceed maximum nesting");
  const ref = reference(value);
  if (ref) {
    if (!Number.isSafeInteger(ref.step) || ref.step >= step)
      throw new RangeError("Pipeline references must point to an earlier step");
    paths.push(path);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbidden.has(key)) throw new RangeError("Unsafe pipeline argument key");
      referencePaths(item, step, [...path, Array.isArray(value) ? Number(key) : key], paths, depth + 1);
    }
  }
  return paths;
}

function deferredIssue(issue: ZodIssue, paths: (string | number)[][]): boolean {
  if (issue.code === "invalid_union")
    return issue.unionErrors.some(branch => branch.issues.every(item => deferredIssue(item, paths)));
  return paths.some(path => path.every((part, index) => issue.path[index] === part));
}

export function pipelinePlan(body: unknown, schemaFor: (name: string) => ZodTypeAny): Plan {
  const calls = Array.isArray(body) ? body : record(body) && record(body.params) ? body.params.calls : undefined;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_PIPELINE_CALLS)
    throw new RangeError(`A pipeline requires 1-${MAX_PIPELINE_CALLS} ordered tools/call requests`);
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw new RangeError("Pipeline request exceeds 4 MiB");
  const ids = new Set<string>();
  let amountSats = 0;
  for (const [index, call] of calls.entries()) {
    if (!record(call) || call.jsonrpc !== "2.0" || call.method !== "tools/call" ||
        !(typeof call.id === "string" || typeof call.id === "number" && Number.isSafeInteger(call.id)) ||
        !record(call.params) || typeof call.params.name !== "string" ||
        Object.keys(call).some(key => !["jsonrpc", "id", "method", "params"].includes(key)) ||
        Object.keys(call.params).some(key => !["name", "arguments"].includes(key)))
      throw new RangeError("Each pipeline step must be a tools/call request with an id, name and arguments");
    const id = JSON.stringify(call.id);
    if (ids.has(id)) throw new RangeError("Pipeline step ids must be unique");
    ids.add(id);
    const name = canonicalToolName(call.params.name);
    if (!Object.hasOwn(mcpToolPrices, name)) throw new RangeError("Unknown pipeline tool");
    const args = call.params.arguments ?? {};
    if (!record(args)) throw new RangeError("Pipeline arguments must be an object");
    // Nested async execution would break ordered completion and the unified receipt.
    if (Object.hasOwn(args, "webhook_url")) throw new RangeError("Pipeline steps execute synchronously; omit webhook_url");
    const paths = referencePaths(args, index);
    const parsed = schemaFor(name).safeParse(args);
    if (!parsed.success && !parsed.error.issues.every(issue => deferredIssue(issue, paths)))
      throw new RangeError(`Invalid arguments for pipeline step ${index} (${name})`);
    amountSats += mcpToolPrices[name as keyof typeof mcpToolPrices];
  }
  if (!Number.isSafeInteger(amountSats * 1000)) throw new RangeError("Pipeline price exceeds safe range");
  return { calls: calls as Call[], digest: pipelineDigest(body), amountSats };
}

export function resolvePipelineArguments(value: unknown, results: unknown[]): unknown {
  const ref = reference(value);
  if (ref) {
    let output: unknown = results[ref.step];
    for (const part of ref.path) {
      if (output === null || typeof output !== "object" || !Object.hasOwn(output, part))
        throw new RangeError("Pipeline reference does not exist in the earlier result");
      output = (output as Record<string, unknown>)[part];
    }
    if (output === undefined) throw new RangeError("Pipeline reference result is unavailable");
    return structuredClone(output);
  }
  if (Array.isArray(value)) return value.map(item => resolvePipelineArguments(item, results));
  if (record(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, resolvePipelineArguments(item, results)]));
  return value;
}

/** Existing JSONB evidence store: no new schema, migrations, or startup DDL. */
export interface PipelineReceiptStore {
  ready(): Promise<void>;
  reserve(key: string, record: Record<string, unknown>): Promise<boolean>;
  save(key: string, record: Record<string, unknown>): Promise<void>;
}
export function postgresPipelineReceiptStore(database: {
  query(text: string, values?: unknown[]): Promise<{rows: unknown[]}>;
} = pool): PipelineReceiptStore {
  return {
    async ready() {
      await database.query("SELECT record_key, payload FROM enterprise_affiliate_security LIMIT 0");
    },
    async reserve(key, value) {
      const result = await database.query(
        "INSERT INTO enterprise_affiliate_security (record_key,payload) VALUES ($1,$2::jsonb) ON CONFLICT (record_key) DO NOTHING RETURNING record_key",
        [key, JSON.stringify(value)]);
      return result.rows.length === 1;
    },
    async save(key, value) {
      const result = await database.query(
        "UPDATE enterprise_affiliate_security SET payload=$2::jsonb WHERE record_key=$1 RETURNING record_key",
        [key, JSON.stringify(value)]);
      if (result.rows.length !== 1) throw new Error("Pipeline evidence reservation missing");
    },
  };
}

export function createMcpPipelineHandler(options: {
  settlementRouter: SettlementRouter; sessionSecret?: string;
  usageStore?: MacaroonUsageStore; revocationStore: MacaroonRevocationStore; ledger?: RevenueLedger;
  store?: PipelineReceiptStore; key: () => KeyObject;
  schemaFor: (name: string) => ZodTypeAny;
  execute: (req: Request, res: Response, name: string, args: Record<string, unknown>,
    signal: AbortSignal) => Promise<McpTaskOutcome>;
}): RequestHandler {
  const store = options.store ?? postgresPipelineReceiptStore();
  const plans = new WeakMap<Request, Plan>();
  const gate = createL402Middleware({
    invoicePow,
    ...options, amountSats: req => plans.get(req)!.amountSats,
    enforceCurrentAmount: true,
    scopePath: req => `/mcp/pipelines/${plans.get(req)!.digest}`,
    description: "Bitcoin Stratigraphy MCP pipeline execution",
    invoiceExpirySeconds: MCP_INVOICE_EXPIRY_SECONDS, allowBatch: false,
    // One combined challenge can replace many per-tool challenges from the
    // same enterprise gateway; still bound unpaid invoice creation.
    maxChallengesPerMinute: 100,
    requestKind: "stratigraphy",
  });
  return async (req, res, next) => {
    if (!Array.isArray(req.body) && !["tools/pipeline", "tools/batch"].includes(req.body?.method)) return next();
    // Preserve free JSON-RPC discovery batches; only arrays containing tool calls
    // opt into the paid ordered extension. Modern MCP still disallows raw arrays.
    if (Array.isArray(req.body) && !req.body.some(item => item?.method === "tools/call")) return next();
    const id = Array.isArray(req.body) ? null : req.body.id;
    let plan: Plan;
    let key: KeyObject;
    try {
      if (req.get("X-L402-Batch-Size") || req.get("PAYMENT-SIGNATURE"))
        throw new RangeError("Pipelines use a single Lightning invoice, not x402 or X-L402-Batch-Size");
      if (!Array.isArray(req.body) &&
          (req.body.jsonrpc !== "2.0" ||
           !(typeof id === "string" || typeof id === "number" && Number.isSafeInteger(id)) ||
           !record(req.body.params) ||
           Object.keys(req.body.params).some(field => !["calls", "_meta"].includes(field))))
        throw new RangeError("Use a tools/pipeline JSON-RPC request with params.calls");
      plan = pipelinePlan(req.body, options.schemaFor);
      key = options.key();
      issuerKeyId(key);
      await store.ready();
      plans.set(req, plan);
    } catch (error) {
      res.status(error instanceof RangeError ? 400 : 503).json({
        jsonrpc: "2.0", id, error: { code: error instanceof RangeError ? -32602 : -32603,
          message: error instanceof RangeError ? error.message : "Pipeline signing or durable evidence storage unavailable; no payment consumed" },
      });
      return;
    }
    const execute = async () => {
      const paid = res.locals.l402 as { paymentHash: string; provider: string; settledAt: number } | undefined;
      const receiptId = paid?.paymentHash ?? randomUUID();
      const recordKey = `mcp-pipeline:${receiptId}`;
      const startedAt = new Date().toISOString();
      const steps: Record<string, unknown>[] = [];
      const journal = { version: "mcp-pipeline-v1", request_sha256: plan.digest,
        payment_hash: paid?.paymentHash ?? null, amount_sats: plan.amountSats,
        provider: paid?.provider ?? null, started_at: startedAt, steps };
      if (!await store.reserve(recordKey, { ...journal, status: "running" })) {
        res.status(409).json({jsonrpc: "2.0", id,
          error: {code: -32602, message: "Pipeline payment already reserved; execution was not repeated"}});
        return;
      }
      const controller = new AbortController();
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", onClose);
      const timer = setTimeout(() => controller.abort(), 300_000);
      timer.unref();
      const responses: unknown[] = [];
      const results: unknown[] = [];
      let status = "completed";
      let bytes = 0;
      try {
        for (const [index, call] of plan.calls.entries()) {
          const name = canonicalToolName(call.params.name);
          let args: Record<string, unknown> | undefined;
          let outcome: McpTaskOutcome;
          const stepStartedAt = new Date().toISOString();
          try {
            if (controller.signal.aborted) throw new Error("Pipeline interrupted");
            args = options.schemaFor(name).parse(resolvePipelineArguments(call.params.arguments ?? {}, results));
            if (Object.hasOwn(args!, "webhook_url")) throw new RangeError("Pipeline steps cannot spawn webhook jobs");
            outcome = await options.execute(req, res, name, args!, controller.signal);
          } catch (error) {
            outcome = { error: {code: error instanceof RangeError ? -32602 : -32603,
              message: error instanceof RangeError ? error.message : "Pipeline step failed"} };
            req.log?.warn({err: error, step: index, tool: name}, "MCP pipeline step failed");
          }
          const failed = "error" in outcome || outcome.result.isError === true;
          const response = {jsonrpc: "2.0", id: call.id, ...outcome};
          bytes += Buffer.byteLength(JSON.stringify(response));
          steps.push({index, id: call.id, tool: name, status: failed ? "failed" : "completed",
            started_at: stepStartedAt, completed_at: new Date().toISOString(),
            input_sha256: pipelineDigest(args ?? call.params.arguments ?? {}),
            output_sha256: pipelineDigest(outcome)});
          // Store commitments only: arguments/results may contain holder credentials.
          await store.save(recordKey, {...journal, status: "running"});
          responses.push(response);
          if ("result" in outcome) results.push(outcome.result);
          if (failed || bytes > MAX_BYTES || controller.signal.aborted) {
            status = failed ? "failed" : "interrupted";
            break;
          }
        }
        const receipt = signIssuerPayload({
          ...journal, receipt_id: receiptId, status, total_steps: plan.calls.length,
          completed_steps: steps.filter(step => step.status === "completed").length,
          finished_at: new Date().toISOString(),
          steps_sha256: pipelineDigest(steps),
          execution_semantics: "sequential_fail_fast_no_external_side_effect_rollback",
          compliance_scope: "Article 12 technical record-keeping evidence; not legal certification or Bitcoin anchoring",
        }, key, "mcp-pipeline-ed25519-v1", PIPELINE_DOMAIN);
        await store.save(recordKey, {...journal, status, receipt});
        res.setHeader("Cache-Control", "no-store");
        if (!res.destroyed) res.status(200).json({jsonrpc: "2.0", id,
          result: {status, responses, receipt}});
      } finally {
        clearTimeout(timer);
        res.off("close", onClose);
      }
    };
    try {
      if (plan.amountSats === 0) await execute();
      else await gate(req, res, error => {
        if (error) return next(error);
        void execute().catch(next);
      });
    } catch (error) { next(error); }
  };
}
