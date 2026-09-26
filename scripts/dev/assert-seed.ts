import assert from 'node:assert/strict';
import { DEMO, abis } from '@wrapswap/types';
import { deployment, read, chain, account } from './client.js';
const d = deployment();
for (const token of d.tokens) {
  assert.equal((await read('parityHook','inventory',[token.address])).toString(), DEMO.inventory[token.symbol].toString());
  const balance = await chain.readContract({address:token.address,abi:abis.IMockIssuerToken,functionName:'balanceOf',args:[account(1).address]});
  assert.equal(balance.toString(),DEMO.balances.demo[token.symbol].toString());
}
assert.equal(await read('eligibility','demoMode'),true);
const fee = await read('parityHook','feeBreakdown',[d.pool.key]);
assert.equal(fee.totalPips,DEMO.variants.anvil.parityFill.feePips);
assert.equal((await chain.getBlock()).timestamp,BigInt(DEMO.variants.anvil.warpTimestamp));
console.log('Exact ANVIL seed balances, inventory, fee, eligibility and timestamp verified');
const base=d.tokens.find(x=>x.symbol==='mcbAAPL')!;
const quote=d.tokens.find(x=>x.symbol==='mAAPLx')!;
const [batch]=await read('darkCrossHook','currentBatch');
assert.equal(await read('darkCrossHook','settled',[batch]),false);
assert.deepEqual((await read('darkCrossHook','participants',[batch])).map((x:string)=>x.toLowerCase()),[account(2).address,account(3).address].map(x=>x.toLowerCase()));
for(const [index,name,token] of [[2,'counterpartyA',base],[3,'counterpartyB',quote]] as const){
  const expected=DEMO.dark.orders[name];
  const order=await read('darkCrossHook','order',[batch,account(index).address]);
  assert.equal(order.locked,expected.amountIn);
  assert.equal(order.revealed,false);
  const balance=await chain.readContract({address:token.address,abi:abis.IMockIssuerToken,functionName:'balanceOf',args:[account(index).address]});
  assert.equal(balance,DEMO.balances[name][token.symbol]-expected.amountIn);
}
assert.equal((await read('oracle','getMid',[base.address,quote.address]))[0],DEMO.dark.oracleMidX18);
const pool=await (await fetch(`http://127.0.0.1:${process.env.API_PORT}/pool`)).json();
assert.ok(BigInt(pool.liquidity)>0n,'LP fall-through liquidity');
assert.equal(pool.sqrtPriceX96,d.pool.initSqrtPriceX96);
console.log('Pending counterparties, oracle midpoint and parity LP verified');
