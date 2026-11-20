import type { Pool } from "pg";
import { WaiverError, type WaiverQuote, type WaiverStore } from "./agplWaivers";

export function createPostgresWaiverStore(pool: Pool): WaiverStore {
  const certificate = async (id: string) =>
    (await pool.query("SELECT certificate FROM agpl_waiver_certificates WHERE quote_id=$1", [id])).rows[0]?.certificate ?? null;
  return {
    async saveQuote(q) {
      await pool.query(`INSERT INTO agpl_waiver_quotes
        (id,tier,licensee_name,licensee_identifier,usd_basis,quoted_sats,btc_spot_usd,settlement_address,min_confirmations,terms_sha256,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [q.quote_id,q.tier,q.licensee_name,q.licensee_identifier,q.usd_basis,q.quoted_sats,String(q.btc_spot_usd),q.settlement_address,q.min_confirmations,q.terms_sha256,q.created_at,q.expires_at]);
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
        await client.query("INSERT INTO agpl_waiver_certificates (id,quote_id,txid,vout,certificate) VALUES ($1,$2,$3,$4,$5::jsonb)",
          [cert.waiver_id,q.quote_id,cert.txid,cert.vout,JSON.stringify(cert)]);
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
