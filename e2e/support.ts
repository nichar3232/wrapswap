import { expect, type Page } from '@playwright/test';
import { abis, validate, DEMO } from '@wrapswap/types';
import { deployment, chain, read, account, wallet, rpcCall, write } from '../scripts/dev/client.js';
export { deployment, chain, read, account, rpcCall, write, abis, DEMO };
export const apiURL = `http://127.0.0.1:${process.env.API_PORT || 18008}`;
export const webURL = `http://127.0.0.1:${process.env.WEB_PORT || 13008}`;
export async function api(path:string,schema:any) {
  const response = await fetch(apiURL+path);
  expect(response.status,`${path}: backend boundary`).toBe(200);
  const body=await response.json();
  expect(validate(schema,body),`${path}: frozen schema`).toEqual([]);
  return body;
}
export async function waitHead() {
  await expect.poll(async()=>{const h=await api('/health','HealthResponse');return h.ok && h.indexedBlock===h.headBlock;},{timeout:30000}).toBe(true);
}
export async function injectWallet(page:Page) {
  await page.exposeFunction('demoRPC', async ({method,params=[]}:any) => {
    if(method==='eth_accounts'||method==='eth_requestAccounts')return [account(1).address];
    if(method==='wallet_switchEthereumChain')return null;
    if(method==='eth_sendTransaction') {
      const tx=params[0];
      return wallet(1).sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value||0),gas:3000000n,gasPrice:1000000000n,chain:null});
    }
    return rpcCall(method,params);
  });
  await page.addInitScript(()=>{
    const listeners=new Map();
    (window as any).ethereum={isMetaMask:true,request:(args:any)=>(window as any).demoRPC(args),on:(event:any,fn:any)=>listeners.set(event,fn),removeListener:(event:any)=>listeners.delete(event)};
  });
}
export async function inventoryMatchesChain() {
  const inventory=await api('/inventory','InventoryResponse');
  for(const token of inventory.tokens)for(const field of ['inventory','inventoryShares','feesAccrued']) {
    expect(token[field]).toBe((await read('parityHook',field,[token.address],BigInt(inventory.block))).toString());
  }
  return inventory;
}
export async function advanceToReveal() {
  for(let i=0;i<20;i++) {
    const [,phase]=await read('darkCrossHook','currentBatch');
    if(phase===1)return;
    if(phase===2)throw Error('Harness missed reveal phase');
    await rpcCall('anvil_mine',['0x1']);
  }
  throw Error('No reveal phase');
}
export async function revealBoth() {
  const d=deployment();
  await advanceToReveal();
  for(const [index,name] of [[2,'counterpartyA'],[3,'counterpartyB']] as const) {
    const order=DEMO.dark.orders[name];
    await write(index,d.contracts.darkCrossHook,abis.IDarkCrossHook,'reveal',[order.sellBase,order.amountIn,order.limitPriceX18,order.routeResidual,`0x${index.toString(16).padStart(64,'0')}`]);
  }
  while((await read('darkCrossHook','currentBatch'))[1]!==2)await rpcCall('anvil_mine',['0x1']);
}
