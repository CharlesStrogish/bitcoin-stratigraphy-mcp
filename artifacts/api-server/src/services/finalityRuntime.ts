import { pool } from "@workspace/db";
import { McpFinalityTasks } from "../lib/mcp-finality-tasks";
import { finalityReceiptArchive } from "../lib/finality-receipt-archive";
import type { McpUrlElicitation } from "../lib/mcp-url-elicitation";
import { createPostgresWaiverStore } from "./agplWaiverStore";
import { createWaiverChainReader } from "./agplWaivers";
import { observeOtsFinality } from "./otsProvenance";

export function createFinalityRuntime(ownership: McpUrlElicitation) {
  return new McpFinalityTasks({
    ownership,
    receipts: finalityReceiptArchive(),
    waivers: createPostgresWaiverStore(pool),
    chain: createWaiverChainReader(),
    observeOts: observeOtsFinality,
  });
}
