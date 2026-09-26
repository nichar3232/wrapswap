import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Abi,
  type EIP1193Provider,
  type Hash,
  type TransactionReceipt,
} from "viem";
import {
  CHAINS,
  DEMO,
  IMockIssuerTokenAbi,
  IDarkCrossHookAbi,
  IParityHookAbi,
  IWrapSwapRouterAbi,
  encodeParityHookData,
  type Address,
  type Deployment,
  type PoolKey,
} from "@wrapswap/types";
import { config } from "./config";

type Provider = EIP1193Provider & {
  on?: (e: string, f: (...a: unknown[]) => void) => void;
  removeListener?: (e: string, f: (...a: unknown[]) => void) => void;
};
export const injected = () =>
  (window as unknown as { ethereum?: Provider }).ethereum;
const provider = () => {
  const p = injected();
  if (!p) throw new WalletError("no-wallet");
  return p;
};

/** Wallet failures the UI can describe; the raw error is kept for the console only. */
export class WalletError extends Error {
  constructor(
    readonly kind: "no-wallet" | "no-account",
    readonly cause?: unknown,
  ) {
    super(kind);
  }
}

export const hexChainId = (id: number) => "0x" + id.toString(16);
export const expectedChain = () => CHAINS[config.network];

/**
 * Who signs. An injected wallet always wins. Without one: in the mock-data build (tests only) a simulated wallet
 * signs locally; live, the demo relay (a server-side signer, GET/POST {api}/demo/relay) sends real transactions and
 * returns real hashes, when the backend runs one. The demo key never reaches this bundle.
 */
export const simulatedWallet = () => config.useMocks && !injected();
/** No chain writes: mock data (where an injected wallet still signs, for tests). */
const offChain = () => config.useMocks;

type RelayInfo = { address: Address };
let relayProbe: Promise<RelayInfo | null> | undefined;
/** The demo relay's account, or null when the backend runs none (probed once). */
export function relayInfo(): Promise<RelayInfo | null> {
  if (config.useMocks || injected()) return Promise.resolve(null);
  relayProbe ??= fetch(`${config.apiUrl}/demo/relay`)
    .then(async (r) => {
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
      const j = (await r.json()) as { address?: string };
      return j.address && /^0x[0-9a-fA-F]{40}$/.test(j.address) ? { address: j.address as Address } : null;
    })
    .catch(() => null);
  return relayProbe;
}
let relayAccount: Address | undefined;
const usingRelay = () => !injected() && !config.useMocks && !!relayAccount;
/** Demo: mock data, or transactions signed by the demo relay. The UI marks both. */
export const isDemo = () => config.useMocks || usingRelay();

export async function requestAccount(d?: Deployment): Promise<Address> {
  if (simulatedWallet())
    return (d?.demoAccounts.accounts.find((a) => a.role === "demo")?.address ??
      DEMO.accounts.demo.anvilAddress) as Address;
  if (!injected()) {
    const relay = await relayInfo();
    if (!relay) throw new WalletError("no-wallet");
    relayAccount = relay.address;
    return relay.address;
  }
  const accounts = (await provider().request({
    method: "eth_requestAccounts",
  })) as Address[] | null;
  if (!accounts?.[0]) throw new WalletError("no-account");
  return accounts[0];
}

export async function readChainId(): Promise<number | null> {
  if (simulatedWallet() || !injected()) return expectedChain().id;
  try {
    const id = await provider().request({ method: "eth_chainId" });
    return id ? Number(id) : null;
  } catch {
    return null;
  }
}

/** One click: switch to the app's chain, adding it first when the wallet does not know it (EIP-3085, code 4902). */
export async function switchToExpectedChain() {
  const chain = expectedChain();
  const chainId = hexChainId(chain.id);
  const p = provider();
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } })
      .code ?? (e as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 || !chain.explorer) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [chain.rpcUrl],
          blockExplorerUrls: [chain.explorer],
        },
      ],
    });
  }
}

/** Kept for callers of the original API: account plus a best-effort chain switch. */
export async function connect(d: Deployment): Promise<Address> {
  const account = await requestAccount(d);
  if (!simulatedWallet() && (await readChainId()) !== d.chainId)
    await switchToExpectedChain();
  return account;
}

/** Best effort: MetaMask supports revoking the site's account permission. */
export async function disconnectWallet() {
  relayAccount = undefined;
  if (!injected()) return;
  try {
    await injected()?.request({
      method: "wallet_revokePermissions" as never,
      params: [{ eth_accounts: {} }] as never,
    });
  } catch {
    /* not supported: the app forgets the account locally */
  }
}

export function subscribeWallet(handlers: {
  accounts: (a: Address[]) => void;
  chain: (id: number) => void;
}) {
  const p = injected();
  const onAccounts = (a: unknown) => handlers.accounts((a as Address[]) ?? []);
  const onChain = (id: unknown) => handlers.chain(Number(id));
  p?.on?.("accountsChanged", onAccounts);
  p?.on?.("chainChanged", onChain);
  return () => {
    p?.removeListener?.("accountsChanged", onAccounts);
    p?.removeListener?.("chainChanged", onChain);
  };
}

const rpc = () =>
  createPublicClient({
    transport: http(new URL(config.rpcUrl, location.origin).href),
  });

export async function tokenBalances(account: Address, tokens: Address[]) {
  return Promise.all(
    tokens.map((address) =>
      rpc().readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    ),
  );
}
export async function allowance(token: Address, owner: Address, spender: Address) {
  return rpc().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export type SendOptions = { onHash?: (hash: Hash) => void; /** swapExactIn only: deliver the output here. */ recipient?: Address };
export type Sent = { hash: Hash; receipt?: TransactionReceipt; simulated: boolean };

const fakeHash = () =>
  ("0x" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")) as Hash;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function send(
  d: Deployment,
  account: Address,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
  opts: SendOptions = {},
): Promise<Sent> {
  if (offChain()) {
    // Demo: the simulated wallet signs instantly; with mock data an injected wallet still signs (so reject/revert
    // paths are real) while the chain is simulated.
    let hash = fakeHash();
    const p = injected();
    if (p) {
      // Mock fixtures carry non-checksummed addresses; lowercase ones encode without a checksum check.
      const lower = (x: unknown): unknown =>
        typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x)
          ? x.toLowerCase()
          : Array.isArray(x)
            ? x.map(lower)
            : x && typeof x === "object" && typeof x !== "bigint"
              ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, lower(v)]))
              : x;
      hash = (await p.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: account,
            to: address.toLowerCase(),
            data: encodeFunctionData({ abi, functionName, args: lower(args) as unknown[] }),
          },
        ],
      } as never)) as Hash;
    }
    opts.onHash?.(hash);
    await pause(700);
    return { hash, simulated: true };
  }
  const client = rpc();
  if (usingRelay()) {
    // Simulate first so a revert shows its decoded reason before anything is sent.
    await client.simulateContract({ account, address, abi, functionName, args });
    const r = await fetch(`${config.apiUrl}/demo/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: address, data: encodeFunctionData({ abi, functionName, args }) }),
    }).catch(() => undefined);
    const j = r?.ok ? ((await r.json().catch(() => ({}))) as { hash?: string }) : {};
    if (!j.hash || !/^0x[0-9a-fA-F]{64}$/.test(j.hash)) throw new Error("NoRelay");
    const hash = j.hash as Hash;
    opts.onHash?.(hash);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction reverted onchain.");
    return { hash, receipt, simulated: false };
  }
  const wallet = createWalletClient({ account, transport: custom(provider()) });
  if ((await wallet.getChainId()) !== d.chainId) throw new Error("WrongChain");
  // Load-balanced public RPCs can serve a backend that has not seen the previous receipt (e.g. the approval),
  // so a failed simulation is retried briefly before it is reported.
  const simulate = () =>
    client.simulateContract({ account, address, abi, functionName, args });
  let simulation: Awaited<ReturnType<typeof simulate>>;
  for (let attempt = 1; ; attempt++) {
    try {
      simulation = await simulate();
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await pause(1500);
    }
  }
  const hash = await wallet.writeContract({
    ...simulation.request,
    chain: null,
  });
  opts.onHash?.(hash);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction reverted onchain.");
  return { hash, receipt, simulated: false };
}
export const approve = (
  d: Deployment,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  opts?: SendOptions,
) => send(d, account, token, IMockIssuerTokenAbi, "approve", [spender, amount], opts);

/** Exact-in swap through WrapSwapRouter (INTERFACES.md §13) on the asset's pool; approve tokenIn to the router first. */
export async function convertExactIn(
  d: Deployment,
  key: PoolKey,
  account: Address,
  tokenIn: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  attestationUid?: Address,
  opts?: SendOptions,
) {
  // Mock deployments predate the router: sign the same calldata against the mock swap router address.
  const router = d.contracts.wrapSwapRouter ?? (offChain() ? d.contracts.swapRouter : undefined);
  if (!router) throw new Error("NoRouter");
  // Deadline from chain time: anvil runs on a warped clock, not host time.
  const timestamp = offChain()
    ? BigInt(Math.floor(Date.now() / 1000))
    : (await rpc().getBlock()).timestamp;
  return send(
    d,
    account,
    router,
    IWrapSwapRouterAbi,
    "swapExactIn",
    [
      {
        key,
        zeroForOne: tokenIn.toLowerCase() === key.currency0.toLowerCase(),
        amountIn,
        amountOutMin,
        recipient: opts?.recipient ?? account,
        deadline: timestamp + 600n,
        hookData: encodeParityHookData({ swapper: account, attestationUid }),
      },
    ],
    opts,
  );
}

/** The ParityHook Converted event of a swap receipt: the exact shares out, base fee, skew fee and post-trade skew. */
export type Converted = { sharesOut: bigint; baseFee: bigint; skewFee: bigint; postSkew: bigint; amountOut?: bigint };
export function convertedOf(receipt: TransactionReceipt, tokenOut: Address, recipient: Address): Converted | undefined {
  let c: Converted | undefined;
  let amountOut: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({ abi: IParityHookAbi, data: log.data, topics: log.topics });
      if (e.eventName === "Converted")
        c = { sharesOut: e.args.sharesOut, baseFee: e.args.baseFee, skewFee: e.args.skewFee, postSkew: e.args.postSkew };
    } catch {
      /* not a ParityHook event */
    }
    if (log.address.toLowerCase() === tokenOut.toLowerCase())
      try {
        const e = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (e.eventName === "Transfer" && e.args.to.toLowerCase() === recipient.toLowerCase())
          amountOut = (amountOut ?? 0n) + e.args.value;
      } catch {
        /* not a Transfer */
      }
  }
  return c && { ...c, amountOut };
}

/** A call on the asset's DarkCrossHook. */
export const darkSend = (
  d: Deployment,
  hook: Address,
  account: Address,
  name: string,
  args: unknown[],
  opts?: SendOptions,
) => send(d, account, hook, IDarkCrossHookAbi, name, args, opts);

export async function verifyOrder(
  hook: Address,
  account: Address,
  batchId: string,
  expectedHash?: Address,
) {
  if (offChain()) return;
  const order = await rpc().readContract({
    address: hook,
    abi: IDarkCrossHookAbi,
    functionName: "order",
    args: [BigInt(batchId), account],
  });
  if (expectedHash ? order.commitHash !== expectedHash : !order.revealed || !order.valid)
    throw new Error(expectedHash ? "CommitNotAccepted" : "RevealNotValid");
}

const FAUCET_ABI = parseAbi(["function claim()", "function nextClaimAt(address) view returns (uint256)"]);
/** TestShareFaucet.claim(): every listed test wrapper to the caller, once per COOLDOWN (1 day). */
export const claimFaucet = (d: Deployment, account: Address, faucet: Address, opts?: SendOptions) =>
  send(d, account, faucet, FAUCET_ABI, "claim", [], opts);

/** Dark Cross escrow: the account's available (unlocked) balance of each token on the hook; undefined in mock mode. */
export async function escrowAvailable(hook: Address, account: Address, tokens: Address[]) {
  if (offChain()) return undefined;
  const rows = await Promise.all(
    tokens.map((t) => rpc().readContract({ address: hook, abi: IDarkCrossHookAbi, functionName: "balances", args: [account, t] })),
  );
  return rows.map((r) => r[0]);
}
