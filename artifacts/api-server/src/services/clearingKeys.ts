// Genesis production keys are distinct from the legacy local-development key.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import developmentKey from "./zk/clearing-development/verification_key.json";
import productionKey from "./zk/clearing-production/verification_key.json";

export const GENESIS_PROVING_KEY_SHA256 =
  "ad2c722746c675e7c563d7ad767fdd7b47cbffa026abafad2ebfaa4300d6f630";
const GENESIS_VERIFICATION_KEY_SHA256 =
  "3f80938a62021acdf1344da24da4779f49a21f9ad3740bd6b96259ad106b30a7";
export const GENESIS_VERIFICATION_KEY_ID =
  "aef4fe7c2ce2cae369d635a467c0b290a413429f328243c0438bccc37c279275";
export const GENESIS_VERIFICATION_KEY_URL = new URL(
  "./zk/clearing-production/verification_key.json",
  import.meta.url,
);
export const GENESIS_PROVING_KEY_URL = new URL(
  "./zk/clearing-production/circuit_final.zkey",
  import.meta.url,
);

const id = (key: unknown) =>
  createHash("sha256").update(JSON.stringify(key)).digest("hex");

export const developmentClearingKeys = Object.freeze({
  developmentOnly: true,
  scheme: "clearing-poseidon-preimage-development-v1",
  receiptDomain: "bitcoinstratigraphy/clearing-development-receipt/v1\n",
  verificationKey: developmentKey,
  verificationKeyId: id(developmentKey),
});

const productionClearingKeys = Object.freeze({
  developmentOnly: false,
  scheme: "clearing-poseidon-preimage-genesis-v1",
  receiptDomain: "bitcoinstratigraphy/clearing-genesis-receipt/v1\n",
  verificationKey: productionKey,
  verificationKeyId: id(productionKey),
});

export type ClearingKeys =
  | typeof developmentClearingKeys
  | typeof productionClearingKeys;
let genesisChecked = false;

/** Fail closed on missing/mismatched installed artifacts. No test-key fallback. */
export function loadProductionClearingKeys(): ClearingKeys {
  if (!genesisChecked) {
    const digest = (data: Uint8Array | string) =>
      createHash("sha256").update(data).digest("hex");
    if (
      productionKey.protocol !== "groth16" ||
      productionKey.curve !== "bn128" ||
      productionKey.nPublic !== 2 ||
      productionClearingKeys.verificationKeyId !== GENESIS_VERIFICATION_KEY_ID ||
      digest(readFileSync(GENESIS_VERIFICATION_KEY_URL)) !==
        GENESIS_VERIFICATION_KEY_SHA256 ||
      digest(readFileSync(GENESIS_PROVING_KEY_URL)) !== GENESIS_PROVING_KEY_SHA256
    ) {
      throw new Error("Genesis clearing key integrity check failed");
    }
    genesisChecked = true;
  }
  return productionClearingKeys;
}

export function isProductionClearing(env = process.env): boolean {
  return env.NODE_ENV === "production" || Boolean(env.REPLIT_DEPLOYMENT);
}

export function developmentClearingEnabled(env = process.env): boolean {
  return (
    !isProductionClearing(env) &&
    ["development", "test"].includes(env.NODE_ENV ?? "") &&
    env.CLEARING_DEVELOPMENT_SETTLEMENT === "1"
  );
}

export function activeClearingKeys(env = process.env): ClearingKeys | undefined {
  if (isProductionClearing(env)) return loadProductionClearingKeys();
  return developmentClearingEnabled(env) ? developmentClearingKeys : undefined;
}
