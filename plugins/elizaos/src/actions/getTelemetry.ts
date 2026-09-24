import type { Action } from "@elizaos/core";
import type { McpToolArguments, MetricName } from "../../../../sdk/typescript/client.js";
import { actionInput, executePaidAction, hasWallet } from "./shared.js";

const metrics: MetricName[] = [
  "target_multiplier", "difficulty_epoch_progress", "thermodynamic_signal",
];

function telemetryArgs(
  input: Record<string, unknown>,
  text: string,
): McpToolArguments["stratigraphy.get"] {
  const args: McpToolArguments["stratigraphy.get"] = {};
  for (const key of ["days", "blockHeight", "startBlock", "endBlock", "limit"] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    const minimum = key === "days" || key === "limit" ? 1 : 0;
    const maximum = key === "days" ? 365 : key === "limit" ? 100 : Infinity;
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
    args[key] = value;
  }
  for (const key of ["date", "startDate", "endDate"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input[key])) {
      throw new Error(`${key} must be a YYYY-MM-DD date`);
    }
    args[key] = input[key];
  }
  if (input.metrics !== undefined) {
    if (
      !Array.isArray(input.metrics) ||
      !input.metrics.length ||
      !input.metrics.every((value) => metrics.includes(value)) ||
      new Set(input.metrics).size !== input.metrics.length
    ) {
      throw new Error("metrics must contain unique supported thermodynamic metric names");
    }
    args.metrics = input.metrics as MetricName[];
  }
  const hasSelector = ["days", "date", "blockHeight", "startDate", "endDate", "startBlock", "endBlock"]
    .some((key) => args[key as keyof typeof args] !== undefined);
  if (!hasSelector) {
    const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    const days = text.match(/\b(?:last|past)\s+(\d+)\s+days?\b/i)?.[1];
    if (date) args.date = date;
    else {
      const count = days ? Number(days) : 1;
      if (count < 1 || count > 365) throw new Error("days must be between 1 and 365");
      args.days = count;
    }
  }
  return args;
}

export const getTelemetryAction: Action = {
  name: "GET_BITCOIN_STRATIGRAPHY_TELEMETRY",
  similes: ["GET_TELEMETRY", "GET_BITCOIN_THERMODYNAMICS", "QUERY_STRATIGRAPHY"],
  description:
    "Fetch paid Bitcoin thermodynamic stratigraphy telemetry by date, days, block height, " +
    "date/block range, or selected quantitative metrics. Costs 250 sats per request.",
  examples: [[
    { name: "user", content: { text: "Show the Bitcoin thermodynamic telemetry for 2026-09-09" } },
    {
      name: "assistant",
      content: {
        text: "I'll query that daily stratigraphy record.",
        actions: ["GET_BITCOIN_STRATIGRAPHY_TELEMETRY"],
      },
    },
  ]],
  validate: async (runtime) => hasWallet(runtime),
  handler: async (runtime, message, _state, options, callback) =>
    executePaidAction(
      runtime, message, callback,
      (client) => client.getTelemetry(
        telemetryArgs(actionInput(message, options), message.content.text ?? ""),
      ),
      (result) => `Retrieved ${(result.records as unknown[]).length} stratigraphy record(s).`,
    ),
};