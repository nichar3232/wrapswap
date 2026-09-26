import { parseAbiItem } from 'viem';
import { deployment,chain,account } from './client.js';
const d=deployment();
const head=await chain.getBlockNumber();
const found=new Map<string,Set<string>>();
for(let start=BigInt(d.startBlock);start<=head;start+=2000n){
  const logs=await chain.getLogs({address:d.contracts.darkCrossHook,event:parseAbiItem('event Committed(uint256 indexed batchId,address indexed trader,bytes32 commitHash,address lockToken,uint256 locked)'),fromBlock:start,toBlock:start+1999n<head?start+1999n:head});
  for(const log of logs){
    const trader=log.args.trader?.toLowerCase();
    if(![account(2).address,account(3).address].some(x=>x.toLowerCase()===trader))continue;
    const key=String(log.args.batchId);const set=found.get(key)||new Set<string>();set.add(trader!);found.set(key,set);
  }
}
if(found.size){
  if(found.size!==1 || [...found.values()][0].size!==2)throw Error('Partial/ambiguous seed commits already exist; inspect chain before retrying. No new commits sent.');
  console.log([...found.keys()][0]);
}else console.log('none');
