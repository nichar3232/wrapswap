-- Databases created before the Unichain Sepolia switch carry CHECK (network IN ('anvil', 'base-sepolia')).
-- Idempotent: re-adds the constraint with the current network set on every migrate.
ALTER TABLE indexer_deployments DROP CONSTRAINT IF EXISTS indexer_deployments_network_check;
ALTER TABLE indexer_deployments ADD CONSTRAINT indexer_deployments_network_check
  CHECK (network IN ('anvil', 'unichain-sepolia'));
