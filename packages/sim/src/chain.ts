// Fork harness: viem clients against the anvil fork, the resolved deployment, and the human-readable ABIs the sim
// needs. Every address comes from deployments/unichain-sepolia.{json,resolved.json}; agents are auto-impersonated
// fork accounts (anvil_autoImpersonateAccount), so no private keys are involved.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  keccak256,
  toHex,
  type Hex,
  type Address,
  decodeEventLog,
  type Log,
} from "viem";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8555";
export const API = process.env.SIM_API ?? "http://127.0.0.1:19010";
export const RELAY = process.env.SIM_RELAY ?? "http://127.0.0.1:19210";

const chain = {
  id: 1301,
  name: "unichain-sepolia-fork",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;
export const pub = createPublicClient({ chain, transport: http(RPC, { batch: false, timeout: 60_000 }), pollingInterval: 50 });
export const wallet = createWalletClient({ chain, transport: http(RPC, { timeout: 60_000 }) });

export const manifest = JSON.parse(readFileSync(resolve(ROOT, "deployments/unichain-sepolia.json"), "utf8"));
export const resolved = JSON.parse(readFileSync(resolve(ROOT, "deployments/unichain-sepolia.resolved.json"), "utf8"));
export const DEPLOYER: Address = getAddress(resolved.deployer);
export const PROTOCOL_FEE_RECIPIENT: Address = getAddress(manifest.protocolFeeRecipient);
export const ROUTER: Address = getAddress(manifest.router);
export const FAUCET: Address = getAddress(manifest.faucet);
export const ORACLE: Address = getAddress(resolved.contracts.oracle);
export const PARITY_HOOK: Address = getAddress(manifest.assets[0].parityHook);
// ShareVault ships with the Sui payments lane (status/sui.md, final deployment); bound to the AAPL pool.
export const SHARE_VAULT: Address = getAddress(process.env.SHARE_VAULT ?? "0x76B1661dB3858b5455Ae4371291c954fa248Bd5d");

export type Wrapper = { platform: string; symbol: string; token: Address; adapter: Address; multiplier: bigint; decimals: number };
export type Asset = {
  symbol: string;
  wrappers: [Wrapper, Wrapper];
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  poolId: Hex;
  dark: Address;
  base: Address;
  quote: Address;
};
export const assets: Asset[] = resolved.assets.map((a: any) => ({
  symbol: a.symbol,
  wrappers: a.wrappers.map((w: any) => ({ ...w, token: getAddress(w.token), adapter: getAddress(w.adapter), multiplier: BigInt(w.multiplier) })),
  key: { ...a.pool.key, currency0: getAddress(a.pool.key.currency0), currency1: getAddress(a.pool.key.currency1), hooks: getAddress(a.pool.key.hooks) },
  poolId: a.pool.id,
  dark: getAddress(a.darkCrossHook),
  base: getAddress(a.darkBaseToken),
  quote: getAddress(a.darkQuoteToken),
}));

const KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const FEE = "(uint24 basePips, uint24 skewPips, uint24 totalPips, int256 skewX18, int256 postSkewX18, bool reducesImbalance)";
export const abi = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function decimals() view returns (uint8)",
    "function mint(address,uint256)",
  ]),
  router: parseAbi([
    `struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }`,
    `struct ExactInputParams { PoolKey key; bool zeroForOne; uint128 amountIn; uint128 amountOutMin; address recipient; uint256 deadline; bytes hookData; }`,
    "function swapExactIn(ExactInputParams p) returns (uint256)",
  ]),
  hook: parseAbi([
    `function quote(${KEY} key, bool zeroForOne, int256 amountSpecified) view returns ((bool fillable, uint256 amountIn, uint256 amountOut, uint256 grossOut, uint256 shares, uint256 feeAmount, ${FEE} fee))`,
    `function feeBreakdown(${KEY} key) view returns (${FEE})`,
    "function inventory(address) view returns (uint256)",
    "function inventoryShares(address) view returns (uint256)",
    "function baseFeePips() view returns (uint24)",
    "function depositInventory(address currency, uint256 amount)",
    "function isKeeper(address) view returns (bool)",
    "function setKeeper(address,bool)",
    "event Converted(bytes32 indexed asset, address indexed from, address indexed to, address sender, address recipient, uint256 amountIn, uint256 sharesOut, uint256 baseFee, uint256 skewFee, int256 postSkew)",
    "event InventoryFill(bytes32 indexed poolId, address indexed swapper, address indexed sender, bool zeroForOne, bool exactInput, uint256 amountIn, uint256 amountOut, uint256 shares, uint256 feeAmount, uint24 feePips)",
    "event FallThrough(bytes32 indexed poolId, address indexed swapper, address indexed sender, bool zeroForOne, uint8 reason, int128 amount0, int128 amount1, uint24 feePips, uint256 deviationBpsAfter)",
  ]),
  adapter: parseAbi(["function sharesPerToken() view returns (uint256)"]),
  oracle: parseAbi([
    "function getMid(address,address) view returns (uint256, uint64)",
    "function setMid(address,address,uint256)",
    "function setPusher(address,bool)",
  ]),
  dark: parseAbi([
    "function currentBatch() view returns (uint256 batchId, uint8 phase, uint256 phaseEndsBlock)",
    "function commitHashOf(uint256,address,bool,uint256,uint256,address,bytes32) view returns (bytes32)",
    "function fund(address,uint256)",
    "function withdraw(address,uint256)",
    "function commit(bytes32,address,uint256,bytes32) returns (bool)",
    "function reveal(bool,uint256,uint256,address,bytes32)",
    "function settle(uint256)",
    "function settled(uint256) view returns (bool)",
    "function balances(address,address) view returns (uint256 available, uint256 locked)",
    "function CROSS_FEE_PIPS() view returns (uint24)",
    "function protocolFeeRecipient() view returns (address)",
    "event Crossed(uint256 indexed batchId, bytes32 indexed asset, uint256 matchedShares, uint256 midpoint, uint256 protocolFee)",
    "event CrossFilled(uint256 indexed batchId, address indexed trader, address indexed recipient, bool sellBase, uint256 amountIn, uint256 amountOut, uint256 fee)",
    "event ResidualFilled(uint256 indexed batchId, address indexed user, uint256 shares, uint256 baseFee, uint256 skewFee)",
    "event Unfilled(uint256 indexed batchId, address indexed user, uint256 sharesRefunded)",
    "event ResidualSkipped(uint256 indexed batchId, address indexed trader, bytes reason)",
    "event BatchSettled(uint256 indexed batchId, uint256 midX18, uint64 midUpdatedAt, uint256 crossedBase, uint256 crossedQuote, uint256 residualBaseIn, uint256 residualQuoteIn, uint32 participants)",
  ]),
  faucet: parseAbi([
    "function claim()",
    "function tokens() view returns (address[])",
    "function amountOf(address) view returns (uint256)",
    "function nextClaimAt(address) view returns (uint256)",
    "function COOLDOWN() view returns (uint256)",
    "error CooldownActive(uint256 secondsRemaining)",
  ]),
  vault: parseAbi([
    "struct Withdrawal { bytes32 commitment; address recipient; address targetIssuerToken; uint256 shares; uint256 maxFeeBps; }",
    "function deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) returns (uint256)",
    "function settleWithdrawals(Withdrawal[] ws, bytes auth)",
    "function reserves() view returns (uint256 held, uint256 outstanding)",
    "function quoteWithdrawal(address target, uint256 shares) view returns (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct)",
    "function setKeeper(address,bool)",
    "function owner() view returns (address)",
    "event Deposited(bytes32 indexed commitment, address indexed issuerToken, uint256 amount, uint256 shares, bytes32 suiRecipientTag)",
    "event WithdrawalSettled(bytes32 indexed commitment, address indexed recipient, address indexed targetIssuerToken, address sourceIssuerToken, uint256 amountIn, uint256 amountOut, uint256 sharesDebited)",
    "event WithdrawalSkipped(bytes32 indexed commitment, bytes reason)",
  ]),
};

export const ONE = 10n ** 18n;
export const toSharesDown = (amount: bigint, spt: bigint, dec: number) => (amount * spt) / 10n ** BigInt(dec);
export const fromSharesDown = (shares: bigint, spt: bigint, dec: number) => (shares * 10n ** BigInt(dec)) / spt;
export const sharesToRaw = (w: Wrapper, shares: number) => fromSharesDown(BigInt(Math.round(shares * 1e6)) * 10n ** 12n, w.multiplier, w.decimals);
export const fmt = (x18: bigint, dp = 4) => (Number(x18) / 1e18).toFixed(dp);

export async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw Error(`${method}: ${j.error.message}`);
  return j.result;
}
export const mine = (n: number) => rpc("anvil_mine", [toHex(n)]);
export const increaseTime = (s: number) => rpc("evm_increaseTime", [toHex(s)]);
export const setBalance = (a: Address, wei: bigint) => rpc("anvil_setBalance", [a, toHex(wei)]);

/// Deterministic agent address: keccak("wrapswap-sim:<name>") truncated. Fork-only; the node auto-impersonates it.
export const agentAddress = (name: string): Address => getAddress(("0x" + keccak256(toHex(`wrapswap-sim:${name}`)).slice(26)) as Hex);

export async function send(from: Address, address: Address, abiDef: any, functionName: string, args: any[] = [], gas?: bigint) {
  const hash = await wallet.writeContract({ account: from, address, abi: abiDef, functionName, args, chain, ...(gas ? { gas } : {}) } as any);
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== "success") throw Error(`${functionName} reverted: ${hash}`);
  return receipt;
}
/// Simulates first so a revert surfaces its decoded error name instead of a bare status.
export async function call(from: Address, address: Address, abiDef: any, functionName: string, args: any[] = [], gas?: bigint) {
  try {
    await pub.simulateContract({ account: from, address, abi: abiDef, functionName, args } as any);
  } catch (e: any) {
    const d = e.walk?.((x: any) => x?.data?.errorName)?.data;
    const why = d ? `${d.errorName}(${(d.args ?? []).join(", ")})` : String(e.shortMessage ?? e.message).split("\n")[0];
    throw Error(`${functionName} reverts: ${why}`);
  }
  return send(from, address, abiDef, functionName, args, gas);
}
export const read = <T = any>(address: Address, abiDef: any, functionName: string, args: any[] = []) =>
  pub.readContract({ address, abi: abiDef, functionName, args } as any) as Promise<T>;

export function events(logs: Log[], abiDef: any, address?: Address) {
  const out: { eventName: string; args: any; address: Address; txHash: Hex }[] = [];
  for (const l of logs) {
    if (address && getAddress(l.address) !== address) continue;
    try {
      const d: any = decodeEventLog({ abi: abiDef, data: l.data, topics: (l as any).topics });
      out.push({ eventName: d.eventName, args: d.args, address: getAddress(l.address), txHash: l.transactionHash as Hex });
    } catch {
      /* other event */
    }
  }
  return out;
}

export async function impersonateDeployer() {
  await rpc("anvil_autoImpersonateAccount", [true]);
  await setBalance(DEPLOYER, 10n ** 21n);
}
export async function mintTo(to: Address, w: Wrapper, rawAmount: bigint) {
  return send(DEPLOYER, w.token, abi.erc20, "mint", [to, rawAmount]);
}
export async function sptOf(w: Wrapper): Promise<bigint> {
  return read<bigint>(w.adapter, abi.adapter, "sharesPerToken");
}
/// Mock oracle mid for the Dark Cross pair, parity at the adapters' live ratios (what the crank pushes in mock mode).
export async function pushParityMid(a: Asset) {
  const [b, q] = [a.wrappers.find((w) => w.token === a.base)!, a.wrappers.find((w) => w.token === a.quote)!];
  const [sb, sq] = await Promise.all([sptOf(b), sptOf(q)]);
  const mid = (sb * ONE) / sq; // canonical.parityPriceX18 (whole-token price), as the crank pushes it
  await send(DEPLOYER, ORACLE, abi.oracle, "setMid", [a.base, a.quote, mid]);
  return mid;
}
export async function inventoryShares(a: Asset) {
  const r = await Promise.all(a.wrappers.map(async (w) => toSharesDown(await read<bigint>(PARITY_HOOK, abi.hook, "inventory", [w.token]), w.multiplier, w.decimals)));
  return r as [bigint, bigint];
}
