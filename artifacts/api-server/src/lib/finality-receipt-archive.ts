import { createHash } from "node:crypto";

/** Private, immutable App Storage objects; task rows contain references, not file bytes. */
export function finalityReceiptArchive() {
  let client: Promise<import("@google-cloud/storage").Storage> | undefined;
  const storage = () =>
    (client ??= import("@google-cloud/storage").then(
      ({ Storage }) =>
        new Storage({
          credentials: {
            audience: "replit",
            subject_token_type: "access_token",
            token_url: "http://127.0.0.1:1106/token",
            type: "external_account",
            credential_source: {
              url: "http://127.0.0.1:1106/credential",
              format: {
                type: "json",
                subject_token_field_name: "access_token",
              },
            },
            universe_domain: "googleapis.com",
          },
          projectId: "",
        }),
    ));
  const root = () => {
    const value = process.env.PRIVATE_OBJECT_DIR?.replace(/\/+$/, "");
    if (!value || !/^\/[^/]+\/.+/.test(value))
      throw new Error("Private receipt archive unavailable");
    return value + "/mcp-finality";
  };
  const file = async (path: string) => {
    if (
      !path.startsWith(root() + "/") ||
      !/\/[0-9a-f]{64}\/[0-9a-f]{64}\.ots$/.test(path)
    )
      throw new Error("Invalid private receipt reference");
    const [, bucket, ...parts] = path.split("/");
    return (await storage()).bucket(bucket!).file(parts.join("/"));
  };
  return {
    async put(owner: string, hex: string) {
      if (
        !/^[0-9a-f]{64}$/.test(owner) ||
        !/^(?:[0-9a-f]{2})+$/.test(hex) ||
        hex.length > 1024 * 1024
      )
        throw new Error("Invalid receipt archive input");
      const bytes = Buffer.from(hex, "hex"),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      const objectPath = root() + "/" + owner + "/" + sha256 + ".ots";
      try {
        await (
          await file(objectPath)
        ).save(bytes, {
          resumable: false,
          validation: "crc32c",
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: "application/octet-stream",
            cacheControl: "private, no-store",
          },
        });
      } catch (error) {
        if (Number((error as { code?: number }).code) !== 412) throw error;
      }
      return { objectPath, sha256 };
    },
    async get(path: string) {
      const object = await file(path),
        [metadata] = await object.getMetadata();
      if (
        !Number.isSafeInteger(Number(metadata.size)) ||
        Number(metadata.size) > 512 * 1024
      )
        throw new Error("Receipt exceeds size limit");
      const [bytes] = await object.download({ validation: "crc32c" });
      if (bytes.length === 0 || bytes.length > 512 * 1024)
        throw new Error("Invalid archived receipt size");
      return bytes.toString("hex");
    },
  };
}
