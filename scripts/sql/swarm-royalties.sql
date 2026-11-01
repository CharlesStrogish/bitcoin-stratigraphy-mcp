-- Additive development migration. Production schema rollout is managed by Publish.
-- Existing private_yield_earnings and private_yield_claims remain unchanged.
CREATE TABLE private_swarm_royalties (
  payment_hash text PRIMARY KEY,
  owner text NOT NULL,
  provider text NOT NULL,
  gross_msats bigint NOT NULL,
  earned_msats bigint NOT NULL,
  balance_msats bigint NOT NULL,
  claim_id text REFERENCES private_yield_claims(id),
  claimed_at timestamptz,
  CONSTRAINT swarm_royalty_arithmetic CHECK
    (gross_msats > 0 AND earned_msats = gross_msats * 5 / 100 AND balance_msats >= 0),
  CONSTRAINT swarm_royalty_consumption CHECK
    ((claim_id IS NULL AND claimed_at IS NULL AND balance_msats = earned_msats) OR
     (claim_id IS NOT NULL AND claimed_at IS NOT NULL AND balance_msats = 0))
);
CREATE INDEX private_swarm_royalties_owner_idx ON private_swarm_royalties (owner, payment_hash);
