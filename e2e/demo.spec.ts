import { test, expect } from '@playwright/test';
import { canonical } from '@wrapswap/types';
import { formatUnits } from 'viem';
import { mkdirSync,writeFileSync } from 'node:fs';
import { api,webURL,injectWallet,inventoryMatchesChain,waitHead,revealBoth,deployment,read,chain,account,abis,DEMO } from './support.js';

test('Part A: issuer conversion, inventory fill, dark cross and residual', async({page})=>{
  test.setTimeout(90000);
  const d=deployment(); // Missing/legacy deployment fails before any browser actions.
  const v=DEMO.variants.anvil;
  await injectWallet(page);
  // Move flow: From (Coinbase, amount) → To → How (Instant) → Review; route and fee breakdown sit behind Details.
  const pane=page.locator('#pane-convert');
  await page.goto(webURL+'/app?tab=move&asset=AAPL');
  await page.getByRole('button',{name:/connect wallet/i}).click();
  await pane.getByRole('radio',{name:/Coinbase/}).click();
  await pane.getByLabel('Amount',{exact:true}).fill(formatUnits(DEMO.parityFill.amountIn,DEMO.tokens.mcbAAPL.decimals));
  await expect(pane.getByTestId('fee-breakdown').getByText(new RegExp(v.parityFill.feeBps.replace('.', '\\.')+'\\s*bps'))).toBeVisible();
  const base=d.tokens.find(x=>x.symbol==='mcbAAPL')!;
  const quote=d.tokens.find(x=>x.symbol==='mAAPLx')!;
  const query=`?tokenIn=${base.address}&tokenOut=${quote.address}&amount=${DEMO.parityFill.amountIn}&kind=exactIn`;
  const before=await api('/quote'+query,'QuoteResponse');
  expect(before.amountOut).toBe(v.parityFill.amountOut.toString());
  expect(before.feeAmount).toBe(v.parityFill.feeAmount.toString());
  expect(before.fee.totalPips).toBe(v.parityFill.feePips);
  const onchain=await read('parityHook','quote',[d.pool.key,base.address.toLowerCase()===d.pool.key.currency0.toLowerCase(),DEMO.parityFill.amountSpecified],BigInt(before.block));
  for(const field of ['amountIn','amountOut','grossOut','shares','feeAmount'])expect(before[field]).toBe(onchain[field].toString());
  // Live Convert: ERC-20 approval to WrapSwapRouter, then swapExactIn with the displayed minimum output (§13).
  await pane.getByRole('button',{name:/^(approve and )?convert$/i}).click(); // approval then swapExactIn, one action
  await expect(pane.getByText(/^\s*Converted\b/)).toBeVisible({timeout:30000});
  await expect.poll(async()=> (await chain.readContract({address:base.address,abi:abis.IMockIssuerToken,functionName:'balanceOf',args:[account(1).address]})).toString()).toBe(v.end.demoMcbAAPL.toString());
  await waitHead();
  const fills=await api('/fills','FillListResponse');
  const fill=fills.items.find((x:any)=>x.kind==='PARITY');
  expect(fill?.amountOut).toBe(v.parityFill.amountOut.toString());
  let inv=await inventoryMatchesChain();
  const sign=base.address.toLowerCase()===d.pool.key.currency0.toLowerCase()?1n:-1n;
  // Realised skew: fees stay in inventory, so the hook keeps amountIn and pays out only the net amountOut.
  const realised=(mcb:bigint,x:bigint)=>canonical.skewX18(
    canonical.toSharesDown(mcb,DEMO.tokens.mcbAAPL.sharesPerTokenX18,DEMO.tokens.mcbAAPL.decimals),
    canonical.toSharesDown(x,DEMO.tokens.mAAPLx.sharesPerTokenX18,DEMO.tokens.mAAPLx.decimals));
  const afterFill={mcb:DEMO.inventory.mcbAAPL+DEMO.parityFill.amountIn,x:DEMO.inventory.mAAPLx-v.parityFill.amountOut};
  expect(inv.skewX18).toBe((realised(afterFill.mcb,afterFill.x)*sign).toString());
  await page.locator('header nav').getByRole('button',{name:'Liquidity',exact:true}).click();
  await expect(page.getByText(/19(?:\.0+)?\s*%/).first()).toBeVisible(); // Liquidity shows the inventory skew
  const [batch]=await read('darkCrossHook','currentBatch');
  await revealBoth();
  await expect.poll(()=>read('darkCrossHook','settled',[batch]),{timeout:30000}).toBe(true);
  await waitHead();
  const detail=await api(`/batches/${batch}`,'BatchDetailResponse');
  const result=await read('darkCrossHook','batchResult',[batch]);
  for(const field of ['crossedBase','crossedQuote','residualBaseIn','residualQuoteIn'])expect(detail.batch[field]).toBe(result[field].toString());
  expect(result.crossedBase).toBe(DEMO.dark.crossedBase);
  expect(result.crossedQuote).toBe(DEMO.dark.crossedQuote);
  expect(detail.fills.find((x:any)=>x.kind==='DARK-RESIDUAL')?.amountOut).toBe(v.residual.amountOut.toString());
  expect(detail.skippedResiduals).toEqual([]);
  for (const [index,name] of [[2,'counterpartyA'],[3,'counterpartyB']] as const) {
    const cross=detail.fills.find((x:any)=>x.kind==='DARK-CROSS' && x.account.toLowerCase()===account(index).address.toLowerCase());
    expect(cross?.amountOut).toBe(DEMO.dark.crossOut[name].toString());
    expect(cross?.feeAmount).toBe(DEMO.dark.crossFees[name].toString());
  }
  inv=await inventoryMatchesChain();
  expect(inv.skewX18).toBe((realised(afterFill.mcb+DEMO.dark.residual.amountIn,afterFill.x-v.residual.amountOut)*sign).toString());
  // Fees stay in the hook's inventory; the indexed inventory fees (parity fill + residual, in mAAPLx) are the §10 total.
  await waitHead();
  const earned=(await api('/stats','StatsResponse')).feesEarned.tokens.find((t:any)=>t.address.toLowerCase()===quote.address.toLowerCase());
  expect(earned?.amount).toBe(v.end.hookFeesMAAPLx.toString());
  expect((await read('darkCrossHook','balances',[account(2).address,quote.address]))[0]).toBe(v.end.counterpartyAEscrowMAAPLx);
  expect((await read('darkCrossHook','balances',[account(3).address,base.address]))[0]).toBe(v.end.counterpartyBEscrowMcbAAPL);
  expect(await chain.readContract({address:quote.address,abi:abis.IMockIssuerToken,functionName:'balanceOf',args:[account(1).address]})).toBe(v.end.demoMAAPLx);
  // Sealed cross is a Move method: its option shows the cross and the residual route.
  await page.locator('header nav').getByRole('button',{name:'Move',exact:true}).click();
  await page.getByRole('tab',{name:'Dark Cross'}).click();
  await expect(page.locator('#pane-dark').getByText(/cross/i).first()).toBeVisible();
  await expect(page.locator('#pane-dark').getByText(/residual/i).first()).toBeVisible();
  mkdirSync('logs/integration',{recursive:true});
  // Complete response bodies are compared, including block numbers, timestamps and tx hashes.
  writeFileSync(`logs/integration/run-${process.env.DEMO_RUN||'1'}.json`,JSON.stringify({before,fills,detail,inventory:inv},null,2));
});
