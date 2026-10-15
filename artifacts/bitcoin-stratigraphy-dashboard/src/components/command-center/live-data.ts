// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useQuery } from "@tanstack/react-query";
import {
  getGetEscrowGenesisReceiptQueryKey,
  getGetEscrowLedgerStatsQueryKey,
  getGetEscrowTollQueryKey,
  getGetProvenanceAnchorQueryKey,
  getGetProvenanceChainQueryKey,
  getRevenueAnalytics,
  getRevenueAudit,
  quoteMcpToolCosts,
  useGetEscrowGenesisReceipt,
  useGetEscrowLedgerStats,
  useGetEscrowToll,
  useGetProvenanceAnchor,
  useGetProvenanceChain,
  type McpBatchCostQuoteL402Batch,
} from "@workspace/api-client-react";
import { CANONICAL_MCP_TOOL_NAMES } from "./catalog";

/*
 * Every telemetry read counts against the API's public limit: 100 requests per
 * IP per sliding 15-minute window, shared with docs, cookbook downloads and the
 * escrow terminal's own 30-second ledger poll (about 30 per window). At these
 * cadences one visible tab stays near 50 per window; background tabs pause.
 */
/** Settlement figures move with payments, which arrive minutes apart at most. */
const SETTLEMENT_POLL_MS = 5 * 60_000;
/** The strata chain and its OpenTimestamps anchor change on a daily cadence. */
const PROVENANCE_POLL_MS = 15 * 60_000;
const RECENT_SETTLEMENT_LIMIT = 5;

export interface McpToolQuote {
  prices: ReadonlyMap<string, number>;
  authorizationFormat: string;
  batch: McpBatchCostQuoteL402Batch | null;
}

/** Free price discovery: POST /api/v1/cost never creates an invoice. */
export function useMcpToolQuote() {
  return useQuery({
    queryKey: ["command-center", "mcp-tool-quote"],
    queryFn: async (): Promise<McpToolQuote> => {
      const quote = await quoteMcpToolCosts({
        tools: [...CANONICAL_MCP_TOOL_NAMES],
      });
      const prices = new Map(
        quote.items.map((item) => [item.canonical_tool, item.price_sats]),
      );
      const missing = CANONICAL_MCP_TOOL_NAMES.filter(
        (name) => !prices.has(name),
      );
      if (missing.length) {
        throw new Error(`The live quote omitted ${missing.join(", ")}`);
      }
      return {
        prices,
        authorizationFormat: quote.l402.authorization_format,
        batch: quote.l402.batch ?? null,
      };
    },
    staleTime: 10 * 60_000,
  });
}

export function useEscrowLedgerStats() {
  return useGetEscrowLedgerStats({
    query: {
      queryKey: getGetEscrowLedgerStatsQueryKey(),
      refetchInterval: SETTLEMENT_POLL_MS,
    },
  });
}

export function useEscrowTollQuote() {
  return useGetEscrowToll({
    query: {
      queryKey: getGetEscrowTollQueryKey(),
      refetchInterval: SETTLEMENT_POLL_MS,
    },
  });
}

/** The genesis receipt is an immutable historical record. */
export function useGenesisReceipt() {
  return useGetEscrowGenesisReceipt({
    query: {
      queryKey: getGetEscrowGenesisReceiptQueryKey(),
      staleTime: Infinity,
    },
  });
}

export function useProvenanceChain() {
  return useGetProvenanceChain({
    query: {
      queryKey: getGetProvenanceChainQueryKey(),
      refetchInterval: PROVENANCE_POLL_MS,
    },
  });
}

export function useProvenanceAnchor() {
  return useGetProvenanceAnchor({
    query: {
      queryKey: getGetProvenanceAnchorQueryKey(),
      refetchInterval: PROVENANCE_POLL_MS,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSats(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface LightningVolume {
  totalSats: number;
  last24hSats: number;
  l402Sats: number;
  nip90Sats: number;
}

/** Durable ledger of merchant-verified Lightning settlements. */
export function parseLightningVolume(value: unknown): LightningVolume {
  if (!isRecord(value) || !isRecord(value.channelBreakdown)) {
    throw new Error("Unexpected revenue analytics response");
  }
  const { totalVolumeSats, volume24hSats, channelBreakdown } = value;
  const l402Sats = channelBreakdown["L402"];
  const nip90Sats = channelBreakdown["NIP-90"];
  if (
    !isSats(totalVolumeSats) ||
    !isSats(volume24hSats) ||
    !isSats(l402Sats) ||
    !isSats(nip90Sats)
  ) {
    throw new Error("Unexpected revenue analytics response");
  }
  return {
    totalSats: totalVolumeSats,
    last24hSats: volume24hSats,
    l402Sats,
    nip90Sats,
  };
}

export interface SettlementRecord {
  id: string;
  timestamp: string;
  channel: string;
  requestKind: string;
  satsReceived: number;
  paymentReference: string | null;
}

export function parseSettlementRecords(value: unknown): SettlementRecord[] {
  if (!isRecord(value) || !Array.isArray(value.transactions)) {
    throw new Error("Unexpected settlement audit response");
  }
  return value.transactions.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.timestamp !== "string" ||
      Number.isNaN(Date.parse(entry.timestamp)) ||
      typeof entry.channel !== "string" ||
      typeof entry.requestKind !== "string" ||
      !isSats(entry.satsReceived) ||
      (entry.paymentReference !== undefined &&
        typeof entry.paymentReference !== "string")
    ) {
      throw new Error("Unexpected settlement audit record");
    }
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      channel: entry.channel,
      requestKind: entry.requestKind,
      satsReceived: entry.satsReceived,
      paymentReference: entry.paymentReference ?? null,
    };
  });
}

export function useLightningVolume() {
  return useQuery({
    queryKey: ["command-center", "lightning-volume"],
    queryFn: async () => parseLightningVolume(await getRevenueAnalytics()),
    refetchInterval: SETTLEMENT_POLL_MS,
  });
}

export function useRecentSettlements() {
  return useQuery({
    queryKey: ["command-center", "recent-settlements", RECENT_SETTLEMENT_LIMIT],
    queryFn: async () =>
      parseSettlementRecords(
        await getRevenueAudit({ limit: RECENT_SETTLEMENT_LIMIT }),
      ),
    refetchInterval: SETTLEMENT_POLL_MS,
  });
}
