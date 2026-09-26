// Expands the minimal Unichain Sepolia manifest (deployments/<network>.json: chainId, deployBlock, router, faucet,
// protocolFeeRecipient, assets[{symbol, wrappers[{platform, token, adapter, multiplier}], pool, parityHook, darkCross}])
// into the typed Deployment (INTERFACES.md §4) by reading the chain from those addresses only, and writes
// deployments/<network>.resolved.json for loadDeployment. Nothing here is a hardcoded address.
// Usage: NETWORK=unichain-sepolia RPC_URL=… [DEMO_MNEMONIC=…] pnpm exec tsx scripts/dev/resolve-deployment.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createPublicClient, http, parseAbi, parseAbiItem, keccak256, encodeAbiParameters, getAddress, hexToString } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { parseDeployment, CHAIN_IDS, type Network } from '@wrapswap/types';

const network = (process.env.NETWORK || 'unichain-sepolia') as Network;
const path = `deployments/${network}.json`;
const m = JSON.parse(readFileSync(path, 'utf8'));
if (!m.assets?.[0]?.parityHook) throw Error(`${path} is not a minimal multi-asset manifest`);
if (CHAIN_IDS[network] !== m.chainId) throw Error(`${path} chainId ${m.chainId} is not ${network}`);
const client = createPublicClient({ transport: http(process.env.RPC_URL || 'https://sepolia.unichain.org') });
if ((await client.getChainId()) !== m.chainId) throw Error('RPC chain id does not match the manifest');
const deployBlock = BigInt(m.deployBlock);

const abi = parseAbi([
  'function poolManager() view returns (address)',
  'function registry() view returns (address)',
  'function eligibility() view returns (address)',
  'function oracle() view returns (address)',
  'function baseToken() view returns (address)',
  'function quoteToken() view returns (address)',
  'function asset() view returns (bytes32)',
  'function batchOrigin() view returns (uint256)',
  'function BATCH_BLOCKS() view returns (uint256)',
  'function COMMIT_BLOCKS() view returns (uint256)',
  'function REVEAL_BLOCKS() view returns (uint256)',
  'function parityPoolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
  'function eas() view returns (address)',
  'function attestationIndexer() view returns (address)',
  'function owner() view returns (address)',
  'function demoMode() view returns (bool)',
  'function isPusher(address) view returns (bool)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const read = (address: string, functionName: any, args: any[] = []) =>
  client.readContract({ address: address as `0x${string}`, abi, functionName, args } as any) as Promise<any>;
const poolId = (k: any) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const initialize = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const PERMISSIONS = ['afterRemoveLiquidityReturnDelta', 'afterAddLiquidityReturnDelta', 'afterSwapReturnDelta', 'beforeSwapReturnDelta',
  'afterDonate', 'beforeDonate', 'afterSwap', 'beforeSwap', 'afterRemoveLiquidity', 'beforeRemoveLiquidity', 'afterAddLiquidity',
  'beforeAddLiquidity', 'afterInitialize', 'beforeInitialize'];
const hookOf = (address: string) => {
  const flags = Number.parseInt(address.slice(-4), 16) & 0x3fff;
  return { address: getAddress(address), flags: `0x${flags.toString(16).padStart(4, '0')}`,
    permissions: PERMISSIONS.filter((_, bit) => flags & (1 << bit)).reverse() };
};

const parityHook = getAddress(m.assets[0].parityHook);
const [poolManager, registry, eligibility] = await Promise.all(['poolManager', 'registry', 'eligibility'].map((f) => read(parityHook, f)));
const [eas, easIndexer, demoMode, owner] = await Promise.all(['eas', 'attestationIndexer', 'demoMode', 'owner'].map((f) => read(eligibility, f)));
const deployedAt = new Date(Number((await client.getBlock({ blockNumber: deployBlock })).timestamp) * 1000).toISOString();

const assets: any[] = [];
for (const a of m.assets) {
  if (getAddress(a.parityHook) !== parityHook) throw Error(`${a.symbol}: every asset must share one ParityHook`);
  const dark = a.darkCross ? getAddress(a.darkCross) : null;
  if (!dark) throw Error(`${a.symbol}: no DarkCrossHook; the pool key is read from it`);
  const key = await read(dark, 'parityPoolKey');
  if (poolId(key).toLowerCase() !== a.pool.toLowerCase()) throw Error(`${a.symbol}: DarkCrossHook pool key does not hash to ${a.pool}`);
  if (hexToString(await read(dark, 'asset'), { size: 32 }).replace(/\0+$/, '') !== a.symbol) throw Error(`${a.symbol}: DarkCrossHook.asset() mismatch`);
  const logs = await client.getLogs({ address: poolManager, event: initialize, args: { id: a.pool }, fromBlock: deployBlock, toBlock: 'latest' });
  if (!logs.length) throw Error(`${a.symbol}: no Initialize event for pool ${a.pool} since the deploy block`);
  const [base, quote, oracle, batchOrigin, batchBlocks, commitBlocks, revealBlocks] = await Promise.all(
    ['baseToken', 'quoteToken', 'oracle', 'batchOrigin', 'BATCH_BLOCKS', 'COMMIT_BLOCKS', 'REVEAL_BLOCKS'].map((f) => read(dark, f)));
  const wrappers = await Promise.all(a.wrappers.map(async (w: any) => {
    const [symbol, name, decimals, adapterName] = await Promise.all([read(w.token, 'symbol'), read(w.token, 'name'), read(w.token, 'decimals'), read(w.adapter, 'name')]);
    return { platform: w.platform, symbol, name, token: getAddress(w.token), adapter: getAddress(w.adapter), multiplier: String(w.multiplier), decimals: Number(decimals), adapterName };
  }));
  assets.push({ symbol: a.symbol, wrappers, key, id: a.pool, initSqrtPriceX96: logs[0].args.sqrtPriceX96!.toString(), dark, base: getAddress(base), quote: getAddress(quote),
    oracle: getAddress(oracle), dk: { batchOrigin: batchOrigin.toString(), batchBlocks: Number(batchBlocks), commitBlocks: Number(commitBlocks), revealBlocks: Number(revealBlocks) } });
}
const first = assets[0];
const kind = (name: string) => (/b20/i.test(name) ? 'B20Multiplier' : /xstocks/i.test(name) ? 'XStocksMultiplier' : 'Static');
const mnemonic = process.env.DEMO_MNEMONIC;
const roles = ['deployer', 'demo', 'counterpartyA', 'counterpartyB', 'crank'] as const;
const block = deployBlock.toString();

const resolved = {
  schemaVersion: 1,
  network,
  chainId: m.chainId,
  deployCommit: execSync(`git log -1 --format=%H -- ${path}`).toString().trim(),
  deployedAt,
  deployer: getAddress(owner),
  startBlock: block,
  demoMode,
  mockOracle: await read(first.oracle, 'isPusher', [owner]).then(() => true, () => false),
  contracts: {
    poolManager: getAddress(poolManager), positionManager: null, stateView: null, quoter: null, permit2: null, universalRouter: null,
    swapRouter: null, modifyLiquidityRouter: null, registry: getAddress(registry), calendar: null, eligibility: getAddress(eligibility),
    oracle: first.oracle, parityHook, darkCrossHook: first.dark, wrapSwapRouter: getAddress(m.router), eas: getAddress(eas),
    easIndexer: /^0x0{40}$/i.test(easIndexer) ? null : getAddress(easIndexer),
  },
  tokens: first.wrappers.map((w) => ({
    symbol: w.symbol, name: w.name, address: w.token, decimals: w.decimals, issuer: w.platform.toLowerCase(), underlying: first.symbol,
    mock: demoMode, adapter: w.adapter, adapterKind: kind(w.adapterName), sharesPerTokenX18: w.multiplier,
    darkRole: w.token === first.base ? 'base' : 'quote',
  })),
  pool: { id: first.id, key: first.key, initSqrtPriceX96: first.initSqrtPriceX96 },
  hooks: { parityHook: hookOf(parityHook), darkCrossHook: hookOf(first.dark) },
  dark: { baseToken: first.base, quoteToken: first.quote, ...first.dk },
  blocks: { parityHook: block, darkCrossHook: block, wrapSwapRouter: block, poolInitialized: block },
  demoAccounts: {
    mnemonicSource: 'env:DEMO_MNEMONIC',
    accounts: mnemonic ? roles.map((role, index) => ({ role, index, address: mnemonicToAccount(mnemonic, { addressIndex: index }).address })) : [],
  },
  router: getAddress(m.router),
  faucet: getAddress(m.faucet),
  protocolFeeRecipient: getAddress(m.protocolFeeRecipient),
  deployBlock: block,
  ...(m.send ? { send: { ...m.send, shareVault: getAddress(m.send.shareVault) } } : {}),
  // Demo relay signer (services/relay): public address only; its key lives in ~/wrapswap-run/env/.
  ...(m.demo?.relay ? { demo: { relay: getAddress(m.demo.relay) } } : {}),
  assets: assets.map((a) => ({
    symbol: a.symbol,
    wrappers: a.wrappers.map(({ adapterName, name, ...w }) => w),
    pool: { id: a.id, key: a.key, initSqrtPriceX96: a.initSqrtPriceX96 },
    darkCross: true,
    parityHook,
    darkCrossHook: a.dark,
    darkBaseToken: a.base,
    darkQuoteToken: a.quote,
  })),
};
const typed = parseDeployment(JSON.parse(JSON.stringify(resolved, (_, v) => (typeof v === 'bigint' ? Number(v) : v))));
const out = `deployments/${network}.resolved.json`;
writeFileSync(out, JSON.stringify(typed, null, 2) + '\n');
console.log(`${out}: ${assets.map((a) => `${a.symbol} pool ${a.id.slice(0, 10)}… dark ${a.dark}`).join('; ')}; deployBlock ${block}`);
