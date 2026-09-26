import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, parseAbi, type Abi } from "viem";
import { IParityHookAbi, IWrapSwapRouterAbi } from "@wrapswap/types";
import { humanize } from "./tx";

const hookErrors = parseAbi([
  "error InsufficientInventory(address currency, uint256 available, uint256 requested)",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error SomethingNew(uint256 code)",
]);
const token = "0x433DAfF77AD96b9319957D83d9d422E70c996C45";
/** A viem simulateContract failure on swapExactIn (whose args include amountOutMin) reverting with `data`. */
const failure = (data: `0x${string}`) => {
  const reverted = new ContractFunctionRevertedError({ abi: IWrapSwapRouterAbi as Abi, data, functionName: "swapExactIn" });
  return new ContractFunctionExecutionError(reverted as BaseError, {
    abi: IWrapSwapRouterAbi as Abi,
    functionName: "swapExactIn",
    args: [{ amountIn: 1n, amountOutMin: 1n }],
  });
};

describe("humanize surfaces the real revert reason", () => {
  it("a hook revert wrapped by PoolManager is decoded, not labelled slippage", () => {
    const inner = encodeErrorResult({ abi: hookErrors, errorName: "InsufficientInventory", args: [token, 1n, 2n] });
    const wrapped = encodeErrorResult({ abi: hookErrors, errorName: "WrappedError", args: [token, "0x575e24b4", inner, "0x"] });
    const msg = humanize(failure(wrapped));
    expect(msg).toMatch(/inventory is short/i);
    expect(msg).not.toMatch(/slippage/i);
  });
  it("TooLittleReceived is the only slippage message", () => {
    const data = encodeErrorResult({ abi: IWrapSwapRouterAbi as Abi, errorName: "TooLittleReceived", args: [1n, 2n] });
    expect(humanize(failure(data))).toMatch(/minimum/i);
  });
  it("an unmapped custom error is shown by name; an undeclared one by selector", () => {
    const known = encodeErrorResult({ abi: IParityHookAbi as Abi, errorName: "UnsupportedPool", args: [token, token] });
    expect(humanize(failure(known))).toMatch(/^The contract reverted: UnsupportedPool\(/);
    const data = encodeErrorResult({ abi: hookErrors, errorName: "SomethingNew", args: [7n] });
    expect(humanize(failure(data))).toMatch(/0x8ac2ae24/);
  });
  it("wallet rejection and non-revert failures", () => {
    expect(humanize({ code: 4001, message: "User rejected the request." })).toMatch(/rejected/);
    expect(humanize(new Error("WrongChain"))).toMatch(/Unichain Sepolia/);
    expect(humanize(new Error("boom"))).toBe("The transaction failed: boom");
  });
});
