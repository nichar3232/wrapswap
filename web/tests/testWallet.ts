import type { Page } from "@playwright/test";
import { encodeErrorResult, parseAbi } from "viem";

// Real revert payloads (ABI-encoded custom errors), returned the way MetaMask wraps a node's revert.
const errors = parseAbi([
  "error PegGuardTripped(bytes32 poolId, uint256 deviationBps)",
  "error TooLittleReceived(uint256 amountOut, uint256 amountOutMin)",
]);
const REVERTS = {
  peg: encodeErrorResult({ abi: errors, errorName: "PegGuardTripped", args: [`0x${"11".repeat(32)}`, 75n] }),
  slippage: encodeErrorResult({ abi: errors, errorName: "TooLittleReceived", args: [1n, 2n] }),
};

export type TxMode = "ok" | "reject" | "revert-peg" | "revert-slippage";
/**
 * An injected EIP-1193 wallet for browser tests: starts on `chainId`, knows only `known` chains until
 * wallet_addEthereumChain, and answers eth_sendTransaction according to window.__txMode.
 */
export async function injectTestWallet(
  page: Page,
  opts: { account: string; chainId: string; known?: string[] },
) {
  await page.addInitScript(({ account, chainId, known, reverts }) => {
    const w = window as any;
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const emit = (e: string, v: unknown) => (listeners[e] || []).forEach((f) => f(v));
    w.__wallet = { chainId, known: [...known], added: [] as unknown[], sent: [] as unknown[], connected: false };
    w.__txMode = "ok";
    let n = 0;
    w.ethereum = {
      isMetaMask: true,
      on: (e: string, f: any) => ((listeners[e] ||= []).push(f)),
      removeListener: (e: string, f: any) => (listeners[e] = (listeners[e] || []).filter((x) => x !== f)),
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        const s = w.__wallet;
        switch (method) {
          case "eth_requestAccounts":
            s.connected = true;
            return [account];
          case "eth_accounts":
            return s.connected ? [account] : [];
          case "eth_chainId":
            return s.chainId;
          case "wallet_switchEthereumChain": {
            const id = params![0].chainId;
            if (!s.known.includes(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
            s.chainId = id;
            emit("chainChanged", id);
            return null;
          }
          case "wallet_addEthereumChain":
            s.added.push(params![0]);
            s.known.push(params![0].chainId);
            s.chainId = params![0].chainId;
            emit("chainChanged", s.chainId);
            return null;
          case "wallet_revokePermissions":
            s.connected = false;
            return null;
          case "eth_sendTransaction": {
            s.sent.push(params![0]);
            await new Promise((r) => setTimeout(r, 150));
            if (w.__txMode === "reject")
              throw Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), { code: 4001 });
            if (w.__txMode === "revert-peg" || w.__txMode === "revert-slippage")
              throw Object.assign(new Error("Internal JSON-RPC error."), {
                code: -32603,
                data: { originalError: { code: 3, message: "execution reverted", data: reverts[w.__txMode === "revert-peg" ? "peg" : "slippage"] } },
              });
            return "0x" + (++n).toString(16).padStart(64, "a");
          }
          default:
            return null;
        }
      },
    };
  }, { known: [], ...opts, reverts: REVERTS });
}
export const setTxMode = (page: Page, mode: TxMode) =>
  page.evaluate((m) => ((window as any).__txMode = m), mode);
