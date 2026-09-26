// Unichain Sepolia side: ShareVault reads, Deposited scanning and withdrawal settlement.
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unichainSepolia } from 'viem/chains';
import { evmKeeperKey, evmRpcUrl } from './config.js';

export const shareVaultAbi = parseAbi([
  'event Deposited(bytes32 indexed commitment, address indexed issuerToken, uint256 amount, uint256 shares, bytes32 suiRecipientTag)',
  'event WithdrawalSettled(bytes32 indexed commitment, address indexed recipient, address indexed targetIssuerToken, address sourceIssuerToken, uint256 amountIn, uint256 amountOut, uint256 sharesDebited)',
  'event WithdrawalSkipped(bytes32 indexed commitment, bytes reason)',
  'event SettlementBatch(bytes32 indexed authHash, uint256 count, uint256 settled, uint256 sharesDebited)',
  'struct Withdrawal { bytes32 commitment; address recipient; address targetIssuerToken; uint256 shares; uint256 maxFeeBps; }',
  'function deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) returns (uint256)',
  'function settleWithdrawals(Withdrawal[] ws, bytes auth)',
  'function reserves() view returns (uint256 held, uint256 outstanding)',
  'function sharesOutstanding() view returns (uint256)',
  'function quoteWithdrawal(address target, uint256 shares) view returns (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct)',
  'function isKeeper(address) view returns (bool)',
  'error FeeAboveMax(uint256 feePips, uint256 maxFeeBps)',
  'error NotFillable(uint256 grossOut)',
  'error InsufficientCustody(address token, uint256 held, uint256 needed)',
  'error UnsupportedIssuer(address token)',
  'error AlreadySettled(bytes32 commitment)',
  'error ZeroAmount()',
  'error ZeroRecipient()',
]);

export const erc20Abi = parseAbi([
  'function approve(address, uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
  'function mint(address, uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const publicClient = () => createPublicClient({ chain: unichainSepolia, transport: http(evmRpcUrl()) });
export const keeperWallet = () =>
  createWalletClient({ chain: unichainSepolia, transport: http(evmRpcUrl()), account: privateKeyToAccount(evmKeeperKey()) });
export const walletFor = (pk: Hex) =>
  createWalletClient({ chain: unichainSepolia, transport: http(evmRpcUrl()), account: privateKeyToAccount(pk) });

export type DepositEvent = { commitment: Hex; issuerToken: Hex; amount: bigint; shares: bigint; suiRecipientTag: Hex; txHash: Hex; logIndex: number; blockNumber: bigint };

export async function scanDeposits(vault: Hex, fromBlock: bigint, toBlock: bigint): Promise<DepositEvent[]> {
  const pc = publicClient();
  const out: DepositEvent[] = [];
  const step = 5000n;
  for (let a = fromBlock; a <= toBlock; a += step) {
    const b = a + step - 1n > toBlock ? toBlock : a + step - 1n;
    const logs = await pc.getContractEvents({ address: vault, abi: shareVaultAbi, eventName: 'Deposited', fromBlock: a, toBlock: b });
    for (const l of logs) {
      out.push({ ...(l.args as any), txHash: l.transactionHash!, logIndex: l.logIndex!, blockNumber: l.blockNumber! });
    }
  }
  return out;
}

export type SettlementResult = {
  txHash: Hex;
  settled: Map<string, { sharesDebited: bigint; amountOut: bigint; amountIn: bigint; source: Hex }>;
  skipped: Map<string, Hex>;
};

export async function settle(
  vault: Hex,
  ws: { commitment: Hex; recipient: Hex; targetIssuerToken: Hex; shares: bigint; maxFeeBps: bigint }[],
  auth: string,
): Promise<SettlementResult> {
  const wc = keeperWallet();
  const pc = publicClient();
  const txHash = await wc.writeContract({
    address: vault,
    abi: shareVaultAbi,
    functionName: 'settleWithdrawals',
    args: [ws, `0x${Buffer.from(auth).toString('hex')}`],
  });
  const rcpt = await pc.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') throw new Error(`settleWithdrawals reverted: ${txHash}`);
  const logs = parseEventLogs({ abi: shareVaultAbi, logs: rcpt.logs });
  const settled: SettlementResult['settled'] = new Map();
  const skipped: SettlementResult['skipped'] = new Map();
  for (const l of logs) {
    if (l.eventName === 'WithdrawalSettled') {
      const a = l.args;
      settled.set(a.commitment.toLowerCase(), { sharesDebited: a.sharesDebited, amountOut: a.amountOut, amountIn: a.amountIn, source: a.sourceIssuerToken });
    } else if (l.eventName === 'WithdrawalSkipped') {
      skipped.set(l.args.commitment.toLowerCase(), l.args.reason);
    }
  }
  return { txHash, settled, skipped };
}

export async function vaultReserves(vault: Hex) {
  const pc = publicClient();
  const [block, [held, outstanding]] = await Promise.all([
    pc.getBlockNumber(),
    pc.readContract({ address: vault, abi: shareVaultAbi, functionName: 'reserves' }),
  ]);
  return { held, outstanding, block };
}
