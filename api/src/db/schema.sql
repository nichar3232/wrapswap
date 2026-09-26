CREATE TABLE indexer_deployments (
  chain_id        INTEGER PRIMARY KEY,
  network         TEXT NOT NULL CHECK (network IN ('anvil', 'unichain-sepolia')),
  identity        TEXT NOT NULL,             -- keccak256(deployCommit|startBlock|parityHook|darkCrossHook)
  deploy_commit   TEXT NOT NULL,
  start_block     NUMERIC(78,0) NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indexer_cursor (
  chain_id        INTEGER PRIMARY KEY REFERENCES indexer_deployments(chain_id) ON DELETE CASCADE,
  last_block      NUMERIC(78,0) NOT NULL,
  last_block_hash TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE blocks (
  chain_id        INTEGER NOT NULL,
  block_number    NUMERIC(78,0) NOT NULL,
  block_hash      TEXT NOT NULL,
  parent_hash     TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, block_number),
  UNIQUE (chain_id, block_hash)
);

-- Every event table below starts with these reorg/provenance columns (spelled out per table):
--   chain_id, block_number, block_hash, block_timestamp, tx_hash, log_index, contract
--   PRIMARY KEY (chain_id, tx_hash, log_index)
--   FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE

CREATE TABLE raw_logs (
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  topic0 TEXT NOT NULL, event_name TEXT NOT NULL, args JSONB NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX raw_logs_block ON raw_logs (chain_id, block_number);
CREATE INDEX raw_logs_event ON raw_logs (chain_id, event_name, block_number);

-- ParityHook
CREATE TABLE parity_pools (                       -- PoolRegistered
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL, underlying TEXT NOT NULL,
  tick_spacing INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX parity_pools_id ON parity_pools (chain_id, pool_id);

CREATE TABLE parity_fee_quotes (                  -- FeeQuoted
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, total_pips INTEGER NOT NULL, base_pips INTEGER NOT NULL, skew_pips INTEGER NOT NULL,
  closed_pips INTEGER NOT NULL, skew_x18 NUMERIC(78,0) NOT NULL, market_open BOOLEAN NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_fee_quotes_pool ON parity_fee_quotes (chain_id, pool_id, block_number DESC, log_index DESC);

CREATE TABLE parity_fills (                       -- InventoryFill
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, swapper TEXT NOT NULL, sender TEXT NOT NULL, zero_for_one BOOLEAN NOT NULL,
  exact_input BOOLEAN NOT NULL, token_in TEXT NOT NULL, token_out TEXT NOT NULL,
  amount_in NUMERIC(78,0) NOT NULL, amount_out NUMERIC(78,0) NOT NULL, shares NUMERIC(78,0) NOT NULL,
  fee_amount NUMERIC(78,0) NOT NULL, fee_pips INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_fills_swapper ON parity_fills (chain_id, swapper, block_number DESC, log_index DESC);
CREATE INDEX parity_fills_tx ON parity_fills (chain_id, tx_hash);

CREATE TABLE parity_fallthroughs (                -- FallThrough
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, swapper TEXT NOT NULL, sender TEXT NOT NULL, zero_for_one BOOLEAN NOT NULL,
  reason SMALLINT NOT NULL, amount0 NUMERIC(78,0) NOT NULL, amount1 NUMERIC(78,0) NOT NULL,
  fee_pips INTEGER NOT NULL, deviation_bps_after NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_fallthroughs_swapper ON parity_fallthroughs (chain_id, swapper, block_number DESC, log_index DESC);
CREATE INDEX parity_fallthroughs_tx ON parity_fallthroughs (chain_id, tx_hash);

CREATE TABLE parity_inventory_changes (           -- InventoryChanged
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  currency TEXT NOT NULL, actor TEXT NOT NULL, reason SMALLINT NOT NULL CHECK (reason BETWEEN 0 AND 3),
  delta NUMERIC(78,0) NOT NULL, inventory_after NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_inventory_changes_currency ON parity_inventory_changes (chain_id, currency, block_number DESC, log_index DESC);

CREATE TABLE parity_fee_sweeps (                  -- FeesSwept
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  currency TEXT NOT NULL, recipient TEXT NOT NULL, amount NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);

CREATE TABLE parity_peg_status (                  -- PegGuardStatus
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, tripped BOOLEAN NOT NULL, pool_price_x18 NUMERIC(78,0) NOT NULL,
  parity_price_x18 NUMERIC(78,0) NOT NULL, deviation_bps NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_peg_status_pool ON parity_peg_status (chain_id, pool_id, block_number DESC, log_index DESC);

-- DarkCrossHook
CREATE TABLE dark_escrow_events (                 -- Funded, Withdrawn
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('FUNDED', 'WITHDRAWN')), account TEXT NOT NULL, token TEXT NOT NULL,
  amount NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_escrow_events_account ON dark_escrow_events (chain_id, account, block_number DESC);

CREATE TABLE dark_commits (                       -- Committed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, commit_hash TEXT NOT NULL, lock_token TEXT NOT NULL,
  locked NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_commits_order ON dark_commits (chain_id, batch_id, trader);
CREATE INDEX dark_commits_trader ON dark_commits (chain_id, trader, batch_id DESC);

CREATE TABLE dark_reveals (                       -- Revealed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, sell_base BOOLEAN NOT NULL, amount_in NUMERIC(78,0) NOT NULL,
  limit_price_x18 NUMERIC(78,0) NOT NULL, route_residual BOOLEAN NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_reveals_order ON dark_reveals (chain_id, batch_id, trader);

CREATE TABLE dark_reveal_rejections (             -- RevealRejected
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, reason SMALLINT NOT NULL CHECK (reason BETWEEN 1 AND 4),
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_reveal_rejections_order ON dark_reveal_rejections (chain_id, batch_id, trader);

CREATE TABLE dark_crosses (                       -- Crossed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, sell_base BOOLEAN NOT NULL, amount_in NUMERIC(78,0) NOT NULL,
  amount_out NUMERIC(78,0) NOT NULL, fee_amount NUMERIC(78,0) NOT NULL, mid_x18 NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_crosses_batch ON dark_crosses (chain_id, batch_id);
CREATE INDEX dark_crosses_trader ON dark_crosses (chain_id, trader, block_number DESC, log_index DESC);

CREATE TABLE dark_residuals (                     -- ResidualRouted
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, pool_id TEXT NOT NULL, sell_base BOOLEAN NOT NULL,
  amount_in NUMERIC(78,0) NOT NULL, amount_out NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_residuals_batch ON dark_residuals (chain_id, batch_id);
CREATE INDEX dark_residuals_trader ON dark_residuals (chain_id, trader, block_number DESC, log_index DESC);

CREATE TABLE dark_residual_skips (                -- ResidualSkipped
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, reason TEXT NOT NULL,   -- hex revert data
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_residual_skips_batch ON dark_residual_skips (chain_id, batch_id);

CREATE TABLE dark_forfeits (                      -- Forfeited
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, token TEXT NOT NULL, amount NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_forfeits_batch ON dark_forfeits (chain_id, batch_id, trader);

CREATE TABLE dark_batches (                       -- BatchSettled
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, mid_x18 NUMERIC(78,0) NOT NULL, mid_updated_at NUMERIC(78,0) NOT NULL,
  crossed_base NUMERIC(78,0) NOT NULL, crossed_quote NUMERIC(78,0) NOT NULL,
  residual_base_in NUMERIC(78,0) NOT NULL, residual_quote_in NUMERIC(78,0) NOT NULL, participants INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_batches_id ON dark_batches (chain_id, batch_id);

-- Eligibility, oracle, ratios, admin
CREATE TABLE eligibility_denials (                -- EligibilityDenied (caller must be a deployment hook)
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  account TEXT NOT NULL, caller TEXT NOT NULL, reason SMALLINT NOT NULL, attestation_uid TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX eligibility_denials_account ON eligibility_denials (chain_id, account, block_number DESC);

CREATE TABLE demo_mode_changes (                  -- DemoModeSet
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  enabled BOOLEAN NOT NULL, set_by TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX demo_mode_changes_latest ON demo_mode_changes (chain_id, block_number DESC, log_index DESC);

CREATE TABLE oracle_mids (                        -- MidUpdated
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  base TEXT NOT NULL, quote TEXT NOT NULL, mid_x18 NUMERIC(78,0) NOT NULL, updated_at NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX oracle_mids_pair ON oracle_mids (chain_id, base, quote, block_number DESC);

CREATE TABLE IF NOT EXISTS faucet_claims (                  -- TestShareFaucet.Claimed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  account TEXT NOT NULL, "timestamp" NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS faucet_claims_account ON faucet_claims (chain_id, account, block_number DESC);

CREATE TABLE ratio_updates (                      -- RatioUpdated (adapter), MultiplierUpdated (mock token)
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ADAPTER', 'TOKEN')), token TEXT NOT NULL,
  old_value NUMERIC(78,0) NOT NULL, new_value NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX ratio_updates_token ON ratio_updates (chain_id, token, block_number DESC);

CREATE TABLE registry_events (                    -- IssuerAdded, IssuerRemoved, IssuerPaused
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ADDED', 'REMOVED', 'PAUSED')), token TEXT NOT NULL, adapter TEXT,
  underlying TEXT, paused BOOLEAN,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX registry_events_token ON registry_events (chain_id, token, block_number DESC);

CREATE TABLE admin_events (  -- KeeperSet, TrustedRouterSet, PusherSet, HolidaySet, EarlyCloseSet, AdapterPaused, TransfersPaused
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  event_name TEXT NOT NULL, args JSONB NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX admin_events_name ON admin_events (chain_id, event_name, block_number DESC);

-- Written by the API (not events; no reorg linkage)
CREATE TABLE eligibility_checks (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL, account TEXT NOT NULL, attestation_uid TEXT, eligible BOOLEAN NOT NULL,
  reason SMALLINT NOT NULL, demo_mode BOOLEAN NOT NULL, block_number NUMERIC(78,0) NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('route', 'eligibility')), checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_checks_account ON eligibility_checks (chain_id, account, checked_at DESC);

-- Derived state: views only
CREATE VIEW v_dark_orders AS
SELECT c.chain_id, c.batch_id, c.trader, c.commit_hash, c.lock_token, c.locked, c.tx_hash AS committed_tx,
       c.block_number, c.log_index,
       (r.trader IS NOT NULL OR x.trader IS NOT NULL) AS revealed, (r.trader IS NOT NULL) AS valid,
       x.reason AS reject_reason, r.sell_base, r.amount_in, r.limit_price_x18, r.route_residual,
       f.amount AS forfeited
FROM dark_commits c
LEFT JOIN dark_reveals r ON r.chain_id = c.chain_id AND r.batch_id = c.batch_id AND r.trader = c.trader
LEFT JOIN dark_reveal_rejections x ON x.chain_id = c.chain_id AND x.batch_id = c.batch_id AND x.trader = c.trader
LEFT JOIN dark_forfeits f ON f.chain_id = c.chain_id AND f.batch_id = c.batch_id AND f.trader = c.trader;

CREATE VIEW v_dark_batches AS
SELECT ids.chain_id, ids.batch_id, (b.batch_id IS NOT NULL) AS settled, b.mid_x18,
       COALESCE(b.crossed_base, 0) AS crossed_base, COALESCE(b.crossed_quote, 0) AS crossed_quote,
       COALESCE(b.residual_base_in, 0) AS residual_base_in, COALESCE(b.residual_quote_in, 0) AS residual_quote_in,
       COALESCE(b.participants, (SELECT count(*) FROM dark_commits c WHERE c.chain_id = ids.chain_id AND c.batch_id = ids.batch_id))::INTEGER AS participants,
       b.tx_hash AS settled_tx, b.block_number AS settled_block, b.block_timestamp AS settled_at
FROM (SELECT chain_id, batch_id FROM dark_commits UNION SELECT chain_id, batch_id FROM dark_batches) ids
LEFT JOIN dark_batches b ON b.chain_id = ids.chain_id AND b.batch_id = ids.batch_id;

CREATE VIEW v_fills AS
SELECT p.chain_id, 'PARITY'::TEXT AS kind, p.swapper AS account, p.token_in, p.token_out, p.amount_in, p.amount_out,
       p.fee_amount, p.fee_pips, p.shares, NULL::NUMERIC AS batch_id, p.pool_id, p.block_number, p.block_timestamp,
       p.tx_hash, p.log_index
FROM parity_fills p
WHERE NOT EXISTS (SELECT 1 FROM dark_residuals d WHERE d.chain_id = p.chain_id AND d.tx_hash = p.tx_hash AND d.trader = p.swapper)
UNION ALL
SELECT t.chain_id, 'FALL-THROUGH', t.swapper,
       CASE WHEN t.zero_for_one THEN pp.currency0 ELSE pp.currency1 END,
       CASE WHEN t.zero_for_one THEN pp.currency1 ELSE pp.currency0 END,
       ABS(CASE WHEN t.zero_for_one THEN t.amount0 ELSE t.amount1 END),
       ABS(CASE WHEN t.zero_for_one THEN t.amount1 ELSE t.amount0 END),
       NULL, t.fee_pips, NULL, NULL, t.pool_id, t.block_number, t.block_timestamp, t.tx_hash, t.log_index
FROM parity_fallthroughs t JOIN parity_pools pp ON pp.chain_id = t.chain_id AND pp.pool_id = t.pool_id
WHERE NOT EXISTS (SELECT 1 FROM dark_residuals d WHERE d.chain_id = t.chain_id AND d.tx_hash = t.tx_hash AND d.trader = t.swapper)
UNION ALL
SELECT x.chain_id, 'DARK-CROSS', x.trader,
       CASE WHEN x.sell_base THEN (SELECT base FROM v_dark_pair) ELSE (SELECT quote FROM v_dark_pair) END,
       CASE WHEN x.sell_base THEN (SELECT quote FROM v_dark_pair) ELSE (SELECT base FROM v_dark_pair) END,
       x.amount_in, x.amount_out, x.fee_amount, 500, NULL, x.batch_id, NULL, x.block_number, x.block_timestamp,
       x.tx_hash, x.log_index
FROM dark_crosses x
UNION ALL
SELECT d.chain_id, 'DARK-RESIDUAL', d.trader,
       CASE WHEN d.sell_base THEN (SELECT base FROM v_dark_pair) ELSE (SELECT quote FROM v_dark_pair) END,
       CASE WHEN d.sell_base THEN (SELECT quote FROM v_dark_pair) ELSE (SELECT base FROM v_dark_pair) END,
       d.amount_in, d.amount_out, pf.fee_amount, COALESCE(pf.fee_pips, ft.fee_pips), pf.shares, d.batch_id, d.pool_id,
       d.block_number, d.block_timestamp, d.tx_hash, d.log_index
FROM dark_residuals d
LEFT JOIN parity_fills pf ON pf.chain_id = d.chain_id AND pf.tx_hash = d.tx_hash AND pf.swapper = d.trader
     AND pf.log_index = (SELECT max(log_index) FROM parity_fills q WHERE q.chain_id = d.chain_id AND q.tx_hash = d.tx_hash AND q.swapper = d.trader AND q.log_index < d.log_index)
LEFT JOIN parity_fallthroughs ft ON ft.chain_id = d.chain_id AND ft.tx_hash = d.tx_hash AND ft.swapper = d.trader
     AND ft.log_index = (SELECT max(log_index) FROM parity_fallthroughs q WHERE q.chain_id = d.chain_id AND q.tx_hash = d.tx_hash AND q.swapper = d.trader AND q.log_index < d.log_index);
