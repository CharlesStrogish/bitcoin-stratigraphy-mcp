import { createHash } from "node:crypto";
import {
  type McpTaskStore,
  type TaskRecord,
  postgresMcpTaskStore,
} from "./mcp-task-store";
import { McpUrlElicitation, UrlHandoffError } from "./mcp-url-elicitation";
import type {
  WaiverQuote,
  Certificate,
  ChainSettlement,
} from "../services/agplWaivers";
import { logger } from "./logger";

export type FinalitySource =
  | {
      domain: "ots_finality";
      digest: string;
      receiptSha256: string;
      objectPath: string;
    }
  | { domain: "waiver_finality"; quoteId: string; txid?: string };
export type FinalityValue = {
  domain: "ots_finality" | "waiver_finality";
  execution_status:
    | "receipt_issued"
    | "quote_active"
    | "claim_submitted"
    | "certificate_issued";
  finality_status:
    | "pending_calendar"
    | "bitcoin_anchored"
    | "awaiting_broadcast"
    | "confirming"
    | "confirmed"
    | "expired"
    | "failed";
  next_step: string;
  idempotency_key: string;
  confirmations_observed?: number;
  confirmations_required?: number;
  quote_expires_at?: string;
  certificate_ready?: boolean;
  certificate_reference?: { waiver_id: string; txid: string; vout: number };
  txid?: string;
  block_height?: number;
  block_hash?: string;
  upgraded_proof_sha256?: string;
  observation_status?: "available" | "temporarily_unavailable";
};
export type FinalityTracking = {
  ownerHash: string;
  source: FinalitySource;
  value: FinalityValue;
  checkedAt?: number;
};
export interface FinalityDependencies {
  receipts: {
    put(
      owner: string,
      proofHex: string,
    ): Promise<{ objectPath: string; sha256: string }>;
    get(objectPath: string): Promise<string>;
  };
  observeOts(
    proofHex: string,
    digest: string,
  ): Promise<{
    anchored: boolean;
    blockHeight?: number;
    blockHash?: string;
    proofSha256?: string;
  }>;
  waivers: Pick<
    import("../services/agplWaivers").WaiverStore,
    "quote" | "certificate"
  >;
  chain(txid: string): Promise<ChainSettlement>;
  ownership: McpUrlElicitation;
}
export const FINALITY_ID = /^fin_[A-Za-z0-9_-]{43}$/;
const identity = (owner: string, domain: string, ref: string) =>
  "fin_" +
  createHash("sha256")
    .update("mcp-finality-v1\0" + owner + "\0" + domain + "\0" + ref)
    .digest("base64url");
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class FinalityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class FinalityTerminalError extends Error {}

/** Tracking mutates only its own task metadata, never payment/quote/certificate state. */
export class McpFinalityTasks {
  private flights = new Map<string, Promise<TaskRecord>>();
  constructor(
    readonly dependencies: FinalityDependencies,
    readonly store: McpTaskStore = postgresMcpTaskStore(),
    readonly now: () => number = Date.now,
  ) {}

  async owned(
    id: unknown,
    owner: string,
  ): Promise<TaskRecord & { finality: FinalityTracking }> {
    if (typeof id !== "string" || !FINALITY_ID.test(id))
      throw new FinalityError(404, "Finality task not found");
    const task = await this.store.get(id);
    if (
      !task?.finality ||
      task.finality.ownerHash !== owner ||
      this.now() >= Date.parse(task.createdAt) + task.ttlMs
    )
      throw new FinalityError(404, "Finality task not found");
    return task as TaskRecord & { finality: FinalityTracking };
  }
  private async create(
    owner: string,
    source: FinalitySource,
    value: FinalityValue,
    reference: string,
  ) {
    if (!/^[0-9a-f]{64}$/.test(owner))
      throw new FinalityError(403, "Authenticated owner required");
    const taskId = identity(owner, source.domain, reference);
    const existing = await this.store.get(taskId);
    if (existing) return this.owned(taskId, owner);
    const timestamp = new Date(this.now()).toISOString();
    const task: TaskRecord = {
      taskId,
      tool: source.domain,
      arguments: {},
      status: "working",
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
      ttlMs: 30 * 86400_000,
      pollIntervalMs: 10_000,
      revision: 0,
      finality: {
        ownerHash: owner,
        source,
        value: { ...value, idempotency_key: taskId },
      },
    };
    if (this.store.createFinality) await this.store.createFinality(task);
    else {
      try {
        await this.store.create(task);
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
    return this.owned(taskId, owner);
  }
  async registerOts(
    owner: string,
    receipt: { hash: string; otsProofHex: string },
  ) {
    if (
      !/^[0-9a-f]{64}$/.test(receipt.hash) ||
      !/^(?:[0-9a-f]{2})+$/.test(receipt.otsProofHex) ||
      receipt.otsProofHex.length > 1024 * 1024
    )
      throw new FinalityError(400, "Invalid detached OTS receipt");
    const receiptSha256 = createHash("sha256")
      .update(Buffer.from(receipt.otsProofHex, "hex"))
      .digest("hex");
    const id = identity(owner, "ots_finality", receiptSha256);
    if (await this.store.get(id)) return this.owned(id, owner);
    // Only trusted server-produced receipts enter here. Public registration verifies first.
    const archived = await this.dependencies.receipts.put(
      owner,
      receipt.otsProofHex,
    );
    if (archived.sha256 !== receiptSha256)
      throw new Error("Receipt archive integrity mismatch");
    return this.create(
      owner,
      {
        domain: "ots_finality",
        digest: receipt.hash,
        receiptSha256,
        objectPath: archived.objectPath,
      },
      {
        domain: "ots_finality",
        execution_status: "receipt_issued",
        finality_status: "pending_calendar",
        idempotency_key: id,
        next_step:
          "poll_tracking; receipt execution is complete, Bitcoin finality is pending",
      },
      receiptSha256,
    );
  }
  /** Called only after the existing quote handler has actually returned its quote. */
  async bindCreatedQuote(owner: string, quote: WaiverQuote) {
    return this.create(
      owner,
      { domain: "waiver_finality", quoteId: quote.quote_id },
      this.waiverValue(quote),
      quote.quote_id,
    );
  }
  private waiverValue(quote: WaiverQuote, txid?: string): FinalityValue {
    return {
      domain: "waiver_finality",
      execution_status: txid ? "claim_submitted" : "quote_active",
      finality_status: txid ? "confirming" : "awaiting_broadcast",
      idempotency_key: "",
      confirmations_observed: 0,
      confirmations_required: quote.min_confirmations,
      quote_expires_at: quote.expires_at,
      certificate_ready: false,
      ...(txid ? { txid } : {}),
      next_step: txid
        ? "keep_polling; bound TXID is a claim, not verified settlement"
        : "broadcast_payment_to_existing_quote_then_register_txid",
    };
  }
  async registerWaiver(
    owner: string,
    input: { quote_id: string; txid?: string; handoff_id?: string },
  ) {
    if (
      !uuid.test(input.quote_id) ||
      (input.txid !== undefined && !/^[0-9a-fA-F]{64}$/.test(input.txid))
    )
      throw new FinalityError(400, "Invalid quote or transaction ID");
    const unbound = await this.store.get(
      identity(owner, "waiver_finality", input.quote_id),
    );
    if (unbound?.finality?.ownerHash !== owner) {
      if (!input.handoff_id)
        throw new FinalityError(
          403,
          "An owner-bound quote or matching checkout handoff is required",
        );
      try {
        const handoff = await this.dependencies.ownership.getHandoffStatus(
          input.handoff_id,
          owner,
        );
        if (
          handoff.intent !== "agpl_waiver_checkout" ||
          handoff.referenceId !== "waiver:" + input.quote_id
        )
          throw new FinalityError(403, "Quote ownership mismatch");
      } catch (error) {
        if (error instanceof UrlHandoffError)
          throw new FinalityError(error.status, error.message);
        throw error;
      }
    }
    const quote = await this.dependencies.waivers.quote(input.quote_id);
    if (!quote) throw new FinalityError(404, "Waiver quote not found");
    // Save the ownership binding even after the short-lived checkout handoff expires.
    await this.bindCreatedQuote(owner, quote);
    if (!input.txid)
      return this.owned(
        identity(owner, "waiver_finality", input.quote_id),
        owner,
      );
    const txid = input.txid.toLowerCase();
    return this.create(
      owner,
      { domain: "waiver_finality", quoteId: quote.quote_id, txid },
      this.waiverValue(quote, txid),
      quote.quote_id + ":" + txid,
    );
  }
  view(task: TaskRecord & { finality: FinalityTracking }) {
    return {
      taskId: task.taskId,
      status: task.status,
      statusMessage:
        task.status === "cancelled"
          ? "Tracking cancelled; underlying execution is unchanged"
          : task.finality.value.next_step,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      pollInterval: task.pollIntervalMs,
      ttlMs: task.ttlMs,
      finality: task.finality.value,
    };
  }
  handle(task: TaskRecord & { finality: FinalityTracking }) {
    return {
      task_id: task.taskId,
      task_type: task.finality.value.domain,
      execution_status: task.finality.value.execution_status,
      finality_status: task.finality.value.finality_status,
      poll_via: ["tasks/get", "/api/v1/finality/tasks/" + task.taskId],
    };
  }
  async inspect(id: unknown, owner: string) {
    const task = await this.owned(id, owner);
    if (
      task.status === "cancelled" ||
      (task.status === "failed" &&
        task.finality.source.domain === "ots_finality") ||
      task.finality.value.execution_status === "certificate_issued"
    )
      return task;
    if (this.flights.size >= 4 && !this.flights.has(task.taskId)) return task;
    // Single-flight bounded observation; every waiter still authenticates above.
    const active = this.flights.get(task.taskId);
    if (active)
      return active as Promise<TaskRecord & { finality: FinalityTracking }>;
    const job = this.refresh(task);
    this.flights.set(task.taskId, job);
    try {
      return await job;
    } finally {
      if (this.flights.get(task.taskId) === job)
        this.flights.delete(task.taskId);
    }
  }
  private async refresh(task: TaskRecord & { finality: FinalityTracking }) {
    const source = task.finality.source;
    if (
      source.domain === "ots_finality" &&
      task.finality.checkedAt !== undefined &&
      this.now() - task.finality.checkedAt < 10_000
    )
      return task;
    let value = { ...task.finality.value },
      status = task.status;
    try {
      if (source.domain === "ots_finality") {
        if (task.status === "completed") return task;
        const bytes = await this.dependencies.receipts.get(source.objectPath);
        if (
          createHash("sha256")
            .update(Buffer.from(bytes, "hex"))
            .digest("hex") !== source.receiptSha256
        )
          throw new FinalityTerminalError("Stored receipt integrity mismatch");
        const observed = await this.dependencies.observeOts(
          bytes,
          source.digest,
        );
        if (observed.anchored) {
          if (
            !Number.isSafeInteger(observed.blockHeight) ||
            observed.blockHeight! <= 0 ||
            !/^[0-9a-f]{64}$/.test(observed.blockHash ?? "")
          )
            throw new FinalityTerminalError(
              "Invalid Bitcoin finality evidence",
            );
          value = {
            ...value,
            finality_status: "bitcoin_anchored",
            block_height: observed.blockHeight,
            block_hash: observed.blockHash,
            upgraded_proof_sha256: observed.proofSha256,
            next_step:
              "complete; retain the original detached receipt for independent verification",
          };
          status = "completed";
        }
      } else {
        const quote = await this.dependencies.waivers.quote(source.quoteId);
        if (!quote)
          throw new FinalityTerminalError("Underlying quote is unavailable");
        const certificate = await this.dependencies.waivers.certificate(
          source.quoteId,
        );
        if (certificate) {
          if (source.txid && source.txid !== certificate.txid)
            throw new FinalityTerminalError(
              "Quote settled with another transaction",
            );
          value = {
            ...value,
            execution_status: "certificate_issued",
            finality_status: "confirmed",
            certificate_ready: true,
            txid: certificate.txid,
            certificate_reference: this.reference(certificate),
            next_step:
              "complete; original idempotent claim endpoint returns the exact persisted certificate",
          };
          status = "completed";
        } else if (task.status === "failed") {
          return task;
        } else if (!source.txid) {
          if (this.now() >= Date.parse(quote.expires_at)) {
            value = {
              ...value,
              finality_status: "expired",
              next_step:
                "quote_expired; do not create another payment for an existing transaction",
            };
            status = "failed";
          }
        } else {
          if (
            !Number.isSafeInteger(quote.derivation_index) ||
            quote.derivation_index! < 0
          )
            throw new FinalityTerminalError("Legacy quote requires review");
          const settlement = await this.dependencies.chain(source.txid);
          if (
            !settlement.outputs.some(
              (o) =>
                o.address === quote.settlement_address &&
                Number.isSafeInteger(o.sats) &&
                o.sats >= quote.quoted_sats &&
                Number.isSafeInteger(o.vout) &&
                o.vout >= 0,
            )
          )
            throw new FinalityTerminalError(
              "Transaction does not fund this quote",
            );
          const confirmations =
            settlement.confirmed &&
            Number.isSafeInteger(settlement.confirmations) &&
            settlement.confirmations > 0
              ? settlement.confirmations
              : 0;
          const firstConfirmed =
            settlement.confirmed &&
            Number.isSafeInteger(settlement.blockTime) &&
            settlement.blockTime >= Date.parse(quote.created_at) - 900_000 &&
            settlement.blockTime <= this.now();
          const timely =
            firstConfirmed &&
            settlement.blockTime < Date.parse(quote.expires_at);
          if (settlement.confirmed && !firstConfirmed)
            throw new FinalityTerminalError(
              "Transaction confirmation time is invalid",
            );
          value = {
            ...value,
            confirmations_observed: confirmations,
            certificate_ready:
              timely && confirmations >= quote.min_confirmations,
            finality_status:
              timely && confirmations >= quote.min_confirmations
                ? "confirmed"
                : "confirming",
            next_step:
              timely && confirmations >= quote.min_confirmations
                ? "invoke_idempotent_POST_/api/v1/waivers/claim_with_same_quote_id_and_txid"
                : "keep_polling; do not create a new quote or resend payment",
          };
          status = value.certificate_ready ? "completed" : "working";
          // Preserve timely first confirmations while later confirmations accrue.
          if (!timely && this.now() >= Date.parse(quote.expires_at)) {
            value = {
              ...value,
              finality_status: "expired",
              certificate_ready: false,
              next_step:
                "quote_expired; recover the existing payment; do not pay again",
            };
            status = "failed";
          }
        }
      }
      value.observation_status = "available";
    } catch (error) {
      if (error instanceof FinalityTerminalError) {
        value = {
          ...value,
          finality_status: "failed",
          certificate_ready: false,
          next_step: error.message,
        };
        status = "failed";
      } else {
        value = {
          ...value,
          observation_status: "temporarily_unavailable",
          certificate_ready: false,
          next_step:
            "observation_unavailable; retry tracking, do not repeat payment or execution",
        };
        if (source.domain === "waiver_finality") {
          status = "working";
          value.finality_status = source.txid
            ? "confirming"
            : "awaiting_broadcast";
        }
      }
    }
    const next = {
      ...task,
      status,
      lastUpdatedAt: new Date(this.now()).toISOString(),
      revision: task.revision + 1,
      finality: { ...task.finality, value, checkedAt: this.now() },
    };
    if (await this.store.replace(next, task.revision)) return next;
    return this.owned(task.taskId, task.finality.ownerHash); // cancellation wins any in-flight observation
  }
  private reference(certificate: Certificate) {
    return {
      waiver_id: certificate.waiver_id,
      txid: certificate.txid,
      vout: certificate.vout,
    };
  }
  async cancel(id: unknown, owner: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const task = await this.owned(id, owner);
      if (task.status === "cancelled") return task;
      if (
        await this.store.replace(
          {
            ...task,
            status: "cancelled",
            revision: task.revision + 1,
            lastUpdatedAt: new Date(this.now()).toISOString(),
          },
          task.revision,
        )
      )
        return this.owned(task.taskId, owner);
    }
    throw new FinalityError(409, "Tracking changed; retry cancellation");
  }
  start() {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        for (const row of (await this.store.workingFinality?.()) ?? [])
          if (row.finality)
            await this.inspect(row.taskId, row.finality.ownerHash);
      })()
        .catch(() =>
          logger.warn(
            "Finality observation deferred; durable tracking remains pending",
          ),
        )
        .finally(() => {
          busy = false;
        });
    }, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
