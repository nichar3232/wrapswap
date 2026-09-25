import { describe, it, expect } from "vitest";
import { shares, tokens, lessFee, deviation, poolPrice, WAD } from "./math";
describe("decimal-aware share quotes", () => {
  it("normalizes B20 eight decimals and split multipliers", () => {
    expect(shares(10n ** 8n, 2n * WAD, 8)).toBe(2n * WAD);
    expect(tokens(2n * WAD, 2n * WAD, 8)).toBe(10n ** 8n);
  });
  it("never overquotes integer redemption and fees", () => {
    expect(tokens(WAD, 3n * WAD, 8)).toBe(33333333n);
    expect(lessFee(10000n, 5)).toBe(9995n);
  });
  it("prices Q96 with token decimals and guard bps", () => {
    expect(poolPrice(2n ** 96n, 18, 18)).toBe(WAD);
    expect(deviation(101n * WAD, 100n * WAD)).toBe(100);
  });
});

import {hookOutput} from './math';
it('quotes the hook rounding separately from vault redemption rounding',()=>{
 expect(hookOutput(1001n,2)).toBe(1000n);
 expect(lessFee(1001n,2)).toBe(1001n);
});
