import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  formatUnits,
  parseUnits,
  encodeAbiParameters,
  keccak256,
  toHex,
} from "viem";
import {
  DEMO,
  type Address,
  type Deployment,
  type Route,
} from "@wrapswap/types";
import { useApi } from "./hooks/useApi";
import { config } from "./config";
import { ApiState, Fees, RouteBadge } from "./components";
import {
  approve,
  connect,
  convertExactIn,
  darkSend,
  subscribeWallet,
  verifyOrder,
} from "./wallet";
import "./style.css";
const units = (n: string | bigint, decimals = 18) =>
  formatUnits(BigInt(n), decimals);
const zero32 = toHex(new Uint8Array(32));
type Wallet = {
  d: Deployment;
  address?: Address;
  eligible: boolean;
  uid?: Address;
  run: (fn: () => Promise<void>) => Promise<void>;
  pending: boolean;
};
function App() {
  const deployment = useApi("deployment");
  const health = useApi("health"),
    nyse = useApi("nyse"),
    fees = useApi("fees"),
    pool = useApi("pool"),
    crank = useApi("crankStatus");
  const [address, setAddress] = useState<Address>();
  const eligibility = useApi("eligibility", address || null);
  const [tab, setTab] = useState("Convert"),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  useEffect(
    () =>
      subscribeWallet(() => {
        setAddress(undefined);
        setMessage(
          "Wallet changed. Reconnect to verify network and eligibility.",
        );
      }),
    [],
  );
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setMessage("Waiting for confirmation…");
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setPending(false);
    }
  };
  const d = deployment.data;
  const props = d
    ? {
        d,
        address,
        eligible: !!eligibility.data?.eligible && !eligibility.error,
        uid: eligibility.data?.attestationUid || undefined,
        run,
        pending,
      }
    : undefined;
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <div className="brand">
          WrapSwap <span className="badge">Settlement engine</span>
        </div>
        <div className="wallet">
          {(health.data?.demoMode ?? d?.demoMode) ||
          eligibility.data?.demoMode ? (
            <span className="badge">Demo mode</span>
          ) : null}
          {config.useMocks && (
            <span className="badge">Simulated transactions</span>
          )}
          <button
            disabled={!d || pending}
            onClick={() =>
              void run(async () => {
                setAddress(await connect(d!));
                setMessage("Wallet connected. Checking eligibility…");
              })
            }
          >
            {address
              ? address.slice(0, 6) + "…" + address.slice(-4)
              : "Connect wallet"}
          </button>
        </div>
      </header>
      <div className="status-strip" aria-label="Network status">
        <span>
          {d?.network || config.network} · Chain {d?.chainId || "—"}
        </span>
        <span>Block {health.data?.headBlock ?? "—"}</span>
        <span>
          NYSE {nyse.data ? (nyse.data.open ? "OPEN" : "CLOSED") : "—"}
          {nyse.data && (
            <small>
              Next {nyse.data.nextState.toLowerCase()}:{" "}
              {new Date(Number(nyse.data.nextTransition) * 1000)
                .toISOString()
                .replace("T", " ")
                .replace(".000Z", " UTC")}
            </small>
          )}
        </span>
        <span>Fee {fees.data?.fee.totalBps ?? "—"} bps</span>
        <span>
          Skew{" "}
          {fees.data
            ? (Number(fees.data.fee.skewX18) / 1e16).toFixed(1) + "%"
            : "—"}
        </span>
        <span>
          Peg guard{" "}
          {pool.data ? (pool.data.pegTripped ? "TRIPPED" : "CLEAR") : "—"}
        </span>
        <span>
          Crank {crank.data ? (crank.data.ok ? "healthy" : "degraded") : "—"}
        </span>
        <span>Indexer lag {health.data?.lagBlocks ?? "—"} blocks</span>
      </div>
      <nav aria-label="Main navigation">
        {["Convert", "Dark Cross", "Pool"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            aria-current={tab === t ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      <main id="main">
        <h1>share-for-share conversion, no USDC leg.</h1>
        <p className="intro">
          Issuer securities in. Issuer securities out. Every path settles
          through the hook.
        </p>
        <ApiState state={deployment} label="Deployment" />
        <div className="api-status">
          {[
            [health, "Network"],
            [nyse, "NYSE calendar"],
            [fees, "Fees"],
            [pool, "Peg guard"],
            [crank, "Crank health"],
          ].map(([s, l]) => (
            <ApiState
              key={l as string}
              state={s as typeof health}
              label={l as string}
            />
          ))}
        </div>
        {address && (
          <>
            <ApiState state={eligibility} label="Eligibility" />
            {eligibility.data &&
              (!eligibility.data.eligible ? (
                <p role="alert">
                  <RouteBadge route="BLOCKED-ELIGIBILITY" />{" "}
                  {eligibility.data.reason.replaceAll("_", " ")}. A valid issuer
                  eligibility attestation is required.
                </p>
              ) : (
                <p className="good">
                  Eligibility verified
                  {eligibility.data.demoMode ? " · demo mode" : ""}
                </p>
              ))}
          </>
        )}
        {props &&
          (d!.tokens.length !== 2 ? (
            <p role="alert">Deployment must contain two issuer tokens.</p>
          ) : tab === "Convert" ? (
            <Convert
              {...props}
              onMessage={setMessage}
              onDark={() => setTab("Dark Cross")}
            />
          ) : tab === "Dark Cross" ? (
            <Dark {...props} onMessage={setMessage} />
          ) : (
            <Pool d={d!} />
          ))}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
      </main>
      <footer>
        WrapSwap · ParityHook settlement · Canonical shares are internal
        accounting units.
      </footer>
    </>
  );
}
function Convert({
  d,
  address,
  eligible,
  uid,
  run,
  pending,
  onMessage,
  onDark,
}: Wallet & { onMessage: (s: string) => void; onDark: () => void }) {
  const [reverse, setReverse] = useState(false),
    [input, setInput] = useState("100"),
    [approved, setApproved] = useState("");
  const [a, b] = reverse ? [...d.tokens].reverse() : d.tokens;
  let raw = 0n;
  try {
    if (
      /^\d+(\.\d*)?$/.test(input) &&
      (input.split(".")[1]?.length || 0) <= a.decimals
    )
      raw = parseUnits(input, a.decimals);
  } catch {
    /* displayed below */
  }
  const params = new URLSearchParams({
    tokenIn: a.address,
    tokenOut: b.address,
    amount: raw.toString(),
    kind: "exactIn",
  });
  const quote = useApi("quote", raw > 0n ? params.toString() : null);
  params.set("swapper", address || a.address);
  params.set("allowDark", "false");
  if (uid) params.set("attestationUid", uid);
  const route = useApi("route", address && raw > 0n ? params.toString() : null);
  const q = address ? route.data?.quote : quote.data;
  const activeRoute: Route | undefined =
    address && !eligible
      ? "BLOCKED-ELIGIBILITY"
      : route.data?.route ||
        (q?.fillable ? "PARITY" : q ? "FALL-THROUGH" : undefined);
  const output =
    route.data?.route === "FALL-THROUGH"
      ? route.data.fallThrough?.amountOut
      : q?.amountOut;
  const minOut = output ? (BigInt(output) * 995n) / 1000n : 0n;
  const approvalKey = `${address}:${a.address}:${raw}`;
  const router = d.contracts.wrapSwapRouter;
  const liveUnavailable = !config.useMocks && !router;
  const blocked =
    !address ||
    !eligible ||
    !q ||
    !output ||
    !!route.error ||
    !!quote.error ||
    activeRoute?.startsWith("BLOCKED") ||
    pending;
  return (
    <div className="columns">
      <section>
        <h2>Convert issuer tokens</h2>
        <label>
          From
          <select
            value={a.address}
            onChange={(e) => setReverse(e.target.value === d.tokens[1].address)}
          >
            {d.tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.issuer === "coinbase" ? "Coinbase" : "xStocks"} · {t.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <input
            readOnly
            value={`${b.issuer === "coinbase" ? "Coinbase" : "xStocks"} · ${b.symbol}`}
          />
        </label>
        <label>
          Conversion amount
          <input
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        {raw <= 0n && (
          <p role="alert">
            Enter a positive amount with at most {a.decimals} decimal places.
          </p>
        )}
        <p>
          Settlement: {a.symbol} → ParityHook → {b.symbol}
        </p>
        <p className="muted">
          Approve only this amount to the deployment’s swap router. Slippage
          tolerance: 0.5%.
        </p>
        {liveUnavailable && (
          <p role="alert">
            Live conversion is unavailable: this deployment has no
            WrapSwapRouter with minimum-output protection.
          </p>
        )}
        <button
          className="primary"
          disabled={blocked || liveUnavailable}
          onClick={() =>
            void run(async () => {
              if (activeRoute === "DARK") {
                onDark();
                onMessage("Continue with a dark-cross commitment.");
                return;
              }
              if (approved !== approvalKey) {
                await approve(
                  d,
                  address!,
                  a.address,
                  router ?? d.contracts.swapRouter,
                  raw,
                );
                setApproved(approvalKey);
                onMessage(
                  "Approval confirmed. Review the quote, then convert.",
                );
              } else if (config.useMocks) {
                onMessage(
                  `Simulated conversion confirmed: ${units(output!, b.decimals)} ${b.symbol} through ParityHook.`,
                );
                setApproved("");
              } else {
                await convertExactIn(d, address!, a.address, raw, minOut, uid);
                setApproved("");
                onMessage(
                  `Conversion confirmed: at least ${units(minOut, b.decimals)} ${b.symbol} through ParityHook.`,
                );
              }
            })
          }
        >
          {pending
            ? "Confirming…"
            : activeRoute === "DARK"
              ? "Continue to Dark Cross"
              : approved === approvalKey
                ? "Convert through ParityHook"
                : "Approve token"}
        </button>
        {!address && (
          <p>Connect your wallet to verify eligibility and continue.</p>
        )}
      </section>
      <section>
        <h2>
          Execution quote {activeRoute && <RouteBadge route={activeRoute} />}
        </h2>
        <ApiState state={quote} label="Quote" />
        {address && <ApiState state={route} label="Route" />}
        {route.data?.reason && <p>{route.data.reason}</p>}
        {q && (
          <>
            <dl>
              <dt>Parity ratio</dt>
              <dd>
                {units(
                  (BigInt(a.sharesPerTokenX18) * 10n ** 18n) /
                    BigInt(b.sharesPerTokenX18),
                )}{" "}
                {b.symbol}/{a.symbol}
              </dd>
              <dt>Canonical shares</dt>
              <dd>{units(q.shares)}</dd>
              <dt>Expected output</dt>
              <dd>
                {output ? units(output, b.decimals) : "Unavailable"} {b.symbol}
              </dd>
              <dt>Minimum output</dt>
              <dd>
                {units(minOut, b.decimals)} {b.symbol}
              </dd>
            </dl>
            <Fees fee={q.fee} />
          </>
        )}
        {!q && !quote.loading && !quote.error && (
          <p>No executable quote. Check the amount and route eligibility.</p>
        )}
      </section>
    </div>
  );
}
type SavedOrder = {
  chainId: number;
  account: Address;
  hook: Address;
  batchId: string;
  amount: string;
  limit: string;
  salt: Address;
  confirmed: boolean;
};
function Dark({
  d,
  address,
  eligible,
  uid,
  run,
  pending,
  onMessage,
}: Wallet & { onMessage: (s: string) => void }) {
  const batch = useApi("currentBatch"),
    history = useApi("batches"),
    fills = useApi("fills", "kind=DARK-RESIDUAL");
  const orders = useApi("orders", address || null);
  const storageKey = `wrapswap:${d.chainId}:${d.contracts.darkCrossHook}:${address}`;
  const [saved, setSaved] = useState<SavedOrder>();
  const [mockPhase, setMockPhase] = useState<"COMMIT" | "REVEAL" | "SETTLE">(
    "COMMIT",
  );
  useEffect(() => {
    try {
      const value = localStorage.getItem(storageKey);
      setSaved(value ? JSON.parse(value) : undefined);
    } catch {
      setSaved(undefined);
    }
  }, [storageKey]);
  const phase = config.useMocks ? mockPhase : batch.data?.phase;
  const a = d.tokens.find((t) => t.address === d.dark.baseToken)!,
    b = d.tokens.find((t) => t.address === d.dark.quoteToken)!;
  const amount = DEMO.dark.orders.counterpartyA.amountIn,
    limit = DEMO.dark.orders.counterpartyA.limitPriceX18;
  const store = (o: SavedOrder) => {
    localStorage.setItem(storageKey, JSON.stringify(o));
    setSaved(o);
  };
  return (
    <>
      <div className="columns">
        <section>
          <h2>
            Dark Cross <RouteBadge route="DARK" />
          </h2>
          <ApiState state={batch} label="Current batch" />
          {batch.data && (
            <>
              <p>
                Batch {batch.data.batchId} · <strong>{phase}</strong> ·{" "}
                {batch.data.participants} participants
              </p>
              <p role="timer">
                {Math.max(
                  0,
                  Number(batch.data.phaseEndsBlock) -
                    Number(batch.data.blockNumber),
                )}{" "}
                blocks until phase transition · block{" "}
                {batch.data.phaseEndsBlock}
              </p>
              <p>
                Oracle ratio:{" "}
                {batch.data.oracle.midX18
                  ? units(batch.data.oracle.midX18)
                  : "Unavailable"}{" "}
                {b.symbol}/{a.symbol}
              </p>
              {batch.data.oracle.stale && (
                <p role="alert">Oracle is stale. Settlement is paused.</p>
              )}
            </>
          )}
          <p>
            Sell {units(amount, a.decimals)} {a.symbol} · minimum price{" "}
            {units(limit)} {b.symbol}/{a.symbol}
          </p>
          <p>
            Commit privately, reveal during the next phase, then settle the
            batch.
          </p>
          <p>
            Residual-to-ParityHook settlement: unmatched issuer tokens route
            into the ParityHook pool in the same settlement transaction.
          </p>
          <div className="actions">
            <button
              disabled={
                pending ||
                !eligible ||
                !batch.data ||
                !!batch.error ||
                phase !== "COMMIT" ||
                saved?.confirmed
              }
              onClick={() =>
                void run(async () => {
                  if (!address || !batch.data) return;
                  const salt = toHex(
                    crypto.getRandomValues(new Uint8Array(32)),
                  );
                  const o: SavedOrder = {
                    chainId: d.chainId,
                    account: address,
                    hook: d.contracts.darkCrossHook,
                    batchId: batch.data.batchId,
                    amount: amount.toString(),
                    limit: limit.toString(),
                    salt,
                    confirmed: false,
                  };
                  store(o);
                  await approve(
                    d,
                    address,
                    a.address,
                    d.contracts.darkCrossHook,
                    amount,
                  );
                  await darkSend(d, address, "fund", [a.address, amount]);
                  const hash = keccak256(
                    encodeAbiParameters(
                      [
                        { type: "uint256" },
                        { type: "address" },
                        { type: "uint256" },
                        { type: "address" },
                        { type: "bool" },
                        { type: "uint256" },
                        { type: "uint256" },
                        { type: "bool" },
                        { type: "bytes32" },
                      ],
                      [
                        BigInt(d.chainId),
                        d.contracts.darkCrossHook,
                        BigInt(o.batchId),
                        address,
                        true,
                        amount,
                        limit,
                        true,
                        salt,
                      ],
                    ),
                  );
                  await darkSend(d, address, "commit", [
                    hash,
                    a.address,
                    amount,
                    uid || zero32,
                  ]);
                  await verifyOrder(d, address, o.batchId, hash);
                  store({ ...o, confirmed: true });
                  if (config.useMocks) setMockPhase("REVEAL");
                  onMessage(
                    "Commit confirmed. Reveal secret saved in this browser. Keep this browser data until settlement.",
                  );
                })
              }
            >
              Approve, fund & commit
            </button>
            <button
              disabled={
                pending ||
                !eligible ||
                !saved?.confirmed ||
                phase !== "REVEAL" ||
                !!batch.error ||
                saved?.batchId !== batch.data?.batchId
              }
              onClick={() =>
                void run(async () => {
                  await darkSend(d, address!, "reveal", [
                    true,
                    BigInt(saved!.amount),
                    BigInt(saved!.limit),
                    true,
                    saved!.salt,
                  ]);
                  await verifyOrder(d, address!, saved!.batchId);
                  if (config.useMocks) setMockPhase("SETTLE");
                  onMessage(
                    "Reveal confirmed. Residual will settle through ParityHook.",
                  );
                })
              }
            >
              Reveal order
            </button>
            <button
              disabled={
                pending ||
                !eligible ||
                phase !== "SETTLE" ||
                !batch.data ||
                !!batch.error ||
                batch.data.oracle.stale
              }
              onClick={() =>
                void run(async () => {
                  await darkSend(d, address!, "settle", [
                    BigInt(batch.data!.batchId),
                  ]);
                  localStorage.removeItem(storageKey);
                  setSaved(undefined);
                  onMessage(
                    "Batch settled: matched issuer tokens crossed; residual routed through ParityHook.",
                  );
                })
              }
            >
              Settle batch
            </button>
          </div>
          {!address && <p>Connect a wallet to commit and reveal.</p>}
          {address && (
            <>
              <ApiState
                state={orders}
                label="Your orders"
                empty={orders.data?.items.length === 0}
              />
              {orders.data?.items.map((o) => (
                <p key={o.batchId}>
                  Batch {o.batchId}: {o.revealed ? "Revealed" : "Committed"} ·{" "}
                  {o.valid ? "valid" : "awaiting valid reveal"}
                </p>
              ))}
            </>
          )}
        </section>
        <section>
          <h2>Recent batch settlement</h2>
          <ApiState
            state={history}
            label="Batches"
            empty={history.data?.items.length === 0}
          />
          {history.data?.items.map((h) => (
            <div key={h.batchId}>
              <p>
                Batch {h.batchId} · {h.settled ? "SETTLED" : "Pending"}
              </p>
              <dl>
                <dt>Crossed base</dt>
                <dd>
                  {units(h.crossedBase, a.decimals)} {a.symbol}
                </dd>
                <dt>Crossed quote</dt>
                <dd>
                  {units(h.crossedQuote, b.decimals)} {b.symbol}
                </dd>
                <dt>Residual to ParityHook</dt>
                <dd>
                  {units(h.residualBaseIn, a.decimals)} {a.symbol}
                </dd>
              </dl>
            </div>
          ))}
          <ApiState
            state={fills}
            label="Residual fills"
            empty={fills.data?.items.length === 0}
          />
          {fills.data?.items
            .filter((f) => f.kind === "DARK-RESIDUAL")
            .map((f) => (
              <p key={f.txHash + f.logIndex}>
                ParityHook residual output:{" "}
                <strong>
                  {units(f.amountOut, b.decimals)} {b.symbol}
                </strong>{" "}
                · {(f.feePips! / 100).toFixed(2)} bps
              </p>
            ))}
        </section>
      </div>
    </>
  );
}
function Pool({ d }: { d: Deployment }) {
  const inventory = useApi("inventory"),
    fills = useApi("fills");
  const skew = inventory.data ? Number(inventory.data.skewX18) / 1e18 : 0;
  return (
    <>
      <div className="columns">
        <section>
          <h2>Hook-owned inventory</h2>
          <ApiState
            state={inventory}
            label="Inventory"
            empty={inventory.data?.tokens.length === 0}
          />
          {inventory.data?.tokens.map((t) => (
            <dl key={t.address}>
              <dt>{t.symbol}</dt>
              <dd>
                {units(
                  t.inventory,
                  d.tokens.find((x) => x.address === t.address)?.decimals,
                )}{" "}
                tokens
              </dd>
              <dt>Canonical shares</dt>
              <dd>{units(t.inventoryShares)} shares</dd>
            </dl>
          ))}
          {inventory.data && (
            <>
              <label>
                Inventory skew: {(skew * 100).toFixed(1)}%
                <meter
                  min={-1}
                  max={1}
                  value={skew}
                  aria-label="Inventory skew"
                />
              </label>
              <p>Total {units(inventory.data.totalShares)} canonical shares</p>
              <p className="muted">
                Accounting for issuer ratios, not a user-held security.
              </p>
            </>
          )}
        </section>
        <section>
          <h2>Hook fee curve</h2>
          <p>
            2 + 13 × |skew| + {inventory.data?.fee.marketOpen ? 0 : 10}{" "}
            closed-market bps · capped at 25 bps
          </p>
          <svg
            viewBox="0 0 320 115"
            role="img"
            aria-label="Fee increases with absolute inventory skew; off-hours adds 10 basis points"
          >
            <path d="M20 10V90H310" fill="none" stroke="currentColor" />
            <path
              d="M25 20L165 78L305 20"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="3"
            />
            <text x="20" y="110">
              −100%
            </text>
            <text x="150" y="110">
              0%
            </text>
            <text x="265" y="110">
              +100%
            </text>
          </svg>
          {inventory.data && <Fees fee={inventory.data.fee} />}
        </section>
      </div>
      <section>
        <h2>Recent fills</h2>
        <ApiState
          state={fills}
          label="Fills"
          empty={fills.data?.items.length === 0}
        />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Settlement</th>
                <th>Token in</th>
                <th>Token out</th>
                <th>Hook fee</th>
              </tr>
            </thead>
            <tbody>
              {fills.data?.items.map((f) => {
                const a = d.tokens.find((t) => t.address === f.tokenIn),
                  b = d.tokens.find((t) => t.address === f.tokenOut);
                return (
                  <tr key={f.txHash + f.logIndex}>
                    <td>
                      {f.kind === "PARITY"
                        ? "Inventory"
                        : f.kind === "FALL-THROUGH"
                          ? "Fall-through"
                          : f.kind}{" "}
                      · ParityHook
                    </td>
                    <td>
                      {units(f.amountIn, a?.decimals)} {a?.symbol}
                    </td>
                    <td>
                      {units(f.amountOut, b?.decimals)} {b?.symbol}
                    </td>
                    <td>
                      {f.feePips === null
                        ? "—"
                        : (f.feePips / 100).toFixed(2) + " bps"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
