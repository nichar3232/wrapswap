-- Final fee model (base + skew, fees to the LP) and one DarkCrossHook per asset. Idempotent; runs on every migrate.
-- Events: ParityHook.Converted (per inventory fill, fees in shares); DarkCrossHook.Crossed (per batch: matched shares,
-- midpoint, protocol fee), CrossFilled (per trader), ResidualFilled / Unfilled (per trader residual), Revealed with a
-- recipient. Dark rows are keyed by (contract, batch_id): every hook numbers batches from its own origin.

ALTER TABLE dark_reveals ADD COLUMN IF NOT EXISTS recipient TEXT;
ALTER TABLE dark_reveals ALTER COLUMN route_residual DROP NOT NULL;
ALTER TABLE dark_crosses ADD COLUMN IF NOT EXISTS recipient TEXT;
ALTER TABLE dark_crosses ALTER COLUMN mid_x18 DROP NOT NULL;

CREATE TABLE IF NOT EXISTS parity_conversions (          -- ParityHook.Converted
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  asset TEXT NOT NULL, from_token TEXT NOT NULL, to_token TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
  amount_in NUMERIC(78,0) NOT NULL, shares_out NUMERIC(78,0) NOT NULL,
  base_fee NUMERIC(78,0) NOT NULL, skew_fee NUMERIC(78,0) NOT NULL, post_skew NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS parity_conversions_asset ON parity_conversions (chain_id, asset, block_number DESC);

CREATE TABLE IF NOT EXISTS dark_batch_crosses (          -- DarkCrossHook.Crossed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, asset TEXT NOT NULL, matched_shares NUMERIC(78,0) NOT NULL,
  midpoint NUMERIC(78,0) NOT NULL, protocol_fee NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dark_residual_fills (         -- DarkCrossHook.ResidualFilled
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, shares NUMERIC(78,0) NOT NULL,
  base_fee NUMERIC(78,0) NOT NULL, skew_fee NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dark_unfilled (               -- DarkCrossHook.Unfilled
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, shares_refunded NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);

-- Base/quote tokens of every DarkCrossHook, written by migrate() from the manifest.
CREATE TABLE IF NOT EXISTS dark_pairs (
  chain_id INTEGER NOT NULL, contract TEXT NOT NULL, asset TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
  PRIMARY KEY (chain_id, contract)
);

DROP VIEW IF EXISTS v_fills, v_dark_orders, v_dark_batches CASCADE;

CREATE VIEW v_dark_batches AS
SELECT ids.chain_id, ids.contract, ids.batch_id, (b.batch_id IS NOT NULL) AS settled, b.mid_x18,
       COALESCE(b.crossed_base, 0) AS crossed_base, COALESCE(b.crossed_quote, 0) AS crossed_quote,
       COALESCE(b.residual_base_in, 0) AS residual_base_in, COALESCE(b.residual_quote_in, 0) AS residual_quote_in,
       COALESCE(b.participants, (SELECT count(*) FROM dark_commits c WHERE c.chain_id = ids.chain_id AND c.contract = ids.contract AND c.batch_id = ids.batch_id))::INTEGER AS participants,
       b.tx_hash AS settled_tx, b.block_number AS settled_block, b.block_timestamp AS settled_at
FROM (SELECT chain_id, contract, batch_id FROM dark_commits UNION SELECT chain_id, contract, batch_id FROM dark_batches) ids
LEFT JOIN dark_batches b ON b.chain_id = ids.chain_id AND b.contract = ids.contract AND b.batch_id = ids.batch_id;

CREATE VIEW v_dark_orders AS
SELECT c.chain_id, c.contract, c.batch_id, c.trader, c.commit_hash, c.lock_token, c.locked, c.tx_hash AS committed_tx,
       c.block_number, c.log_index,
       (r.trader IS NOT NULL OR x.trader IS NOT NULL) AS revealed, (r.trader IS NOT NULL) AS valid,
       x.reason AS reject_reason, r.sell_base, r.amount_in, r.limit_price_x18,
       CASE WHEN r.trader IS NULL THEN NULL ELSE COALESCE(r.route_residual, true) END AS route_residual,
       f.amount AS forfeited
FROM dark_commits c
LEFT JOIN dark_reveals r ON r.chain_id = c.chain_id AND r.contract = c.contract AND r.batch_id = c.batch_id AND r.trader = c.trader
LEFT JOIN dark_reveal_rejections x ON x.chain_id = c.chain_id AND x.contract = c.contract AND x.batch_id = c.batch_id AND x.trader = c.trader
LEFT JOIN dark_forfeits f ON f.chain_id = c.chain_id AND f.contract = c.contract AND f.batch_id = c.batch_id AND f.trader = c.trader;

-- A residual fill is the ParityHook InventoryFill a DarkCrossHook sends for a trader (sender = hook, swapper = trader),
-- reported as DARK-RESIDUAL and not as PARITY.
CREATE VIEW v_fills AS
SELECT p.chain_id, 'PARITY'::TEXT AS kind, p.swapper AS account, p.token_in, p.token_out, p.amount_in, p.amount_out,
       p.fee_amount, p.fee_pips, p.shares, NULL::NUMERIC AS batch_id, p.pool_id, p.block_number, p.block_timestamp,
       p.tx_hash, p.log_index, NULL::TEXT AS dark_contract
FROM parity_fills p
WHERE NOT EXISTS (SELECT 1 FROM dark_pairs dp WHERE dp.chain_id = p.chain_id AND dp.contract = p.sender)
UNION ALL
SELECT t.chain_id, 'FALL-THROUGH', t.swapper,
       CASE WHEN t.zero_for_one THEN pp.currency0 ELSE pp.currency1 END,
       CASE WHEN t.zero_for_one THEN pp.currency1 ELSE pp.currency0 END,
       ABS(CASE WHEN t.zero_for_one THEN t.amount0 ELSE t.amount1 END),
       ABS(CASE WHEN t.zero_for_one THEN t.amount1 ELSE t.amount0 END),
       NULL, t.fee_pips, NULL, NULL, t.pool_id, t.block_number, t.block_timestamp, t.tx_hash, t.log_index, NULL
FROM parity_fallthroughs t JOIN parity_pools pp ON pp.chain_id = t.chain_id AND pp.pool_id = t.pool_id
WHERE NOT EXISTS (SELECT 1 FROM dark_pairs dp WHERE dp.chain_id = t.chain_id AND dp.contract = t.sender)
UNION ALL
SELECT x.chain_id, 'DARK-CROSS', x.trader,
       CASE WHEN x.sell_base THEN dp.base ELSE dp.quote END,
       CASE WHEN x.sell_base THEN dp.quote ELSE dp.base END,
       x.amount_in, x.amount_out, x.fee_amount,
       CASE WHEN x.amount_out + x.fee_amount > 0 THEN round(x.fee_amount * 1000000 / (x.amount_out + x.fee_amount))::INTEGER END,
       NULL, x.batch_id, NULL, x.block_number, x.block_timestamp, x.tx_hash, x.log_index, x.contract
FROM dark_crosses x JOIN dark_pairs dp ON dp.chain_id = x.chain_id AND dp.contract = x.contract
UNION ALL
SELECT r.chain_id, 'DARK-RESIDUAL', r.trader, p.token_in, p.token_out, p.amount_in, p.amount_out, p.fee_amount, p.fee_pips,
       p.shares, r.batch_id, p.pool_id, r.block_number, r.block_timestamp, r.tx_hash, r.log_index, r.contract
FROM dark_residual_fills r
JOIN LATERAL (SELECT * FROM parity_fills q WHERE q.chain_id = r.chain_id AND q.tx_hash = r.tx_hash AND q.swapper = r.trader
              AND q.sender = r.contract AND q.log_index < r.log_index ORDER BY q.log_index DESC LIMIT 1) p ON true;
