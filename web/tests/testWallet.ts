import type { Page } from "@playwright/test";

export type TxMode = "ok" | "reject" | "revert-peg" | "revert-slippage";
/**
 * An injected EIP-1193 wallet for browser tests: starts on `chainId`, knows only `known` chains until
 * wallet_addEthereumChain, and answers eth_sendTransaction according to window.__txMode.
 */
export async function injectTestWallet(
  page: Page,
  opts: { account: string; chainId: string; known?: string[] },
) {
  await page.addInitScript(({ account, chainId, known }) => {
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
            if (w.__txMode === "revert-peg")
              throw Object.assign(new Error("execution reverted"), { code: -32603, data: { errorName: "PegGuardTripped" } });
            if (w.__txMode === "revert-slippage")
              throw Object.assign(new Error("execution reverted"), { code: -32603, data: { errorName: "TooLittleReceived" } });
            return "0x" + (++n).toString(16).padStart(64, "a");
          }
          default:
            return null;
        }
      },
    };
  }, { known: [], ...opts });
}
export const setTxMode = (page: Page, mode: TxMode) =>
  page.evaluate((m) => ((window as any).__txMode = m), mode);
