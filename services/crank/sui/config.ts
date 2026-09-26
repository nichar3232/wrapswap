// Keeper/demo configuration: public IDs from deployments/sui-testnet.json, secrets from an env file outside the repo.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

const repoRoot = resolve(import.meta.dirname, '../../..');
export const RUN_DIR = process.env.WRAPSWAP_RUN_DIR ?? join(homedir(), 'wrapswap-run');
export const STATE_DIR = process.env.SUI_STATE_DIR ?? join(RUN_DIR, 'sui-state');

const envFile = process.env.SUI_ENV_FILE ?? join(RUN_DIR, 'env', 'onchain.env');
if (existsSync(envFile)) loadEnv({ path: envFile, quiet: true });

export type EvmToken = { symbol: string; address: `0x${string}`; decimals: number };
export type Deployment = {
  sui: { packageId: string; poolId: string; operatorCapId: string; operator: string; windowMs: number };
  seal: { threshold: number; keyServers: { name: string; objectId: string }[] };
  evm: null | {
    chainId: number;
    shareVault: `0x${string}`;
    startBlock: string;
    explorer: string;
    wrapSwapRouter: `0x${string}`;
    parityHook: `0x${string}`;
    tokens: EvmToken[];
  };
};

export const DEPLOYMENT_PATH = process.env.SUI_DEPLOYMENT ?? join(repoRoot, 'deployments', 'sui-testnet.json');
export const loadDeployment = (): Deployment => JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8'));

// sepolia.unichain.org is load-balanced across backends that disagree (pending nonce below latest, logs and state
// trailing receipts; observed 2026-09-26), so the Sui lane defaults to publicnode, which answered consistently.
export const EVM_RPC_DEFAULT = 'https://unichain-sepolia-rpc.publicnode.com';
export const evmRpcUrl = () => process.env.SUI_EVM_RPC_URL ?? EVM_RPC_DEFAULT;
export function evmKeeperKey(): `0x${string}` {
  const k = process.env.SUI_EVM_KEEPER_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!k) throw new Error('no EVM keeper key (SUI_EVM_KEEPER_KEY or DEPLOYER_PRIVATE_KEY in the env file)');
  return (k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`;
}
