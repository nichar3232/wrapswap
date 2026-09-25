import '../../api/src/chain/runtime.js';
import { test, expect } from "@playwright/test";
test("all implemented tabs load against the fork without browser errors", async ({
  page,
  request,
}) => {
  const health = await request.get(
    "http://127.0.0.1:" + (process.env.API_PORT || 4000) + "/health",
  );
  expect(health.ok()).toBeTruthy();
  expect((await health.json()).ok).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Convert wrappers" }),
  ).toBeVisible();
  for (const [tab, title] of [
    ["Dark pool", "Sealed batch crossing"],
    ["Backing", "Canonical backing"],
    ["Metrics", "Protocol metrics"],
    ["Convert", "Convert wrappers"],
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('demo burner approves and converts through the parity hook',async({page,request})=>{
 test.setTimeout(90000);
 const response=await request.get('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/deployments');const m=await response.json();
 test.skip(!m.demoMode||m.burners?.length!==3,'Requires seeded local burners');
 await page.goto('/');await page.getByLabel('Demo burner').selectOption(m.burners[0].address);
 await page.getByRole('combobox',{name:'From',exact:true}).selectOption(m.tokens.uAAPL.address);
 await page.getByRole('combobox',{name:'To',exact:true}).selectOption(m.tokens.issuer2.address);
 await page.getByLabel('Conversion amount').fill('0.01');
 const button=page.getByRole('button',{name:'Approve & convert',exact:true});await expect(button).toBeEnabled();
 await button.click();await expect(page.getByRole('button',{name:'Confirming…',exact:true})).toBeVisible();
 await expect(button).toBeEnabled({timeout:45000});await expect(page.getByRole('status')).toContainText('Confirmed 0x');
 await expect(page.getByRole('cell',{name:'Hook',exact:true}).first()).toBeVisible({timeout:15000});
});

// These controls execute signed transactions against the seeded local fork.
// The phase test owns mining temporarily and always restores the demo's 2s interval.
import {createPublicClient, http, parseAbi, type Address} from 'viem';
import type {APIRequestContext, Page, Locator} from '@playwright/test';
const chain=createPublicClient({transport:http(process.env.LOCAL_RPC||'http://127.0.0.1:8545')});
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
const batchAbi=parseAbi(['function currentBatch() view returns(uint256,uint8,uint256)','function balances(address,address) view returns(uint256 available,uint256 locked)']);
async function deployment(request:APIRequestContext){
 const base='http://127.0.0.1:'+(process.env.API_PORT||4000);
 await expect.poll(async()=>{try{const response=await request.get(base+'/health');return response.ok()&&(await response.json()).ok}catch{return false}},{timeout:120000}).toBe(true);
 let m:any;
 await expect.poll(async()=>{const response=await request.get(base+'/deployments');m=await response.json();return m.demoMode&&m.burners?.length===3},{timeout:120000}).toBe(true);
 return m;
}
async function selectBurner(page:Page,m:any,index=0){await page.goto('/');await page.getByRole('combobox',{name:'Demo burner'}).selectOption(m.burners[index].address)}
async function balance(token:Address,trader:Address){return chain.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[trader]})}
async function confirmed(page:Page,button:Locator){
 const dismiss=page.getByRole('button',{name:'Dismiss notification'});if(await dismiss.count())await dismiss.click();
 await expect(button).toBeEnabled();await button.click();
 await expect(page.getByRole('status')).toContainText('Confirmed 0x',{timeout:45000});
 // Multi-transaction controls can confirm approval before their final transaction.
 await expect(button).toBeEnabled({timeout:45000});
 await expect(page.getByRole('status')).toContainText('Confirmed 0x');
}
async function rpc(method:string,params:unknown[]=[]){
 const response=await fetch(process.env.LOCAL_RPC||'http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const json=await response.json();if(json.error)throw Error(JSON.stringify(json.error));return json.result;
}

test('Backing controls mint shares and redeem the issuer with the retained fee',async({page,request})=>{
 test.setTimeout(150000);const m=await deployment(request);const trader=m.burners[0].address as Address;
 await selectBurner(page,m);await page.getByRole('button',{name:'Backing',exact:true}).click();
 await page.getByRole('combobox',{name:'Issuer',exact:true}).selectOption(m.tokens.issuer1.address);
 const beforeShares=await balance(m.tokens.uAAPL.address,trader);const beforeIssuer=await balance(m.tokens.issuer1.address,trader);
 const q=10n**BigInt(m.tokens.issuer1.decimals)/100n;
 await page.getByRole('textbox',{name:m.tokens.issuer1.symbol+' amount',exact:true}).fill('0.01');
 await confirmed(page,page.getByRole('button',{name:'Mint',exact:true}));
 const minted=(await balance(m.tokens.uAAPL.address,trader))-beforeShares;
 expect(minted).toBeGreaterThan(0n);expect(await balance(m.tokens.issuer1.address,trader)).toBe(beforeIssuer-q);
 await page.getByRole('combobox',{name:'Operation',exact:true}).selectOption('redeem');
 await page.getByRole('textbox',{name:'uAAPL amount',exact:true}).fill('0.001');
 const beforeRedeem=await balance(m.tokens.uAAPL.address,trader);
 await confirmed(page,page.getByRole('button',{name:'Redeem',exact:true}));
 expect(await balance(m.tokens.uAAPL.address,trader)).toBe(beforeRedeem-10n**15n);
 expect(await balance(m.tokens.issuer1.address,trader)).toBeGreaterThan(beforeIssuer-q);
 expect(await balance(m.tokens.issuer1.address,trader)).toBeLessThan(beforeIssuer);
 await expect(page.getByText('Fully backed',{exact:true})).toBeVisible();
});

test('Dark escrow controls deposit and withdraw real tokens',async({page,request})=>{
 test.setTimeout(150000);const m=await deployment(request);const trader=m.burners[1].address as Address;const token=m.tokens.USDC.address as Address;
 const escrow=()=>chain.readContract({address:m.contracts.darkCrossHook,abi:batchAbi,functionName:'balances',args:[trader,token]});
 await selectBurner(page,m,1);await page.getByRole('button',{name:'Dark pool',exact:true}).click();
 const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'Escrow',exact:true})});
 await panel.getByRole('combobox',{name:'Currency',exact:true}).selectOption(token);
 await panel.getByRole('textbox',{name:'Amount',exact:true}).fill('0.01');
 const beforeWallet=await balance(token,trader),beforeEscrow=await escrow();
 await confirmed(page,panel.getByRole('button',{name:'Deposit',exact:true}));
 expect(await balance(token,trader)).toBe(beforeWallet-10000n);expect((await escrow())[0]).toBe(beforeEscrow[0]+10000n);
 await confirmed(page,panel.getByRole('button',{name:'Withdraw',exact:true}));
 expect(await balance(token,trader)).toBe(beforeWallet);expect(await escrow()).toEqual(beforeEscrow);
});

test('Dark sealed order commits and automatically reveals when Anvil advances phase',async({page,request})=>{
 test.setTimeout(150000);const m=await deployment(request);const trader=m.burners[2].address as Address;
 const current=()=>chain.readContract({address:m.contracts.darkCrossHook,abi:batchAbi,functionName:'currentBatch'});
 await rpc('anvil_setIntervalMining',[0]);await rpc('anvil_setAutomine',[true]);
 try{
  const [,phase,end]=await current();const head=await chain.getBlockNumber({cacheTime:0});
  const next=end+(phase===0?8n:phase===1?2n:0n);
  await rpc('anvil_mine',['0x'+(next-head).toString(16)]);
  const [id]=await current();
  await selectBurner(page,m,2);await page.getByRole('button',{name:'Dark pool',exact:true}).click();
  await expect(page.getByRole('heading',{name:new RegExp('^Batch '+id+' ')})).toBeVisible();
  await page.getByRole('combobox',{name:'Side',exact:true}).selectOption('sell');
  await page.getByRole('textbox',{name:'Quantity',exact:true}).fill('0.01');
  await page.getByRole('textbox',{name:'Limit USD',exact:true}).fill('1');
  await page.getByRole('checkbox',{name:'Route residual to lit pool'}).uncheck();
  await expect(page.getByRole('checkbox',{name:'Auto-reveal while this page is open'})).toBeChecked();
  await confirmed(page,page.getByRole('button',{name:'Commit sealed order',exact:true}));
  const savedKey=`wrapswap:orders:${trader.toLowerCase()}:${id}`;
  const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!),savedKey);
  expect(saved.qty).toBe('10000000000000000');expect(saved.isBuy).toBe(false);expect(saved.revealed).not.toBe(true);
  const [,phaseAfter,endsAfter]=await current();expect(phaseAfter).toBe(0);
  const now=await chain.getBlockNumber({cacheTime:0});await rpc('anvil_mine',['0x'+(endsAfter-now).toString(16)]);
  await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).revealed,savedKey),{timeout:30000}).toBe(true);
  const row=page.getByRole('row').filter({has:page.getByRole('cell',{name:id.toString(),exact:true})}).filter({has:page.getByRole('cell',{name:'Yes',exact:true})});
  await expect(row).toBeVisible({timeout:15000});await expect(row.getByRole('cell',{name:'Sell',exact:true})).toBeVisible();
 }finally{await rpc('anvil_setAutomine',[true]);await rpc('anvil_setIntervalMining',[2])}
});
