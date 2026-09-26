import React, { useEffect, useMemo, useState } from "react";
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
import { createPublicClient, http, isAddress, parseAbi } from "viem";
import { unichainSepolia } from "viem/chains";
import deployment from "../../../deployments/sui-testnet.json";
import { config } from "../config";
import { sealApproveLeafTx } from "../../../services/crank/sui/chain";
import { prepareInstruction } from "../../../services/crank/sui/payer";
import { leafHash, verifyPath, type PathStep } from "../../../services/crank/sui/merkle";
import {
  decodeJson,
  formatShares,
  normalizeSuiAddress,
  parseShares,
  unb64,
  type Leaf,
} from "../../../services/crank/sui/protocol";
import "./pay.css";

// Unison Pay: hold and send tokenized equity privately on Sui; exit to any issuer's wrapper on Unichain.
// Balances are decrypted in this browser with Seal; the API only ever serves ciphertext and Merkle paths.

type Dep = {
  sui: { packageId: string; poolId: string; windowMs: number };
  seal: { threshold: number; keyServers: { name: string; objectId: string }[] };
  walrus: { publisher: string; aggregator: string };
  evm: null | {
    chainId: number;
    shareVault: `0x${string}`;
    tokens: { symbol: string; address: `0x${string}`; decimals: number }[];
  };
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
const evm = createPublicClient({ chain: unichainSepolia, transport: http() });
const vaultAbi = parseAbi([
  "function quoteWithdrawal(address target, uint256 shares) view returns (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct)",
]);
const suiscan = (kind: "tx" | "object", id: string) => `https://suiscan.xyz/testnet/${kind}/${id}`;

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${config.apiUrl}${path}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(body?.error?.message ?? `HTTP ${r.status}`);
  return body as T;
}

function usePoll<T>(path: string, ms: number): { data?: T; error?: string } {
  const [s, set] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    const run = () =>
      api<T>(path).then(
        (data) => live && set({ data }),
        (e) => live && set((p) => ({ data: p.data, error: String(e.message ?? e) })),
      );
    run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [path, ms]);
  return s;
}

async function walrusPut(data: Uint8Array) {
  const r = await fetch(`${dep.walrus.publisher}/v1/blobs?epochs=5`, { method: "PUT", body: data as BodyInit });
  if (!r.ok) throw Error(`Walrus upload failed (${r.status})`);
  const j = await r.json();
  return { blobId: (j.newlyCreated?.blobObject.blobId ?? j.alreadyCertified?.blobId) as string };
}

type Reserves = { suiTotalShares: string; vaultShares: string; vaultSharesHeld: string; invariant: boolean; checkedBlock: string };
type Batch = { batchId: string; seq: number; opensMs: number | null; closesMs: number | null; submitted: number; applied: boolean; nowMs: number };
type LeafResp = { owner: string; present: boolean; seq: number; onchainRoot: string | null; ciphertext?: string; leafHash?: `0x${string}`; merklePath?: PathStep[] };

function ReservesBadge() {
  const r = usePoll<Reserves>("/pay/reserves", 15_000);
  if (r.error && !r.data) return <span className="pay-badge warn">Reserves unavailable</span>;
  if (!r.data) return <span className="pay-badge">Reserves…</span>;
  return (
    <span
      className={`pay-badge ${r.data.invariant ? "ok" : "bad"}`}
      title={`Sui total ${formatShares(r.data.suiTotalShares, 6)} · vault ${formatShares(r.data.vaultShares, 6)} (held ${formatShares(r.data.vaultSharesHeld, 6)}) · block ${r.data.checkedBlock}`}
    >
      {r.data.invariant ? "Reserves 1:1" : "Reserves mismatch"} · {formatShares(r.data.suiTotalShares, 2)} shares
    </span>
  );
}

function useSessionKey() {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const [sk, setSk] = useState<SessionKey | null>(null);
  useEffect(() => setSk(null), [account?.address]);
  return async () => {
    if (!account) throw Error("Connect a Sui wallet first");
    if (sk && !sk.isExpired()) return sk;
    const k = await SessionKey.create({ address: account.address, packageId: dep.sui.packageId, ttlMin: 10, suiClient: grpc });
    const { signature } = await signPersonalMessage({ message: k.getPersonalMessage() });
    await k.setPersonalMessageSignature(signature);
    setSk(k);
    return k;
  };
}

function Balance() {
  const account = useCurrentAccount();
  const getKey = useSessionKey();
  const [state, set] = useState<{ busy?: boolean; balance?: bigint; seq?: number; verified?: boolean; present?: boolean; error?: string }>({});
  const decrypt = async () => {
    set({ busy: true });
    try {
      const leaf = await api<LeafResp>(`/pay/leaf/${account!.address}`);
      if (!leaf.present) return set({ balance: 0n, seq: leaf.seq, present: false, verified: true });
      const ct = unb64(leaf.ciphertext!);
      const hash = leafHash(normalizeSuiAddress(account!.address), ct);
      const verified = hash === leaf.leafHash && !!leaf.onchainRoot && verifyPath(hash, leaf.merklePath!, leaf.onchainRoot as `0x${string}`);
      const key = await getKey();
      const { id } = EncryptedObject.parse(ct);
      const txBytes = await sealApproveLeafTx(dep.sui.packageId, dep.sui.poolId, id).build({ client: grpc, onlyTransactionKind: true });
      const plain = decodeJson<Leaf>(await seal.decrypt({ data: ct, sessionKey: key, txBytes }));
      set({ balance: BigInt(plain.balance), seq: plain.seq, verified, present: true });
    } catch (e: any) {
      set({ error: String(e?.message ?? e) });
    }
  };
  return (
    <section className="pay-card" aria-labelledby="bal-h">
      <div className="pay-card-head">
        <h2 id="bal-h">Balance</h2>
        <ReservesBadge />
      </div>
      <p className="pay-big">
        {state.balance === undefined ? "•••••" : formatShares(state.balance, 4)} <small>AAPL shares</small>
      </p>
      <p className="pay-muted">
        Your leaf is Seal-encrypted to your address. Only your wallet can open it; the Merkle path is checked against the
        root on Sui.
      </p>
      {state.balance !== undefined && (
        <p className={state.verified ? "pay-good" : "pay-bad"}>
          {state.present ? `Leaf from batch ${state.seq}` : "No leaf yet (zero balance)"} ·{" "}
          {state.verified ? "proof verified against on-chain root" : "proof did NOT verify"}
        </p>
      )}
      {state.error && <p className="pay-bad" role="alert">{state.error}</p>}
      <button className="pay-primary" disabled={!account || state.busy} onClick={decrypt}>
        {!account ? "Connect wallet to decrypt" : state.busy ? "Decrypting…" : "Decrypt my balance"}
      </button>
    </section>
  );
}

function Countdown() {
  const b = usePoll<Batch>("/pay/batch/current", 5_000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!b.data) return <p className="pay-muted">{b.error ? `Window unavailable: ${b.error}` : "Loading window…"}</p>;
  const { closesMs, seq, submitted } = b.data;
  if (!closesMs)
    return (
      <p className="pay-muted">
        Batch {seq} is idle. The {dep.sui.windowMs / 60000}-minute window starts with the first submission.
      </p>
    );
  const left = Math.max(0, Math.ceil((closesMs - now) / 1000));
  return (
    <p className="pay-muted">
      Batch {seq} · {submitted} sealed instruction{submitted === 1 ? "" : "s"} ·{" "}
      {left > 0 ? (
        <strong className="pay-count">
          closes in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
        </strong>
      ) : (
        <strong>closed, waiting for the keeper</strong>
      )}
    </p>
  );
}

function useSubmit() {
  const account = useCurrentAccount();
  const { mutateAsync } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) => {
      const r = await grpc.core.executeTransaction({ transaction: fromBase64(bytes), signatures: [signature], include: { effects: true } });
      const t = r.Transaction ?? r.FailedTransaction!;
      if (!t.status.success) throw Error(`Transaction failed: ${JSON.stringify(t.status.error)}`);
      return { digest: t.digest };
    },
  });
  return async (instruction: Parameters<typeof prepareInstruction>[0]["instruction"]) => {
    if (!account) throw Error("Connect a Sui wallet first");
    const pool = await api<{ currentBatch: string; paused: boolean }>("/pay/pool");
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
    return { digest, blobId: p.blobId };
  };
}

function Send() {
  const account = useCurrentAccount();
  const submit = useSubmit();
  const [payee, setPayee] = useState("");
  const [shares, setShares] = useState("3");
  const [memo, setMemo] = useState("");
  const [s, set] = useState<{ busy?: boolean; digest?: string; error?: string }>({});
  const valid = /^0x[0-9a-fA-F]{1,64}$/.test(payee) && /^\d+(\.\d{1,18})?$/.test(shares) && parseShares(shares) > 0n;
  const go = async () => {
    set({ busy: true });
    try {
      const { digest } = await submit({
        v: 1,
        kind: "pay",
        to: normalizeSuiAddress(payee),
        shares: parseShares(shares).toString(),
        memo: memo || undefined,
        nonce: crypto.randomUUID(),
      });
      set({ digest });
    } catch (e: any) {
      set({ error: String(e?.message ?? e) });
    }
  };
  return (
    <section className="pay-card" aria-labelledby="send-h">
      <h2 id="send-h">Send</h2>
      <label>
        Payee (Sui address)
        <input value={payee} onChange={(e) => setPayee(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
      </label>
      <label>
        Shares
        <input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Memo <span className="pay-muted">(optional, sealed with the instruction)</span>
        <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={140} />
      </label>
      <Countdown />
      <p className="pay-muted">
        Amount and payee are Seal-encrypted to this batch; nobody, including the keeper, can open them before the window
        closes. The keeper then sees them to check your balance. That makes this confidential, not anonymous.
      </p>
      {s.digest && (
        <p className="pay-good">
          Sealed and submitted · <a href={suiscan("tx", s.digest)} target="_blank" rel="noreferrer">view on Suiscan</a>
        </p>
      )}
      {s.error && <p className="pay-bad" role="alert">{s.error}</p>}
      <button className="pay-primary" disabled={!account || !valid || s.busy} onClick={go}>
        {s.busy ? "Sealing…" : `Send ${shares || 0} Apple share${shares === "1" ? "" : "s"}`}
      </button>
    </section>
  );
}

function Withdraw() {
  const account = useCurrentAccount();
  const submit = useSubmit();
  const tokens = dep.evm?.tokens ?? [];
  const [target, setTarget] = useState<string>(tokens[0]?.address ?? "");
  const [recipient, setRecipient] = useState("");
  const [shares, setShares] = useState("1");
  const [maxFeeBps, setMaxFeeBps] = useState(25);
  const [quote, setQuote] = useState<{ feePips: number; sharesDebited: bigint; direct: boolean } | { error: string } | null>(null);
  const [s, set] = useState<{ busy?: boolean; digest?: string; error?: string }>({});
  const raw = /^\d+(\.\d{1,18})?$/.test(shares) ? parseShares(shares) : 0n;

  useEffect(() => {
    if (!dep.evm || !target || raw <= 0n) return setQuote(null);
    let live = true;
    const t = setTimeout(() => {
      evm
        .readContract({ address: dep.evm!.shareVault, abi: vaultAbi, functionName: "quoteWithdrawal", args: [target as `0x${string}`, raw] })
        .then(
          ([, sharesDebited, feePips, direct]) => live && setQuote({ feePips: Number(feePips), sharesDebited, direct }),
          (e) => live && setQuote({ error: String(e?.shortMessage ?? e?.message ?? e) }),
        );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [target, raw]);

  const valid = !!dep.evm && isAddress(recipient) && raw > 0n;
  const go = async () => {
    set({ busy: true });
    try {
      const { digest } = await submit({
        v: 1,
        kind: "withdraw",
        recipient: recipient as `0x${string}`,
        target: target as `0x${string}`,
        shares: raw.toString(),
        maxFeeBps,
        nonce: crypto.randomUUID(),
      });
      set({ digest });
    } catch (e: any) {
      set({ error: String(e?.message ?? e) });
    }
  };
  const sym = tokens.find((t) => t.address === target)?.symbol;
  return (
    <section className="pay-card" aria-labelledby="wd-h">
      <h2 id="wd-h">Withdraw to a brokerage wrapper</h2>
      {!dep.evm && <p className="pay-bad">ShareVault is not deployed yet.</p>}
      <label>
        Target issuer
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
            </option>
          ))}
        </select>
      </label>
      <label>
        Recipient on Unichain Sepolia
        <input value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
      </label>
      <label>
        Shares
        <input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Max fee (bps)
        <input type="number" min={0} max={250} value={maxFeeBps} onChange={(e) => setMaxFeeBps(Number(e.target.value))} />
      </label>
      <div className="pay-quote" aria-live="polite">
        {!quote ? (
          <span className="pay-muted">Enter an amount for a live quote.</span>
        ) : "error" in quote ? (
          <span className="pay-bad">Quote unavailable: {quote.error}</span>
        ) : quote.direct ? (
          <span>
            Delivered from custody as {sym}, share for share. Fee 0. Debit {formatShares(quote.sharesDebited, 6)} shares.
          </span>
        ) : (
          <span>
            Converted through the ParityHook pool on Uniswap v4. Live fee {(quote.feePips / 100).toFixed(2)} bps, grossed up
            so you receive face value. Debit ≈ {formatShares(quote.sharesDebited, 6)} shares.
            {quote.feePips > maxFeeBps * 100 && <strong className="pay-bad"> Above your max fee: this withdrawal would be skipped and your credit restored.</strong>}
          </span>
        )}
      </div>
      {s.digest && (
        <p className="pay-good">
          Sealed and submitted · <a href={suiscan("tx", s.digest)} target="_blank" rel="noreferrer">view on Suiscan</a>
        </p>
      )}
      {s.error && <p className="pay-bad" role="alert">{s.error}</p>}
      <button className="pay-primary" disabled={!account || !valid || s.busy} onClick={go}>
        {s.busy ? "Sealing…" : `Withdraw ${shares || 0} shares as ${sym ?? "…"}`}
      </button>
    </section>
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
          <div className="unison-pay">
            <header className="pay-header">
              <a href="/" className="pay-brand">
                Unison <span>Pay</span>
              </a>
              <ConnectButton />
            </header>
            <main id="main" className="pay-main">
              <h1>Send Bob three Apple shares.</h1>
              <p className="pay-lede">
                No cash leg. Balances and payments are confidential on Sui; exits land in any issuer's wrapper through
                Uniswap v4 on Unichain.
              </p>
              <div className="pay-grid">
                <Balance />
                <Send />
                <Withdraw />
              </div>
              <p className="pay-foot">
                Pool{" "}
                <a href={suiscan("object", dep.sui.poolId)} target="_blank" rel="noreferrer">
                  {dep.sui.poolId.slice(0, 10)}…
                </a>{" "}
                · Seal {dep.seal.threshold}-of-{dep.seal.keyServers.length} · Walrus testnet · custodial, keeper sees amounts
              </p>
            </main>
          </div>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}

export function mountPay(el: HTMLElement) {
  createRoot(el).render(<PayApp />);
}
