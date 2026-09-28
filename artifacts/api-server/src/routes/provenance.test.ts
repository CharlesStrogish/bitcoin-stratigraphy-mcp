import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildProvenanceChain } from "../services/provenanceChain";
import type { ProvenanceAnchor } from "../services/otsProvenance";
import { readDataset } from "./stratigraphy";
import { registerProvenanceRoutes } from "./provenance";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serve(app: ReturnType<typeof express>): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("public provenance endpoints expose the current chain and unanchored state", async () => {
  const records = await readDataset();
  const state = buildProvenanceChain(records);
  const app = express();
  registerProvenanceRoutes(app, {
    readRecords: async () => records,
    getAnchor: async () => undefined,
    schedule: false,
  });
  const baseUrl = await serve(app);

  const chainResponse = await fetch(`${baseUrl}/api/provenance/chain`);
  assert.equal(chainResponse.status, 200);
  assert.deepEqual(await chainResponse.json(), {
    totalDepth: state.totalDepth,
    merkleRoot: state.merkleRoot,
    latestOtsStatus: "not_anchored",
    genesisHash: state.genesisHash,
    headHash: state.headHash,
  });

  const anchorResponse = await fetch(`${baseUrl}/api/provenance/anchor`);
  assert.equal(anchorResponse.status, 200);
  assert.deepEqual(await anchorResponse.json(), {
    headHash: state.headHash,
    merkleRoot: state.merkleRoot,
    totalDepth: state.totalDepth,
    otsStatus: "not_anchored",
  });
});

test("operator anchor endpoint fails closed and requires the Bearer secret", async () => {
  const records = await readDataset();
  const state = buildProvenanceChain(records);
  const app = express();
  let anchored: ProvenanceAnchor | undefined;
  let anchorCalls = 0;
  registerProvenanceRoutes(app, {
    readRecords: async () => records,
    getAnchor: async () => anchored,
    anchor: async (input) => {
      anchorCalls += 1;
      anchored = {
        ...input,
        otsProof: Buffer.from("genuine-test-receipt").toString("base64"),
        otsStatus: "pending_calendar",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      return anchored;
    },
    operatorSecret: "test-operator-secret",
    schedule: false,
  });
  const baseUrl = await serve(app);

  const missingToken = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
  });
  assert.equal(missingToken.status, 401);
  assert.equal(anchorCalls, 0);

  const wrongToken = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
    headers: { authorization: "Bearer incorrect" },
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(anchorCalls, 0);

  const authorized = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
    headers: { authorization: "Bearer test-operator-secret" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), anchored);
  assert.equal(anchorCalls, 1);

  const publicAnchor = await fetch(`${baseUrl}/api/provenance/anchor`);
  assert.equal(publicAnchor.status, 200);
  const publicAnchorBody = await publicAnchor.json() as ProvenanceAnchor;
  assert.equal(publicAnchorBody.headHash, state.headHash);
  assert.equal(publicAnchorBody.merkleRoot, state.merkleRoot);
  assert.equal(publicAnchorBody.totalDepth, state.totalDepth);
  assert.equal(publicAnchorBody.otsStatus, "pending_calendar");
  assert.equal(publicAnchorBody.otsProof, anchored?.otsProof);
});

test("operator anchor endpoint returns 503 when no operator secret is configured", async () => {
  const records = await readDataset();
  const app = express();
  registerProvenanceRoutes(app, {
    readRecords: async () => records,
    operatorSecret: "",
    schedule: false,
  });
  const baseUrl = await serve(app);

  const response = await fetch(`${baseUrl}/api/provenance/anchor`, {
    method: "POST",
    headers: { authorization: "Bearer anything" },
  });
  assert.equal(response.status, 503);
});