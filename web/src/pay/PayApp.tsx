import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ConnectButton,
  SuiClientProvider,
  WalletProvider,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import "@mysten/dapp-kit/dist/index.css";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { EncryptedObject, SealClient, SessionKey } from "@mysten/seal";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseUnits,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { unichainSepolia } from "viem/chains";
import deployment from "../../../deployments/sui-testnet.json";
import { config } from "../config";
import { readBatch, readPool, sealApproveLeafTx, type BatchState, type PoolState } from "../../../services/crank/sui/chain";
import { prepareInstruction } from "../../../services/crank/sui/payer";
import { leafHash, verifyPath } from "../../../services/crank/sui/merkle";
import {
  decodeJson,
  formatShares,
  leafProof,
  normalizeSuiAddress,
  parseShares,
  unb64,
  type Instruction,
  type Leaf,
  type Manifest,
} from "../../../services/crank/sui/protocol";
import "./pay.css";

// Unison Pay, one page: Deposit (Unichain) -> Pay (Sui) -> Withdraw (Unichain).
// Sui state is read straight from a fullnode; balances are decrypted in this browser with Seal. The only API call is
// /pay/reserves, the cross-chain solvency check.

type Token = { symbol: string; address: Hex; decimals: number };
type Dep = {
  sui: { packageId: string; poolId: string; windowMs: number };
  seal: { threshold: number; keyServers: { name: string; objectId: string }[] };
  walrus: { publisher: string; aggregator: string };
  evm: { chainId: number; shareVault: Hex; explorer: string; tokens: Token[] };
  demoAccounts?: { suiPayer: string; suiPayee: string };
};
const dep = deployment as unknown as Dep;
const SUI_RPC = "https://fullnode.testnet.sui.io:443";
const grpc = new SuiGrpcClient({ network: "testnet", baseUrl: SUI_RPC });
const seal = new SealClient({
  suiClient: grpc,
  serverConfigs: dep.seal.keyServers.map((k) => ({ objectId: k.objectId, weight: 1 })),
  verifyKeyServers: false,
  timeout: 20_000,
});
// publicnode: sepolia.unichain.org backends disagree on recent state (see services/crank/sui/config.ts).
const evmRead = createPublicClient({ chain: unichainSepolia, transport: http("https://unichain-sepolia-rpc.publicnode.com") });
const vaultAbi = parseAbi([
  "function deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) returns (uint256)",
  "function quoteWithdrawal(address target, uint256 shares) view returns (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct)",
  "event WithdrawalSettled(bytes32 indexed commitment, address indexed recipient, address indexed targetIssuerToken, address sourceIssuerToken, uint256 amountIn, uint256 amountOut, uint256 sharesDebited)",
  "event WithdrawalSkipped(bytes32 indexed commitment, bytes reason)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const suiscan = (kind: "tx" | "object" | "account", id: string) => `https://suiscan.xyz/testnet/${kind}/${id}`;
const uniscan = (kind: "tx" | "address", id: string) => `${dep.evm.explorer}/${kind}/${id}`;
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
const errText = (e: any) => String(e?.shortMessage ?? e?.message ?? e);

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  );
}

// ---------------------------------------------------------------- live Sui state

function useSuiPool() {
  const [s, set] = useState<{ pool?: PoolState; batch?: BatchState; error?: string }>({});
  const load = useCallback(async () => {
    try {
      const pool = await readPool(grpc, dep.sui.poolId);
      const batch = await readBatch(grpc, pool.currentBatch);
      set({ pool, batch });
    } catch (e) {
      set((p) => ({ ...p, error: errText(e) }));
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, [load]);
  return { ...s, reload: load };
}
type SuiPool = ReturnType<typeof useSuiPool>;

const manifestCache = new Map<string, Manifest>();
async function manifestOf(blobId: string): Promise<Manifest> {
  const hit = manifestCache.get(blobId);
  if (hit) return hit;
  const r = await fetch(`${dep.walrus.aggregator}/v1/blobs/${blobId}`);
  if (!r.ok) throw Error(`Walrus read failed (${r.status})`);
  const m = (await r.json()) as Manifest;
  manifestCache.set(blobId, m);
  return m;
}

async function walrusPut(data: Uint8Array) {
  const r = await fetch(`${dep.walrus.publisher}/v1/blobs?epochs=5`, { method: "PUT", body: data as BodyInit });
  if (!r.ok) throw Error(`Walrus upload failed (${r.status})`);
  const j = await r.json();
  return { blobId: (j.newlyCreated?.blobObject.blobId ?? j.alreadyCertified?.blobId) as string };
}

// ---------------------------------------------------------------- EVM wallet (injected, MetaMask)

const injected = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
const CHAIN_HEX = `0x${dep.evm.chainId.toString(16)}`;

function useEvmWallet() {
  const [address, setAddress] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setError(null);
    const p = injected();
    if (!p) return setError("No injected Ethereum wallet. Install MetaMask.");
    try {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
      } catch (e: any) {
        if (e?.code !== 4902) throw e;
        await p.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_HEX,
              chainName: "Unichain Sepolia",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: ["https://sepolia.unichain.org"],
              blockExplorerUrls: [dep.evm.explorer],
            },
          ],
        });
      }
      const [a] = (await p.request({ method: "eth_requestAccounts" })) as Hex[];
      if (!a) throw Error("Wallet returned no account");
      setAddress(a);
    } catch (e) {
      setError(errText(e));
    }
  };
  useEffect(() => {
    const p = injected() as any;
    const onAccounts = (a: Hex[]) => setAddress(a[0] ?? null);
    p?.on?.("accountsChanged", onAccounts);
    return () => p?.removeListener?.("accountsChanged", onAccounts);
  }, []);
  const write = async (args: Parameters<ReturnType<typeof createWalletClient>["writeContract"]>[0]) => {
    const w = createWalletClient({ account: address!, chain: unichainSepolia, transport: custom(injected()!) });
    const hash = await w.writeContract(args as any);
    const r = await evmRead.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw Error(`Transaction reverted: ${hash}`);
    return hash;
  };
  return { address, error, connect, write };
}
type EvmWallet = ReturnType<typeof useEvmWallet>;

// ---------------------------------------------------------------- header pieces

type Reserves = { suiTotalShares: string; vaultShares: string; vaultSharesHeld: string; invariant: boolean; checkedBlock: string };
function ReservesBadge() {
  const [r, set] = useState<{ data?: Reserves; error?: string }>({});
  useEffect(() => {
    let live = true;
    const run = () =>
      fetch(`${config.apiUrl}/pay/reserves`)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw Error(body?.error?.message ?? `HTTP ${res.status}`);
          if (live) set({ data: body });
        })
        .catch((e) => live && set((p) => ({ ...p, error: errText(e) })));
    run();
    const t = setInterval(run, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!r.data) return <span className="pay-badge warn">{r.error ? "Reserves unavailable" : "Reserves…"}</span>;
  return (
    <span
      className={`pay-badge ${r.data.invariant ? "ok" : "bad"}`}
      title={`Sui credits ${formatShares(r.data.suiTotalShares, 6)} · vault ${formatShares(r.data.vaultShares, 6)} · held ${formatShares(r.data.vaultSharesHeld, 6)} · block ${r.data.checkedBlock}`}
      data-testid="reserves"
    >
      {r.data.invariant ? "Reserves 1:1" : "Reserves mismatch"} · {formatShares(r.data.suiTotalShares, 4)} shares backed
    </span>
  );
}

function Countdown({ batch, windowMs }: { batch?: BatchState; windowMs: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!batch) return null;
  const idle = !batch.closesMs;
  const left = idle ? windowMs : Math.max(0, batch.closesMs - now);
  const pct = idle ? 0 : 100 - (left / windowMs) * 100;
  const secs = Math.ceil(left / 1000);
  return (
    <div className="pay-window" data-testid="countdown">
      <div className="pay-window-row">
        <span className="pay-window-label">batching for privacy</span>
        <strong>
          {idle ? "waiting for first payment" : left > 0 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "sealed, keeper applying…"}
        </strong>
      </div>
      <div className="pay-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="pay-muted">
        Batch {batch.seq} · {batch.instructions.length} sealed instruction{batch.instructions.length === 1 ? "" : "s"}. Nobody can
        open them, not even the keeper, until the {windowMs / 1000}s window closes.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- Sui signing

function useSealedSubmit() {
  const account = useCurrentAccount();
  const { mutateAsync } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) => {
      const r = await grpc.core.executeTransaction({ transaction: fromBase64(bytes), signatures: [signature], include: { effects: true } });
      const t = r.Transaction ?? r.FailedTransaction!;
      if (!t.status.success) throw Error(`Transaction failed: ${JSON.stringify(t.status.error)}`);
      return { digest: t.digest };
    },
  });
  return async (instruction: Instruction) => {
    if (!account) throw Error("Connect a Sui wallet first");
    const pool = await readPool(grpc, dep.sui.poolId);
    if (pool.paused) throw Error("The pool is paused");
    const p = await prepareInstruction({
      seal,
      packageId: dep.sui.packageId,
      poolId: dep.sui.poolId,
      batchId: pool.currentBatch,
      instruction,
      walrusPut,
    });
    p.tx.setSender(account.address);
    const bytes = await p.tx.build({ client: grpc });
    const { digest } = await mutateAsync({ transaction: toBase64(bytes) });
    await grpc.core.waitForTransaction({ digest });
    return { digest, blobId: p.blobId, commitment: p.commitment, batchId: pool.currentBatch };
  };
}

function useSessionKey() {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const [keys] = useState(() => new Map<string, SessionKey>());
  return async () => {
    if (!account) throw Error("Connect a Sui wallet first");
    const hit = keys.get(account.address);
    if (hit && !hit.isExpired()) return hit;
    const k = await SessionKey.create({ address: account.address, packageId: dep.sui.packageId, ttlMin: 10, suiClient: grpc });
    const { signature } = await signPersonalMessage({ message: k.getPersonalMessage() });
    await k.setPersonalMessageSignature(signature);
    keys.set(account.address, k);
    return k;
  };
}

// ---------------------------------------------------------------- balance

type BalanceState = { busy?: boolean; balance?: bigint; seq?: number; verified?: boolean; present?: boolean; error?: string; root?: string };

function useBalance(sui: SuiPool) {
  const account = useCurrentAccount();
  const getKey = useSessionKey();
  const [s, set] = useState<BalanceState>({});
  useEffect(() => set({}), [account?.address]);
  const decrypt = async () => {
    if (!account) return;
    set((p) => ({ ...p, busy: true, error: undefined }));
    try {
      const pool = await readPool(grpc, dep.sui.poolId);
      if (!pool.manifestBlob) return set({ balance: 0n, seq: pool.batchSeq, present: false, verified: true, root: "" });
      const m = await manifestOf(pool.manifestBlob);
      const proof = leafProof(m, account.address);
      if (!proof) return set({ balance: 0n, seq: m.seq, present: false, verified: m.root === pool.entriesRoot, root: pool.entriesRoot });
      const ct = unb64(proof.ct);
      const hash = leafHash(normalizeSuiAddress(account.address), ct);
      const verified = hash === proof.hash && verifyPath(hash, proof.path, proof.root) && proof.root === pool.entriesRoot;
      const key = await getKey();
      const { id } = EncryptedObject.parse(ct);
      const txBytes = await sealApproveLeafTx(dep.sui.packageId, dep.sui.poolId, id).build({ client: grpc, onlyTransactionKind: true });
      const leaf = decodeJson<Leaf>(await seal.decrypt({ data: ct, sessionKey: key, txBytes }));
      set({ balance: BigInt(leaf.balance), seq: leaf.seq, verified, present: true, root: pool.entriesRoot });
    } catch (e) {
      set((p) => ({ ...p, busy: false, error: errText(e) }));
    }
  };
  // Re-decrypt automatically when the on-chain root moves (a credit, a batch, a settlement).
  const root = sui.pool?.entriesRoot;
  useEffect(() => {
    if (s.balance !== undefined && root && root !== s.root && !s.busy) decrypt();
  }, [root]);
  return { ...s, decrypt };
}

function BalanceView({ b }: { b: ReturnType<typeof useBalance> }) {
  const account = useCurrentAccount();
  return (
    <div className="pay-balance" data-testid="balance">
      <div>
        <p className="pay-big">
          {b.balance === undefined ? "•••••" : formatShares(b.balance, 4)} <small>AAPL shares</small>
        </p>
        {b.balance !== undefined && (
          <p className={b.verified ? "pay-good" : "pay-bad"}>
            {b.present ? `Leaf from batch ${b.seq}` : "No leaf yet (zero balance)"} ·{" "}
            {b.verified ? "Merkle proof verified against the Sui root" : "proof did NOT verify"}
          </p>
        )}
        {b.error && <p className="pay-bad" role="alert">{b.error}</p>}
      </div>
      <button className="pay-secondary" disabled={!account || b.busy} onClick={b.decrypt}>
        {!account ? "Connect Sui wallet" : b.busy ? "Decrypting…" : b.balance === undefined ? "Decrypt my balance" : "Refresh"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- step 1: deposit

function Deposit({ evm, sui }: { evm: EvmWallet; sui: SuiPool }) {
  const account = useCurrentAccount();
  const [tokenAddr, setTokenAddr] = useState<Hex>(dep.evm.tokens[0].address);
  const [amount, setAmount] = useState("2");
  const [recipient, setRecipient] = useState("");
  const [bal, setBal] = useState<bigint | null>(null);
  const [s, set] = useState<{ busy?: string; approveTx?: Hex; depositTx?: Hex; receiptsBefore?: number; error?: string }>({});
  const token = dep.evm.tokens.find((t) => t.address === tokenAddr)!;
  useEffect(() => {
    if (account && !recipient) setRecipient(account.address);
  }, [account?.address]);
  useEffect(() => {
    if (!evm.address) return;
    evmRead.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [evm.address] }).then(setBal, () => setBal(null));
  }, [evm.address, tokenAddr, s.depositTx]);
  let raw = 0n;
  try {
    raw = parseUnits(amount || "0", token.decimals);
  } catch {}
  const valid = !!evm.address && raw > 0n && /^0x[0-9a-fA-F]{1,64}$/.test(recipient);
  const credited = s.receiptsBefore !== undefined && (sui.pool?.receipts ?? 0) > s.receiptsBefore;
  const go = async () => {
    set({ busy: "Checking allowance…", receiptsBefore: sui.pool?.receipts });
    try {
      const allowance = await evmRead.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [evm.address!, dep.evm.shareVault] });
      let approveTx: Hex | undefined;
      if (allowance < raw) {
        set((p) => ({ ...p, busy: "Approve in your wallet…" }));
        approveTx = await evm.write({ address: token.address, abi: erc20Abi, functionName: "approve", args: [dep.evm.shareVault, raw] } as any);
      }
      set((p) => ({ ...p, approveTx, busy: "Deposit in your wallet…" }));
      const depositTx = await evm.write({
        address: dep.evm.shareVault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [token.address, raw, normalizeSuiAddress(recipient)],
      } as any);
      set((p) => ({ ...p, depositTx, busy: undefined }));
    } catch (e) {
      set((p) => ({ ...p, busy: undefined, error: errText(e) }));
    }
  };
  return (
    <section className="pay-card pay-step" aria-labelledby="dep-h" data-testid="step-deposit">
      <div className="pay-step-head">
        <span className="pay-step-num">1</span>
        <div>
          <h2 id="dep-h">Deposit</h2>
          <span className="pay-chain">Unichain Sepolia · MetaMask</span>
        </div>
      </div>
      <p className="pay-muted">Put an issuer's Apple token into ShareVault custody. The keeper credits the same number of canonical shares to your Sui address.</p>
      {!evm.address ? (
        <button className="pay-secondary" onClick={evm.connect}>Connect MetaMask</button>
      ) : (
        <p className="pay-muted">
          MetaMask <Ext href={uniscan("address", evm.address)}>{short(evm.address)}</Ext>
          {bal !== null && ` · ${formatUnits(bal, token.decimals)} ${token.symbol}`}
        </p>
      )}
      {evm.error && <p className="pay-bad" role="alert">{evm.error}</p>}
      <div className="pay-row">
        <label>
          Issuer token
          <select value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value as Hex)}>
            {dep.evm.tokens.map((t) => (
              <option key={t.address} value={t.address}>{t.symbol}</option>
            ))}
          </select>
        </label>
        <label>
          Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      <label>
        Credit to Sui address
        <input value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x… (your Sui account)" spellCheck={false} />
      </label>
      <button className="pay-primary" disabled={!valid || !!s.busy} onClick={go}>
        {s.busy ?? `Deposit ${amount || 0} ${token.symbol}`}
      </button>
      <ul className="pay-receipts">
        {s.approveTx && <li>Approve · <Ext href={uniscan("tx", s.approveTx)}>{short(s.approveTx)}</Ext></li>}
        {s.depositTx && <li>Deposit · <Ext href={uniscan("tx", s.depositTx)}>{short(s.depositTx)}</Ext></li>}
        {s.depositTx && (
          <li className={credited ? "pay-good" : ""}>
            {credited ? "Credited on Sui by the keeper · " : "Waiting for the keeper to credit Sui… "}
            <Ext href={suiscan("object", dep.sui.poolId)}>Pool</Ext>
          </li>
        )}
      </ul>
      {s.error && <p className="pay-bad" role="alert">{s.error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- step 2: pay

function Pay({ sui, balance }: { sui: SuiPool; balance: ReturnType<typeof useBalance> }) {
  const account = useCurrentAccount();
  const submit = useSealedSubmit();
  const [payee, setPayee] = useState(dep.demoAccounts?.suiPayee ?? "");
  const [shares, setShares] = useState("1");
  const [memo, setMemo] = useState("");
  const [s, set] = useState<{ busy?: boolean; digest?: string; blobId?: string; batchId?: string; appliedSeq?: number; error?: string }>({});
  const valid = !!account && /^0x[0-9a-fA-F]{1,64}$/.test(payee) && /^\d+(\.\d{1,18})?$/.test(shares) && parseShares(shares) > 0n;
  useEffect(() => {
    if (!s.batchId || s.appliedSeq !== undefined) return;
    readBatch(grpc, s.batchId).then((b) => b.applied && set((p) => ({ ...p, appliedSeq: b.seq })), () => {});
  }, [sui.pool?.batchSeq, s.batchId]);
  const go = async () => {
    set({ busy: true });
    try {
      const r = await submit({ v: 1, kind: "pay", to: normalizeSuiAddress(payee), shares: parseShares(shares).toString(), memo: memo || undefined, nonce: crypto.randomUUID() });
      set({ digest: r.digest, blobId: r.blobId, batchId: r.batchId });
      sui.reload();
    } catch (e) {
      set({ error: errText(e) });
    }
  };
  return (
    <section className="pay-card pay-step" aria-labelledby="pay-h" data-testid="step-pay">
      <div className="pay-step-head">
        <span className="pay-step-num">2</span>
        <div>
          <h2 id="pay-h">Pay</h2>
          <span className="pay-chain">Sui testnet · Slush</span>
        </div>
      </div>
      <BalanceView b={balance} />
      <label>
        Payee (Sui address)
        <input value={payee} onChange={(e) => setPayee(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
      </label>
      <div className="pay-row">
        <label>
          Shares
          <input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={140} placeholder="optional, sealed" />
        </label>
      </div>
      <Countdown batch={sui.batch} windowMs={sui.pool?.windowMs ?? dep.sui.windowMs} />
      <button className="pay-primary" disabled={!valid || s.busy} onClick={go}>
        {s.busy ? "Sealing and signing…" : `Send ${shares || 0} Apple share${shares === "1" ? "" : "s"} privately`}
      </button>
      <ul className="pay-receipts">
        {s.digest && <li>Sealed instruction submitted · <Ext href={suiscan("tx", s.digest)}>{short(s.digest)}</Ext></li>}
        {s.blobId && <li>Ciphertext on Walrus · <Ext href={`https://walruscan.com/testnet/blob/${s.blobId}`}>{short(s.blobId)}</Ext></li>}
        {s.digest && (
          <li className={s.appliedSeq ? "pay-good" : ""}>
            {s.appliedSeq ? `Applied in batch ${s.appliedSeq}; total supply unchanged` : "Waiting for the window to close…"}
          </li>
        )}
      </ul>
      <p className="pay-muted">Confidential, not anonymous: the keeper reads amounts after the window closes to stop overdrafts.</p>
      {s.error && <p className="pay-bad" role="alert">{s.error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- step 3: withdraw

function Withdraw({ evm, sui }: { evm: EvmWallet; sui: SuiPool }) {
  const account = useCurrentAccount();
  const submit = useSealedSubmit();
  const tokens = dep.evm.tokens;
  const [target, setTarget] = useState<Hex>(tokens[0].address);
  const [recipient, setRecipient] = useState("");
  const [shares, setShares] = useState("1");
  const [maxFeeBps, setMaxFeeBps] = useState(25);
  const [quote, setQuote] = useState<{ feePips: number; sharesDebited: bigint; direct: boolean } | { error: string } | null>(null);
  const [s, set] = useState<{ busy?: boolean; digest?: string; commitment?: Hex; fromBlock?: bigint; settled?: { tx: Hex; amountOut: bigint } ; skipped?: Hex; error?: string }>({});
  const [targetBal, setTargetBal] = useState<bigint | null>(null);
  const token = tokens.find((t) => t.address === target)!;
  const raw = /^\d+(\.\d{1,18})?$/.test(shares) ? parseShares(shares) : 0n;
  useEffect(() => {
    if (evm.address && !recipient) setRecipient(evm.address);
  }, [evm.address]);
  useEffect(() => {
    if (!isAddress(recipient)) return setTargetBal(null);
    evmRead.readContract({ address: target, abi: erc20Abi, functionName: "balanceOf", args: [recipient as Hex] }).then(setTargetBal, () => setTargetBal(null));
  }, [recipient, target, s.settled]);
  useEffect(() => {
    if (raw <= 0n) return setQuote(null);
    let live = true;
    const t = setTimeout(() => {
      evmRead
        .readContract({ address: dep.evm.shareVault, abi: vaultAbi, functionName: "quoteWithdrawal", args: [target, raw] })
        .then(([, sharesDebited, feePips, direct]) => live && setQuote({ feePips: Number(feePips), sharesDebited, direct }), (e) => live && setQuote({ error: errText(e) }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [target, raw]);
  // Watch Unichain for the keeper's settlement of this commitment.
  useEffect(() => {
    if (!s.commitment || s.settled || s.skipped) return;
    let live = true;
    const poll = async () => {
      const [settled, skipped] = await Promise.all([
        evmRead.getContractEvents({ address: dep.evm.shareVault, abi: vaultAbi, eventName: "WithdrawalSettled", args: { commitment: s.commitment }, fromBlock: s.fromBlock }),
        evmRead.getContractEvents({ address: dep.evm.shareVault, abi: vaultAbi, eventName: "WithdrawalSkipped", args: { commitment: s.commitment }, fromBlock: s.fromBlock }),
      ]);
      if (!live) return;
      if (settled[0]) set((p) => ({ ...p, settled: { tx: settled[0].transactionHash!, amountOut: settled[0].args.amountOut! } }));
      else if (skipped[0]) set((p) => ({ ...p, skipped: skipped[0].transactionHash! }));
    };
    const t = setInterval(() => poll().catch(() => {}), 4_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [s.commitment, s.settled, s.skipped]);
  const valid = !!account && isAddress(recipient) && raw > 0n;
  const go = async () => {
    set({ busy: true });
    try {
      const fromBlock = await evmRead.getBlockNumber();
      const r = await submit({ v: 1, kind: "withdraw", recipient: recipient as Hex, target, shares: raw.toString(), maxFeeBps, nonce: crypto.randomUUID() });
      set({ digest: r.digest, commitment: r.commitment, fromBlock });
      sui.reload();
    } catch (e) {
      set({ error: errText(e) });
    }
  };
  return (
    <section className="pay-card pay-step" aria-labelledby="wd-h" data-testid="step-withdraw">
      <div className="pay-step-head">
        <span className="pay-step-num">3</span>
        <div>
          <h2 id="wd-h">Withdraw</h2>
          <span className="pay-chain">Sui → Unichain Sepolia · Uniswap v4</span>
        </div>
      </div>
      <p className="pay-muted">Take delivery in any issuer's wrapper. If custody holds a different issuer, ShareVault converts share-for-share through the ParityHook pool.</p>
      <div className="pay-row">
        <label>
          Deliver as
          <select value={target} onChange={(e) => setTarget(e.target.value as Hex)}>
            {tokens.map((t) => (
              <option key={t.address} value={t.address}>{t.symbol}</option>
            ))}
          </select>
        </label>
        <label>
          Shares
          <input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Max fee (bps)
          <input type="number" min={0} max={250} value={maxFeeBps} onChange={(e) => setMaxFeeBps(Number(e.target.value))} />
        </label>
      </div>
      <label>
        Recipient on Unichain Sepolia
        <input value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x… (MetaMask)" spellCheck={false} />
      </label>
      <div className="pay-quote" aria-live="polite" data-testid="quote">
        {!quote ? (
          <span className="pay-muted">Enter an amount for a live quote.</span>
        ) : "error" in quote ? (
          <span className="pay-bad">Quote unavailable: {quote.error}</span>
        ) : quote.direct ? (
          <span>Custody holds {token.symbol}: delivered share for share, no fee. Debit {formatShares(quote.sharesDebited, 6)} shares.</span>
        ) : (
          <span>
            Converted through the ParityHook pool on Uniswap v4. Live fee <strong>{(quote.feePips / 100).toFixed(2)} bps</strong>, grossed up so you receive face value:
            debit ≈ {formatShares(quote.sharesDebited, 6)} shares.
            {quote.feePips > maxFeeBps * 100 && <strong className="pay-bad"> Above your max fee: this withdrawal will be skipped and your credit restored.</strong>}
          </span>
        )}
      </div>
      <button className="pay-primary" disabled={!valid || s.busy} onClick={go}>
        {s.busy ? "Sealing and signing…" : `Withdraw ${shares || 0} shares as ${token.symbol}`}
      </button>
      <ul className="pay-receipts">
        {s.digest && <li>Sealed withdrawal submitted · <Ext href={suiscan("tx", s.digest)}>{short(s.digest)}</Ext></li>}
        {s.digest && !s.settled && !s.skipped && <li>Waiting for the window, then settlement on Unichain…</li>}
        {s.settled && (
          <li className="pay-good">
            Delivered {formatUnits(s.settled.amountOut, token.decimals)} {token.symbol} · <Ext href={uniscan("tx", s.settled.tx)}>{short(s.settled.tx)}</Ext>
          </li>
        )}
        {s.skipped && (
          <li className="pay-bad">
            Skipped on Unichain, credit restored on Sui · <Ext href={uniscan("tx", s.skipped)}>{short(s.skipped)}</Ext>
          </li>
        )}
        {targetBal !== null && isAddress(recipient) && (
          <li>
            Recipient holds {formatUnits(targetBal, token.decimals)} {token.symbol} · <Ext href={uniscan("address", recipient)}>{short(recipient)}</Ext>
          </li>
        )}
      </ul>
      {s.error && <p className="pay-bad" role="alert">{s.error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- page

function Page() {
  const sui = useSuiPool();
  const evm = useEvmWallet();
  const balance = useBalance(sui);
  const account = useCurrentAccount();
  return (
    <div className="unison-pay">
      <header className="pay-header">
        <a href="/" className="pay-brand">
          Unison <span>Pay</span>
        </a>
        <div className="pay-wallets">
          <ReservesBadge />
          <button className="pay-secondary pay-evm" onClick={evm.connect} data-testid="evm-connect">
            {evm.address ? `MetaMask ${short(evm.address)}` : "Connect MetaMask"}
          </button>
          <ConnectButton connectText="Connect Slush" />
        </div>
      </header>
      <main id="main" className="pay-main">
        <h1>Send Bob three Apple shares.</h1>
        <p className="pay-lede">
          No cash leg. Deposit an issuer's Apple token on Unichain, pay privately on Sui, and let the payee take delivery in any
          issuer's wrapper through Uniswap v4.
        </p>
        {account && (
          <p className="pay-muted pay-who">
            Sui account <Ext href={suiscan("account", account.address)}>{short(account.address)}</Ext>
            {dep.demoAccounts && account.address === dep.demoAccounts.suiPayer && " · demo payer"}
            {dep.demoAccounts && account.address === dep.demoAccounts.suiPayee && " · demo payee"}
          </p>
        )}
        {sui.error && !sui.pool && <p className="pay-bad" role="alert">Sui unavailable: {sui.error}</p>}
        <div className="pay-steps">
          <Deposit evm={evm} sui={sui} />
          <Pay sui={sui} balance={balance} />
          <Withdraw evm={evm} sui={sui} />
        </div>
        <p className="pay-foot">
          Pool <Ext href={suiscan("object", dep.sui.poolId)}>{short(dep.sui.poolId)}</Ext> · ShareVault{" "}
          <Ext href={uniscan("address", dep.evm.shareVault)}>{short(dep.evm.shareVault)}</Ext> · Seal {dep.seal.threshold}-of-
          {dep.seal.keyServers.length} · Walrus testnet · custodial; the keeper sees amounts
        </p>
      </main>
    </div>
  );
}

function PayApp() {
  const queryClient = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={queryClient}>
      {/* dapp-kit 1.x wants a JSON-RPC client for its own hooks; every read and execution here goes through gRPC. */}
      <SuiClientProvider
        networks={{ testnet: { url: SUI_RPC, network: "testnet" } }}
        createClient={(_n, c: any) => new SuiJsonRpcClient({ url: c.url, network: "testnet" })}
        defaultNetwork="testnet"
      >
        <WalletProvider autoConnect>
          <Page />
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}

export function mountPay(el: HTMLElement) {
  createRoot(el).render(<PayApp />);
}
