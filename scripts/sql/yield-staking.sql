-- Development / isolated-test migration. Production DDL is owned by Publish.
-- No changes to historical earnings, claims, or payout reservations.
CREATE TABLE yield_staking_accounts (
  pubkey_hash text PRIMARY KEY CONSTRAINT yield_staking_pubkey_hash CHECK (pubkey_hash ~ '^[0-9a-f]{64}$'),
  staked_msats bigint NOT NULL DEFAULT 0
    CONSTRAINT yield_staking_balance CHECK (staked_msats >= 0 AND staked_msats <= 9007199254740991),
  staked_sats bigint GENERATED ALWAYS AS (staked_msats / 1000) STORED
);
CREATE TABLE yield_staking_receipts (
  payment_hash text PRIMARY KEY CONSTRAINT yield_staking_payment_hash CHECK (payment_hash ~ '^[0-9a-f]{64}$'),
  pubkey_hash text NOT NULL REFERENCES yield_staking_accounts(pubkey_hash),
  provider text NOT NULL,
  gross_msats bigint NOT NULL,
  earned_msats bigint NOT NULL,
  CONSTRAINT yield_staking_arithmetic CHECK (
    gross_msats > 0 AND gross_msats <= 9007199254740991 AND earned_msats = gross_msats * 21 / 100
  )
);
