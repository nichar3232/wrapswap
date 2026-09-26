-- Adds the TestShareFaucet claim table to databases created before the faucet deploy. Idempotent.
CREATE TABLE IF NOT EXISTS faucet_claims (                  -- TestShareFaucet.Claimed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  account TEXT NOT NULL, "timestamp" NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS faucet_claims_account ON faucet_claims (chain_id, account, block_number DESC);
