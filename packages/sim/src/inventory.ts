import { assets, inventoryShares, read, abi, PARITY_HOOK, fmt } from "./chain.js";
for (const a of assets) {
  const [s0, s1] = await inventoryShares(a);
  const fb: any = await read(PARITY_HOOK, abi.hook, "feeBreakdown", [a.key]);
  console.log(a.symbol, a.wrappers.map(w=>w.symbol).join("/"), fmt(s0,1), fmt(s1,1), "skew", fmt(fb.skewX18,4), "skewPips", fb.skewPips);
}
