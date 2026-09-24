import type { Plugin } from "@elizaos/core";
import { getTelemetryAction } from "./actions/getTelemetry.js";
import { verifyProofAction } from "./actions/verifyProof.js";
import { broadcastMeshAction } from "./actions/broadcastMesh.js";

export { getTelemetryAction, verifyProofAction, broadcastMeshAction };

export const bitcoinStratigraphyPlugin = {
  name: "bitcoin-stratigraphy",
  description:
    "L402-paid Bitcoin thermodynamic telemetry, zk-SNARK verification, and trusted mesh broadcast",
  actions: [getTelemetryAction, verifyProofAction, broadcastMeshAction],
} satisfies Plugin;

export default bitcoinStratigraphyPlugin;