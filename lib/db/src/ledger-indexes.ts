// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
/** Development index initialization; managed production schema changes belong to Publish. */
export const ledgerIndexes = [
  {name: "enterprise_settled_buyer_idx", table: "enterprise_routing_invoices", columns: ["payload"],
    keys: ["(payload->>'buyer')"], where: "payload->>'settled_at' IS NOT NULL"},
  {name: "enterprise_settlement_time_idx", table: "enterprise_routing_invoices", columns: ["payload"],
    keys: ["(payload->>'settled_at')"], where: "payload->>'settled_at' IS NOT NULL"},
  // Covers both proof origins and the authoritative verification-credit records.
  // Avoid a redundant long nested invoice expression: Publish truncates its SQL.
  {name: "enterprise_proof_origin_idx", table: "enterprise_affiliate_security", columns: ["payload", "record_key"],
    keys: ["(payload->>'origin_pubkey')"],
    where: "record_key LIKE 'proof-origin:%' OR record_key LIKE 'verification-credit:%'"},
  // Grounded contextHash values are already recorded as proof_hash; no new tracking.
  {name: "enterprise_proof_context_idx", table: "enterprise_affiliate_security", columns: ["payload", "record_key"],
    keys: ["(payload->>'proof_hash')"], where: "record_key LIKE 'proof-origin:%'"},
  {name: "enterprise_origin_recorded_at_idx", table: "enterprise_affiliate_security", columns: ["payload", "record_key"],
    keys: ["(payload->>'recorded_at')"], where: "record_key LIKE 'proof-origin:%'"},
  {name: "escrow_authenticated_pubkey_time_idx", table: "escrow_ledger_settlements",
    columns: ["agent_id", "settled_at", "is_authenticated"], keys: ["agent_id", "settled_at"],
    where: "is_authenticated"},
  {name: "escrow_settlement_time_idx", table: "escrow_ledger_settlements",
    columns: ["settled_at"], keys: ["settled_at"], where: ""},
  {name: "escrow_recorded_at_idx", table: "escrow_ledger_settlements",
    columns: ["recorded_at"], keys: ["recorded_at"], where: ""},
  // Keep the existing schema-owned range index; do not create a duplicate.
  {name: "revenue_ledger_timestamp_idx", table: "revenue_ledger",
    columns: ["timestamp"], keys: ["timestamp"], where: ""},
] as const;

type Connection = {
  query(sql: string, values?: unknown[]): Promise<{rows: Record<string, unknown>[]}>;
};
export class LedgerIndexError extends Error {}
const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
const normalize = (value: string) => value.split(/('(?:''|[^'])*')/g).map((part, i) =>
  i % 2 ? part : part.replace(/::text(?:\[\])?/gi, "")
    .replace(/\bLIKE\b/gi, "~~").replace(/[()\s"]/g, "").toLowerCase()).join("");

export async function applyLedgerIndexes(connection: Connection, schema = "public") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new LedgerIndexError("Invalid migration schema");
  const report = {created: [] as string[], existing: [] as string[], deferred: [] as string[]};
  const acquired = await connection.query("SELECT pg_try_advisory_lock(802260102) AS acquired");
  if (acquired.rows[0]?.acquired !== true)
    throw new LedgerIndexError("Another ledger index migration is running; retry later");
  let settings: Record<string, unknown> | undefined;
  try {
    settings = (await connection.query(
      "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
    )).rows[0];
    await connection.query("SELECT set_config('lock_timeout','2s',false), set_config('statement_timeout','10min',false)");
    for (const index of ledgerIndexes) {
      const columns = await connection.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
        [schema, index.table],
      );
      if (!index.columns.every(column => columns.rows.some(row => row.column_name === column))) {
        report.deferred.push(index.name);
        continue;
      }
      const inspect = () => connection.query(
        `SELECT i.indisvalid AS valid, i.indisready AS ready, am.amname AS method,
          t.relname AS table_name, pg_get_expr(i.indpred,i.indrelid) AS predicate,
          ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true)
                FROM generate_series(1,i.indnkeyatts) k) AS keys
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_index i ON i.indexrelid=c.oid JOIN pg_class t ON t.oid=i.indrelid
         JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname=$2`,
        [schema, index.name],
      );
      const previous = (await inspect()).rows[0];
      if (!previous) {
        await connection.query(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quote(index.name)} ON ${quote(schema)}.${quote(index.table)} USING btree (${index.keys.join(", ")})${index.where ? " WHERE " + index.where : ""}`,
        );
      }
      const row = (await inspect()).rows[0];
      if (!row || row.valid !== true || row.ready !== true ||
          row.method !== "btree" || row.table_name !== index.table ||
          !Array.isArray(row.keys) || row.keys.length !== index.keys.length ||
          !row.keys.every((key, i) => normalize(String(key)) === normalize(index.keys[i]!)) ||
          normalize(String(row.predicate ?? "")) !== normalize(index.where))
        throw new LedgerIndexError(`Index ${index.name} is invalid or has an unexpected definition; inspect it before retrying`);
      report[previous ? "existing" : "created"].push(index.name);
    }
    return report;
  } finally {
    try {
      if (settings) await connection.query(
        "SELECT set_config('lock_timeout',$1,false), set_config('statement_timeout',$2,false)",
        [String(settings.lock_timeout), String(settings.statement_timeout)],
      );
    } finally {
      await connection.query("SELECT pg_advisory_unlock(802260102)");
    }
  }
}
