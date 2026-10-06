import type {
  ProvenanceRecord,
  ProvenanceSourceRecord,
} from "./provenanceChain";

type PersistedStratum = Pick<
  ProvenanceRecord<ProvenanceSourceRecord>,
  "day" | "prevHash" | "stratumHash"
>;

type QueryResult<Row> = { rows: Row[] };
type DatabaseClient = {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
};
type DatabasePool = {
  connect(): Promise<DatabaseClient>;
};

type StoredStratum = {
  day: number | string;
  stratum_hash: string;
  prev_hash: string;
};

const LOCK_NAMESPACE = 1_398_037_057;
const LOCK_KEY = 1_347_577_686;

function invalidHistory(message: string): never {
  throw new Error(`Provenance history integrity violation: ${message}`);
}

/**
 * Atomically verifies the durable chain is an exact prefix, then appends only
 * the missing suffix. The transaction-scoped advisory lock serializes startup
 * and refreshes across API workers.
 */
export async function persistProvenancePrefix(
  records: readonly PersistedStratum[],
  databasePool?: DatabasePool,
): Promise<void> {
  if (records.length === 0) {
    invalidHistory("refusing to persist an empty chain");
  }

  const pool =
    databasePool ??
    ((await import("@workspace/db")).pool as unknown as DatabasePool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      LOCK_NAMESPACE,
      LOCK_KEY,
    ]);
    const result = await client.query<StoredStratum>(
      "SELECT day, stratum_hash, prev_hash FROM stratigraphy_provenance_strata ORDER BY day",
    );
    const stored = result.rows;

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (
        record.day !== index + 1 ||
        !/^[a-f0-9]{64}$/.test(record.stratumHash) ||
        !/^[a-f0-9]{64}$/.test(record.prevHash)
      ) {
        invalidHistory(`invalid or gapped candidate at day ${index + 1}`);
      }
    }

    if (stored.length > records.length) {
      invalidHistory(
        `candidate chain truncates stored history (${records.length} < ${stored.length})`,
      );
    }

    let previousHash: string | undefined;
    for (let index = 0; index < stored.length; index += 1) {
      const storedStratum = stored[index];
      const candidate = records[index];
      const storedDay = Number(storedStratum.day);
      if (
        !Number.isSafeInteger(storedDay) ||
        storedDay !== index + 1 ||
        !/^[a-f0-9]{64}$/.test(storedStratum.stratum_hash) ||
        !/^[a-f0-9]{64}$/.test(storedStratum.prev_hash) ||
        (previousHash !== undefined && storedStratum.prev_hash !== previousHash)
      ) {
        invalidHistory(
          `stored history is corrupt or gapped at day ${index + 1}`,
        );
      }
      if (
        storedDay !== candidate.day ||
        storedStratum.stratum_hash !== candidate.stratumHash ||
        storedStratum.prev_hash !== candidate.prevHash
      ) {
        invalidHistory(`candidate rewrites immutable day ${index + 1}`);
      }
      previousHash = storedStratum.stratum_hash;
    }

    for (let index = stored.length; index < records.length; index += 1) {
      const record = records[index];
      const expectedPreviousHash =
        index === 0 ? "0".repeat(64) : records[index - 1].stratumHash;
      if (record.prevHash !== expectedPreviousHash) {
        invalidHistory(
          `candidate chain has a broken link at day ${record.day}`,
        );
      }
      await client.query(
        `INSERT INTO stratigraphy_provenance_strata (day, stratum_hash, prev_hash)
         VALUES ($1, $2, $3)`,
        [record.day, record.stratumHash, record.prevHash],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database or integrity error.
    }
    throw error;
  } finally {
    client.release();
  }
}
