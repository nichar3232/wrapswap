import { test, expect } from '@playwright/test';
import { formatUnits } from 'viem';
import { mkdirSync,writeFileSync } from 'node:fs';
import { api,webURL,injectWallet,inventoryMatchesChain,waitHead,revealBoth,deployment,read,chain,account,abis,DEMO } from './support.js';

test('Part A: issuer conversion, inventory fill, dark cross and residual', async({page})=>{
  test.setTimeout(90000);
  const d=deployment(); // Missing/legacy deployment fails before any browser actions.
  const v=DEMO.variants.anvil;
  await injectWallet(page);
  await page.goto(webURL);
  await page.getByRole('button',{name:'Convert',exact:true}).click();
  await page.getByRole('button',{name:/connect wallet/i}).click();
  await page.getByLabel('Conversion amount').fill(formatUnits(DEMO.parityFill.amountIn,DEMO.tokens.mcbAAPL.decimals));
  await expect(page.getByText('PARITY',{exact:true})).toBeVisible();
  await expect(page.getByTestId('fee-breakdown').getByText(new RegExp(v.parityFill.feeBps.replace('.', '\\.')+'\\s*bps'))).toBeVisible();
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
  const convert=page.getByRole('button',{name:/^convert through parityhook$/i});
  await page.getByRole('button',{name:/^approve token$/i}).click();
  await expect(convert).toBeEnabled({timeout:30000});
  await convert.click();
  await expect(page.getByText(/conversion confirmed/i)).toBeVisible({timeout:30000});
  await expect.poll(async()=> (await chain.readContract({address:base.address,abi:abis.IMockIssuerToken,functionName:'balanceOf',args:[account(1).address]})).toString()).toBe(v.end.demoMcbAAPL.toString());
  await waitHead();
  const fills=await api('/fills','FillListResponse');
  const fill=fills.items.find((x:any)=>x.kind==='PARITY');
  expect(fill?.amountOut).toBe(v.parityFill.amountOut.toString());
  let inv=await inventoryMatchesChain();
  const sign=base.address.toLowerCase()===d.pool.key.currency0.toLowerCase()?1n:-1n;
  expect(inv.skewX18).toBe((DEMO.skewX18.afterParityFill*sign).toString());
  await page.getByRole('button',{name:'Pool',exact:true}).click();
  await expect(page.getByText(/19(?:\.0+)?\s*%/).first()).toBeVisible(); // header badge and Pool label both show skew
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
  expect(inv.skewX18).toBe((DEMO.skewX18.afterDarkResidual*sign).toString());
  expect(await read('parityHook','feesAccrued',[quote.address])).toBe(v.end.hookFeesMAAPLx);
  expect((await read('darkCrossHook','balances',[account(2).address,quote.address]))[0]).toBe(v.end.counterpartyAEscrowMAAPLx);
  expect((await read('darkCrossHook','balances',[account(3).address,base.address]))[0]).toBe(v.end.counterpartyBEscrowMcbAAPL);
  expect(await chain.readContract({address:quote.address,abi:abis.IMockIssuerToken,functionName:'balanceOf',args:[account(1).address]})).toBe(v.end.demoMAAPLx);
  await page.getByRole('button',{name:/dark/i}).click();
  await expect(page.getByText(/cross/i).first()).toBeVisible();
  await expect(page.getByText(/residual/i).first()).toBeVisible();
  mkdirSync('logs/integration',{recursive:true});
  // Complete response bodies are compared, including block numbers, timestamps and tx hashes.
  writeFileSync(`logs/integration/run-${process.env.DEMO_RUN||'1'}.json`,JSON.stringify({before,fills,detail,inventory:inv},null,2));
});
