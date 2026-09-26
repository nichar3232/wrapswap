import fs from 'node:fs';
const pairs=[['IParityHook','ParityHook'],['IDarkCrossHook','DarkCrossHook'],['IIssuerRegistry','IssuerRegistry'],['INyseCalendar','NyseCalendar'],['IMockIssuerToken','MockB20'],['IMockIssuerToken','MockIssuerToken'],['IMockPriceOracle','MockOracle'],['IWrapperAdapter','B20Adapter'],['IWrapperAdapter','StaticAdapter'],['IEligibility','EASEligibility']];
const type=p=>p.type.startsWith('tuple')?`(${p.components.map(type).join(',')})${p.type.slice(5)}`:p.type;
const signature=x=>`${x.type} ${x.name}(${(x.inputs||[]).map(p=>type(p)+(p.indexed?' indexed':'')).join(',')})${x.type==='function'?' -> '+(x.outputs||[]).map(type).join(','):''}`;
let failed=false;
for(const [iface,impl] of pairs){
  const path=`contracts/out/${impl}.sol/${impl}.json`;
  if(!fs.existsSync(path)){console.log(`FAIL ${impl}: missing artifact ${path}`);failed=true;continue;}
  const wanted=JSON.parse(fs.readFileSync(`contracts/out/${iface}.sol/${iface}.json`)).abi;
  const actual=new Set(JSON.parse(fs.readFileSync(path)).abi.map(signature));
  const missing=wanted.filter(x=>['function','event','error'].includes(x.type)).map(signature).filter(x=>!actual.has(x));
  if(missing.length){failed=true;console.log(`FAIL contracts/src ${impl} does not implement ${iface}:\n  ${missing.join('\n  ')}`);}else console.log(`PASS ${impl}`);
}
process.exitCode=failed?1:0;
