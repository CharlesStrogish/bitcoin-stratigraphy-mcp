import {
  generateCryptographicAttestation,
  verifyCryptographicAttestation,
} from "./attestation";

const DEFAULT_MEMPOOL_API = "https://mempool.space/api";
const MAX_RESPONSE_BYTES = 4_096;

export type EpistemicGroundingInput = {
  contextHash: string;
  agentId: string;
  metadata?: Record<string, unknown>;
};

export type BitcoinTip = {
  height: number;
  hash: string;
  source: string;
};

export async function fetchCurrentBitcoinTip(options: {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<BitcoinTip> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_MEMPOOL_API).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Bitcoin tip lookup timed out")),
    options.timeoutMs ?? 5_000,
  );
  timeout.unref?.();
  const readText = async (url: string) => {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Bitcoin tip lookup failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Bitcoin tip response exceeded the size limit");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error("Bitcoin tip response exceeded the size limit");
    }
    return text.trim();
  };
  try {
    const heightText = await readText(`${baseUrl}/blocks/tip/height`);
    const height = Number(heightText);
    if (!Number.isSafeInteger(height) || height <= 0) {
      throw new Error("Bitcoin tip service returned an invalid block height");
    }
    const hash = (
      await readText(`${baseUrl}/block-height/${height}`)
    ).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error("Bitcoin tip service returned an invalid block hash");
    }
    return { height, hash, source: baseUrl };
  } finally {
    clearTimeout(timeout);
  }
}

export async function groundEpistemicContext(
  input: EpistemicGroundingInput,
  options: {
    now?: () => number;
    readBitcoinTip?: () => Promise<BitcoinTip>;
    privateKey?: string;
  } = {},
) {
  const timestamp = (options.now ?? Date.now)();
  const tip = await (options.readBitcoinTip ?? fetchCurrentBitcoinTip)();
  const contextHash = input.contextHash.toLowerCase();
  const agentId = input.agentId.trim();
  const payload = {
    schema: "bitcoin-stratigraphy/epistemic-anchor/v1",
    contextHash,
    agentId,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    bitcoin: {
      blockHeight: tip.height,
      blockHash: tip.hash,
      source: tip.source,
    },
    timestamp,
  };
  const attestation = generateCryptographicAttestation(payload, {
    privateKey: options.privateKey,
    timestamp,
  });
  return {
    ...attestation,
    receiptSchema: payload.schema,
    contextHash,
    agentId,
    blockHeight: tip.height,
    blockHash: tip.hash,
    merkleRoot: attestation.proof.merkleRoot,
    timestamp,
    nostrSignature: attestation.signature,
  };
}

export function verifyEpistemicAnchorReceipt(
  value: unknown,
  options: { issuerPublicKey?: string } = {},
): boolean {
  if (
    !verifyCryptographicAttestation(value, options) ||
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  const payload = receipt.payload;
  const proof = receipt.proof;
  if (
    !payload ||
    typeof payload !== "object" ||
    !proof ||
    typeof proof !== "object"
  ) {
    return false;
  }
  const anchor = payload as Record<string, unknown>;
  const bitcoin = anchor.bitcoin;
  if (!bitcoin || typeof bitcoin !== "object") return false;
  const bitcoinState = bitcoin as Record<string, unknown>;
  return (
    receipt.receiptSchema === "bitcoin-stratigraphy/epistemic-anchor/v1" &&
    anchor.schema === receipt.receiptSchema &&
    receipt.contextHash === anchor.contextHash &&
    receipt.agentId === anchor.agentId &&
    receipt.blockHeight === bitcoinState.blockHeight &&
    receipt.blockHash === bitcoinState.blockHash &&
    receipt.merkleRoot === (proof as Record<string, unknown>).merkleRoot &&
    receipt.timestamp === anchor.timestamp &&
    receipt.timestamp === (proof as Record<string, unknown>).timestamp &&
    JSON.stringify(receipt.nostrSignature) === JSON.stringify(receipt.signature)
  );
}