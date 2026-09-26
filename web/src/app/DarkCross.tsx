import { useEffect, useState } from "react";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { DEMO, type Address, type BatchPhase, type Deployment } from "@wrapswap/types";
import { RouteBadge, Tip } from "../components";
import { config } from "../config";
import { useApi } from "../hooks/useApi";
import { amount } from "../lib/format";
import { approve, darkSend, verifyOrder } from "../wallet";
import { BatchTimeline } from "./BatchTimeline";
import { useTx } from "./tx";
import { Empty, Hex, Skeleton, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

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
const zero32 = toHex(new Uint8Array(32));
const BLOCK_SECONDS = config.network === "unichain-sepolia" ? 1 : undefined;

export function DarkCross({ d }: { d: Deployment | undefined }) {
  const w = useWallet();
  const batch = useApi("currentBatch"),
    history = useApi("batches"),
    fills = useApi("fills", "kind=DARK-RESIDUAL");
  const orders = useApi("orders", w.address || null);
  const tx = useTx();
  const storageKey = d && `wrapswap:${d.chainId}:${d.contracts.darkCrossHook}:${w.address}`;
  const [saved, setSaved] = useState<SavedOrder>();
  const [mockPhase, setMockPhase] = useState<BatchPhase>("COMMIT");
  useEffect(() => {
    if (!storageKey) return;
    try {
      const value = localStorage.getItem(storageKey);
      setSaved(value ? JSON.parse(value) : undefined);
    } catch {
      setSaved(undefined);
    }
  }, [storageKey]);
  const store = (o: SavedOrder | undefined) => {
    try {
      if (o) localStorage.setItem(storageKey!, JSON.stringify(o));
      else localStorage.removeItem(storageKey!);
    } catch {
      /* storage blocked: the order lives for this page only */
    }
    setSaved(o);
  };

  const phase: BatchPhase | undefined = config.useMocks ? mockPhase : batch.data?.phase;
  const realLeft = batch.data ? Math.max(0, Number(batch.data.phaseEndsBlock) - Number(batch.data.blockNumber)) : undefined;
  const blocksLeft = config.useMocks && batch.data ? { COMMIT: realLeft!, REVEAL: 4, SETTLE: 1 }[mockPhase] : realLeft;
  const a = d?.tokens.find((t) => t.address === d.dark.baseToken),
    b = d?.tokens.find((t) => t.address === d.dark.quoteToken);
  const orderAmount = DEMO.dark.orders.counterpartyA.amountIn,
    limit = DEMO.dark.orders.counterpartyA.limitPriceX18;
  const stale = !!batch.data?.oracle.stale;
  const canAct = w.ready && w.eligible && !!batch.data && !tx.busy;

  const commit = () =>
    tx.run("Commit", async (onHash) => {
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const o: SavedOrder = {
        chainId: d!.chainId,
        account: w.address!,
        hook: d!.contracts.darkCrossHook,
        batchId: batch.data!.batchId,
        amount: orderAmount.toString(),
        limit: limit.toString(),
        salt,
        confirmed: false,
      };
      store(o);
      await approve(d!, w.address!, a!.address, d!.contracts.darkCrossHook, orderAmount, { onHash });
      await darkSend(d!, w.address!, "fund", [a!.address, orderAmount], { onHash });
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
          [BigInt(d!.chainId), d!.contracts.darkCrossHook, BigInt(o.batchId), w.address!, true, orderAmount, limit, true, salt],
        ),
      );
      const sent = await darkSend(d!, w.address!, "commit", [hash, a!.address, orderAmount, w.uid || zero32], { onHash });
      await verifyOrder(d!, w.address!, o.batchId, hash);
      store({ ...o, confirmed: true });
      if (config.useMocks) setMockPhase("REVEAL");
      orders.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: null };
    });
  const reveal = () =>
    tx.run("Reveal", async (onHash) => {
      const sent = await darkSend(
        d!,
        w.address!,
        "reveal",
        [true, BigInt(saved!.amount), BigInt(saved!.limit), true, saved!.salt],
        { onHash },
      );
      await verifyOrder(d!, w.address!, saved!.batchId);
      if (config.useMocks) setMockPhase("SETTLE");
      orders.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: null };
    });
  const settle = () =>
    tx.run("Settlement", async (onHash) => {
      const sent = await darkSend(d!, w.address!, "settle", [BigInt(batch.data!.batchId)], { onHash });
      store(undefined);
      history.refresh();
      fills.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: null };
    });

  const steps: { label: string; phase: BatchPhase; run: () => void; enabled: boolean }[] = [
    { label: "Approve, fund & commit", phase: "COMMIT", run: commit, enabled: canAct && phase === "COMMIT" && !saved?.confirmed },
    {
      label: "Reveal order",
      phase: "REVEAL",
      run: reveal,
      enabled: canAct && phase === "REVEAL" && !!saved?.confirmed && saved.batchId === batch.data?.batchId,
    },
    { label: "Settle batch", phase: "SETTLE", run: settle, enabled: canAct && phase === "SETTLE" && !stale },
  ];
  const last = history.data?.items.find((h) => h.settled);

  return (
    <div className="stack wide-stack">
      <section className="card batch-card" aria-label="Current batch">
        <div className="card-head">
          <span className="label">
            <Val status={batch.status} w="10em">
              Batch #{batch.data?.batchId}
              {phase && <span className={`phase phase-${phase.toLowerCase()}`}>{phase}</span>}
            </Val>
          </span>
          <span className="route">
            <RouteBadge route="DARK" />
            <Tip text="Orders are committed sealed, revealed in the next phase, and crossed at the oracle's 30-minute midpoint. The unmatched residual routes into the ParityHook pool in the same transaction." />
          </span>
        </div>
        <div className="batch-stats">
          <div>
            <span className="stat-k">Time left in phase</span>
            <span className="stat-v" role="timer">
              <Val status={batch.status} w="5em">
                {blocksLeft} blocks
                {BLOCK_SECONDS && <small> ≈ {blocksLeft! * BLOCK_SECONDS} s</small>}
              </Val>
            </span>
          </div>
          <div>
            <span className="stat-k">Participants</span>
            <span className="stat-v">
              <Val status={batch.status} w="2em">
                {batch.data?.participants}
              </Val>
            </span>
          </div>
          <div>
            <span className="stat-k">
              Oracle mid <Tip text="30-minute midpoint; a mock oracle on testnet." />
            </span>
            <span className="stat-v">
              <Val status={batch.status} w="6em">
                {batch.data?.oracle.midX18 ? (
                  <>
                    {amount(batch.data.oracle.midX18, 18, 6)} <small>{b?.symbol}/{a?.symbol}</small>
                  </>
                ) : (
                  <span className="val-na">
                    — <small>unavailable</small>
                  </span>
                )}
              </Val>
            </span>
          </div>
        </div>
        {d ? (
          <BatchTimeline phase={batch.data ? phase : undefined} blocksLeft={blocksLeft} dark={d.dark} />
        ) : (
          <Skeleton w="100%" h="64px" />
        )}
        {stale && (
          <p role="alert" className="block-reason">
            Oracle stale · settlement paused until the next midpoint update.
          </p>
        )}
      </section>

      <section className="card order" aria-label="Your order">
        <div className="card-head">
          <span className="label">Your order</span>
          <Tip text="The demo order: sell the base issuer token for the quote issuer token with a price limit. Commit hides it until reveal." />
        </div>
        <p className="metric">
          {a ? (
            <>
              {amount(orderAmount, a.decimals)} <span className="unit">{a.symbol}</span>
            </>
          ) : (
            <Skeleton w="5em" h="1em" />
          )}
        </p>
        <p className="caption">
          {b && a ? `Limit ${amount(limit, 18, 4)} ${b.symbol}/${a.symbol} · sealed until reveal` : <Skeleton w="12em" />}
        </p>
        {!w.address ? (
          <button className="primary wide" disabled={!d || !!w.busy} onClick={() => void w.connect()}>
            {w.busy === "connect" ? "Connecting…" : "Connect to trade"}
          </button>
        ) : w.wrongChain ? (
          <button className="primary wide" disabled={!!w.busy} onClick={() => void w.switchChain()}>
            Switch to {w.expected.name}
          </button>
        ) : (
          <div className="actions steps" data-phase={phase}>
            {steps.map((s) => {
              const current = s.phase === phase;
              const running = tx.busy && current;
              return (
                <button
                  key={s.label}
                  className={current ? "primary" : ""}
                  disabled={!s.enabled}
                  aria-busy={running || undefined}
                  onClick={s.run}
                >
                  {running && <Spinner />}
                  {s.label}
                </button>
              );
            })}
          </div>
        )}
        {w.address && w.eligibility.data && !w.eligible && (
          <p role="alert" className="block-reason">
            This wallet isn't eligible for issuer conversions. A valid issuer eligibility attestation is required.
          </p>
        )}
        {w.notice && (
          <p role="alert" className="block-reason">
            {w.notice}
          </p>
        )}
        <TxPanel
          tx={tx.state}
          onRetry={tx.retry}
          receipt={() =>
            tx.state.step === "confirmed" && (
              <p>
                <span className="ok-dot" aria-hidden="true" />{" "}
                {tx.state.label === "Commit"
                  ? "Commit confirmed. Your reveal secret is saved in this browser; keep it until settlement."
                  : tx.state.label === "Reveal"
                    ? "Reveal confirmed. The residual will settle through ParityHook."
                    : "Batch settled: matched issuer tokens crossed; residual routed through ParityHook."}
                {config.useMocks ? " (simulated)" : ""}
                {tx.state.hash && (
                  <>
                    {" "}
                    <Hex value={tx.state.hash} kind="tx" simulated={config.useMocks} />
                  </>
                )}
              </p>
            )
          }
        />
      </section>

      <section className="card" aria-label="Your orders">
        <div className="card-head">
          <span className="label">Your orders</span>
        </div>
        {!w.address ? (
          <Empty>Connect a wallet to see your committed and revealed orders.</Empty>
        ) : orders.data ? (
          orders.data.items.length ? (
            <ul className="orders">
              {orders.data.items.map((o) => (
                <li key={o.batchId}>
                  <span>Batch #{o.batchId}</span>
                  <span className={`chip ${o.revealed ? (o.valid ? "good" : "warn") : ""}`}>
                    {o.revealed ? (o.valid ? "Revealed · valid" : "Revealed · awaiting valid reveal") : "Committed · sealed"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>
              No orders yet.{" "}
              {phase === "COMMIT" ? `Commit the order above to join batch #${batch.data?.batchId ?? ""}.` : "The next commit window opens with the next batch."}
            </Empty>
          )
        ) : (
          <Val status={orders.status} w="100%">
            {null}
          </Val>
        )}
      </section>

      <section className="card quiet" aria-label="Last settlement">
        <div className="card-head">
          <span className="label">Last settled batch</span>
        </div>
        {last && a && b ? (
          <>
            <p className="metric">
              {amount(last.crossedQuote, b.decimals, 6)} <span className="unit">{b.symbol}</span>
            </p>
            <p className="caption">Crossed at the oracle midpoint · batch #{last.batchId}</p>
            <dl>
              <dt>Base crossed</dt>
              <dd>
                {amount(last.crossedBase, a.decimals, 6)} {a.symbol}
              </dd>
              <dt>Residual to pool</dt>
              <dd>
                {amount(last.residualBaseIn, a.decimals, 6)} {a.symbol}
              </dd>
              {last.settledTx && (
                <>
                  <dt>Settle transaction</dt>
                  <dd>
                    <Hex value={last.settledTx} kind="tx" simulated={config.useMocks} />
                  </dd>
                </>
              )}
            </dl>
            {fills.data?.items
              .filter((f) => f.kind === "DARK-RESIDUAL")
              .slice(0, 1)
              .map((f) => (
                <p className="caption" key={f.txHash + f.logIndex}>
                  Residual out{" "}
                  <strong>
                    {amount(f.amountOut, b.decimals, 6)} {b.symbol}
                  </strong>{" "}
                  · {f.feePips === null ? "—" : (f.feePips / 100).toFixed(2) + " bps"}
                </p>
              ))}
          </>
        ) : history.data ? (
          <Empty>No batches yet. The first settlement will appear here with its transaction.</Empty>
        ) : (
          <Val status={history.status} w="100%" h="3em">
            {null}
          </Val>
        )}
      </section>
    </div>
  );
}
