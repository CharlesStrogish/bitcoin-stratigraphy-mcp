import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProvenanceChain,
  GENESIS_PREV_HASH,
  type ProvenanceSourceRecord,
} from "../artifacts/api-server/src/services/provenanceChain";

const sourceRecords: ProvenanceSourceRecord[] = [
  {
    day: 1,
    title:
      "82.2X away from 10 Million Bitcoin |  #bitcoinpriceprediction  #bitcoinnews #bitcoinprice",
    video_id: "kbn-YkkR0Kc",
    transcript_summary: "",
    quantitative_alpha: {
      target_multiplier: 82.2,
      difficulty_epoch_progress: "7.14%",
      thermodynamic_signal: "compressed-target-distance",
    },
  },
  {
    day: 2,
    title:
      "85.49X away from 10 Million Bitcoin  | #bitcoinpredictions #bitcoins #10mil",
    video_id: "nxqlOXFVG-4",
    transcript_summary: "",
    quantitative_alpha: {
      target_multiplier: 85.49,
      difficulty_epoch_progress: "14.29%",
      thermodynamic_signal: "compressed-target-distance",
    },
  },
  {
    day: 3,
    title:
      "84.23X away from 10 Million Bitcoin | #bitcoinlegend #bitcoiner #bitcoinpredictions",
    video_id: "U4ZubXVNGRg",
    transcript_summary: "",
    quantitative_alpha: {
      target_multiplier: 84.23,
      difficulty_epoch_progress: "21.43%",
      thermodynamic_signal: "compressed-target-distance",
    },
  },
];

test("builds the deterministic canonical provenance vector", () => {
  const chain = buildProvenanceChain(sourceRecords);

  assert.equal(GENESIS_PREV_HASH, "0".repeat(64));
  assert.equal(chain.records[0].prevHash, GENESIS_PREV_HASH);
  assert.equal(
    chain.genesisHash,
    "672b0b2dd8e77d77d4a206d7bcb46860571fd09e766cf456fea845553d82d48f",
  );
  assert.deepEqual(
    chain.records.map(({ stratumHash }) => stratumHash),
    [
      "672b0b2dd8e77d77d4a206d7bcb46860571fd09e766cf456fea845553d82d48f",
      "5a897d583163588deebfb2ebae2b603c156ea284d8b983e7625a835190130767",
      "44c2d519d11367cd4c17d73bf07ba24d80ae60eeba82661ab696648da789a36a",
    ],
  );
  assert.equal(
    chain.merkleRoot,
    "39718e467e8e647213c9af57a31208b8a43f40d2bf4aea822c659d998b3dd77d",
  );
  assert.equal(chain.headHash, chain.records[2].stratumHash);
  assert.equal(chain.totalDepth, 3);
  assert.equal(chain.verified, true);
});

test("appending records preserves every historical stratum hash", () => {
  const firstTwo = buildProvenanceChain(sourceRecords.slice(0, 2));
  const appended = buildProvenanceChain(sourceRecords);

  assert.deepEqual(
    appended.records
      .slice(0, firstTwo.totalDepth)
      .map(({ stratumHash }) => stratumHash),
    firstTwo.records.map(({ stratumHash }) => stratumHash),
  );
  assert.equal(appended.genesisHash, firstTwo.genesisHash);
  assert.equal(
    buildProvenanceChain([sourceRecords[0]]).merkleRoot,
    buildProvenanceChain([sourceRecords[0]]).records[0].stratumHash,
  );
});

test("rejects empty, reordered, and hash-tampered datasets", () => {
  assert.throws(() => buildProvenanceChain([]), /empty dataset/);
  assert.throws(
    () => buildProvenanceChain([sourceRecords[0], sourceRecords[2]]),
    /non-sequential/,
  );

  const chained = buildProvenanceChain(sourceRecords).records;
  const tamperedPrev = chained.map((record) => ({ ...record }));
  tamperedPrev[1].prevHash = GENESIS_PREV_HASH;
  assert.throws(() => buildProvenanceChain(tamperedPrev), /hash mismatch/);

  const tamperedStratum = chained.map((record) => ({ ...record }));
  tamperedStratum[1].stratumHash = "f".repeat(64);
  assert.throws(() => buildProvenanceChain(tamperedStratum), /hash mismatch/);

  const tamperedGenesis = sourceRecords.map((record) => ({ ...record }));
  tamperedGenesis[0].title += " tampered";
  assert.throws(
    () => buildProvenanceChain(tamperedGenesis),
    /pinned genesis hash/,
  );
});
