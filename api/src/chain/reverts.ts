import { abis } from "@wrapswap/types";
import { decodeErrorResult, parseAbi } from "viem";
export const routeErrors = [
  ...abis.IParityHook.filter((x) => x.type === "error"),
  ...parseAbi([
    "error InsufficientLiquidity()",
    "error NotEnoughLiquidity()",
    "error WrappedError(address target,bytes4 selector,bytes reason,bytes details)",
  ]),
];
// v4 can wrap a hook revert. Decode the nested reason rather than treating every
// failed RPC/simulation as a liquidity problem.
export function permitsDarkFallback(error: unknown, depth = 0): boolean {
  if (depth > 12 || error == null) return false;
  if (typeof error === "string") {
    if (
      /PegGuardTripped|InsufficientLiquidity|NotEnoughLiquidity|insufficient liquidity/i.test(
        error,
      )
    )
      return true;
    if (/^0x[0-9a-f]+$/i.test(error)) {
      try {
        const decoded = decodeErrorResult({
          abi: routeErrors,
          data: error as `0x${string}`,
        });
        return permitsDarkFallback(decoded, depth + 1);
      } catch {}
    }
    return false;
  }
  if (typeof error !== "object") return false;
  if (Array.isArray(error))
    return error.some((e) => permitsDarkFallback(e, depth + 1));
  return [
    "errorName",
    "message",
    "cause",
    "data",
    "args",
    "reason",
    "details",
  ].some((k) => permitsDarkFallback((error as any)[k], depth + 1));
}
