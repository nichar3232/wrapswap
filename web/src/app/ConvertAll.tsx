import type { Hash } from "viem";
import type { Address, Deployment } from "@wrapswap/types";
import { request } from "../hooks/useApi";
import { fmtShares } from "../lib/format";
import { relayConvertAll } from "../relay";
import { allowance, approve, convertExactIn, convertedOf, waitReceipt } from "../wallet";
import { toShares, type Asset, type Platform } from "./assets";
import { quoteBreakdown } from "./fees";
import { useTx } from "./tx";
import { Bps, FeeBpsShares, Hex, Sh, Spinner, Tok, TxPanel } from "./ui";
import { useWallet } from "./wallet";

/** One asset's leg of "Convert all to xStocks": raw amounts from the receipt (or the executed quote). */
export type AllResult = {
  asset: string;
  from: Platform;
  to: Platform;
  amountIn: bigint;
  sharesIn: bigint;
  amountOut: bigint;
  sharesOut: bigint;
  feeShares: bigint;
  feePips: number;
  hash: Hash;
  simulated: boolean;
};

/**
 * The comparison route, stated plainly and labelled illustrative: sell the Coinbase-issued token on one venue and buy
 * the xStocks token on another, paying a taker fee on each side plus the price gap between the two issuers' markets.
 */
const SELL_REBUY = { takerBpsPerSide: 10, gapBps: 25 };
const SELL_REBUY_BPS = SELL_REBUY.takerBpsPerSide * 2 + SELL_REBUY.gapBps;

const isTarget = (p: Platform) => /^xStocks\b/.test(p.name);

/** Every non-xStocks balance of every asset, converted into that asset's xStocks wrapper. */
export function ConvertAll({
  d,
  assets,
  onDone,
}: {
  d: Deployment | undefined;
  assets: Asset[];
  onDone: (r: AllResult[], before: Record<string, bigint>) => void;
}) {
  const w = useWallet();
  const tx = useTx<unknown>();
  const jobs = assets.flatMap((asset) => {
    const to = asset.platforms.find(isTarget);
    if (!to || !asset.pool) return [];
    return asset.platforms
      .filter((p) => p !== to && (w.balances.values[p.token.address] ?? 0n) > 0n)
      .map((from) => ({ asset, from, to, balance: w.balances.values[from.token.address]! }));
  });
  const shares = jobs.reduce((s, j) => s + toShares(j.balance, j.from.token), 0n);

  const run = async () => {
    const results: AllResult[] = [];
    // Holdings before, so the after-state is before ± each leg's exact amounts (a fresh RPC read can lag the chain).
    const before = { ...w.balances.values };
    const done = await tx.run("Convert all to xStocks", async (onHash) => {
      if (w.relay) {
        // One relay action: it converts its own whole balance of each other wrapper, asset by asset.
        const r = await relayConvertAll("xStocks");
        for (const leg of r.results) {
          const job = jobs.find((j) => j.asset.symbol === leg.asset) ?? jobs.find((j) => j.from.token.symbol === leg.from);
          const asset = assets.find((a) => a.symbol === leg.asset)!;
          const from = asset.platforms.find((p) => p.token.symbol === leg.from)!,
            to = asset.platforms.find((p) => p.token.symbol === leg.to)!;
          onHash(leg.txHash);
          const c = convertedOf(await waitReceipt(leg.txHash), to.token.address, w.address!);
          const sharesIn = BigInt(leg.sharesIn);
          const feePips = Math.round(Number(leg.feeBps) * 100);
          results.push({
            asset: leg.asset,
            from: job?.from ?? from,
            to,
            amountIn: BigInt(leg.amountIn),
            sharesIn,
            amountOut: c?.amountOut ?? BigInt(leg.quotedOut),
            sharesOut: c?.sharesOut ?? toShares(BigInt(leg.quotedOut), to.token),
            feeShares: c ? c.baseFee + c.skewFee : (sharesIn * BigInt(feePips)) / 1_000_000n,
            feePips,
            hash: leg.txHash,
            simulated: false,
          });
        }
      } else {
        const router = (d!.contracts.wrapSwapRouter ?? d!.router ?? d!.contracts.swapRouter) as Address;
        for (const j of jobs) {
          const params = new URLSearchParams({ tokenIn: j.from.token.address, tokenOut: j.to.token.address, amount: j.balance.toString(), kind: "exactIn" });
          const q = await request("quote", params.toString());
          const qb = quoteBreakdown(q, j.to.token);
          if (!w.demo && (await allowance(j.from.token.address, w.address!, router)) < j.balance)
            await approve(d!, w.address!, j.from.token.address, router, j.balance, { onHash });
          const sent = await convertExactIn(d!, j.asset.pool!.key, w.address!, j.from.token.address, j.balance, (BigInt(q.amountOut) * 995n) / 1000n, w.uid, {
            onHash,
            recipient: w.address,
          });
          const c = sent.receipt ? convertedOf(sent.receipt, j.to.token.address, w.address!) : undefined;
          results.push({
            asset: j.asset.symbol,
            from: j.from,
            to: j.to,
            amountIn: j.balance,
            sharesIn: qb.sharesIn,
            amountOut: c?.amountOut ?? BigInt(q.amountOut),
            sharesOut: c?.sharesOut ?? qb.sharesOut,
            feeShares: c ? c.baseFee + c.skewFee : qb.baseFee + qb.skewFee,
            feePips: q.fee.totalPips,
            hash: sent.hash,
            simulated: sent.simulated,
          });
        }
      }
      for (const r of results) {
        w.adjust(r.from.token.address, -r.amountIn);
        w.adjust(r.to.token.address, r.amountOut);
        w.record({
          hash: r.hash,
          kind: "PARITY",
          text: `${fmtShares(r.sharesIn)} → ${fmtShares(r.sharesOut)} ${r.asset} sh · ${r.from.token.symbol} → ${r.to.token.symbol}`,
          simulated: r.simulated,
        });
      }
      return { hash: results.at(-1)?.hash, simulated: results.every((r) => r.simulated), result: "converted" };
    });
    if (done && results.length) {
      tx.reset();
      onDone(results, before);
    }
  };

  return (
    <section className="card convert-all" aria-label="Convert all to xStocks">
      <div>
        <span className="tile-k">Convert all to xStocks (mock)</span>
        <p className="faucet-line">
          {jobs.length ? (
            <>
              <Sh v={shares} /> shares across {[...new Set(jobs.map((j) => j.asset.symbol))].join(", ")} → xStocks (mock)
            </>
          ) : (
            "Everything is already in xStocks (mock)."
          )}
        </p>
      </div>
      <button className="primary" disabled={!jobs.length || tx.busy || !d} aria-busy={tx.busy || undefined} onClick={() => void run()}>
        {tx.busy && <Spinner />}
        {tx.busy ? "Converting…" : "Convert all to xStocks"}
      </button>
      <TxPanel tx={tx.state} onRetry={() => void run()} />
    </section>
  );
}


/** After-state: the new holdings, each conversion's transaction, and what the same move would cost as sell + rebuy. */
export function ConvertAllResult({
  results,
  before,
  assets,
  onDone,
}: {
  results: AllResult[];
  before: Record<string, bigint>;
  assets: Asset[];
  onDone: () => void;
}) {
  const after = (token: string) => {
    const b = before[token];
    if (b === undefined) return undefined;
    return results.reduce((v, r) => (r.from.token.address === token ? v - r.amountIn : r.to.token.address === token ? v + r.amountOut : v), b);
  };
  const sharesIn = results.reduce((s, r) => s + r.sharesIn, 0n);
  const feeShares = results.reduce((s, r) => s + r.feeShares, 0n);
  // Volume-weighted fee rate across the legs, in pips.
  const feePips = sharesIn ? Number((results.reduce((s, r) => s + r.sharesIn * BigInt(r.feePips), 0n) + sharesIn / 2n) / sharesIn) : 0;
  const altShares = (sharesIn * BigInt(SELL_REBUY_BPS)) / 10_000n;
  const touched = assets.filter((a) => results.some((r) => r.asset === a.symbol));
  return (
    <div className="page portfolio">
      <section className="card receipt convert-all-done" aria-label="Converted all to xStocks" aria-live="polite">
        <p className="receipt-title">
          <span className="ok-dot" aria-hidden="true" /> Converted all to xStocks (mock){results.every((r) => r.simulated) ? " · simulated transactions" : ""}
        </p>
        <div className="table-scroll">
          <table className="all-legs">
            <thead>
              <tr>
                <th>Asset</th>
                <th>In</th>
                <th>Out</th>
                <th>Fee</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.hash}>
                  <td>{r.asset}</td>
                  <td>
                    <Tok v={r.amountIn} decimals={r.from.token.decimals} symbol={r.from.token.symbol} /> {r.from.token.symbol} · <Sh v={r.sharesIn} /> sh
                  </td>
                  <td>
                    <Tok v={r.amountOut} decimals={r.to.token.decimals} symbol={r.to.token.symbol} /> {r.to.token.symbol} · <Sh v={r.sharesOut} /> sh
                    <small className="mult-line">
                      1 {r.to.name} token = <Sh v={r.to.token.sharesPerTokenX18} digits={4} /> sh (multiplier)
                    </small>
                  </td>
                  <td>
                    <FeeBpsShares pips={r.feePips} shares={r.feeShares} />
                  </td>
                  <td>
                    <Hex value={r.hash} kind="tx" simulated={r.simulated} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="card-title">New holdings</h3>
        <ul className="holdings new-holdings">
          {touched.flatMap((a) =>
            a.platforms.map((p) => {
              const bal = after(p.token.address);
              return (
                <li key={p.token.address} className="holding">
                  <div className="holding-name">
                    <span className="platform">
                      {a.symbol} · {p.name}
                    </span>
                    <span className="symbol">
                      {bal !== undefined ? <Tok v={bal} decimals={p.token.decimals} symbol={p.token.symbol} /> : "—"} {p.token.symbol}
                    </span>
                  </div>
                  <span className="holding-shares">{bal !== undefined ? <Sh v={toShares(bal, p.token)} /> : "—"} sh</span>
                </li>
              );
            }),
          )}
        </ul>

        <h3 className="card-title">Cost comparison</h3>
        <dl className="receipt-rows cost-compare">
          <div>
            <dt>Unison Convert (this transaction)</dt>
            <dd data-testid="cost-unison">
              <FeeBpsShares pips={feePips} shares={feeShares} />
            </dd>
          </div>
          <div>
            <dt>Sell + rebuy (illustrative)</dt>
            <dd data-testid="cost-alt">
              <Bps pips={SELL_REBUY_BPS * 100} /> · <Sh v={altShares} /> sh
            </dd>
          </div>
          <div className="cost-save">
            <dt>Saved</dt>
            <dd data-testid="cost-saved">
              <Sh v={altShares > feeShares ? altShares - feeShares : 0n} /> sh
            </dd>
          </div>
        </dl>
        <p className="hint">
          Illustrative, not a quote: selling on one venue and buying on another at a {(SELL_REBUY.takerBpsPerSide / 100).toFixed(2)}% taker fee per side
          plus a {(SELL_REBUY.gapBps / 100).toFixed(2)}% price gap between the issuers&rsquo; markets. The Unison figure is the fee in the transaction above.
        </p>
        <button type="button" className="ghost-btn" onClick={onDone}>
          Back to portfolio
        </button>
      </section>
    </div>
  );
}
