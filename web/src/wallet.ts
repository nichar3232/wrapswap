import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Abi,
  type EIP1193Provider,
  type AddEthereumChainParameter,
} from "viem";
import {
  IMockIssuerTokenAbi,
  IDarkCrossHookAbi,
  IWrapSwapRouterAbi,
  encodeParityHookData,
  type Address,
  type Deployment,
} from "@wrapswap/types";
import { config } from "./config";
const provider = () => {
  const p = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!p)
    throw Error(
      "No wallet found. Open this app with an Ethereum wallet extension.",
    );
  return p;
};
// https://developers.uniswap.org/docs/unichain/technical-information/network-information
const ADDABLE_CHAINS: Record<number, Omit<AddEthereumChainParameter, "chainId">> = {
  1301: {
    chainName: "Unichain Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.unichain.org"],
    blockExplorerUrls: ["https://sepolia.uniscan.xyz"],
  },
};
export async function connect(d: Deployment): Promise<Address> {
  if (config.useMocks)
    return d.demoAccounts.accounts.find((a) => a.role === "demo")!.address;
  const p = provider();
  const chainId = "0x" + d.chainId.toString(16);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    // 4902: the wallet does not know the chain yet. Add Unichain Sepolia with its public RPC and explorer.
    const add = ADDABLE_CHAINS[d.chainId];
    if ((e as { code?: number }).code !== 4902 || !add) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [{ chainId, ...add }] });
  }
  const accounts = await p.request({ method: "eth_requestAccounts" });
  if (!accounts[0]) throw Error("Wallet returned no account");
  return accounts[0];
}
export function subscribeWallet(onChange: () => void) {
  const p = (
    window as unknown as {
      ethereum?: {
        on?: (e: string, f: () => void) => void;
        removeListener?: (e: string, f: () => void) => void;
      };
    }
  ).ethereum;
  p?.on?.("accountsChanged", onChange);
  p?.on?.("chainChanged", onChange);
  return () => {
    p?.removeListener?.("accountsChanged", onChange);
    p?.removeListener?.("chainChanged", onChange);
  };
}
export async function send(
  d: Deployment,
  account: Address,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
) {
  if (config.useMocks) return;
  const wallet = createWalletClient({ account, transport: custom(provider()) });
  if ((await wallet.getChainId()) !== d.chainId)
    throw Error(`Switch wallet to ${d.network} (${d.chainId}) and reconnect.`);
  const rpc = createPublicClient({
    transport: http(new URL(config.rpcUrl, location.origin).href),
  });
  // Load-balanced public RPCs can serve a backend that has not seen the previous receipt (e.g. the approval),
  // so a failed simulation is retried briefly before it is reported.
  const simulate = () =>
    rpc.simulateContract({ account, address, abi, functionName, args });
  let simulation: Awaited<ReturnType<typeof simulate>>;
  for (let attempt = 1; ; attempt++) {
    try {
      simulation = await simulate();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const hash = await wallet.writeContract({
    ...simulation.request,
    chain: null,
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw Error(`Transaction reverted: ${hash}`);
}
export const approve = (
  d: Deployment,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
) => send(d, account, token, IMockIssuerTokenAbi, "approve", [spender, amount]);
/** Exact-in swap through WrapSwapRouter (INTERFACES.md §13); approve tokenIn to the router first. */
export async function convertExactIn(
  d: Deployment,
  account: Address,
  tokenIn: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  attestationUid?: Address,
) {
  const router = d.contracts.wrapSwapRouter;
  if (!router) throw Error("This deployment has no WrapSwapRouter.");
  const rpc = createPublicClient({
    transport: http(new URL(config.rpcUrl, location.origin).href),
  });
  // Deadline from chain time: anvil runs on a warped clock, not host time.
  const { timestamp } = await rpc.getBlock();
  return send(d, account, router, IWrapSwapRouterAbi, "swapExactIn", [
    {
      key: d.pool.key,
      zeroForOne: tokenIn.toLowerCase() === d.pool.key.currency0.toLowerCase(),
      amountIn,
      amountOutMin,
      recipient: account,
      deadline: timestamp + 600n,
      hookData: encodeParityHookData({ swapper: account, attestationUid }),
    },
  ]);
}
export const darkSend = (
  d: Deployment,
  account: Address,
  name: string,
  args: unknown[],
) => send(d, account, d.contracts.darkCrossHook, IDarkCrossHookAbi, name, args);
export async function verifyOrder(
  d: Deployment,
  account: Address,
  batchId: string,
  expectedHash?: Address,
) {
  if (config.useMocks) return;
  const rpc = createPublicClient({
    transport: http(new URL(config.rpcUrl, location.origin).href),
  });
  const order = await rpc.readContract({
    address: d.contracts.darkCrossHook,
    abi: IDarkCrossHookAbi,
    functionName: "order",
    args: [BigInt(batchId), account],
  });
  if (
    expectedHash
      ? order.commitHash !== expectedHash
      : !order.revealed || !order.valid
  )
    throw Error(
      expectedHash
        ? "Commit was not accepted. Check eligibility; funded tokens remain in escrow."
        : "Reveal was not accepted as valid. Inspect the batch before settlement.",
    );
}
