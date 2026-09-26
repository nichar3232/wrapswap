import { test, expect } from '@playwright/test';
import { formatUnits } from 'viem';
import { mkdirSync, writeFileSync } from 'node:fs';
import { api, webURL, deployment, chain, account, abis, DEMO } from '../support.js';
import { wallet, network } from '../../scripts/dev/client.js';

// Live Convert on Unichain Sepolia through the web UI and WrapSwapRouter (INTERFACES.md §13), as demo account index 1.
// Run against a local stack started with NETWORK=unichain-sepolia; writes logs/sepolia/live-swap.json.
test.skip(network !== 'unichain-sepolia', 'live Unichain Sepolia only');

test('live Convert: approve then swapExactIn through WrapSwapRouter', async ({ page }) => {
  test.setTimeout(180000);
  const d = deployment();
  const base = d.tokens.find((x) => x.symbol === 'mcbAAPL')!;
  const quote = d.tokens.find((x) => x.symbol === 'mAAPLx')!;
  const hashes: string[] = [];
  await page.exposeFunction('demoRPC', async ({ method, params = [] }: any) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account(1).address];
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      // Network fees are estimated: the demo account holds only a small Sepolia gas top-up.
      // The public Unichain RPC intermittently reports a stale pending nonce (0); use max(latest, pending).
      const [latest, pending] = await Promise.all((['latest', 'pending'] as const).map((blockTag) =>
        chain.getTransactionCount({ address: account(1).address, blockTag })));
      // A just-mined approve can be missing on the backend that estimates gas for the next tx: retry briefly.
      let hash: `0x${string}` | undefined;
      for (let attempt = 0; !hash; attempt++)
        try {
          hash = await wallet(1).sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0), chain: null, nonce: Math.max(latest, pending) });
        } catch (e) {
          if (attempt >= 5) throw e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      hashes.push(hash);
      return hash;
    }
    return chain.request({ method, params } as any);
  });
  await page.addInitScript(() => {
    (window as any).ethereum = { request: (a: any) => (window as any).demoRPC(a), on: () => {}, removeListener: () => {} };
  });
  const balance = (t: string) =>
    chain.readContract({ address: t as `0x${string}`, abi: abis.IMockIssuerToken, functionName: 'balanceOf', args: [account(1).address] });
  const [baseBefore, quoteBefore] = [await balance(base.address), await balance(quote.address)];
  const q = await api(`/quote?tokenIn=${base.address}&tokenOut=${quote.address}&amount=${DEMO.parityFill.amountIn}&kind=exactIn`, 'QuoteResponse');

  const pane = page.locator('#pane-convert');
  await page.goto(webURL+'/app?tab=move&asset=AAPL');
  await page.getByRole('button', { name: /connect wallet/i }).click();
  await pane.getByRole('radio', { name: /Coinbase/ }).click();
  await pane.getByLabel('Amount', { exact: true }).fill(formatUnits(DEMO.parityFill.amountIn, base.decimals));
  await expect(pane.getByTestId('you-keep')).toContainText('→', { timeout: 30000 });
  const convert = pane.getByRole('button', { name: /^(approve and )?convert$/i });
  await expect(convert).toBeEnabled({ timeout: 30000 });
  await convert.click(); // approval then swapExactIn
  await expect(pane.getByText(/^\s*Converted\b/)).toBeVisible({ timeout: 90000 });

  const swapTx = hashes.at(-1)!;
  const receipt = await chain.getTransactionReceipt({ hash: swapTx as `0x${string}` });
  expect(receipt.status).toBe('success');
  expect(receipt.to?.toLowerCase()).toBe(d.contracts.wrapSwapRouter!.toLowerCase());
  // Public RPC backends lag each other: poll until one read shows both post-swap balances, and keep that read.
  let baseAfter = baseBefore, quoteAfter = quoteBefore;
  await expect.poll(async () => {
    [baseAfter, quoteAfter] = [await balance(base.address), await balance(quote.address)];
    return baseBefore - baseAfter === DEMO.parityFill.amountIn && quoteAfter > quoteBefore;
  }, { timeout: 30000 }).toBe(true);
  const received = quoteAfter - quoteBefore;
  expect(received >= (BigInt(q.amountOut) * 995n) / 1000n).toBe(true);
  mkdirSync('logs/sepolia', { recursive: true });
  writeFileSync('logs/sepolia/live-swap.json', JSON.stringify({
    approveTx: hashes[0], swapTx, block: receipt.blockNumber.toString(), router: d.contracts.wrapSwapRouter,
    amountIn: DEMO.parityFill.amountIn.toString(), amountOut: received.toString(), quotedOut: q.amountOut, feePips: q.fee.totalPips,
  }, null, 2));
});
