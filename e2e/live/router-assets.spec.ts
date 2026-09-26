import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeParityHookData } from '@wrapswap/types';
import { api, chain, account, abis } from '../support.js';
import { wallet, network } from '../../scripts/dev/client.js';

// Live Convert on every asset of the manifest (GET /assets) through WrapSwapRouter.swapExactIn, as demo account 1:
// quote via GET /quote?asset&from&to, approve, swap, then the fill must be indexed under that asset in GET /stats.
// Complements e2e/live/sepolia-convert.spec.ts (the same flow through the /app UI). Writes logs/live/router-assets.json.
test.skip(network !== 'unichain-sepolia', 'live Unichain Sepolia only');

const erc20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

test('live Convert on every asset through WrapSwapRouter', async () => {
  test.setTimeout(300000);
  const me = account(1).address;
  const deployment = await api('/deployment', 'Deployment');
  const router = deployment.contracts.wrapSwapRouter as `0x${string}`;
  const { assets } = await api('/assets', 'AssetsResponse');
  expect(assets.length).toBeGreaterThanOrEqual(3);
  // The public RPC intermittently reports a stale pending nonce; use max(latest, pending).
  // A lagging backend can also miss our own just-mined tx, so never go below the last nonce we used + 1.
  let used = -1;
  const nonce = async () => {
    const [latest, pending] = await Promise.all((['latest', 'pending'] as const).map((blockTag) =>
      chain.getTransactionCount({ address: me, blockTag })));
    used = Math.max(latest, pending, used + 1);
    return used;
  };
  const send = async (request: any) => {
    const hash = await wallet(1).writeContract({ ...request, chain: null, nonce: await nonce() });
    const receipt = await chain.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    return receipt;
  };
  const results: any[] = [];
  for (const asset of assets) {
    const from = asset.platforms.find((p: any) => p.issuer === 'coinbase')!;
    const to = asset.platforms.find((p: any) => p.issuer === 'xstocks')!;
    const amount = 10n * 10n ** BigInt(from.decimals);
    const before = await api(`/stats?address=${me}`, 'StatsResponse');
    const fillsBefore = before.byAsset.find((a: any) => a.asset === asset.asset)?.fills ?? 0;
    const q = await api(`/quote?asset=${asset.asset}&from=${from.symbol}&to=${to.symbol}&amount=${amount}`, 'QuoteResponse');
    expect(q.asset).toBe(asset.asset);
    expect(q.poolId).toBe(asset.pools[0].poolId);
    const approve = await send({ address: from.address, abi: erc20, functionName: 'approve', args: [router, amount] });
    const block = await chain.getBlock();
    const swap = await send({
      address: router,
      abi: abis.IWrapSwapRouter,
      functionName: 'swapExactIn',
      args: [{
        key: (({ poolId, ...key }) => key)(asset.pools[0]),
        zeroForOne: q.zeroForOne,
        amountIn: amount,
        amountOutMin: (BigInt(q.amountOut) * 995n) / 1000n,
        recipient: me,
        deadline: block.timestamp + 600n,
        hookData: encodeParityHookData({ swapper: me }),
      }],
    });
    expect(swap.to?.toLowerCase()).toBe(router.toLowerCase());
    // Indexed under this asset (the indexer confirms 2 blocks behind head).
    await expect.poll(async () =>
      (await api(`/stats?address=${me}`, 'StatsResponse')).byAsset.find((a: any) => a.asset === asset.asset)?.fills ?? 0,
    { timeout: 90000, intervals: [3000] }).toBeGreaterThan(fillsBefore);
    results.push({ asset: asset.asset, from: from.symbol, to: to.symbol, amountIn: amount.toString(), quotedOut: q.amountOut,
      feeBps: q.fee.totalBps, youKeep: q.youKeep, approveTx: approve.transactionHash, swapTx: swap.transactionHash,
      block: swap.blockNumber.toString() });
  }
  mkdirSync('logs/live', { recursive: true });
  writeFileSync('logs/live/router-assets.json', JSON.stringify(results, null, 2));
});
