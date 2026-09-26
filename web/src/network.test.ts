import { describe, expect, it } from "vitest";
import {
  CHAINS,
  CHAIN_IDS,
  DEFAULT_CHAIN,
  DEFAULT_NETWORK,
  explorerUrl,
  parseNetwork,
} from "@wrapswap/types";

describe("@wrapswap/types networks", () => {
  it("defaults to Unichain Sepolia (1301) when NETWORK is unset", () => {
    expect(DEFAULT_NETWORK).toBe("unichain-sepolia");
    expect(parseNetwork(undefined)).toBe("unichain-sepolia");
    expect(parseNetwork("")).toBe("unichain-sepolia");
    expect(CHAIN_IDS[parseNetwork(undefined)]).toBe(1301);
    expect(DEFAULT_CHAIN.rpcUrl).toBe("https://sepolia.unichain.org");
  });
  it("still accepts explicit networks and rejects unknown ones", () => {
    expect(parseNetwork("anvil")).toBe("anvil");
    expect(parseNetwork("unichain-sepolia")).toBe("unichain-sepolia");
    expect(() => parseNetwork("base-sepolia")).toThrow(/NETWORK must be one of/);
    expect(() => parseNetwork("mainnet")).toThrow(/NETWORK must be one of/);
  });
  it("builds explorer links per network", () => {
    expect(explorerUrl("unichain-sepolia", "tx", "0xabc")).toBe(
      "https://sepolia.uniscan.xyz/tx/0xabc",
    );
    expect(explorerUrl("unichain-sepolia", "address", "0x1")).toBe(
      "https://sepolia.uniscan.xyz/address/0x1",
    );
    expect(explorerUrl("anvil", "tx", "0xabc")).toBeNull();
    expect(CHAINS["unichain-sepolia"].id).toBe(1301);
  });
});
