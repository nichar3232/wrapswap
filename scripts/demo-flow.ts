import '../api/src/chain/runtime.js';
import 'dotenv/config';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,parseAbi,encodeAbiParameters,keccak256,decodeEventLog,type Hex,type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const m=JSON.parse(readFileSync('deployments/local.json','utf8'));
const rpc=process.env.LOCAL_RPC||'http://127.0.0.1:8545';
assert(/^http:\/\/(localhost|127\.0\.0\.1):/.test(rpc)&&m.demoMode,'demo requires localhost');
const pc=createPublicClient({transport:http(rpc),pollingInterval:250});
const owner=createWalletClient({account:privateKeyToAccount(process.env.DEPLOYER_PK as Hex),transport:http(rpc)});
const wallets=m.burners.map((b:any)=>createWalletClient({account:privateKeyToAccount(b.privateKey),transport:http(rpc)}));
const abi=(name:string)=>JSON.parse(readFileSync(`deployments/abis/${name}.json`,'utf8'));
const erc=parseAbi(['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)']);
const C=m.contracts,T=m.tokens;
const receipts:{action:string,hash:string,block:string}[]=[];
async function send(w:any,address:Address,contractAbi:any,functionName:string,args:any[]=[]){const hash=await w.writeContract({chain:null,address,abi:contractAbi,functionName,args});const r=await pc.waitForTransactionReceipt({hash});assert.equal(r.status,'success',`${functionName} failed ${hash}`);console.log(`${functionName}: ${hash}`);receipts.push({action:functionName,hash,block:r.blockNumber.toString()});return r;}
async function read(address:Address,contractAbi:any,functionName:string,args:any[]=[]){return pc.readContract({address,abi:contractAbi,functionName,args}) as Promise<any>;}
function events(r:any,name:string,event:string){return r.logs.flatMap((l:any)=>{try{const d=decodeEventLog({abi:abi(name),data:l.data,topics:l.topics});return d.eventName===event?[d.args]:[]}catch{return []}});}
const request=(method:string,params:any[]=[])=>pc.request({method:method as any,params} as any);
async function mineTo(target:bigint){const current=await pc.getBlockNumber({cacheTime:0});if(target>current)await request('anvil_mine',[`0x${(target-current).toString(16)}`,'0x0']);}
async function swap(w:any,input:Address,output:Address,amount:bigint){const p=m.pools.find((p:any)=>p.kind==='parity'&&[p.key.currency0.toLowerCase(),p.key.currency1.toLowerCase()].includes(input.toLowerCase())&&[p.key.currency0.toLowerCase(),p.key.currency1.toLowerCase()].includes(output.toLowerCase()));assert(p);await send(w,input,erc,'approve',[C.swapRouter,amount]);const zero=p.key.currency0.toLowerCase()===input.toLowerCase();return send(w,C.swapRouter,abi('PoolSwapTest'),'swap',[p.key,{zeroForOne:zero,amountSpecified:-amount,sqrtPriceLimitX96:zero?4295128740n:1461446703485210103287273052203988822378723970341n},{takeClaims:false,settleUsingBurn:false},'0x']);}
await request('anvil_setIntervalMining',[0]);
await request('evm_setAutomine',[true]);
try {
 await send(wallets[0],T.issuer1.address,erc,'approve',[C.vault,10n*10n**8n]);
 const before=await read(C.vault,erc,'balanceOf',[wallets[0].account.address]);
 await send(wallets[0],C.vault,abi('CanonicalStock'),'mint',[T.issuer1.address,10n*10n**8n,wallets[0].account.address]);
 assert.equal((await read(C.vault,erc,'balanceOf',[wallets[0].account.address]))-before,10n**19n);
 const fill=await swap(wallets[0],C.vault,T.issuer2.address,10n**18n);assert(events(fill,'ParityHook','Converted').some((x:any)=>x.filledByHook===true));
 const inventory=await read(C.parityHook,abi('ParityHook'),'inventory',[T.issuer2.address]);
 await send(owner,C.parityHook,abi('ParityHook'),'withdrawInventory',[T.issuer2.address,inventory]);
 const fallback=await swap(wallets[0],C.vault,T.issuer2.address,10n**18n);assert(events(fallback,'ParityHook','Converted').some((x:any)=>x.filledByHook===false));
 await send(owner,T.issuer2.address,erc,'approve',[C.parityHook,inventory]);await send(owner,C.parityHook,abi('ParityHook'),'depositInventory',[T.issuer2.address,inventory]);
 // Ensure the initialized tick has a full 30-minute observation horizon when NYSE is closed.
 await request('evm_increaseTime',[1801]);await request('anvil_mine',['0x1']);
 const origin=await read(C.darkCrossHook,abi('DarkCrossHook'),'batchOrigin');const block=await pc.getBlockNumber({cacheTime:0});const next=(block-origin)/20n+1n;await mineTo(origin+next*20n);
 const [id]=await read(C.darkCrossHook,abi('DarkCrossHook'),'currentBatch');
 const feed=await read(C.oracle,parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']),'latestRoundData');
 const mid=BigInt(feed[1])*10n**10n;
 const orders=[{buy:true,qty:2n*10n**18n,px:mid*102n/100n,route:true},{buy:true,qty:1n*10n**18n,px:mid*102n/100n,route:false},{buy:false,qty:1n*10n**18n,px:mid*98n/100n,route:false}];
 const salts=orders.map((_,i)=>keccak256(encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[id,BigInt(i)])));
 for(let i=0;i<3;i++) {const o=orders[i];const hash=keccak256(encodeAbiParameters([{type:'bool'},{type:'uint256'},{type:'uint256'},{type:'bool'},{type:'bytes32'},{type:'uint256'},{type:'address'}],[o.buy,o.qty,o.px,o.route,salts[i],id,wallets[i].account.address]));const lock=o.buy?await read(C.darkCrossHook,abi('DarkCrossHook'),'requiredBuyLock',[o.qty,o.px]):o.qty;await send(wallets[i],C.darkCrossHook,abi('DarkCrossHook'),'commit',[hash,o.buy?T.USDC.address:C.vault,lock,`0x${'0'.repeat(64)}`]);}
 await mineTo(origin+id*20n+12n);
 for(let i=0;i<3;i++){const o=orders[i];await send(wallets[i],C.darkCrossHook,abi('DarkCrossHook'),'reveal',[o.buy,o.qty,o.px,o.route,salts[i]]);}
 await mineTo(origin+id*20n+18n);
 let receipt:any;
 for(let i=0;i<90;i++){try{const s=await (await fetch(`http://127.0.0.1:${process.env.CRANK_PORT||4001}/status`)).json() as any;if(s.lastBatch===id.toString()&&s.lastTx){receipt=await pc.getTransactionReceipt({hash:s.lastTx});break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 assert(receipt,'crank did not settle demo batch');assert.equal(receipt.status,'success');
 assert(events(receipt,'DarkCrossHook','Crossed').length===3,'three crossing events required');assert(events(receipt,'DarkCrossHook','RoutedToLit').length>=1,'residual routing event required');
 console.log(`crank settle: ${receipt.transactionHash}`);
 receipts.push({action:"crank settle",hash:receipt.transactionHash,block:receipt.blockNumber.toString()});
 writeFileSync("deployments/demo-receipts.json",JSON.stringify({chainId:m.chainId,deploymentBlock:m.blockNumber,batchId:id.toString(),crossedEvents:events(receipt,"DarkCrossHook","Crossed").length,routedEvents:events(receipt,"DarkCrossHook","RoutedToLit").length,receipts},null,2)+"\n");
 console.log('DEMO GREEN: 10 mAAPLc minted; ERC6909 parity fill; curve fallback; three-wallet cross and residual routed in one crank settlement.');
} finally {await request('anvil_setIntervalMining',[2]);}
