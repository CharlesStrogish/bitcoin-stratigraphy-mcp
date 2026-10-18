// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type IntegrityEnvironment = {
  TOOL_INTEGRITY_PRIVATE_KEY?: string;
  SESSION_SECRET?: string;
  TOOL_INTEGRITY_KEYS_DIR?: string;
};

function isFsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function validateKey(privateKey: KeyObject): KeyObject {
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Tool integrity requires an Ed25519 private key.");
  }
  return privateKey;
}

/**
 * Priority: dedicated PEM secret, domain-separated persistent session secret,
 * then an atomically created owner-only local key for standalone installations.
 * Invalid/unreadable configured keys fail closed; they are never overwritten.
 */
export function loadToolIntegrityKey(
  env: IntegrityEnvironment = process.env,
  keysDir = resolve(env.TOOL_INTEGRITY_KEYS_DIR ?? ".keys"),
): KeyObject {
  if (env.TOOL_INTEGRITY_PRIVATE_KEY !== undefined) {
    return validateKey(createPrivateKey(env.TOOL_INTEGRITY_PRIVATE_KEY));
  }
  if (env.SESSION_SECRET !== undefined) {
    if (env.SESSION_SECRET.length === 0) {
      throw new Error(
        "Cannot derive tool integrity key from an empty session secret.",
      );
    }
    // Dedicated Ed25519 seed: never reuse the session secret as a signing key.
    // This survives ephemeral deployment filesystems while the secret is stable.
    const seed = Buffer.from(
      hkdfSync(
        "sha256",
        env.SESSION_SECRET,
        "bitcoin-stratigraphy/tool-integrity/v1",
        "ed25519-signing-seed",
        32,
      ),
    );
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    try {
      return validateKey(
        createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
      );
    } finally {
      seed.fill(0);
      der.fill(0);
    }
  }

  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(keysDir).isDirectory()) {
    throw new Error(
      "Tool integrity key directory must not be a symbolic link.",
    );
  }
  chmodSync(keysDir, 0o700);
  const privatePath = join(keysDir, "tool-integrity-ed25519.pem");
  const readKey = () => {
    const fd = openSync(privatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, 0o600);
      return validateKey(createPrivateKey(readFileSync(fd)));
    } finally {
      closeSync(fd);
    }
  };
  try {
    return readKey();
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
  }

  const generated = generateKeyPairSync("ed25519").privateKey;
  const temporaryPath = join(keysDir, `.tool-integrity-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(fd, generated.export({ format: "pem", type: "pkcs8" }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // A hard link publishes only complete key bytes, without replacing a
      // concurrently created key. Every process reads the same winning key.
      linkSync(temporaryPath, privatePath);
    } catch (error) {
      if (!isFsError(error, "EEXIST")) throw error;
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return readKey();
}

export type IntegrityTool = Readonly<{ name: string; description: string }>;

export function createToolIntegrityManifest(
  tools: readonly IntegrityTool[],
  privateKey: KeyObject,
  generatedAt = new Date(),
) {
  validateKey(privateKey);
  if (
    tools.length !== 15 ||
    new Set(tools.map((tool) => tool.name)).size !== 15
  ) {
    throw new Error(
      "Tool integrity requires exactly 15 uniquely named MCP tools.",
    );
  }
  const entries = tools.map((tool) => {
    if (!tool.name || typeof tool.description !== "string") {
      throw new Error(
        "Tool integrity requires a name and exact description for every tool.",
      );
    }
    const digest = createHash("sha256")
      .update(tool.description, "utf8")
      .digest();
    return Object.freeze({
      name: tool.name,
      description_hash: digest.toString("hex"),
      signature: sign(null, digest, privateKey).toString("base64"),
    });
  });
  const publicKey = createPublicKey(privateKey);
  return Object.freeze({
    server_public_key: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    algorithm: "Ed25519",
    timestamp: generatedAt.toISOString(),
    hash_algorithm: "SHA-256",
    signature_encoding: "base64",
    signed_message:
      "Raw 32-byte SHA-256 digest of the exact UTF-8 description string",
    key_id: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
    tools: Object.freeze(entries),
  });
}
