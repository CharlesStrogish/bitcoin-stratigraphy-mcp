import { createHash } from "node:crypto";
import type { BitcoinStratigraphyClient as RestClient, PaidStratigraphyResponse } from "@bitcoin-stratigraphy/sdk";
import type { BitcoinStratigraphyClient as McpClient } from "@bitcoin-stratigraphy/sdk/mcp";
import type { Checkpoint, StateStore } from "./state.js";

export type AgentEvent =
  | { type: "telemetry"; day: number; signal: string }
  | { type: "verified"; snapshotKey: string }
  | { type: "broadcast"; date: string; peerAttestations: number }
  | { type: "isolated"; reason: string }
  | { type: "error"; error: string };

export type AgentDependencies = {
  rest: Pick<RestClient, "getLatest">;
  mcp: Pick<McpClient, "verifyProof" | "getMeshStatus" | "listStratigraphy" | "broadcastMeshSignal">;
  store: StateStore;
  emit: (event: AgentEvent) => void;
};

function fingerprint(response: PaidStratigraphyResponse): string {
  // Ignore freshly signed Nostr attestations: only source record changes are new.
  const records = response.data.map(({
    day, title, video_id, transcript_summary, quantitative_alpha,
  }) => ({ day, title, video_id, transcript_summary, quantitative_alpha }));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

/** One iteration; a checkpoint is written only after each successful paid step. */
export async function runCycle({ rest, mcp, store, emit }: AgentDependencies): Promise<void> {
  const snapshot = await rest.getLatest();
  const latest = snapshot.data.at(-1);
  if (!latest || !snapshot.zkProof?.proof || !snapshot.zkProof.verificationKeyId) {
    throw new Error("The paid dataset did not include records and a verifiable proof");
  }
  emit({
    type: "telemetry", day: latest.day,
    signal: latest.quantitative_alpha.thermodynamic_signal,
  });

  const snapshotKey = fingerprint(snapshot);
  let checkpoint: Checkpoint = await store.load() ?? { snapshotKey, verified: false };
  if (checkpoint.snapshotKey !== snapshotKey) {
    checkpoint = { snapshotKey, verified: false };
  }
  if (!checkpoint.verified) {
    // proof.list/status only carry lifecycle metadata, not the proof bytes.
    // Use the exact proof and data emitted together by the REST SDK.
    const verified = await mcp.verifyProof({
      proof: snapshot.zkProof.proof,
      publicInputs: snapshot.zkProof.publicInputs,
      verificationKeyId: snapshot.zkProof.verificationKeyId,
      data: snapshot.data as unknown as Record<string, unknown>[],
    });
    if (!verified.valid) {
      throw new Error(`The dataset proof was invalid: ${verified.error ?? "verification failed"}`);
    }
    checkpoint = { snapshotKey, verified: true };
    await store.save(checkpoint);
    emit({ type: "verified", snapshotKey });
  }

  const mesh = await mcp.getMeshStatus();
  if (mesh.configuredPeerCount < 1 || mesh.topologyHealth === "isolated") {
    emit({ type: "isolated", reason: "No trusted mesh peers configured or reachable" });
    return;
  }
  const catalog = await mcp.listStratigraphy();
  const date = catalog.dateBounds.endDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("The stratigraphy catalog did not include a broadcast date");
  }
  if (checkpoint.broadcastDate === date) return;

  // The server signs its own canonical record for this date and verifies quorum.
  const receipt = await mcp.broadcastMeshSignal(date);
  if (receipt.date !== date || receipt.peerAttestations < 1) {
    throw new Error("Mesh broadcast did not return a matching peer receipt");
  }
  await store.save({ ...checkpoint, broadcastDate: date });
  emit({ type: "broadcast", date, peerAttestations: receipt.peerAttestations });
}

export async function runAgentLoop(
  dependencies: AgentDependencies,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 900_000) {
    throw new Error("POLL_INTERVAL_MS must be at least 900000 (15 minutes)");
  }
  while (!signal.aborted) {
    try {
      await runCycle(dependencies);
    } catch (error) {
      dependencies.emit({
        type: "error",
        error: error instanceof Error ? error.message : "Unknown worker error",
      });
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", done);
        resolve();
      }, intervalMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
    });
  }
}