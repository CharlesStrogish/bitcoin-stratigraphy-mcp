import type { Action } from "@elizaos/core";
import { actionInput, executePaidAction, hasWallet } from "./shared.js";

export const broadcastMeshAction: Action = {
  name: "BROADCAST_BITCOIN_STRATIGRAPHY_MESH",
  similes: ["BROADCAST_MESH_SIGNAL", "PUBLISH_TELEMETRY_SNAPSHOT", "MESH_BROADCAST"],
  description:
    "Broadcast one existing daily telemetry snapshot to configured, trusted Bitcoin " +
    "Stratigraphy mesh peers. Requires a YYYY-MM-DD date and costs 250 sats. " +
    "Cannot broadcast arbitrary caller-supplied data.",
  examples: [[
    { name: "user", content: { text: "Broadcast the mesh signal for 2026-09-09" } },
    {
      name: "assistant",
      content: {
        text: "I'll request peer cross-validation for that day's snapshot.",
        actions: ["BROADCAST_BITCOIN_STRATIGRAPHY_MESH"],
      },
    },
  ]],
  validate: async (runtime) => hasWallet(runtime),
  handler: async (runtime, message, _state, options, callback) =>
    executePaidAction(
      runtime, message, callback,
      (client) => {
        const input = actionInput(message, options);
        const date = typeof input.date === "string"
          ? input.date
          : message.content.text?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error("Mesh broadcast requires a YYYY-MM-DD snapshot date");
        }
        return client.broadcastMeshSignal(date);
      },
      (result) =>
        `Mesh broadcast confirmed by ${result.peerAttestations} remote peer(s).`,
    ),
};