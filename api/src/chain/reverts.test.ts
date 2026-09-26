import { it, expect } from "vitest";
import { encodeErrorResult } from "viem";
import { permitsDarkFallback, routeErrors } from "./reverts.js";
import { deployment, hash } from "../testing/fixtures.js";
it("recognizes nested v4 hook peg reverts but preserves infrastructure failures", () => {
  const reason = encodeErrorResult({
    abi: routeErrors,
    errorName: "PegGuardTripped",
    args: [hash(99), 51n],
  } as any);
  const wrapped = encodeErrorResult({
    abi: routeErrors,
    errorName: "WrappedError",
    args: [deployment.contracts.parityHook, "0x12345678", reason, "0x"],
  } as any);
  expect(permitsDarkFallback({ cause: { data: wrapped } })).toBe(true);
  expect(permitsDarkFallback(Error("RPC failed reading liquidity"))).toBe(
    false,
  );
});
