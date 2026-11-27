import { pool } from "@workspace/db";

export type CheckoutIntent = "scanner_pack_checkout" | "agpl_waiver_checkout";
export type HandoffRecord = {
  elicitationId: string;
  intent: CheckoutIntent;
  ownerHash: string;
  status: "pending" | "completed" | "expired" | "cancelled";
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
  referenceId?: string;
  checkoutStarted?: boolean;
  revision: number;
};
type Capabilities = {
  url: boolean;
  protocolVersion: string;
  expiresAt: number;
};
export interface UrlElicitationStore {
  create(record: HandoffRecord): Promise<void>;
  get(id: string): Promise<HandoffRecord | undefined>;
  replace(record: HandoffRecord, revision: number): Promise<boolean>;
  remember(owner: string, value: Capabilities): Promise<void>;
  capabilities(owner: string): Promise<Capabilities | undefined>;
}

/** Explicit test double. Production never silently falls back to process memory. */
export function memoryUrlElicitationStore(): UrlElicitationStore {
  const records = new Map<string, HandoffRecord>();
  const clients = new Map<string, Capabilities>();
  return {
    async create(record) {
      records.set(record.elicitationId, structuredClone(record));
    },
    async get(id) {
      const row = records.get(id);
      return row && structuredClone(row);
    },
    async replace(record, revision) {
      if (records.get(record.elicitationId)?.revision !== revision)
        return false;
      records.set(record.elicitationId, structuredClone(record));
      return true;
    },
    async remember(owner, value) {
      clients.set(owner, structuredClone(value));
    },
    async capabilities(owner) {
      const value = clients.get(owner);
      return value && structuredClone(value);
    },
  };
}

/** Same lazy, fail-closed PostgreSQL/CAS convention as the finite MCP task store. */
export function postgresUrlElicitationStore(
  database: Pick<typeof pool, "query" | "connect"> = pool,
): UrlElicitationStore {
  let ready: Promise<unknown> | undefined;
  const ensure = async () => {
    ready ??= database
      .query(
        `
      CREATE TABLE IF NOT EXISTS mcp_url_handoffs (
        elicitation_id uuid PRIMARY KEY, owner_hash text NOT NULL,
        revision integer NOT NULL, state jsonb NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_url_handoffs_owner ON mcp_url_handoffs(owner_hash);
      CREATE TABLE IF NOT EXISTS mcp_url_clients (
        owner_hash text PRIMARY KEY, state jsonb NOT NULL, expires_at timestamptz NOT NULL
      )
    `,
      )
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    await ready;
  };
  return {
    async create(record) {
      await ensure();
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(726635)");
        await client.query(
          "DELETE FROM mcp_url_handoffs WHERE expires_at < now() - interval '1 day'",
        );
        await client.query(
          "DELETE FROM mcp_url_clients WHERE expires_at < now()",
        );
        const counts = await client.query(
          "SELECT count(*)::int AS total, count(*) FILTER (WHERE owner_hash=$1)::int AS owned FROM mcp_url_handoffs WHERE expires_at > now()",
          [record.ownerHash],
        );
        if (
          Number(counts.rows[0]?.total) >= 1000 ||
          Number(counts.rows[0]?.owned) >= 16
        )
          throw new Error("Checkout handoff capacity exhausted");
        await client.query(
          "INSERT INTO mcp_url_handoffs(elicitation_id,owner_hash,revision,state,expires_at) VALUES($1,$2,$3,$4,$5)",
          [
            record.elicitationId,
            record.ownerHash,
            record.revision,
            JSON.stringify(record),
            new Date(record.expiresAt),
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async get(id) {
      await ensure();
      const result = await database.query(
        "SELECT state FROM mcp_url_handoffs WHERE elicitation_id=$1",
        [id],
      );
      return result.rows[0]?.state as HandoffRecord | undefined;
    },
    async replace(record, revision) {
      await ensure();
      const result = await database.query(
        "UPDATE mcp_url_handoffs SET state=$1,revision=$2 WHERE elicitation_id=$3 AND owner_hash=$4 AND revision=$5 AND ($6='expired' OR expires_at>now())",
        [
          JSON.stringify(record),
          record.revision,
          record.elicitationId,
          record.ownerHash,
          revision,
          record.status,
        ],
      );
      return result.rowCount === 1;
    },
    async remember(owner, value) {
      await ensure();
      await database.query(
        "INSERT INTO mcp_url_clients(owner_hash,state,expires_at) VALUES($1,$2,$3) ON CONFLICT(owner_hash) DO UPDATE SET state=$2,expires_at=$3",
        [owner, JSON.stringify(value), new Date(value.expiresAt)],
      );
    },
    async capabilities(owner) {
      await ensure();
      const result = await database.query(
        "SELECT state FROM mcp_url_clients WHERE owner_hash=$1 AND expires_at>now()",
        [owner],
      );
      return result.rows[0]?.state as Capabilities | undefined;
    },
  };
}
