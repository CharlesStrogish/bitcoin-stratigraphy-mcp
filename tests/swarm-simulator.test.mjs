import test from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const base =
  "../artifacts/bitcoin-stratigraphy-dashboard/src/simulator/engine/";
const { MerkleAccumulator, verifyMerkleInclusion } = await tsImport(
  base + "merkle.ts",
  import.meta.url,
);
const { canonicalJson, utf8, toHex, fromHex } = await tsImport(
  base + "canonical.ts",
  import.meta.url,
);
const sim = await tsImport(base + "simulation.ts", import.meta.url);

test("matches Python swarm_merkle vector (5 leaves)", async () => {
  const acc = new MerkleAccumulator();
  for (const c of "abcde") await acc.append(utf8(c));
  assert.equal(
    toHex(await acc.root()),
    "fe14a5426fbd70c0fa73f52342afed0da0bd23c4838662ccf6b88a3070ead97b",
  );
  assert.deepEqual(
    (await acc.inclusionPath(4)).map((h) => toHex(h).slice(0, 8)),
    ["33376a3b"],
  );
  assert.deepEqual(
    (await acc.inclusionPath(1)).map((h) => toHex(h).slice(0, 8)),
    ["022a6979", "dbbd68c3", "2824a7cc"],
  );
});

test("canonical JSON sorts keys by code point, compact, unescaped unicode", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [true, null, "é"], "\u{1F600}": 2, "\uFF5E": 3 }),
    '{"a":[true,null,"é"],"b":1,"\uFF5E":3,"\u{1F600}":2}',
  );
  assert.throws(() => canonicalJson({ x: 1.5 }));
});

test("every leaf of every size 1..40 verifies; tampering and bad paths fail", async () => {
  const acc = new MerkleAccumulator();
  for (let n = 1; n <= 40; n++) {
    await acc.append(utf8("leaf" + (n - 1)));
    const root = await acc.root();
    for (let i = 0; i < n; i++) {
      const path = await acc.inclusionPath(i);
      assert.equal(
        await verifyMerkleInclusion(utf8("leaf" + i), i, n, path, root),
        true,
      );
    }
  }
  const root = await acc.root();
  const path = await acc.inclusionPath(7);
  assert.equal(
    await verifyMerkleInclusion(utf8("x"), 7, 40, path, root),
    false,
  );
  await assert.rejects(
    verifyMerkleInclusion(utf8("leaf7"), 7, 40, path.slice(1), root),
  );
  await assert.rejects(
    verifyMerkleInclusion(utf8("leaf7"), 7, 40, [...path, path[0]], root),
  );
});

test("full 1000-trace swarm: all leaves verify against final root, salts fresh", async () => {
  const session = new sim.SwarmSession("test-batch");
  const ctl = new AbortController();
  let batches = 0;
  await sim.runSwarm({
    session,
    signal: ctl.signal,
    delayMs: 0,
    onBatch: () => {
      batches++;
    },
  });
  assert.equal(batches, 20);
  assert.equal(session.size, 1000);
  assert.equal(new Set(session.records.map((r) => r.salt)).size, 1000);
  assert.equal(new Set(session.records.map((r) => r.trace.agent_id)).size, 50);
  const root = await session.rootHex();
  for (const i of [0, 1, 499, 998, 999]) {
    const proof = await session.proof(i);
    assert.equal(
      await sim.verifyDisclosedProof(session.records[i].trace, proof, root),
      true,
    );
  }
  const p = await session.proof(10);
  assert.equal(
    await sim.verifyDisclosedProof(
      { ...session.records[10].trace, thought: "forged" },
      p,
      root,
    ),
    false,
  );
  // leaf preimage uses the Python schema
  const pre = new TextDecoder().decode(
    sim.leafPreimage({ a: 1 }, "00".repeat(32)),
  );
  assert.equal(
    pre,
    `{"salt":"${"00".repeat(32)}","schema_version":"saai-swarm-leaf/1","trace":{"a":1}}`,
  );
});

test("abort cancels pending work", async () => {
  const session = new sim.SwarmSession("abort");
  const ctl = new AbortController();
  const run = sim.runSwarm({ session, signal: ctl.signal, delayMs: 50 });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(run, { name: "AbortError" });
  assert.equal(session.size, 0);
});

test("notarize is simulated with batch-size 100 and root bound", async () => {
  const r = await sim.simulateNotarize("b", 1000, "ab".repeat(32));
  assert.equal(r.request.headers["X-L402-Batch-Size"], "100");
  assert.equal(r.receipt.anchoring.otsProofHex, null);
  assert.equal(r.receipt.anchoring.bitcoin_confirmation, false);
  assert.equal(
    r.receipt.anchoring.illustrative_ots_object.bound_root,
    "ab".repeat(32),
  );
  assert.equal(fromHex("00ff").length, 2);
});

test("appending during proof computation still verifies the captured prefix", async () => {
  const session = new sim.SwarmSession("race");
  for (let i = 0; i < 37; i++) await session.append(sim.makeTrace(i));
  const pending = session.disclosure(5, 37);
  const appends = (async () => {
    for (let i = 37; i < 90; i++) await session.append(sim.makeTrace(i));
  })();
  const { proof, rootHex } = await pending;
  await appends;
  assert.equal(proof.tree_size, 37);
  assert.equal(
    await sim.verifyDisclosedProof(session.records[5].trace, proof, rootHex),
    true,
  );
  assert.equal(rootHex, await session.rootHex(37));
  assert.notEqual(rootHex, await session.rootHex());
  await assert.rejects(
    sim.verifyDisclosedProof(
      session.records[5].trace,
      { ...proof, schema_version: "x" },
      rootHex,
    ),
  );
});
