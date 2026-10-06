import type { Plugin } from "@elizaos/core";
import {
  fetchBitcoinStratigraphyAction,
  getTelemetryAction,
} from "./actions/getTelemetry.js";
import { verifyProofAction } from "./actions/verifyProof.js";
import { broadcastMeshAction } from "./actions/broadcastMesh.js";
import { bitcoinStratigraphyProvider } from "./provider.js";

export {
  fetchBitcoinStratigraphyAction,
  getTelemetryAction,
  verifyProofAction,
  broadcastMeshAction,
  bitcoinStratigraphyProvider,
};

export const bitcoinStratigraphyPlugin: Plugin = {
  name: "bitcoin-stratigraphy",
  description:
    "L402-paid Bitcoin thermodynamic telemetry, zk-SNARK verification, and trusted mesh broadcast",
  actions: [
    fetchBitcoinStratigraphyAction,
    verifyProofAction,
    broadcastMeshAction,
  ],
  providers: [bitcoinStratigraphyProvider],
  services: [],
};

export default bitcoinStratigraphyPlugin;
