import {formatUnits} from 'viem';
export function amount(value:string|bigint|undefined,decimals=18,digits=4){if(value===undefined||value===null)return '—';const [whole,fraction='']=formatUnits(BigInt(value),decimals).split('.');return Number(whole).toLocaleString('en-US')+(digits&&fraction?'.'+fraction.slice(0,digits).replace(/0+$/,''):'').replace(/\.$/,'')}
export const short=(a:string)=>a?a.slice(0,6)+'…'+a.slice(-4):'Disconnected';
export function countdown(ts:string){const d=Math.max(0,Number(ts)-Date.now()/1000);return `${Math.floor(d/3600)}h ${Math.floor(d%3600/60)}m`}
export function parityOutput(input:bigint,fromRatio:bigint,toRatio:bigint,fromDecimals:number,toDecimals:number){return input*fromRatio*10n**BigInt(toDecimals)/(toRatio*10n**BigInt(fromDecimals))}
