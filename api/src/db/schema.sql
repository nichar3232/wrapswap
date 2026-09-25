CREATE TABLE IF NOT EXISTS chain_events(chain_id INTEGER,block NUMERIC(78,0),block_hash TEXT,tx TEXT,log_index INTEGER,event_name TEXT,args JSONB,ts NUMERIC(78,0),trader TEXT,PRIMARY KEY(chain_id,tx,log_index));
CREATE TABLE IF NOT EXISTS conversions(tx TEXT,log_index INTEGER,chain_id INTEGER,block NUMERIC(78,0),ts NUMERIC(78,0),from_token TEXT,to_token TEXT,shares NUMERIC(78,0),fee_bps INTEGER,filled_by_hook BOOLEAN,trader TEXT,PRIMARY KEY(chain_id,tx,log_index));
CREATE TABLE IF NOT EXISTS batches(batch_id NUMERIC(78,0) PRIMARY KEY,phase TEXT,mid NUMERIC(78,0),mid_source TEXT,crossed_qty NUMERIC(78,0),routed_qty NUMERIC(78,0),settled_tx TEXT);
CREATE TABLE IF NOT EXISTS orders(batch_id NUMERIC(78,0),trader TEXT,commit_hash TEXT,revealed BOOLEAN DEFAULT FALSE,is_buy BOOLEAN,qty NUMERIC(78,0),limit_px NUMERIC(78,0),route_residual BOOLEAN,PRIMARY KEY(batch_id,trader));
CREATE TABLE IF NOT EXISTS fills(batch_id NUMERIC(78,0),trader TEXT,is_buy BOOLEAN,qty NUMERIC(78,0),px NUMERIC(78,0),kind TEXT CHECK(kind IN ('cross','lit')),tx TEXT,log_index INTEGER,PRIMARY KEY(tx,log_index));
CREATE TABLE IF NOT EXISTS backing_snapshots(block NUMERIC(78,0),issuer TEXT,tokens_held NUMERIC(78,0),spt NUMERIC(78,0),shares NUMERIC(78,0),supply NUMERIC(78,0),PRIMARY KEY(block,issuer));
CREATE TABLE IF NOT EXISTS hook_inventory(block NUMERIC(78,0),pool_id TEXT,currency TEXT,amount NUMERIC(78,0),fee_accrued NUMERIC(78,0),PRIMARY KEY(block,pool_id,currency));
CREATE TABLE IF NOT EXISTS intents(hash TEXT PRIMARY KEY,status TEXT,input_amount NUMERIC(78,0),min_out NUMERIC(78,0),filled_amount NUMERIC(78,0),filler TEXT,opened_tx TEXT,filled_tx TEXT,finalized_tx TEXT);
CREATE TABLE IF NOT EXISTS cursor(chain_id INTEGER PRIMARY KEY,last_block NUMERIC(78,0));

CREATE TABLE IF NOT EXISTS indexer_deployments(chain_id INTEGER PRIMARY KEY, identity TEXT NOT NULL);
