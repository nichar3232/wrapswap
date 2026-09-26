import { test,expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { api,webURL,deployment,account,write,abis,rpcCall,DEMO } from '../support.js';

// Playwright's default runs cases in one file sequentially, without skipping later failures.
test.describe.configure({mode:'default'});
for(const variant of ['FALL-THROUGH','BLOCKED-PEG','NYSE-CLOSED','BLOCKED-ELIGIBILITY']) {
  test(variant,async({page})=>{
    test.setTimeout(90000);
    execFileSync('scripts/dev/reset',{stdio:'inherit'});
    const d=deployment();
    const base=d.tokens.find(x=>x.symbol==='mcbAAPL')!;
    const quote=d.tokens.find(x=>x.symbol==='mAAPLx')!;
    if(variant==='FALL-THROUGH')await write(0,d.contracts.parityHook,abis.IParityHook,'withdrawInventory',[quote.address,DEMO.inventory.mAAPLx,account(0).address]);
    if(variant==='BLOCKED-PEG')await write(0,base.address,abis.IMockIssuerToken,'setTransfersPaused',[true]);
    if(variant==='BLOCKED-ELIGIBILITY')await write(0,d.contracts.eligibility,abis.IEligibility,'setDemoMode',[false]);
    if(variant==='NYSE-CLOSED') {
      await rpcCall('evm_setNextBlockTimestamp',[1791037800]);
      await rpcCall('evm_mine');
    }
    // A small fall-through stays within the 50 bps guard with the specified LP position.
    const amount=variant==='FALL-THROUGH'?'1000000':DEMO.parityFill.amountIn.toString();
    const route=await api(`/route?tokenIn=${base.address}&tokenOut=${quote.address}&amount=${amount}&swapper=${account(1).address}&allowDark=false`,'RouteResponse');
    expect(route.route).toBe(variant==='NYSE-CLOSED'?'PARITY':variant);
    // Same anvil seed state as the open-market fill, plus the 1000-pip NYSE-closed add-on (not a live-network figure).
    if(variant==='NYSE-CLOSED')expect(route.quote.fee.totalPips).toBe(DEMO.variants.anvil.parityFill.feePips+1000);
    await page.goto(webURL);
    await page.getByRole('button',{name:'Convert',exact:true}).click();
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
}
