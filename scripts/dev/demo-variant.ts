// Regenerates the INTERFACES.md §10 live-network variant from the deployment itself; the figures are never hand-typed.
// Seed block N = the block before the first ParityHook fill on the §10 pool after the hook's deploy block. At N it reads
// the seed inventory (stored as `seedInventory`; a live deploy may seed differently from the anvil narrative), adapter
// ratios and ParityHook.quote for the §10 parity fill, and requires the on-chain quote to equal the
// canonical.ts mirror. It then derives the residual and end state with the same arithmetic as
// packages/types/scripts/verify-demo.ts and rewrites the variant in INTERFACES.md.
// Usage: NETWORK=unichain-sepolia RPC_URL=… pnpm exec tsx scripts/dev/demo-variant.ts && pnpm types
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, decodeEventLog } from 'viem';
import { abis, canonical as c, topics } from '@wrapswap/types';
import { DEMO } from '../../packages/types/src/generated/demo.js';
import { deployment } from './client.js';

const network = process.env.NETWORK || 'unichain-sepolia';
if (network === 'anvil') throw Error('the anvil variant is warped and fixed; this script is for live networks');
// The typed deployment (a minimal manifest is read through its chain-resolved expansion).
const d: any = deployment();
const client = createPublicClient({ transport: http(process.env.RPC_URL || 'https://sepolia.unichain.org') });
const hook = d.contracts.parityHook as `0x${string}`;
const key = d.pool.key;
const mcbT = d.tokens.find((t: any) => t.symbol === 'mcbAAPL'), xT = d.tokens.find((t: any) => t.symbol === 'mAAPLx');
const mcbIs0 = mcbT.address.toLowerCase() === key.currency0.toLowerCase();

// 1. Seed block: the block before the first InventoryFill/FallThrough on this pool at or after the hook deploy.
const fillTopics = [topics['IParityHook.InventoryFill'], topics['IParityHook.FallThrough']];
const head = await client.getBlockNumber();
let first: bigint | undefined;
for (let from = BigInt(d.blocks.parityHook); from <= head && first === undefined; from += 2000n) {
  const logs = await client.getLogs({ address: hook, fromBlock: from, toBlock: from + 1999n > head ? head : from + 1999n });
  for (const log of logs) {
    if (!fillTopics.includes(log.topics[0] as any)) continue;
    const e: any = decodeEventLog({ abi: abis.IParityHook, data: log.data, topics: log.topics });
    if (e.args.poolId?.toLowerCase() === d.pool.id.toLowerCase()) { first = log.blockNumber; break; }
  }
}
if (first === undefined) throw Error('no fill on the §10 pool yet; the seed state is the current head');
const N = first - 1n;
const block = await client.getBlock({ blockNumber: N });
const read = (functionName: string, args: any[], address = hook, abi: any = abis.IParityHook) =>
  client.readContract({ address, abi, functionName, args, blockNumber: N }) as Promise<any>;

// 2. Seed state at N, and adapter ratios equal to §10.
const invMcb: bigint = await read('inventory', [mcbT.address]);
const invX: bigint = await read('inventory', [xT.address]);
for (const [t, spt] of [[mcbT, DEMO.tokens.mcbAAPL.sharesPerTokenX18], [xT, DEMO.tokens.mAAPLx.sharesPerTokenX18]] as const) {
  const onchainSpt = await read('sharesPerToken', [], t.adapter, abis.IWrapperAdapter);
  if (onchainSpt !== spt) throw Error(`${t.symbol} sharesPerToken at ${N} is ${onchainSpt}, §10 says ${spt}`);
}

// 3. On-chain quote for the §10 parity fill (mcbAAPL in, exact in) must equal the canonical mirror.
const mcb = { spt: DEMO.tokens.mcbAAPL.sharesPerTokenX18, decimals: DEMO.tokens.mcbAAPL.decimals };
const x = { spt: DEMO.tokens.mAAPLx.sharesPerTokenX18, decimals: DEMO.tokens.mAAPLx.decimals };
const sharesOf = (m: bigint, q: bigint) => ({ mcb: c.toSharesDown(m, mcb.spt, mcb.decimals), x: c.toSharesDown(q, x.spt, x.decimals) });
const pf = DEMO.parityFill;
const onchain: any = await read('quote', [key, mcbIs0, pf.amountSpecified]);
let s = sharesOf(invMcb, invX);
const fee1 = c.tradeFeeBreakdown(s.mcb, s.x, true, pf.shares);
const q1 = c.parityQuote(mcb, x, pf.amountSpecified, fee1.totalPips);
if (BigInt(onchain.fee.totalPips) !== fee1.totalPips || onchain.amountOut !== q1.amountOut || onchain.feeAmount !== q1.feeAmount)
  throw Error(`on-chain quote ${onchain.fee.totalPips}/${onchain.amountOut} != mirror ${fee1.totalPips}/${q1.amountOut}`);

// 4. Residual after the parity fill and the §10 dark cross, then the end state (verify-demo arithmetic).
s = sharesOf(invMcb + pf.amountIn, invX - q1.grossOut);
const r = DEMO.dark.residual;
const fee2 = c.tradeFeeBreakdown(s.mcb, s.x, true, r.shares);
const q2 = c.parityQuote(mcb, x, -r.amountIn, fee2.totalPips);
const variant = {
  network, chainId: d.chainId, warpTimestamp: null,
  seedBlock: Number(N), label: `Seed state at deploy block ${N}`,
  seedInventory: { mcbAAPL: invMcb.toString(), mAAPLx: invX.toString() },
  parityFill: { feePips: Number(fee1.totalPips), feeBps: c.pipsToBps(fee1.totalPips), feeAmount: q1.feeAmount.toString(), amountOut: q1.amountOut.toString() },
  residual: { feePips: Number(fee2.totalPips), feeBps: c.pipsToBps(fee2.totalPips), feeAmount: q2.feeAmount.toString(), amountOut: q2.amountOut.toString() },
  end: {
    demoMAAPLx: (DEMO.balances.demo.mAAPLx + q1.amountOut).toString(),
    demoMcbAAPL: (DEMO.balances.demo.mcbAAPL - q1.amountIn).toString(),
    counterpartyAEscrowMAAPLx: (DEMO.dark.crossOut.counterpartyA + q2.amountOut).toString(),
    counterpartyBEscrowMcbAAPL: DEMO.dark.crossOut.counterpartyB.toString(),
    hookFeesMAAPLx: (q1.feeAmount + q2.feeAmount).toString(),
  },
};

// 5. Rewrite the variant in the §10 wrapswap:demo block.
const path = 'INTERFACES.md';
const doc = readFileSync(path, 'utf8');
const start = doc.indexOf(`    "${network}": {`, doc.indexOf('```json wrapswap:demo'));
const end = doc.indexOf('\n    }', start) + '\n    }'.length;
if (start < 0 || end <= start) throw Error(`no "${network}" variant in the wrapswap:demo block`);
const j = (o: any) => JSON.stringify(o).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }');
const { parityFill, residual, end: endState, ...head0 } = variant;
const body = `    "${network}": {\n      ${j(head0).slice(2, -2)},\n      "parityFill": ${j(parityFill)},\n      "residual": ${j(residual)},\n      "end": ${j(endState)}\n    }`;
writeFileSync(path, doc.slice(0, start) + body + doc.slice(end));
console.log(`${network}: ${variant.label} (block time ${new Date(Number(block.timestamp) * 1000).toISOString()}); parity fill ${variant.parityFill.feeBps} bps → ${variant.parityFill.amountOut}; residual ${variant.residual.feeBps} bps`);
