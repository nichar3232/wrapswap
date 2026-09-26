import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ConnectModal,
  SuiClientProvider,
  WalletProvider as SuiWalletProvider,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import "@mysten/dapp-kit/dist/index.css";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { EncryptedObject, SealClient, SessionKey } from "@mysten/seal";
import { createPublicClient, formatUnits, http, isAddress, parseAbi, parseUnits, type Address, type Hash } from "viem";
import { canonical, type Deployment } from "@wrapswap/types";
import suiDeployment from "../../../deployments/sui-testnet.json";
import { config } from "../config";
import { useApi } from "../hooks/useApi";
import { amount } from "../lib/format";
import { approve, injected, send } from "../wallet";
import { readBatch, readPool, sealApproveLeafTx, type BatchState, type PoolState } from "../../../services/crank/sui/chain";
import { prepareInstruction } from "../../../services/crank/sui/payer";
import { leafHash, verifyPath } from "../../../services/crank/sui/merkle";
import { decodeJson, leafProof, normalizeSuiAddress, type Instruction, type Leaf, type Manifest } from "../../../services/crank/sui/protocol";
import { useTx } from "./tx";
import { CopyButton, Hex, Spinner, TxPanel, Val, shortHex } from "./ui";
import { useWallet } from "./wallet";
import "./send.css";

// Send panel, "Send shares to someone": Deposit (Unichain) → Send (Sui, sealed for the batch window) → the recipient
// withdraws to any platform's wrapper through the router. One primary action per step and a tracker receipt.
// Assets and platforms come from /assets (falling back to the same shape derived from the deployment).
// Live: EVM legs go through the app's own wallet/send (same signing, mock and demo behaviour as Convert); Sui legs use
// dapp-kit (Slush) and Seal, reading Sui straight from a fullnode. Demo: every leg runs with simulated states, and
// every number still comes from real data: token multipliers from the deployment, the fee from the live fee feed with
// the hook's own rounding (canonical.parityQuote), the batch window from the Sui pool.

type SuiDep = {
  sui: { packageId: string; poolId: string; windowMs: number };
  seal: { threshold: number; keyServers: { name: string; objectId: string }[] };
  walrus: { publisher: string; aggregator: string };
  evm: { chainId: number; shareVault: Address };
  demoAccounts: { suiPayer: string; suiPayee: string };
};
const sd = suiDeployment as unknown as SuiDep;
const SUI_RPC = "https://fullnode.testnet.sui.io:443";
const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: SUI_RPC });
const seal = new SealClient({
  suiClient: grpc,
  serverConfigs: sd.seal.keyServers.map((k) => ({ objectId: k.objectId, weight: 1 })),
  verifyKeyServers: false,
  timeout: 20_000,
});
const vaultAbi = parseAbi([
  "function deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) returns (uint256)",
  "function quoteWithdrawal(address target, uint256 shares) view returns (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct)",
  "event WithdrawalSettled(bytes32 indexed commitment, address indexed recipient, address indexed targetIssuerToken, address sourceIssuerToken, uint256 amountIn, uint256 amountOut, uint256 sharesDebited)",
  "event WithdrawalSkipped(bytes32 indexed commitment, bytes reason)",
]);
const ONE = 10n ** 18n;
const STAGES = ["Deposit", "Send", "Withdraw"] as const;
type Stage = (typeof STAGES)[number];
const CHAIN_OF: Record<Stage, string> = { Deposit: "Unichain", Send: "Sui", Withdraw: "Recipient · Unichain" };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeEvmHash = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hash;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeDigest = () => Array.from(crypto.getRandomValues(new Uint8Array(44)), (b) => B58[b % 58]).join("");
const shares = (v: bigint, dp = 4) => amount(v, 18, dp);
const sharesWord = (v: bigint, dp = 4) => `${shares(v, dp)} share${v === ONE ? "" : "s"}`;
const parseShares = (s: string) => {
  try {
    const v = parseUnits(s.trim() || "0", 18);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
};
const suiscan = (kind: "tx" | "object" | "account", id: string) => `https://suiscan.xyz/testnet/${kind}/${id}`;

/** Sui id/digest with the same look as the app's Hex: mono, shortened, copy, explorer link unless simulated. */
function SuiRef({ value, kind, simulated }: { value: string; kind: "tx" | "object" | "account"; simulated?: boolean }) {
  return (
    <span className="hex">
      <span className="mono" title={value}>
        {shortHex(value)}
      </span>
      <CopyButton value={value} label={kind === "tx" ? "Copy digest" : "Copy id"} />
      {!simulated && (
        <a className="ext" href={suiscan(kind, value)} target="_blank" rel="noreferrer" aria-label="View on Suiscan">
          ↗
        </a>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- live Sui + reserves state

type Feed<T> = { status: "loading" | "ok" | "unavailable"; data?: T };

function useSuiPool(enabled: boolean): Feed<{ pool: PoolState; batch: BatchState }> & { reload: () => void } {
  const [s, set] = useState<Feed<{ pool: PoolState; batch: BatchState }>>({ status: "loading" });
  const load = useCallback(async () => {
    try {
      const pool = await readPool(grpc, sd.sui.poolId);
      set({ status: "ok", data: { pool, batch: await readBatch(grpc, pool.currentBatch) } });
    } catch {
      set((p) => (p.data ? p : { status: "unavailable" }));
    }
  }, []);
  useEffect(() => {
    if (!enabled) return set({ status: "unavailable" });
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [enabled, load]);
  return { ...s, reload: () => void load() };
}

type Reserves = { suiTotalShares: string; vaultShares: string; vaultSharesHeld: string; invariant: boolean; checkedBlock: string };
function useReserves(): Feed<Reserves> {
  const [s, set] = useState<Feed<Reserves>>({ status: "loading" });
  useEffect(() => {
    if (config.useMocks) return set({ status: "unavailable" });
    let live = true;
    const run = () =>
      fetch(`${config.apiUrl}/pay/reserves`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const data = (await r.json()) as Reserves;
          if (live) set({ status: "ok", data });
        })
        .catch(() => live && set((p) => (p.data ? p : { status: "unavailable" })));
    void run();
    const t = setInterval(run, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return s;
}

const manifests = new Map<string, Manifest>();
async function manifestOf(blobId: string) {
  const hit = manifests.get(blobId);
  if (hit) return hit;
  const r = await fetch(`${sd.walrus.aggregator}/v1/blobs/${blobId}`);
  if (!r.ok) throw new Error(`walrus ${r.status}`);
  const m = (await r.json()) as Manifest;
  manifests.set(blobId, m);
  return m;
}
async function walrusPut(data: Uint8Array) {
  const r = await fetch(`${sd.walrus.publisher}/v1/blobs?epochs=5`, { method: "PUT", body: data as BodyInit });
  if (!r.ok) throw new Error(`walrus ${r.status}`);
  const j = await r.json();
  return { blobId: (j.newlyCreated?.blobObject.blobId ?? j.alreadyCertified?.blobId) as string };
}

// ---------------------------------------------------------------- assets (/assets)

type Platform = { issuer: string; name: string; symbol: string; address: Address; decimals: number; sharesPerTokenX18: string };
type Asset = { asset: string; platforms: Platform[] };
const PLATFORM: Record<string, string> = { coinbase: "Coinbase", xstocks: "xStocks" };
const platformName = (issuer: string) => PLATFORM[issuer] ?? issuer.charAt(0).toUpperCase() + issuer.slice(1);

/** Assets and the platforms (issuer wrappers) each trades on, from GET /assets; the same shape is derived from the
 *  deployment when the route is unreachable. Live multipliers come from /assets when it answers. */
function useAssets(d: Deployment | undefined): Feed<Asset[]> {
  const [s, set] = useState<Feed<Asset[]>>({ status: "loading" });
  useEffect(() => {
    let on = true;
    const fromDeployment = (): Asset[] | undefined => {
      if (!d) return undefined;
      const by = new Map<string, Platform[]>();
      for (const t of d.tokens)
        by.set(t.underlying, [
          ...(by.get(t.underlying) ?? []),
          { issuer: t.issuer, name: t.name, symbol: t.symbol, address: t.address as Address, decimals: t.decimals, sharesPerTokenX18: String(t.sharesPerTokenX18) },
        ]);
      return [...by].map(([asset, platforms]) => ({ asset, platforms }));
    };
    const load = async () => {
      try {
        if (config.useMocks) throw new Error("mock data has no /assets");
        const r = await fetch(`${config.apiUrl}/assets`);
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as { assets: Asset[] };
        if (on) set({ status: "ok", data: body.assets.filter((a) => a.platforms.length > 0) });
      } catch {
        const fallback = fromDeployment();
        if (on) set(fallback ? { status: "ok", data: fallback } : { status: "unavailable" });
      }
    };
    void load();
    return () => {
      on = false;
    };
  }, [d]);
  return s;
}

// ---------------------------------------------------------------- tracker

type LegState = "done" | "active" | "next";
type Leg = { key: string; label: string; chain: "Unichain" | "Sui"; state: LegState; detail?: ReactNode; simulated?: boolean };

function Tracker({ legs }: { legs: Leg[] }) {
  if (!legs.some((l) => l.state !== "next")) return null;
  return (
    <section className="card send-tracker" aria-label="Send tracker">
      <ol>
        {legs.map((l) => (
          <li key={l.key} className={`leg leg-${l.state}`}>
            <span className="leg-dot" aria-hidden="true">
              {l.state === "active" ? <Spinner /> : null}
            </span>
            <div className="leg-body">
              <div className="leg-head">
                <span className="leg-label">{l.label}</span>
                <span className="chip">{l.chain}</span>
                {l.simulated && l.state !== "next" && <span className="chip">simulated</span>}
              </div>
              {l.detail && l.state !== "next" && <div className="leg-detail">{l.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- panel

type Flow = {
  deposit?: { hash: Hash; token: string; raw: bigint; shares: bigint; simulated: boolean; receiptsBefore?: number; credited?: boolean };
  pay?: { digest: string; blobId?: string; shares: bigint; payee: string; batchId?: string; seq?: number; applied?: boolean; simulated: boolean };
  withdraw?: {
    digest: string;
    commitment: string;
    shares: bigint;
    target: string;
    fromBlock?: bigint;
    settled?: { hash: Hash; amountOut: bigint; sharesDebited: bigint };
    skipped?: Hash;
    debited?: boolean;
    /** Sui total_shares when the withdrawal was submitted; only debit_withdrawal lowers it. */
    totalAtSubmit?: bigint;
    simulated: boolean;
  };
};

export function Send(props: { d: Deployment | undefined; demo?: boolean }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      {/* dapp-kit 1.x wants a JSON-RPC client for its own hooks; reads and execution here go through gRPC. */}
      <SuiClientProvider
        networks={{ testnet: { url: SUI_RPC, network: "testnet" } }}
        createClient={(_n, c: { url: string }) => new SuiJsonRpcClient({ url: c.url, network: "testnet" })}
        defaultNetwork="testnet"
      >
        <SuiWalletProvider autoConnect>
          <SendPanel d={props.d} demo={props.demo ?? (config.useMocks || !injected())} />
        </SuiWalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}

/** Descriptor for the panel list (Portfolio · Move · Send · Liquidity). */
export const sendPanel = { key: "Send", param: "send", Panel: Send } as const;

function SendPanel({ d, demo }: { d: Deployment | undefined; demo: boolean }) {
  const w = useWallet();
  const sui = useCurrentAccount();
  const live = !demo && config.network === "unichain-sepolia";
  const pool = useSuiPool(!config.useMocks);
  const reserves = useReserves();
  const fees = useApi("fees");
  const rpc = useMemo(() => createPublicClient({ transport: http(new URL(config.rpcUrl, location.origin).href) }), []);
  const tx = useTx<string>();
  const [stage, setStage] = useState<Stage>("Deposit");
  const [flow, setFlow] = useState<Flow>({});
  const assets = useAssets(d);
  const [assetIx, setAssetIx] = useState(0);
  const asset = assets.data?.[assetIx];
  const tokens = asset?.platforms;
  // Demo without an injected wallet: EVM legs simulate here, as the deployment's demo account.
  const evmSimulated = demo && !injected();
  const evmAccount = (w.address ?? (evmSimulated ? d?.demoAccounts.accounts.find((a) => a.role === "demo")?.address : undefined)) as Address | undefined;

  // ---- balances
  const suiAddress = normalizeSuiAddress(sui?.address ?? sd.demoAccounts.suiPayer);
  const [balance, setBalance] = useState<{ status: "idle" | "loading" | "ok" | "unavailable"; value?: bigint; verified?: boolean; seq?: number }>({
    status: demo ? "ok" : "idle",
    value: demo ? 0n : undefined,
  });
  // Demo: the sender's and the recipient's Sui balances, moved by the simulated legs.
  const demoBalances = useRef({ sender: 0n, recipient: 0n });
  const sessionKeys = useRef(new Map<string, SessionKey>());
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const decrypt = useCallback(async () => {
    if (demo) return setBalance({ status: "ok", value: demoBalances.current.sender, verified: true });
    if (!sui) return;
    setBalance((b) => ({ ...b, status: "loading" }));
    try {
      const p = await readPool(grpc, sd.sui.poolId);
      if (!p.manifestBlob) return setBalance({ status: "ok", value: 0n, verified: true, seq: p.batchSeq });
      const m = await manifestOf(p.manifestBlob);
      const proof = leafProof(m, sui.address);
      if (!proof) return setBalance({ status: "ok", value: 0n, verified: m.root === p.entriesRoot, seq: m.seq });
      const ct = Uint8Array.from(atob(proof.ct), (c) => c.charCodeAt(0));
      const hash = leafHash(normalizeSuiAddress(sui.address), ct);
      const verified = hash === proof.hash && verifyPath(hash, proof.path, proof.root) && proof.root === p.entriesRoot;
      let key = sessionKeys.current.get(sui.address);
      if (!key || key.isExpired()) {
        key = await SessionKey.create({ address: sui.address, packageId: sd.sui.packageId, ttlMin: 10, suiClient: grpc });
        const { signature } = await signPersonalMessage({ message: key.getPersonalMessage() });
        await key.setPersonalMessageSignature(signature);
        sessionKeys.current.set(sui.address, key);
      }
      const { id } = EncryptedObject.parse(ct);
      const txBytes = await sealApproveLeafTx(sd.sui.packageId, sd.sui.poolId, id).build({ client: grpc, onlyTransactionKind: true });
      const leaf = decodeJson<Leaf>(await seal.decrypt({ data: ct, sessionKey: key, txBytes }));
      setBalance({ status: "ok", value: BigInt(leaf.balance), verified, seq: leaf.seq });
    } catch {
      setBalance((b) => ({ ...b, status: "unavailable" }));
    }
  }, [demo, sui, signPersonalMessage]);
  // Re-decrypt when the Sui root moves, once the holder has opened their balance.
  const root = pool.data?.pool.entriesRoot;
  const opened = balance.status === "ok";
  useEffect(() => {
    if (!demo && opened) void decrypt();
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, setDemoTick] = useState(0);
  const creditDemo = (who: "sender" | "recipient", delta: bigint) => {
    demoBalances.current[who] += delta;
    setDemoTick((t) => t + 1);
  };

  // ---- Sui signing
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) => {
      const r = await grpc.core.executeTransaction({ transaction: fromBase64(bytes), signatures: [signature], include: { effects: true } });
      const t = r.Transaction ?? r.FailedTransaction!;
      if (!t.status.success) throw new Error("Sui transaction failed");
      return { digest: t.digest };
    },
  });
  const sealAndSubmit = async (instruction: Instruction) => {
    const p = await readPool(grpc, sd.sui.poolId);
    if (p.paused) throw new Error("The pool is paused");
    const prepared = await prepareInstruction({ seal, packageId: sd.sui.packageId, poolId: sd.sui.poolId, batchId: p.currentBatch, instruction, walrusPut });
    prepared.tx.setSender(sui!.address);
    const { digest } = await signAndExecute({ transaction: toBase64(await prepared.tx.build({ client: grpc })) });
    await grpc.core.waitForTransaction({ digest });
    pool.reload();
    return { digest, blobId: prepared.blobId, commitment: prepared.commitment, batchId: p.currentBatch };
  };

  // ---- deposit stage
  const [depToken, setDepToken] = useState(0);
  const [depInput, setDepInput] = useState("");
  const dt = tokens?.[depToken];
  const depRaw = useMemo(() => {
    if (!dt) return undefined;
    try {
      const v = parseUnits(depInput.trim() || "0", dt.decimals);
      return v > 0n ? v : undefined;
    } catch {
      return undefined;
    }
  }, [depInput, dt]);
  const depShares = dt && depRaw ? canonical.toSharesDown(depRaw, BigInt(dt.sharesPerTokenX18), dt.decimals) : undefined;
  const depBalance = dt && w.balances.status === "ok" ? (w.balances.values[dt.address] ?? 0n) : undefined;
  const doDeposit = () =>
    tx.run("Deposit", async (onHash) => {
      const receiptsBefore = pool.data?.pool.receipts;
      let sent: { hash: Hash; simulated: boolean };
      if (evmSimulated) {
        await pause(700);
        sent = { hash: fakeEvmHash(), simulated: true };
        onHash(sent.hash);
        await pause(700);
      } else {
        await approve(d!, evmAccount!, dt!.address, sd.evm.shareVault, depRaw!);
        sent = await send(d!, evmAccount!, sd.evm.shareVault, vaultAbi, "deposit", [dt!.address, depRaw!, suiAddress], { onHash });
      }
      w.adjust(dt!.address, -depRaw!);
      setDepInput("");
      setFlow({ deposit: { hash: sent.hash, token: dt!.symbol, raw: depRaw!, shares: depShares!, simulated: sent.simulated || demo, receiptsBefore } });
      if (sent.simulated || demo) {
        await pause(900);
        creditDemo("sender", depShares!);
        setFlow((f) => ({ ...f, deposit: { ...f.deposit!, credited: true } }));
      }
      return { hash: sent.hash, simulated: sent.simulated, result: "deposited" };
    });
  // Live: the keeper's credit shows up as a new single-use receipt on the Sui pool.
  useEffect(() => {
    const dep = flow.deposit;
    if (!dep || dep.credited || dep.simulated || dep.receiptsBefore === undefined) return;
    if ((pool.data?.pool.receipts ?? 0) > dep.receiptsBefore) setFlow((f) => ({ ...f, deposit: { ...f.deposit!, credited: true } }));
  }, [pool.data?.pool.receipts, flow.deposit]);

  // ---- pay stage
  const [payee, setPayee] = useState(sd.demoAccounts.suiPayee);
  const [payInput, setPayInput] = useState("");
  const payShares = parseShares(payInput);
  const payeeOk = /^0x[0-9a-fA-F]{1,64}$/.test(payee);
  const doPay = () =>
    tx.run("Sealed send", async () => {
      if (demo) {
        await pause(700);
        const digest = fakeDigest();
        const seq = (pool.data?.pool.batchSeq ?? 0) + 1;
        setFlow((f) => ({ ...f, pay: { digest, shares: payShares!, payee, seq, simulated: true } }));
        await pause(900);
        creditDemo("sender", -payShares!);
        creditDemo("recipient", payShares!);
        setFlow((f) => ({ ...f, pay: { ...f.pay!, applied: true } }));
        setPayInput("");
        return { simulated: true, result: digest };
      }
      const r = await sealAndSubmit({ v: 1, kind: "pay", to: normalizeSuiAddress(payee), shares: payShares!.toString(), nonce: crypto.randomUUID() });
      setFlow((f) => ({ ...f, pay: { digest: r.digest, blobId: r.blobId, shares: payShares!, payee, batchId: r.batchId, simulated: false } }));
      setPayInput("");
      return { simulated: false, result: r.digest };
    });
  useEffect(() => {
    const p = flow.pay;
    if (!p || p.applied || p.simulated || !p.batchId) return;
    void readBatch(grpc, p.batchId).then(
      (b) => b.applied && setFlow((f) => ({ ...f, pay: { ...f.pay!, applied: true, seq: b.seq } })),
      () => undefined,
    );
  }, [pool.data?.pool.batchSeq, flow.pay]);

  // ---- withdraw stage
  const [wdToken, setWdToken] = useState(0);
  const [wdInput, setWdInput] = useState("");
  const wt = tokens?.[wdToken];
  const src = tokens?.[wdToken === 0 ? 1 : 0];
  const wdShares = parseShares(wdInput);
  const recipient = evmAccount;
  const feePips = fees.data ? BigInt(fees.data.fee.totalPips) : undefined;
  const [liveQuote, setLiveQuote] = useState<{ amountIn: bigint; sharesDebited: bigint; feePips: number; direct: boolean } | "unavailable" | undefined>();
  useEffect(() => {
    setLiveQuote(undefined);
    if (!live || !wt || !wdShares) return;
    let on = true;
    const t = setTimeout(() => {
      rpc
        .readContract({ address: sd.evm.shareVault, abi: vaultAbi, functionName: "quoteWithdrawal", args: [wt.address, wdShares] })
        .then(([amountIn, sharesDebited, fp, direct]) => on && setLiveQuote({ amountIn, sharesDebited, feePips: Number(fp), direct }))
        .catch(() => on && setLiveQuote("unavailable"));
    }, 300);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [live, wt, wdShares, rpc]);
  // Demo (and live fallback): the hook's exact-output quote from the live fee feed and the deployment's multipliers.
  const quote = useMemo(() => {
    if (!wt || !src || !wdShares) return undefined;
    const tSide = { spt: BigInt(wt.sharesPerTokenX18), decimals: wt.decimals };
    const sSide = { spt: BigInt(src.sharesPerTokenX18), decimals: src.decimals };
    const net = canonical.fromSharesDown(wdShares, tSide.spt, tSide.decimals);
    if (liveQuote && liveQuote !== "unavailable") {
      return { net, direct: liveQuote.direct, feePips: liveQuote.feePips, sharesDebited: liveQuote.sharesDebited, source: "vault" as const };
    }
    if (feePips === undefined) return undefined;
    const q = canonical.parityQuote(sSide, tSide, net, feePips);
    return { net, direct: false, feePips: Number(feePips), sharesDebited: canonical.toSharesUp(q.amountIn, sSide.spt, sSide.decimals), source: "feed" as const };
  }, [wt, src, wdShares, liveQuote, feePips]);
  const doWithdraw = () =>
    tx.run("Sealed withdrawal", async () => {
      if (demo) {
        await pause(700);
        const digest = fakeDigest();
        setFlow((f) => ({ ...f, withdraw: { digest, commitment: fakeEvmHash(), shares: wdShares!, target: wt!.symbol, simulated: true } }));
        await pause(900);
        creditDemo("recipient", -quote!.sharesDebited);
        setFlow((f) => ({ ...f, withdraw: { ...f.withdraw!, settled: { hash: fakeEvmHash(), amountOut: quote!.net, sharesDebited: quote!.sharesDebited } } }));
        w.adjust(wt!.address, quote!.net);
        await pause(700);
        setFlow((f) => ({ ...f, withdraw: { ...f.withdraw!, debited: true } }));
        setWdInput("");
        return { simulated: true, result: digest };
      }
      const fromBlock = await rpc.getBlockNumber();
      const totalAtSubmit = (await readPool(grpc, sd.sui.poolId)).totalShares;
      const r = await sealAndSubmit({ v: 1, kind: "withdraw", recipient: recipient!, target: wt!.address, shares: wdShares!.toString(), maxFeeBps: 25, nonce: crypto.randomUUID() });
      setFlow((f) => ({ ...f, withdraw: { digest: r.digest, commitment: r.commitment, shares: wdShares!, target: wt!.symbol, fromBlock, totalAtSubmit, simulated: false } }));
      setWdInput("");
      return { simulated: false, result: r.digest };
    });
  // Live: settlement lands as a ShareVault event on Unichain; the debit on Sui brings reserves back to 1:1.
  const wd = flow.withdraw;
  useEffect(() => {
    if (!wd || wd.simulated || wd.settled || wd.skipped) return;
    let on = true;
    const poll = async () => {
      const args = { commitment: wd.commitment as Hash };
      const [s, k] = await Promise.all([
        rpc.getContractEvents({ address: sd.evm.shareVault, abi: vaultAbi, eventName: "WithdrawalSettled", args, fromBlock: wd.fromBlock }),
        rpc.getContractEvents({ address: sd.evm.shareVault, abi: vaultAbi, eventName: "WithdrawalSkipped", args, fromBlock: wd.fromBlock }),
      ]);
      if (!on) return;
      if (s[0]) {
        setFlow((f) => ({ ...f, withdraw: { ...f.withdraw!, settled: { hash: s[0].transactionHash!, amountOut: s[0].args.amountOut!, sharesDebited: s[0].args.sharesDebited! } } }));
        w.adjust(s[0].args.targetIssuerToken as Address, 0n); // live wallets refresh balances on adjust
      } else if (k[0]) setFlow((f) => ({ ...f, withdraw: { ...f.withdraw!, skipped: k[0].transactionHash! } }));
    };
    const t = setInterval(() => void poll().catch(() => undefined), 4000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [wd, rpc]); // eslint-disable-line react-hooks/exhaustive-deps
  // Settlement on Unichain leaves the Sui total unchanged; the keeper's debit_withdrawal is what lowers it.
  const suiTotal = pool.data?.pool.totalShares;
  useEffect(() => {
    if (wd?.settled && !wd.debited && !wd.simulated && wd.totalAtSubmit !== undefined && suiTotal !== undefined && suiTotal < wd.totalAtSubmit)
      setFlow((f) => ({ ...f, withdraw: { ...f.withdraw!, debited: true } }));
  }, [wd, suiTotal]);

  // ---- window countdown
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const windowMs = pool.data?.pool.windowMs ?? sd.sui.windowMs;
  const closes = pool.data?.batch.closesMs || 0;
  const left = closes ? Math.max(0, closes - now) : undefined;

  // In demo the Withdraw step is the recipient's view; live, the recipient connects their own Sui wallet.
  const viewer: "sender" | "recipient" = demo && stage === "Withdraw" ? "recipient" : "sender";
  const viewBalance = demo ? demoBalances.current[viewer] : balance.value;
  const known = demo || balance.status === "ok";

  // ---- the one primary action per stage
  const needSui = !demo && !sui;
  const primary: { label: string; disabled: boolean; onClick?: () => void; suiConnect?: boolean } = (() => {
    if (tx.state.step === "signing") return { label: "Confirm in wallet…", disabled: true };
    if (tx.state.step === "pending") return { label: "Waiting for confirmation…", disabled: true };
    if (stage === "Deposit") {
      if (!d) return { label: "Connecting…", disabled: true };
      if (!evmAccount) return { label: w.busy === "connect" ? "Connecting…" : "Connect to deposit", disabled: !!w.busy, onClick: () => void w.connect() };
      if (!evmSimulated && w.wrongChain) return { label: `Switch to ${w.expected.name}`, disabled: !!w.busy, onClick: () => void w.switchChain() };
      if (needSui) return { label: "Connect Sui wallet", disabled: false, suiConnect: true };
      if (!depRaw) return { label: "Enter an amount", disabled: true };
      if (depBalance !== undefined && depRaw > depBalance) return { label: `Insufficient ${dt!.symbol}`, disabled: true };
      return { label: `Deposit ${amount(depRaw, dt!.decimals, 4)} ${dt!.symbol}`, disabled: false, onClick: () => void doDeposit() };
    }
    if (needSui) return { label: "Connect Sui wallet", disabled: false, suiConnect: true };
    if (stage === "Send") {
      if (!payeeOk) return { label: "Enter a Sui address", disabled: true };
      if (!payShares) return { label: "Enter shares", disabled: true };
      if (known && viewBalance !== undefined && payShares > viewBalance) return { label: "Insufficient balance", disabled: true };
      return { label: `Send ${shares(payShares, 4)} ${asset?.asset ?? ""} shares`, disabled: false, onClick: () => void doPay() };
    }
    if (!evmAccount) return { label: "Connect the receiving wallet", disabled: !!w.busy, onClick: () => void w.connect() };
    if (!wdShares) return { label: "Enter shares", disabled: true };
    if (!quote) return { label: "Quoting…", disabled: true };
    if (quote.feePips > 2500) return { label: "Fee above your maximum", disabled: true };
    if (known && viewBalance !== undefined && quote.sharesDebited > viewBalance) return { label: "Insufficient balance", disabled: true };
    return { label: `Withdraw to ${platformName(wt!.issuer)}`, disabled: false, onClick: () => void doWithdraw() };
  })();
  const primaryButton = (
    <button className="primary wide" disabled={primary.disabled} onClick={primary.onClick} data-testid="send-primary">
      {tx.busy && <Spinner />} {primary.label}
    </button>
  );

  // ---- tracker legs
  const dep = flow.deposit,
    pay = flow.pay;
  const legs: Leg[] = [
    {
      key: "deposit",
      label: dep ? `Deposited ${amount(dep.raw, tokens?.find((t) => t.symbol === dep.token)?.decimals ?? 18, 4)} ${dep.token}` : "Deposit into ShareVault",
      chain: "Unichain",
      state: dep ? "done" : stage === "Deposit" ? "active" : "next",
      simulated: dep?.simulated,
      detail: dep && <Hex value={dep.hash} kind="tx" simulated={dep.simulated} />,
    },
    {
      key: "credit",
      label: dep ? `Credited ${sharesWord(dep.shares)}` : "Keeper credits shares",
      chain: "Sui",
      state: dep?.credited ? "done" : dep ? "active" : "next",
      simulated: dep?.simulated,
      detail: dep?.credited && !dep.simulated && <SuiRef value={sd.sui.poolId} kind="object" />,
    },
    {
      key: "pay",
      label: pay ? `Sent ${sharesWord(pay.shares)} to ${shortHex(pay.payee)}, sealed` : "Sealed send",
      chain: "Sui",
      state: pay ? "done" : dep?.credited && stage === "Send" ? "active" : "next",
      simulated: pay?.simulated,
      detail: pay && <SuiRef value={pay.digest} kind="tx" simulated={pay.simulated} />,
    },
    {
      key: "batch",
      label: pay?.applied ? `Batch ${pay.seq ?? ""} applied · total unchanged` : "Batch closes and applies",
      chain: "Sui",
      state: pay?.applied ? "done" : pay ? "active" : "next",
      simulated: pay?.simulated,
    },
    {
      key: "withdraw",
      label: wd ? `Recipient withdrew ${sharesWord(wd.shares)} as ${wd.target}` : "Recipient withdraws",
      chain: "Sui",
      state: wd ? "done" : stage === "Withdraw" && pay?.applied ? "active" : "next",
      simulated: wd?.simulated,
      detail: wd && <SuiRef value={wd.digest} kind="tx" simulated={wd.simulated} />,
    },
    {
      key: "settle",
      label: wd?.settled
        ? `Delivered ${amount(wd.settled.amountOut, tokens?.find((t) => t.symbol === wd.target)?.decimals ?? 18, 6)} ${wd.target}`
        : wd?.skipped
          ? "Skipped · credit restored on Sui"
          : "Delivered through the router",
      chain: "Unichain",
      state: wd?.settled || wd?.skipped ? "done" : wd ? "active" : "next",
      simulated: wd?.simulated,
      detail: (wd?.settled || wd?.skipped) && <Hex value={(wd.settled?.hash ?? wd.skipped)!} kind="tx" simulated={wd.simulated} />,
    },
    {
      key: "debit",
      label: wd?.settled ? `Debited ${sharesWord(wd.settled.sharesDebited, 6)}` : "Keeper debits Sui",
      chain: "Sui",
      state: wd?.debited ? "done" : wd?.settled ? "active" : "next",
      simulated: wd?.simulated,
    },
  ];

  const stageDone: Record<Stage, boolean> = { Deposit: !!dep?.credited, Send: !!pay?.applied, Withdraw: !!wd?.debited };
  const walletSui = demo ? (viewer === "recipient" ? normalizeSuiAddress(payee) : sd.demoAccounts.suiPayer) : sui?.address;

  return (
    <div className="send-panel">
      <section className="card swap send" aria-labelledby="send-title">
        <div className="card-head">
          <h2 id="send-title" className="send-title">
            Send shares to someone
          </h2>
          {assets.data && assets.data.length > 1 ? (
            <select className="token" aria-label="Asset" value={assetIx} onChange={(e) => setAssetIx(Number(e.target.value))}>
              {assets.data.map((a, i) => (
                <option key={a.asset} value={i}>
                  {a.asset}
                </option>
              ))}
            </select>
          ) : (
            <span className="chip">
              <Val status={assets.status} w="3em">
                {asset?.asset}
              </Val>
            </span>
          )}
        </div>
        <div className="actions steps send-stages" role="tablist" aria-label="Send steps">
          {STAGES.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={stage === s}
              className={`send-stage${stage === s ? " on" : ""}${stageDone[s] ? " done" : ""}`}
              onClick={() => {
                setStage(s);
                if (!tx.busy) tx.reset();
              }}
            >
              <span className="send-stage-name">{s}</span>
              <small>{CHAIN_OF[s]}</small>
            </button>
          ))}
        </div>

        <div className="send-balances">
          <div className="field">
            <div className="field-top">
              <span className="field-label">{viewer === "recipient" ? "Recipient balance" : "Balance"}</span>
              {walletSui && <SuiRef value={walletSui} kind="account" simulated={demo} />}
            </div>
            <div className="field-row">
              <output className="amount" aria-label="Sui balance">
                {balance.status === "idle" ? (
                  <button type="button" className="ghost-btn" disabled={!sui} onClick={() => void decrypt()}>
                    Decrypt
                  </button>
                ) : (
                  <Val status={balance.status === "loading" ? "loading" : balance.status === "ok" ? "ok" : "unavailable"} w="5em" h="1.1em">
                    {shares(viewBalance ?? 0n)}
                  </Val>
                )}
                <span className="unit"> shares</span>
              </output>
            </div>
            {balance.status === "ok" && !demo && (
              <p className={`caption ${balance.verified ? "good" : "bad"}`}>{balance.verified ? `Seal-decrypted · proof checked · batch ${balance.seq}` : "Proof did not verify"}</p>
            )}
          </div>
          <div className="field">
            <div className="field-top">
              <span className="field-label">Reserves</span>
              {reserves.data && <span className={`chip ${reserves.data.invariant ? "good" : "warn"}`}>{reserves.data.invariant ? "1:1" : "settling"}</span>}
            </div>
            <div className="field-row">
              <output className="amount" aria-label="Shares backed">
                <Val status={reserves.status === "ok" ? "ok" : reserves.status} w="5em" h="1.1em">
                  {shares(BigInt(reserves.data?.suiTotalShares ?? "0"))}
                </Val>
                <span className="unit"> backed</span>
              </output>
            </div>
          </div>
        </div>

        {stage === "Deposit" && (
          <div className="field">
            <div className="field-top">
              <span className="field-label">Deposit from</span>
              {evmAccount && dt && w.balances.status !== "unavailable" && w.address && (
                <span className="balance">
                  Balance{" "}
                  <Val status={w.balances.status} w="4em">
                    {amount(depBalance ?? 0n, dt.decimals, 4)}
                  </Val>
                  {depBalance !== undefined && depBalance > 0n && (
                    <button type="button" className="max" onClick={() => setDepInput(formatUnits(depBalance, dt.decimals))}>
                      Max
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="field-row">
              <input className="amount" aria-label="Deposit amount" inputMode="decimal" placeholder="0" value={depInput} onChange={(e) => setDepInput(e.target.value)} />
              <select className="token" aria-label="Deposit token" value={depToken} onChange={(e) => setDepToken(Number(e.target.value))}>
                {tokens?.map((t, i) => (
                  <option key={t.address} value={i}>
                    {platformName(t.issuer)} · {t.symbol}
                  </option>
                ))}
              </select>
            </div>
            {depShares !== undefined && <p className="caption">= {shares(depShares)} shares on Sui</p>}
          </div>
        )}

        {stage === "Send" && (
          <>
            <div className="field">
              <div className="field-top">
                <span className="field-label">Recipient (Sui address)</span>
                {payee === sd.demoAccounts.suiPayee && <span className="caption">demo recipient</span>}
              </div>
              <div className="field-row">
                <input className="amount mono send-address" aria-label="Recipient Sui address" spellCheck={false} value={payee} onChange={(e) => setPayee(e.target.value.trim())} />
              </div>
            </div>
            <div className="field">
              <div className="field-top">
                <span className="field-label">Shares</span>
              </div>
              <div className="field-row">
                <input className="amount" aria-label="Shares to send" inputMode="decimal" placeholder="0" value={payInput} onChange={(e) => setPayInput(e.target.value)} />
              </div>
            </div>
            <div className="send-window" aria-live="polite">
              <div className="field-top">
                <span className="field-label">Sealed for {windowMs / 1000} s · batching for privacy</span>
                <span className="mono">
                  {demo ? "simulated" : left === undefined ? "opens on the next send" : left > 0 ? `${Math.floor(left / 60000)}:${String(Math.ceil((left % 60000) / 1000)).padStart(2, "0")}` : "sealed · applying"}
                </span>
              </div>
              <div className="send-bar">
                <div style={{ width: `${left === undefined || demo ? 0 : 100 - (left / windowMs) * 100}%` }} />
              </div>
            </div>
          </>
        )}

        {stage === "Withdraw" && (
          <>
            <div className="field">
              <div className="field-top">
                <span className="field-label">Recipient withdraws</span>
                {wt && w.address && w.balances.status === "ok" && (
                  <span className="balance">
                    Holding {amount(w.balances.values[wt.address] ?? 0n, wt.decimals, 4)} {wt.symbol}
                  </span>
                )}
              </div>
              <div className="field-row">
                <input className="amount" aria-label="Shares to withdraw" inputMode="decimal" placeholder="0" value={wdInput} onChange={(e) => setWdInput(e.target.value)} />
                <select className="token" aria-label="Deliver on platform" value={wdToken} onChange={(e) => setWdToken(Number(e.target.value))}>
                  {tokens?.map((t, i) => (
                    <option key={t.address} value={i}>
                      {platformName(t.issuer)} · {t.symbol}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {quote && wt && (
              <dl className="send-quote">
                <div>
                  <dt>You receive</dt>
                  <dd>
                    {amount(quote.net, wt.decimals, 6)} {wt.symbol}
                  </dd>
                </div>
                <div>
                  <dt>Route</dt>
                  <dd>{quote.direct ? "From custody" : "Router → ParityHook"}</dd>
                </div>
                <div>
                  <dt>Fee</dt>
                  <dd>{quote.direct ? "0.00" : canonical.pipsToBps(quote.feePips)} bps</dd>
                </div>
                <div>
                  <dt>Debit</dt>
                  <dd>{shares(quote.sharesDebited, 6)} shares</dd>
                </div>
              </dl>
            )}
            {liveQuote === "unavailable" && quote?.source === "feed" && <p className="caption">Vault quote unavailable; priced from the live fee feed.</p>}
          </>
        )}

        {primary.suiConnect ? <ConnectModal trigger={primaryButton} /> : primaryButton}
        {/* The tracker below is the receipt; the tx panel covers signing, pending and failure. */}
        {tx.state.step !== "confirmed" && <TxPanel tx={tx.state} onRetry={tx.retry} />}
      </section>
      <Tracker legs={legs} />
    </div>
  );
}

