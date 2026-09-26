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
import { ApiState, Fees, RouteBadge, Tip } from "./components";
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
/** [internal tab key, visible name]; keys double as accessible names. */
const ROUTE_TIPS: Record<Route, string> = {
  PARITY: "Filled from ParityHook inventory at exact share parity.",
  "FALL-THROUGH": "Inventory short; the remainder routes through the v4 pool.",
  DARK: "Size is better crossed in the next dark batch.",
  "BLOCKED-PEG": "Paused: the issuer peg has drifted beyond tolerance.",
  "BLOCKED-ELIGIBILITY": "This wallet has no valid issuer eligibility attestation.",
};
const TABS = [
  ["Convert", "Convert"],
  ["Dark Cross", "Dark Pool"],
  ["Pool", "Pool"],
] as const;
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
  const closedAt = nyse.data
    ? new Date(Number(nyse.data.nextTransition) * 1000)
        .toISOString()
        .replace("T", " ")
        .replace(".000Z", " UTC")
    : "—";
  const systemTip = [
    `Next ${nyse.data?.nextState.toLowerCase() ?? "transition"}: ${closedAt}`,
    `Block ${health.data?.headBlock ?? "—"}`,
    `Skew ${fees.data ? (Number(fees.data.fee.skewX18) / 1e16).toFixed(1) + "%" : "—"}`,
    `Peg guard ${pool.data ? (pool.data.pegTripped ? "TRIPPED" : "CLEAR") : "—"}`,
    `Crank ${crank.data ? (crank.data.ok ? "healthy" : "degraded") : "—"}`,
    `Indexer lag ${health.data?.lagBlocks ?? "—"} blocks`,
  ].join(" · ");
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <div className="wordmark">WrapSwap</div>
        <nav aria-label="Main navigation">
          {TABS.map(([t, name], i) => (
            <React.Fragment key={t}>
              {i > 0 && (
                <span className="sep" aria-hidden="true">
                  ·
                </span>
              )}
              <button
                className={tab === t ? "active" : ""}
                aria-current={tab === t ? "page" : undefined}
                aria-label={name !== t ? t : undefined}
                onClick={() => setTab(t)}
              >
                {name}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="wallet">
          {(health.data?.demoMode ?? d?.demoMode) ||
          eligibility.data?.demoMode ? (
            <span className="badge">
              Demo mode
              {config.useMocks && (
                <Tip text="Simulated transactions: nothing is signed or sent onchain." />
              )}
            </span>
          ) : config.useMocks ? (
            <span className="badge">Simulated transactions</span>
          ) : null}
          <button
            className="primary"
            disabled={!d || pending}
            aria-label={address ? undefined : "Connect wallet"}
            onClick={() =>
              void run(async () => {
                setAddress(await connect(d!));
                setMessage("Wallet connected. Checking eligibility…");
              })
            }
          >
            {address
              ? address.slice(0, 6) + "…" + address.slice(-4)
              : "Connect"}
          </button>
        </div>
      </header>
      <main id="main">
        {tab === "Convert" ? (
          <div className="hero">
            <h1>Swap the wrapper. Keep the share.</h1>
            <h2 className="sub">share-for-share conversion, no USDC leg.</h2>
          </div>
        ) : (
          <div className="hero compact">
            <h1>{TABS.find(([t]) => t === tab)![1]}</h1>
            <h2 className="sub">
              {tab === "Dark Cross"
                ? "Commit privately. Cross at the oracle mid."
                : "Hook-owned inventory, priced by skew."}
            </h2>
          </div>
        )}
        <ApiState state={deployment} label="Deployment" />
        {address && (
          <div className="eligibility">
            <ApiState state={eligibility} label="Eligibility" />
            {eligibility.data &&
              (!eligibility.data.eligible ? (
                <p role="alert" className="error">
                  {eligibility.data.reason.replaceAll("_", " ")}. A valid issuer
                  eligibility attestation is required.
                </p>
              ) : (
                <p className="good">
                  Eligibility verified
                  {eligibility.data.demoMode ? " · demo mode" : ""}
                </p>
              ))}
          </div>
        )}
        {props &&
          (d!.tokens.length !== 2 ? (
            <p role="alert" className="state error">
              Deployment must contain two issuer tokens.
            </p>
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
      </main>
      <footer aria-label="Network status">
        <span
          className={`dot ${nyse.data ? (nyse.data.open ? "open" : "closed") : ""}`}
          aria-hidden="true"
        />
        <span>
          NYSE {nyse.data ? (nyse.data.open ? "open" : "closed") : "—"}
        </span>
        <span aria-hidden="true">·</span>
        <span className="network">
          {d?.network || config.network} · Chain {d?.chainId || "—"}
        </span>
        <span aria-hidden="true">·</span>
        <span>{fees.data ? Number(fees.data.fee.totalBps) : "—"} bps</span>
        <Tip text={systemTip} />
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
    [approved, setApproved] = useState(""),
    [open, setOpen] = useState(false);
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
  const issuer = (t: typeof a) =>
    t.issuer === "coinbase" ? "Coinbase" : "xStocks";
  return (
    <section className="card swap">
      <div className="field">
        <span className="field-label">From · {issuer(a)}</span>
        <div className="field-row">
          <input
            className="amount"
            aria-label="Conversion amount"
            inputMode="decimal"
            placeholder="0"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <select
            className="token"
            aria-label="From token"
            value={a.address}
            onChange={(e) => setReverse(e.target.value === d.tokens[1].address)}
          >
            {d.tokens.map((t) => (
              <option key={t.address} value={t.address}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        {raw <= 0n && (
          <p role="alert" className="field-error">
            Enter a positive amount, up to {a.decimals} decimals.
          </p>
        )}
      </div>
      <button
        type="button"
        className="flip"
        aria-label="Reverse direction"
        onClick={() => setReverse(!reverse)}
      >
        ↓
      </button>
      <div className="field">
        <span className="field-label">To · {issuer(b)}</span>
        <div className="field-row">
          <output className="amount">
            {output ? units(output, b.decimals) : "0"}{" "}
            <span className="unit">{b.symbol}</span>
          </output>
          <span className="token">{b.symbol}</span>
        </div>
      </div>
      <div className="meta">
        {activeRoute ? (
          <span className="route">
            <RouteBadge route={activeRoute} />
            <Tip text={ROUTE_TIPS[activeRoute]} />
          </span>
        ) : (
          <span />
        )}
        {q && (
          <span className="fee-line">Fee {Number(q.fee.totalBps)} bps</span>
        )}
      </div>
      {route.data?.reason && <p className="reason">{route.data.reason}</p>}
      <ApiState state={quote} label="Quote" />
      {address && <ApiState state={route} label="Route" />}
      {!q && !quote.loading && !quote.error && (
        <p className="state">No executable quote.</p>
      )}
      {liveUnavailable && (
        <p role="alert" className="state error">
          Live conversion is unavailable on this deployment.
        </p>
      )}

      <button
        className="primary wide"
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
              onMessage("Approval confirmed. Review the quote, then convert.");
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
      {q && (
        <div className={`details${open ? " open" : ""}`}>
          <button
            type="button"
            className="details-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Details
            <span className="rate">
              {units(
                (BigInt(a.sharesPerTokenX18) * 10n ** 18n) /
                  BigInt(b.sharesPerTokenX18),
              )}{" "}
              {b.symbol}/{a.symbol}
            </span>
          </button>
          <div className="details-body">
            <dl>
              <dt>
                Minimum output{" "}
                <Tip text="0.5% slippage tolerance. Approval is for this amount only." />
              </dt>
              <dd>
                {units(minOut, b.decimals)} {b.symbol}
              </dd>
              <dt>Canonical shares</dt>
              <dd>{units(q.shares)}</dd>
            </dl>
            <Fees fee={q.fee} />
          </div>
        </div>
      )}
    </section>
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
    <div className="stack">
      <section className="card order">
        <div className="card-head">
          <span className="label">
            Batch {batch.data?.batchId ?? "—"}
            {batch.data && (
              <>
                {" · "}
                <span role="timer">
                  {Math.max(
                    0,
                    Number(batch.data.phaseEndsBlock) -
                      Number(batch.data.blockNumber),
                  )}{" "}
                  blocks left
                </span>
              </>
            )}
          </span>
          <span className="route">
            <RouteBadge route="DARK" />
            <Tip text="Commit privately, reveal in the next phase, then settle. Unmatched size routes into the ParityHook pool in the same transaction." />
          </span>
        </div>
        <ApiState state={batch} label="Current batch" />
        <p className="metric">
          {units(amount, a.decimals)} <span className="unit">{a.symbol}</span>
        </p>
        <p className="caption">
          Min {units(limit)} {b.symbol}/{a.symbol}
          {batch.data && (
            <>
              {" · "}oracle{" "}
              {batch.data.oracle.midX18
                ? units(batch.data.oracle.midX18)
                : "unavailable"}
              {" · "}
              {batch.data.participants} in batch
            </>
          )}
        </p>
        {batch.data?.oracle.stale && (
          <p role="alert" className="state error">
            Oracle stale · settlement paused
          </p>
        )}
        <div className="actions steps" data-phase={phase}>
          <button
            className={phase === "COMMIT" ? "primary" : ""}
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
                const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
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
            className={phase === "REVEAL" ? "primary" : ""}
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
            className={phase === "SETTLE" ? "primary" : ""}
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
        {address && (
          <>
            <ApiState
              state={orders}
              label="Orders"
              empty={orders.data?.items.length === 0}
            />
            {orders.data?.items.map((o) => (
              <p className="caption" key={o.batchId}>
                Batch {o.batchId} · {o.revealed ? "Revealed" : "Committed"} ·{" "}
                {o.valid ? "valid" : "awaiting valid reveal"}
              </p>
            ))}
          </>
        )}
      </section>
      <section className="card quiet">
        <div className="card-head">
          <span className="label">Last settlement</span>
        </div>
        <ApiState
          state={history}
          label="Batches"
          empty={history.data?.items.length === 0}
        />
        {history.data?.items.map((h) => (
          <div className="batch" key={h.batchId}>
            <p className="metric">
              {units(h.crossedQuote, b.decimals)}{" "}
              <span className="unit">{b.symbol}</span>
            </p>
            <p className="caption">
              Crossed · batch {h.batchId} · {h.settled ? "settled" : "pending"}
            </p>
            <dl>
              <dt>Base</dt>
              <dd>
                {units(h.crossedBase, a.decimals)} {a.symbol}
              </dd>
              <dt>Residual</dt>
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
            <p className="caption" key={f.txHash + f.logIndex}>
              Residual out{" "}
              <strong>
                {units(f.amountOut, b.decimals)} {b.symbol}
              </strong>{" "}
              · {(f.feePips! / 100).toFixed(2)} bps
            </p>
          ))}
      </section>
    </div>
  );
}
function Pool({ d }: { d: Deployment }) {
  const inventory = useApi("inventory"),
    fills = useApi("fills");
  const skew = inventory.data ? Number(inventory.data.skewX18) / 1e18 : 0;
  return (
    <div className="cards">
      <section className="card">
        <div className="card-head">
          <span className="label">Inventory</span>
          <Tip text="Canonical shares account for issuer ratios; they are not a user-held security." />
        </div>
        <ApiState
          state={inventory}
          label="Inventory"
          empty={inventory.data?.tokens.length === 0}
        />
        {inventory.data && (
          <p className="metric">
            <span className="unit">Total</span>{" "}
            {units(inventory.data.totalShares)}{" "}
            <span className="unit">canonical shares</span>
          </p>
        )}
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
            <dt className="indent">Shares</dt>
            <dd>{units(t.inventoryShares)} shares</dd>
          </dl>
        ))}
        {inventory.data && (
          <label className="skew">
            <span>
              Skew <strong>{(skew * 100).toFixed(1)}%</strong>
            </span>
            <meter min={-1} max={1} value={skew} aria-label="Inventory skew" />
          </label>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <span className="label">Hook fee</span>
          <Tip
            text={`2 + 13 × |skew| + ${inventory.data?.fee.marketOpen ? 0 : 10} closed-market bps, capped at 25 bps.`}
          />
        </div>
        {inventory.data && (
          <p className="metric">
            {Number(inventory.data.fee.totalBps)}{" "}
            <span className="unit">bps</span>
          </p>
        )}
        <svg
          viewBox="0 0 320 115"
          role="img"
          aria-label="Fee increases with absolute inventory skew; off-hours adds 10 basis points"
        >
          <path d="M20 10V90H310" fill="none" stroke="var(--line)" />
          <path
            d="M25 20L165 78L305 20"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
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
      <section className="card span">
        <div className="card-head">
          <span className="label">Recent fills</span>
        </div>
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
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
