/** Reproducible Merkle test vector, not a live API response or timestamp receipt. */
export const MERKLE_EXAMPLE = {
  example_only: true,
  trace: {
    agent_id: "vendor-a/agent-01",
    event: "decision_recorded",
    sequence: 1,
  },
  merkle_proof: {
    schema_version: "saai-swarm-inclusion/1",
    batch_id: "example-batch",
    leaf_index: 0,
    tree_size: 2,
    leaf_salt:
      "0000000000000000000000000000000000000000000000000000000000000001",
    path: ["178649b3c7829799f76bd5172286acd8b77d4a57bc0a5afc743cccfa6d6ac9e1"],
  },
  leaf_hash: "104f8b8cc3d901728ed6f043b85bcf2244ee1da1a082c6ad0c95c3e54a68623b",
  root_hash: "96dae2aa999c159347972413b0bf53aaa1125eefd2b374175ec93e7a188afa05",
  bitcoin_anchor_status: "not_submitted",
};
