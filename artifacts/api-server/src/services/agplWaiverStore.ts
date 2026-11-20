import type { Pool } from "pg";
import { WaiverError, type WaiverQuote, type WaiverStore } from "./agplWaivers";

export function createPostgresWaiverStore(pool: Pool): WaiverStore {
  const certificate = async (id: string) =>
    (await pool.query("SELECT certificate FROM agpl_waiver_certificates WHERE quote_id=$1", [id])).rows[0]?.certificate ?? null;
  return {
    async createQuote(build, clientKey, now) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const admitted = await client.query(`INSERT INTO agpl_waiver_quote_limits (client_key,window_start,quote_count)
          VALUES ($1,$2,1) ON CONFLICT (client_key) DO UPDATE SET
          quote_count=CASE WHEN agpl_waiver_quote_limits.window_start <= $2-3600000 THEN 1 ELSE agpl_waiver_quote_limits.quote_count+1 END,
          window_start=CASE WHEN agpl_waiver_quote_limits.window_start <= $2-3600000 THEN $2 ELSE agpl_waiver_quote_limits.window_start END
          WHERE agpl_waiver_quote_limits.window_start <= $2-3600000 OR agpl_waiver_quote_limits.quote_count < 5
          RETURNING client_key`, [clientKey, now]);
        if (!admitted.rowCount) {
          const row = (await client.query("SELECT window_start FROM agpl_waiver_quote_limits WHERE client_key=$1", [clientKey])).rows[0];
          throw new WaiverError(429, "waiver_quote_rate_limited", {
            retry_after: Math.max(1, Math.ceil((Number(row.window_start) + 3600000 - now) / 1000)),
          });
        }
        // nextval is never rolled back: even a failed insert burns its index forever.
        const index = Number((await client.query("SELECT nextval('agpl_waiver_derivation_seq') AS idx")).rows[0].idx);
        const q = build(index);
        if (q.derivation_index !== index) throw new WaiverError(503, "waiver_settlement_key_invalid");
        await client.query(`INSERT INTO agpl_waiver_quotes
          (id,tier,licensee_name,licensee_identifier,usd_basis,quoted_sats,btc_spot_usd,settlement_address,min_confirmations,terms_sha256,created_at,expires_at,derivation_index)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [q.quote_id,q.tier,q.licensee_name,q.licensee_identifier,q.usd_basis,q.quoted_sats,String(q.btc_spot_usd),q.settlement_address,q.min_confirmations,q.terms_sha256,q.created_at,q.expires_at,index]);
        await client.query("COMMIT");
        return q;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async quote(id) {
      const row = (await pool.query("SELECT * FROM agpl_waiver_quotes WHERE id=$1", [id])).rows[0];
      if (!row) return null;
      return { ...row, quote_id: row.id, quoted_sats: Number(row.quoted_sats), btc_spot_usd: Number(row.btc_spot_usd),
        created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString() } as WaiverQuote;
    },
    certificate,
    async issue(q, cert, now) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = (await client.query("SELECT expires_at FROM agpl_waiver_quotes WHERE id=$1 FOR UPDATE", [q.quote_id])).rows[0];
        const existing = (await client.query("SELECT certificate FROM agpl_waiver_certificates WHERE quote_id=$1", [q.quote_id])).rows[0]?.certificate;
        if (existing) {
          if (existing.txid !== cert.txid) throw new WaiverError(409, "waiver_quote_already_claimed");
          await client.query("COMMIT"); return existing;
        }
        if (!locked || new Date(locked.expires_at).getTime() <= now) throw new WaiverError(410, "waiver_quote_expired");
        await client.query("INSERT INTO agpl_waiver_certificates (id,quote_id,txid,vout,certificate,derivation_index) VALUES ($1,$2,$3,$4,$5::jsonb,$6)",
          [cert.waiver_id,q.quote_id,cert.txid,cert.vout,JSON.stringify(cert),q.derivation_index]);
        await client.query("COMMIT");
        return cert;
      } catch (error) {
        await client.query("ROLLBACK");
        if ((error as {code?:string}).code === "23505") throw new WaiverError(409, "waiver_transaction_output_already_claimed");
        throw error;
      } finally { client.release(); }
    },
  };
}
