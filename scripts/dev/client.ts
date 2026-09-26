import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { parseDeployment, abis } from '@wrapswap/types';
export const network = process.env.NETWORK || 'anvil';
export const deployment = () => parseDeployment(JSON.parse(readFileSync(`deployments/${network}.json`, 'utf8')));
export const rpc = process.env.RPC_URL || `http://127.0.0.1:${process.env.ANVIL_PORT || 18508}`;
export const chain = createPublicClient({transport:http(rpc)});
export const account = (index:number) => mnemonicToAccount(process.env.DEMO_MNEMONIC || 'test test test test test test test test test test test junk', {addressIndex:index});
export const wallet = (index:number) => createWalletClient({account:account(index),transport:http(rpc)});
export const read = async (contract:string, name:string, args:readonly unknown[] = [], blockNumber?:bigint):Promise<any> => {
  const d = deployment();
  const map = {parityHook:'IParityHook',darkCrossHook:'IDarkCrossHook',eligibility:'IEligibility',oracle:'IMockPriceOracle'} as const;
  return chain.readContract({address:d.contracts[contract], abi:abis[map[contract]], functionName:name, args, blockNumber} as any);
};
export async function rpcCall(method:string, params:unknown[] = []) { return chain.request({method,params} as any); }
export async function write(index:number,address:string,abi:any,name:string,args:readonly unknown[]=[]) {
  const hash = await wallet(index).writeContract({address,abi,functionName:name,args,chain:null,gas:3000000n,gasPrice:1000000000n} as any);
  const receipt = await chain.waitForTransactionReceipt({hash});
  if(receipt.status !== 'success') throw Error(`${name} reverted: ${hash}`);
  return hash;
}
