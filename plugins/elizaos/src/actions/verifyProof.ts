import type { Action } from "@elizaos/core";
import type { McpToolArguments, PublicInputs } from "../../../../sdk/typescript/client.js";
import { actionInput, executePaidAction, hasWallet, record } from "./shared.js";

function proofRequest(input: Record<string, unknown>): McpToolArguments["proof.verify"] {
  const publicInputs = record(input.publicInputs);
  const data = input.data;
  if (
    typeof input.proof !== "string" ||
    typeof input.verificationKeyId !== "string" ||
    !publicInputs ||
    typeof publicInputs.blockHeight !== "number" ||
    typeof publicInputs.snapshotDigest !== "string" ||
    typeof publicInputs.thermodynamicHash !== "string" ||
    typeof publicInputs.timestamp !== "number" ||
    typeof publicInputs.valuationSat !== "number" ||
    !(record(data) || (Array.isArray(data) && data.every((item) => record(item))))
  ) {
    throw new Error(
      "Proof verification requires proof, publicInputs, verificationKeyId, and snapshot data",
    );
  }
  return {
    proof: input.proof,
    publicInputs: publicInputs as PublicInputs,
    verificationKeyId: input.verificationKeyId,
    data: data as Extract<McpToolArguments["proof.verify"], { proofType?: "groth16" }>["data"],
  };
}

export const verifyProofAction: Action = {
  name: "VERIFY_BITCOIN_STRATIGRAPHY_PROOF",
  similes: ["VERIFY_ZK_PROOF", "CHECK_STRATIGRAPHY_PROOF", "VERIFY_SNARK"],
  description:
    "Verify a Groth16/Poseidon zk-SNARK against its original telemetry snapshot. " +
    "Requires structured proof, publicInputs, verificationKeyId, and data; costs 250 sats.",
  examples: [[
    {
      name: "user",
      content: {
        text: "Verify this Bitcoin stratigraphy zk-SNARK against the snapshot",
        input: { proof: "<encoded proof>", publicInputs: {}, verificationKeyId: "sha256:...", data: {} },
      },
    },
    {
      name: "assistant",
      content: {
        text: "I'll verify the supplied proof and snapshot.",
        actions: ["VERIFY_BITCOIN_STRATIGRAPHY_PROOF"],
      },
    },
  ]],
  validate: async (runtime) => hasWallet(runtime),
  handler: async (runtime, message, _state, options, callback) =>
    executePaidAction(
      runtime, message, callback,
      (client) => client.verifyProof(proofRequest(actionInput(message, options))),
      (result) => result.valid === true ? "The zk-SNARK proof is valid." : "The zk-SNARK proof is invalid.",
    ),
};