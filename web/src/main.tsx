import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  WagmiProvider,
  createConfig,
  http as wagmiHttp,
  useConnect,
  useAccount,
  useWalletClient,
} from "wagmi";
import { injected } from "wagmi/connectors";
import { base, baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useApi } from "./hooks/useApi";
import { amount, short, countdown } from "./lib/format";
import { erc20, vaultAbi, darkAbi, swapAbi } from "./lib/abi";
import type { Manifest, Token } from "../../api/src/chain/client";
import "./style.css";
const config = createConfig({
  chains: [base, baseSepolia],
  connectors: [injected()],
  transports: {
    [base.id]: wagmiHttp("/rpc"),
    [baseSepolia.id]: wagmiHttp("/rpc"),
  },
});
const query = new QueryClient();
const publicClient = createPublicClient({ transport: http("/rpc") });
type Send = (
  address: Address,
  abi: Abi,
  name: string,
  args: unknown[],
) => Promise<`0x${string}`>;
function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length}>No records yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
function ErrorNote({ error }: { error?: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
function TokenSelect({
  tokens,
  value,
  onChange,
  label,
}: {
  tokens: Token[];
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {tokens.map((t) => (
          <option key={t.address} value={t.address}>
            {t.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}
function App() {
  const deployment = useApi<Manifest>("/deployments", 10000);
  const m = deployment.data;
  const hours = useApi("/hours");
  const oracle = useApi("/oracle");
  const inventory = useApi("/parity");
  const { connectAsync, connectors } = useConnect();
  const { address: injectedAddress } = useAccount();
  const { data: wallet } = useWalletClient();
  const [burner, setBurner] = useState("");
  const address = (burner || injectedAddress) as Address | undefined;
  const [tab, setTab] = useState("Convert");
  const [toast, setToast] = useState("");
  const [pending, setPending] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const send = useCallback<Send>(
    async (addressTo, abi, name, args) => {
      if (!m || !address)
        throw Error("Connect a wallet or select a demo burner");
      let client: any = wallet;
      if (burner) {
        const entry = m.burners?.find((b) => b.address === burner);
        if (
          !entry ||
          !m.demoMode ||
          !["localhost", "127.0.0.1"].includes(location.hostname)
        )
          throw Error("Demo signing is restricted to the local fork");
        client = createWalletClient({
          account: privateKeyToAccount(entry.privateKey),
          transport: http("/rpc"),
        });
      }
      if (!client) throw Error("Wallet unavailable");
      const chainId = await client.getChainId();
      if (chainId !== m.chainId)
        throw Error(`Switch wallet to chain ${m.chainId}`);
      const simulation = await publicClient.simulateContract({
        account: address,
        address: addressTo,
        abi,
        functionName: name,
        args,
      });
      const hash = await client.writeContract({
        ...simulation.request,
        chain: null,
      });
      setToast("Submitted " + hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw Error("Transaction reverted " + hash);
      setToast("Confirmed " + hash);
      return hash;
    },
    [m, address, wallet, burner],
  );
  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      setToast(String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <header>
        <div className="brand">
          WrapSwap{" "}
          <span className="badge">
            {m
              ? m.chainId === 84532
                ? "Base Sepolia"
                : "Base fork"
              : "Connecting"}
          </span>
        </div>
        <div className="market">
          <span className={hours.data?.open ? "good" : ""}>
            NYSE {hours.data ? (hours.data.open ? "OPEN" : "CLOSED") : "—"}
          </span>{" "}
          {hours.data && (
            <small>{countdown(hours.data.nextTransitionTs)}</small>
          )}
          <span>
            AAPL ${amount(oracle.data?.price, 18, 2)}{" "}
            <i className={oracle.data?.stale ? "dot stale" : "dot"} />
          </span>
        </div>
        <div className="wallet">
          {m?.burners && (
            <select
              aria-label="Demo burner"
              value={burner}
              onChange={(e) => setBurner(e.target.value)}
            >
              <option value="">Injected wallet</option>
              {m.burners.map((b, i) => (
                <option value={b.address} key={b.address}>
                  Demo {i + 1} · {short(b.address)}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() =>
              run(async () => {
                setBurner("");
                await connectAsync({ connector: connectors[0] });
              })
            }
          >
            {short(address || "") === "Disconnected"
              ? "Connect wallet"
              : short(address || "")}
          </button>
        </div>
      </header>
      <div className="inventory-strip">
        Hook inventory{" "}
        {inventory.data?.map((p: any) => (
          <span key={p.poolId}>
            {m &&
              Object.values(m.tokens).find(
                (t) => t.address.toLowerCase() === p.issuer.toLowerCase(),
              )?.symbol}
            :{" "}
            {amount(
              p.hookInventory.in,
              m &&
                Object.values(m.tokens).find(
                  (t) => t.address.toLowerCase() === p.issuer.toLowerCase(),
                )?.decimals,
            )}{" "}
            / {amount(p.hookInventory.out)} uAAPL
          </span>
        )) || "—"}
      </div>
      <nav>
        {["Convert", "Dark pool", "Backing", "Metrics"].map((t) => (
          <button
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
            key={t}
          >
            {t}
          </button>
        ))}
      </nav>
      <main>
        <ErrorNote error={deployment.error || hours.error || oracle.error} />
        {m ? (
          <>
            {tab === "Convert" && (
              <Convert
                m={m}
                address={address}
                send={send}
                run={run}
                pending={pending}
              />
            )}{" "}
            {tab === "Dark pool" && (
              <Dark
                m={m}
                address={address}
                send={send}
                run={run}
                pending={pending}
              />
            )}{" "}
            {tab === "Backing" && (
              <Backing
                m={m}
                address={address}
                send={send}
                run={run}
                pending={pending}
              />
            )}{" "}
            {tab === "Metrics" && <Metrics />}
          </>
        ) : (
          <p>Waiting for deployment manifest and fork… Run make demo.</p>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            ×
          </button>
        </div>
      )}
      <footer>
        Share-for-share conversion · Local fork transactions are simulations ·{" "}
        {tick >= 0 ? "MIT licensed" : ""}
      </footer>
    </>
  );
}
type Props = {
  m: Manifest;
  address?: Address;
  send: Send;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  pending: boolean;
};
function Convert({ m, address, send, run, pending }: Props) {
  const stock = Object.values(m.tokens).filter((t) => t.symbol !== "USDC");
  const [from, setFrom] = useState(m.tokens.issuer1.address as string);
  const [to, setTo] = useState(m.tokens.uAAPL.address as string);
  const [input, setInput] = useState("1");
  const [balance, setBalance] = useState<bigint>();
  const a = stock.find((t) => t.address === from)!,
    b = stock.find((t) => t.address === to)!;
  let raw = 0n;
  try {
    raw = parseUnits(input, a.decimals);
  } catch {}
  const quote = useApi(
    raw > 0n && from !== to
      ? `/quote?from=${from}&to=${to}&amount=${raw}`
      : null,
  );
  const history = useApi(address ? "/conversions/" + address : null);
  useEffect(() => {
    setBalance(undefined);
    if (address)
      publicClient
        .readContract({
          address: a.address,
          abi: erc20,
          functionName: "balanceOf",
          args: [address],
        })
        .then(setBalance)
        .catch(() => setBalance(undefined));
  }, [address, a.address, pending]);
  async function convert() {
    if (!address || !quote.data)
      throw Error("A wallet and successful quote are required");
    if (quote.data.route === "vault") {
      if (from === m.tokens.uAAPL.address) {
        await send(m.contracts.vault, vaultAbi, "redeem", [
          b.address,
          raw,
          address,
        ]);
      } else {
        const before = await publicClient.readContract({
          address: m.tokens.uAAPL.address,
          abi: erc20,
          functionName: "balanceOf",
          args: [address],
        });
        await send(a.address, erc20, "approve", [m.contracts.vault, raw]);
        await send(m.contracts.vault, vaultAbi, "mint", [
          a.address,
          raw,
          address,
        ]);
        if (to !== m.tokens.uAAPL.address) {
          const after = await publicClient.readContract({
            address: m.tokens.uAAPL.address,
            abi: erc20,
            functionName: "balanceOf",
            args: [address],
          });
          await send(m.contracts.vault, vaultAbi, "redeem", [
            b.address,
            after - before,
            address,
          ]);
        }
      }
    } else {
      const pool = m.pools.find((p) => p.id === quote.data.poolId)!;
      const zeroForOne =
        pool.key.currency0.toLowerCase() === from.toLowerCase();
      await send(a.address, erc20, "approve", [m.contracts.swapRouter, raw]);
      await send(m.contracts.swapRouter, swapAbi, "swap", [
        pool.key,
        {
          zeroForOne,
          amountSpecified: -raw,
          sqrtPriceLimitX96: zeroForOne
            ? 4295128740n
            : 1461446703485210103287273052203988822378723970341n,
        },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ]);
    }
  }
  return (
    <>
      <h1>Convert wrappers</h1>
      <div className="columns">
        <section>
          <div className="form-row">
            <TokenSelect
              label="From"
              tokens={stock}
              value={from}
              onChange={setFrom}
            />
            <TokenSelect
              label="To"
              tokens={stock}
              value={to}
              onChange={setTo}
            />
          </div>
          <label>
            Amount{" "}
            <div className="input-action">
              <input
                aria-label="Conversion amount"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                inputMode="decimal"
              />
              <button
                disabled={balance === undefined}
                onClick={() =>
                  setInput(
                    balance === undefined
                      ? ""
                      : formatUnits(balance, a.decimals),
                  )
                }
              >
                Max
              </button>
            </div>
          </label>
          <small>
            Balance {amount(balance, a.decimals)} {a.symbol}
          </small>
          {from !== m.tokens.uAAPL.address && to !== m.tokens.uAAPL.address && (
            <p>
              Two confirmed vault transactions: mint uAAPL, then redeem the
              selected issuer.
            </p>
          )}
          <button
            className="primary"
            disabled={pending || !address || !quote.data || !!quote.error}
            onClick={() => run(convert)}
          >
            {pending ? "Confirming…" : "Approve & convert"}
          </button>
        </section>
        <section>
          <h2>Execution quote</h2>
          <ErrorNote error={quote.error} />
          <dl>
            <dt>Share-parity ratio</dt>
            <dd>
              {amount(quote.data?.ratio)} {b.symbol}/{a.symbol}
            </dd>
            <dt>Expected out</dt>
            <dd>
              {amount(quote.data?.expectedOut, b.decimals)} {b.symbol}
            </dd>
            <dt>Route</dt>
            <dd>
              <span className="badge">
                {(
                  {
                    vault: "Vault direct",
                    hook: "ParityHook fill",
                    curve: "Curve fall-through",
                  } as any
                )[quote.data?.route] || "—"}
              </span>
            </dd>
            <dt>Fee</dt>
            <dd>{quote.data?.feeBps ?? "—"} bps</dd>
            <dt>Price impact</dt>
            <dd>{quote.data?.priceImpactBps ?? "—"} bps</dd>
          </dl>
          <p className="muted">share-for-share, no USDC leg</p>
        </section>
      </div>
      <h2>Your conversions</h2>
      <ErrorNote error={history.error} />
      <Table
        headers={["Transaction", "From", "To", "Shares", "Fee", "Route"]}
        rows={(history.data || []).map((r: any) => [
          short(r.tx),
          stock.find(
            (t) => t.address.toLowerCase() === r.fromToken.toLowerCase(),
          )?.symbol,
          stock.find((t) => t.address.toLowerCase() === r.toToken.toLowerCase())
            ?.symbol,
          amount(r.shares),
          r.feeBps + " bps",
          r.filledByHook ? "Hook" : "Curve",
        ])}
      />
    </>
  );
}
function Backing(props: Props) {
  const { m, address, send, run, pending } = props;
  const backing = useApi("/backing");
  const [issuer, setIssuer] = useState(m.tokens.issuer1.address as string);
  const [mode, setMode] = useState("mint");
  const [input, setInput] = useState("1");
  const tokens = [m.tokens.issuer1, m.tokens.issuer2];
  const token = tokens.find((t) => t.address === issuer)!;
  return (
    <>
      <h1>Canonical backing</h1>
      <ErrorNote error={backing.error} />
      <div className="summary">
        <strong>{amount(backing.data?.totalShares)} shares backing</strong>
        <span>{amount(backing.data?.totalSupply)} uAAPL supply</span>
        <span className={backing.data?.invariant ? "good" : "error"}>
          {backing.data
            ? backing.data.invariant
              ? "Fully backed"
              : "Backing deficit"
            : "Loading"}
        </span>
      </div>
      <div className="stacked">
        {backing.data?.issuers.map((i: any, j: number) => (
          <div
            key={i.token}
            className={"segment s" + j}
            style={{
              width: `${Number((BigInt(i.sharesRepresented) * 10000n) / (BigInt(backing.data.totalShares) || 1n)) / 100}%`,
            }}
            title={amount(i.sharesRepresented) + " shares"}
          />
        ))}
      </div>
      <Table
        headers={[
          "Wrapper",
          "Tokens held",
          "Shares / token",
          "Shares represented",
        ]}
        rows={(backing.data?.issuers || []).map((i: any) => {
          const t = tokens.find(
            (t) => t.address.toLowerCase() === i.token.toLowerCase(),
          );
          return [
            t?.symbol || short(i.token),
            amount(i.tokensHeld, t?.decimals),
            amount(i.spt),
            amount(i.sharesRepresented),
          ];
        })}
      />
      <section className="narrow">
        <h2>Mint / redeem</h2>
        <div className="form-row">
          <label>
            Operation
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="mint">Mint uAAPL</option>
              <option value="redeem">Redeem issuer · 5 bps</option>
            </select>
          </label>
          <TokenSelect
            label="Issuer"
            tokens={tokens}
            value={issuer}
            onChange={setIssuer}
          />
        </div>
        <label>
          {mode === "mint" ? token.symbol : "uAAPL"} amount
          <input value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
        <button
          className="primary"
          disabled={!address || pending}
          onClick={() =>
            run(async () => {
              const q = parseUnits(
                input,
                mode === "mint" ? token.decimals : 18,
              );
              if (q <= 0n) throw Error("Positive amount required");
              if (mode === "mint")
                await send(token.address, erc20, "approve", [
                  m.contracts.vault,
                  q,
                ]);
              await send(m.contracts.vault, vaultAbi, mode, [
                token.address,
                q,
                address,
              ]);
            })
          }
        >
          {pending ? "Confirming…" : mode === "mint" ? "Mint" : "Redeem"}
        </button>
      </section>
    </>
  );
}
type Saved = {
  isBuy: boolean;
  qty: string;
  limitPx: string;
  routeResidual: boolean;
  salt: `0x${string}`;
  batchId: string;
  revealed?: boolean;
};
function Dark({ m, address, send, run, pending }: Props) {
  const batch = useApi("/batch/current", 1500);
  const fills = useApi(address ? "/fills/" + address : null);
  const orders = useApi(address ? "/orders/" + address : null);
  const current = useApi(batch.data ? "/batch/" + batch.data.batchId : null);
  const [escrow, setEscrow] = useState<
    Record<string, readonly [bigint, bigint]>
  >({});
  const [currency, setCurrency] = useState(m.tokens.uAAPL.address as string);
  const [deposit, setDeposit] = useState("1");
  const [side, setSide] = useState("buy");
  const [qty, setQty] = useState("1");
  const [limit, setLimit] = useState("250");
  const [residual, setResidual] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [auto, setAuto] = useState(true);
  const [attempted, setAttempted] = useState("");
  const [historyId, setHistoryId] = useState("");
  const history = useApi(
    historyId && /^\d+$/.test(historyId) ? "/batch/" + historyId : null,
  );
  const curr = [m.tokens.uAAPL, m.tokens.USDC].find(
    (t) => t.address === currency,
  )!;
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!address) {
        setEscrow({});
        return;
      }
      try {
        const values = await Promise.all(
          [m.tokens.uAAPL, m.tokens.USDC].map(
            async (t) =>
              [
                t.address,
                await publicClient.readContract({
                  address: m.contracts.darkCrossHook,
                  abi: darkAbi,
                  functionName: "balances",
                  args: [address, t.address],
                }),
              ] as const,
          ),
        );
        if (active) setEscrow(Object.fromEntries(values));
      } catch (e) {
        if (active) setStorageError(String(e));
      }
    };
    void poll();
    const t = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [address, m, pending]);
  const storageKey =
    address && batch.data
      ? `wrapswap:orders:${address.toLowerCase()}:${batch.data.batchId}`
      : "";
  async function reveal() {
    if (!storageKey) throw Error("Connect wallet");
    let saved: Saved;
    try {
      const value = localStorage.getItem(storageKey);
      if (!value) throw Error("No saved order for this wallet and batch");
      saved = JSON.parse(value);
    } catch (e) {
      throw Error("Cannot load reveal secret: " + e);
    }
    if (saved.revealed) return;
    await send(m.contracts.darkCrossHook, darkAbi, "reveal", [
      saved.isBuy,
      BigInt(saved.qty),
      BigInt(saved.limitPx),
      saved.routeResidual,
      saved.salt,
    ]);
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ...saved, revealed: true }),
      );
    } catch (e) {
      setStorageError("Revealed on chain; localStorage update failed: " + e);
    }
  }
  useEffect(() => {
    if (
      auto &&
      batch.data?.phase === "Reveal" &&
      storageKey &&
      attempted !== storageKey &&
      !pending
    ) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved && !JSON.parse(saved).revealed) {
          setAttempted(storageKey);
          void run(reveal);
        }
      } catch (e) {
        setStorageError(String(e));
      }
    }
  }, [auto, batch.data?.phase, storageKey, pending]);
  async function commit() {
    if (!address || !batch.data) throw Error("Connect wallet");
    const q = parseUnits(qty, 18),
      px = parseUnits(limit, 18);
    if (q <= 0n || px <= 0n)
      throw Error("Positive quantity and limit required");
    const salt = ("0x" +
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")) as `0x${string}`;
    const saved: Saved = {
      isBuy: side === "buy",
      qty: q.toString(),
      limitPx: px.toString(),
      routeResidual: residual,
      salt,
      batchId: batch.data.batchId,
    };
    const hash = keccak256(
      encodeAbiParameters(
        [
          { type: "bool" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bool" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [saved.isBuy, q, px, residual, salt, BigInt(saved.batchId), address],
      ),
    );
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch (e) {
      throw Error(
        "Cannot safely save reveal secret. Enable browser storage: " + e,
      );
    }
    const cost = (q * px + 10n ** 30n - 1n) / 10n ** 30n;
    const lock = saved.isBuy ? cost + (cost * 5n + 9999n) / 10000n : q;
    await send(m.contracts.darkCrossHook, darkAbi, "commit", [
      hash,
      saved.isBuy ? m.tokens.USDC.address : m.tokens.uAAPL.address,
      lock,
      "0x" + "00".repeat(32),
    ]);
  }
  return (
    <>
      <h1>Sealed batch crossing</h1>
      <ErrorNote error={batch.error || storageError} />
      <div className="columns">
        <section>
          <h2>Escrow</h2>
          <Table
            headers={["Currency", "Available", "Locked"]}
            rows={[m.tokens.uAAPL, m.tokens.USDC].map((t) => [
              t.symbol,
              amount(escrow[t.address]?.[0], t.decimals),
              amount(escrow[t.address]?.[1], t.decimals),
            ])}
          />
          <div className="form-row">
            <TokenSelect
              label="Currency"
              tokens={[m.tokens.uAAPL, m.tokens.USDC]}
              value={currency}
              onChange={setCurrency}
            />
            <label>
              Amount
              <input
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            {["Deposit", "Withdraw"].map((action) => (
              <button
                key={action}
                disabled={!address || pending}
                onClick={() =>
                  run(async () => {
                    const q = parseUnits(deposit, curr.decimals);
                    if (q <= 0n) throw Error("Positive amount required");
                    if (action === "Deposit")
                      await send(curr.address, erc20, "approve", [
                        m.contracts.darkCrossHook,
                        q,
                      ]);
                    await send(
                      m.contracts.darkCrossHook,
                      darkAbi,
                      action === "Deposit" ? "fund" : "withdraw",
                      [curr.address, q],
                    );
                  })
                }
              >
                {action}
              </button>
            ))}
          </div>
          <small>Funding escrow does not reveal your order direction.</small>
        </section>
        <section>
          <h2>
            Batch {batch.data?.batchId ?? "—"}{" "}
            <span className="badge">{batch.data?.phase ?? "—"}</span>
          </h2>
          <dl>
            <dt>Blocks left</dt>
            <dd>
              {batch.data
                ? Math.max(
                    0,
                    Number(batch.data.phaseEndsBlock) -
                      Number(batch.data.blockNumber),
                  )
                : "—"}
            </dd>
            <dt>Mid source</dt>
            <dd>{current.data?.midSource || "Selected at settlement"}</dd>
            <dt>Midpoint</dt>
            <dd>${amount(current.data?.mid)}</dd>
          </dl>
          <div className="form-row">
            <label>
              Side
              <select value={side} onChange={(e) => setSide(e.target.value)}>
                <option value="buy">Buy uAAPL</option>
                <option value="sell">Sell uAAPL</option>
              </select>
            </label>
            <label>
              Quantity
              <input value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <label>
              Limit USD
              <input value={limit} onChange={(e) => setLimit(e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={residual}
              onChange={(e) => setResidual(e.target.checked)}
            />
            Route residual to lit pool
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Auto-reveal while this page is open
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={!address || pending || batch.data?.phase !== "Commit"}
              onClick={() => run(commit)}
            >
              Commit sealed order
            </button>
            <button
              disabled={!address || pending || batch.data?.phase !== "Reveal"}
              onClick={() => run(reveal)}
            >
              Reveal saved order
            </button>
            <button
              disabled={!address || pending || batch.data?.phase !== "Settle"}
              onClick={() =>
                run(() =>
                  send(m.contracts.darkCrossHook, darkAbi, "settle", [
                    BigInt(batch.data.batchId),
                  ]),
                )
              }
            >
              Settle batch
            </button>
          </div>
          <small>
            Keep this browser open for reveal. Unrevealed commitments forfeit 10
            bps. The local crank settles eligible batches.
          </small>
        </section>
      </div>
      <h2>Your orders</h2>
      <ErrorNote error={orders.error} />
      <Table
        headers={[
          "Batch",
          "Commitment",
          "Revealed",
          "Side",
          "Quantity",
          "Limit",
        ]}
        rows={(orders.data || []).map((o: any) => [
          o.batchId,
          short(o.commitHash || ""),
          o.revealed ? "Yes" : "No",
          o.revealed ? (o.isBuy ? "Buy" : "Sell") : "Sealed",
          o.revealed ? amount(o.qty) : "—",
          o.revealed ? "$" + amount(o.limitPx, 18, 2) : "—",
        ])}
      />
      <h2>Your fills</h2>
      <ErrorNote error={fills.error} />
      <Table
        headers={["Batch", "Side", "Qty", "Price", "Venue"]}
        rows={(fills.data || []).map((f: any) => [
          f.batchId,
          f.isBuy ? "Buy" : "Sell",
          amount(f.qty),
          "$" + amount(f.px, 18, 2),
          f.kind,
        ])}
      />
      <section>
        <h2>Batch history</h2>
        <label>
          Batch ID
          <input
            value={historyId}
            placeholder="Enter a batch ID"
            onChange={(e) => setHistoryId(e.target.value)}
          />
        </label>
        <ErrorNote error={history.error} />
        {history.data && (
          <>
            <p>
              {history.data.settledTx
                ? "Settled " + short(history.data.settledTx)
                : "Not settled"}{" "}
              · {history.data.midSource || "Mid not selected"}
            </p>
            {!history.data.settledTx && (
              <button
                disabled={
                  !address ||
                  pending ||
                  !batch.data ||
                  BigInt(historyId) >= BigInt(batch.data.batchId)
                }
                onClick={() =>
                  run(() =>
                    send(m.contracts.darkCrossHook, darkAbi, "settle", [
                      BigInt(historyId),
                    ]),
                  )
                }
              >
                Settle past batch
              </button>
            )}
            <div className="volume-bars">
              <div
                style={{
                  width: `${Number((BigInt(history.data.crossedQty) * 100n) / (BigInt(history.data.crossedQty) + BigInt(history.data.routedQty) || 1n))}%`,
                }}
              >
                Cross {amount(history.data.crossedQty)}
              </div>
              <div>Lit {amount(history.data.routedQty)}</div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
function Metrics() {
  const { data, error } = useApi("/metrics");
  return (
    <>
      <h1>Protocol metrics</h1>
      <ErrorNote error={error} />
      <div className="cards">
        {[
          [
            "Conversion volume · 24h",
            amount(data?.conversionVolume24h) + " shares",
          ],
          ["Crossed volume", amount(data?.crossedVolume) + " shares"],
          ["Routed volume", amount(data?.routedVolume) + " shares"],
          ["Hook fees accrued", amount(data?.hookFeePnl) + " shares"],
          [
            "Mean parity deviation",
            (data?.meanAbsoluteDeviationBps ?? "—") + " bps",
          ],
          ["Batches settled", data?.batchesSettled ?? "—"],
        ].map(([label, value]) => (
          <section key={label}>
            <h2>{label}</h2>
            <strong>{value}</strong>
          </section>
        ))}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={query}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
