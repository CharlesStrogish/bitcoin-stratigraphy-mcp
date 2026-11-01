-- Development-only additive safety migration; Publish owns production DDL.
BEGIN;
ALTER TABLE private_yield_claims DROP CONSTRAINT IF EXISTS private_yield_claim_mock_only;
ALTER TABLE private_yield_claims ADD COLUMN payment_status text NOT NULL DEFAULT 'settled';
ALTER TABLE private_yield_claims ALTER COLUMN payment_status SET DEFAULT 'pending';
ALTER TABLE private_yield_claims ALTER COLUMN settlement_mode SET DEFAULT 'mainnet';
ALTER TABLE private_yield_claims ADD COLUMN coinos_txid text;
ALTER TABLE private_yield_claims ADD COLUMN preimage text;
ALTER TABLE private_yield_claims ADD COLUMN failure_code text;
ALTER TABLE private_yield_claims ADD COLUMN selection_digest text;
ALTER TABLE private_yield_claims ADD COLUMN receipt_count integer NOT NULL DEFAULT 0;
ALTER TABLE private_yield_claims ADD COLUMN attempt integer NOT NULL DEFAULT 1;
ALTER TABLE private_yield_claims ADD CONSTRAINT private_yield_claim_payment_state CHECK (
  settlement_mode IN ('mock','mainnet') AND total_msats>0 AND payment_status IN ('pending','settled','failed')
  AND (settlement_mode<>'mainnet' OR payment_status<>'settled' OR coinos_txid IS NOT NULL OR preimage IS NOT NULL)
);
CREATE TABLE private_yield_payout_items (
  source text NOT NULL CONSTRAINT private_yield_payout_source CHECK(source IN ('yield','royalty')),
  payment_hash text NOT NULL,
  claim_id text NOT NULL REFERENCES private_yield_claims(id),
  PRIMARY KEY(source,payment_hash)
);
CREATE INDEX private_yield_payout_claim_idx ON private_yield_payout_items(claim_id);
COMMIT;
