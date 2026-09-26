import { useState } from "react";
import type { Deployment } from "@wrapswap/types";
import { config } from "../config";
import { useApi, type Feed } from "../hooks/useApi";
import { amount } from "../lib/format";
import { platformName, toShares, type Asset, type Platform } from "./assets";
import { FeeCurve, hours, pct } from "./FeeCurve";
import { pipsToBps, tradeFee, type Inventory } from "./fees";
import { fmtShares } from "./Move";
import { Empty, Hex, Val } from "./ui";

/** A beam that tips toward the side holding more inventory; each pan shows the fee for moving out of that platform. */
function Balance({ sides }: { sides: { p: Platform; bps: number; cheap: boolean; shares: bigint }[] }) {
  const [l, r] = sides;
  const total = l.shares + r.shares;
  const tilt = total === 0n ? 0 : Number(((r.shares - l.shares) * 10_000n) / total) / 10_000; // −1…1, + = right heavier
  const angle = Math.max(-14, Math.min(14, tilt * 40));
  const W = 640,
    cx = W / 2,
    cy = 70,
    arm = 220;
  const rad = (angle * Math.PI) / 180;
  const ends = [
    { x: cx - arm * Math.cos(rad), y: cy - arm * Math.sin(rad) },
    { x: cx + arm * Math.cos(rad), y: cy + arm * Math.sin(rad) },
  ];
  return (
    <svg
      className="balance-svg"
      viewBox={`0 0 ${W} 230`}
      role="img"
      aria-label={`Inventory balance: ${sides.map((s) => `${s.p.name} ${fmtShares(s.shares)} shares, ${s.bps.toFixed(2)} bps to move out`).join("; ")}`}
    >
      <path className="bal-post" d={`M${cx} ${cy} L${cx - 26} 214 H${cx + 26} Z`} />
      <line className="bal-beam" x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} />
      <circle className="bal-pivot" cx={cx} cy={cy} r={6} />
      {sides.map((s, i) => (
        <g key={s.p.token.address} className={`bal-pan${s.cheap ? " cheap" : ""}`}>
          <line x1={ends[i].x} y1={ends[i].y} x2={ends[i].x} y2={ends[i].y + 30} />
          <rect x={ends[i].x - 96} y={ends[i].y + 30} width={192} height={64} rx={12} />
          <text x={ends[i].x} y={ends[i].y + 56} textAnchor="middle" className="bal-name">
            {s.p.name}
          </text>
          <text x={ends[i].x} y={ends[i].y + 78} textAnchor="middle" className="bal-fee">
            {amount(s.shares, 18, 0)} sh · {s.bps.toFixed(2)} bps
          </text>
        </g>
      ))}
    </svg>
  );
}

function AssetLiquidity({
  asset,
  inventory,
  marketOpen,
  onMove,
}: {
  asset: Asset;
  inventory: Feed<"inventory">;
  marketOpen?: boolean;
  onMove: (fromToken: string) => void;
}) {
  const invTokens = inventory.data?.tokens ?? [];
  const find = (p: Platform) => invTokens.findIndex((t) => t.address.toLowerCase() === p.token.address.toLowerCase());
  const ready = asset.platforms.length === 2 && asset.platforms.every((p) => find(p) >= 0) && marketOpen !== undefined;
  if (!ready)
    return (
      <section className="card">
        <Val status={inventory.status === "ok" ? "loading" : inventory.status} w="100%" h="10em">
          {null}
        </Val>
      </section>
    );
  const inv: Inventory = { shares0: BigInt(invTokens[0].inventoryShares), shares1: BigInt(invTokens[1].inventoryShares) };
  // Reference size: 100 shares (the demo conversion), priced with the shared formula for each direction.
  const ref = 100n * 10n ** 18n;
  const sides = asset.platforms.map((p) => {
    const f = tradeFee(inv, { sharesIn: ref, inIsToken0: find(p) === 0 }, marketOpen!);
    return { p, f, bps: pipsToBps(f.totalPips), shares: BigInt(invTokens[find(p)].inventoryShares), cheap: false };
  });
  const [x, y] = sides;
  const strictly = x.bps !== y.bps;
  const best = strictly ? (x.bps < y.bps ? x : y) : x.f.rebalances ? x : y;
  best.cheap = true;
  const skew = Number(inventory.data!.skewX18) / 1e18;
  const other = (s: (typeof sides)[number]) => sides.find((z) => z !== s)!.p;
  return (
    <>
      <section className="card liq-hero" aria-label={`${asset.symbol} fees by direction`}>
        <span className="tile-k">{asset.symbol} · fee by direction (100 shares)</span>
        <div className="dir-fees">
          {sides.map((s) => (
            <div key={s.p.token.address} className={`dir${s.cheap ? " cheap" : ""}`}>
              <span className="dir-name">
                {s.p.name} → {other(s).name}
              </span>
              <span className="dir-v">
                {s.bps.toFixed(2)} <small>bps</small>
              </span>
              <span className="dir-s">{s.f.rebalances ? "rebalances the pool" : "adds to the imbalance"}</span>
            </div>
          ))}
        </div>
        <button className="primary" onClick={() => onMove(best.p.token.address)}>
          {strictly ? "Move the cheap direction →" : "Move the rebalancing direction →"}
        </button>
      </section>
      <section className="card" aria-label={`${asset.symbol} inventory balance`}>
        <div className="card-head">
          <span className="tile-k">Inventory · skew {pct(skew)}</span>
          <meter className="sr-only" min={-1} max={1} value={skew} aria-label="Inventory skew" />
        </div>
        <Balance sides={sides} />
      </section>
    </>
  );
}

export function Liquidity({
  d,
  assets,
  fees,
  nyse,
  onMove,
}: {
  d: Deployment | undefined;
  assets: Asset[];
  fees: Feed<"fees">;
  nyse: Feed<"nyse">;
  onMove: (fromToken: string) => void;
}) {
  const inventory = useApi("inventory");
  const fills = useApi("fills");
  const stats = useApi("stats", "", 15000);
  const [curve, setCurve] = useState(false);
  const skew = inventory.data ? Number(inventory.data.skewX18) / 1e18 : undefined;
  const conversions = stats.data ? stats.data.byKind.PARITY + stats.data.byKind["FALL-THROUGH"] : undefined;
  const crosses = stats.data ? stats.data.byKind["DARK-CROSS"] : undefined;
  return (
    <div className="page">
      <div className="liq-top">
        {assets.map((a) => (
          <AssetLiquidity key={a.symbol} asset={a} inventory={inventory} marketOpen={fees.data?.fee.marketOpen} onMove={onMove} />
        ))}
      </div>
      <div className="tiles">
        <section className="card tile" aria-label="Volume converted">
          <span className="tile-k">Volume converted</span>
          <span className="tile-v">
            <Val status={stats.status} w="4em" h="1em">
              {stats.data && fmtShares(stats.data.sharesVolume)} <small>shares</small>
            </Val>
          </span>
          <span className="tile-s">
            {conversions !== undefined ? `${conversions} instant move${conversions === 1 ? "" : "s"} · ${crosses} sealed cross fill${crosses === 1 ? "" : "s"}` : " "}
          </span>
        </section>
        <section className="card tile" aria-label="Fees earned">
          <span className="tile-k">Fees earned by inventory</span>
          <span className="tile-v">
            <Val status={stats.status} w="4em" h="1em">
              {stats.data && fmtShares(stats.data.feesEarned.totalShares)} <small>shares</small>
            </Val>
          </span>
          <span className="tile-s">
            {stats.data
              ? stats.data.feesEarned.tokens
                  .filter((t) => BigInt(t.amount) > 0n)
                  .map((t) => {
                    const tok = d?.tokens.find((x) => x.address === t.address);
                    return `${amount(t.amount, tok?.decimals ?? 18, 4)} ${t.symbol}`;
                  })
                  .join(" · ") || "none yet"
              : " "}
          </span>
        </section>
        <section className="card tile" aria-label="Market">
          <span className="tile-k">Market</span>
          <span className="tile-v">
            <Val status={nyse.status} w="5em" h="1em">
              {nyse.data && <span className={nyse.data.open ? "good" : "warn"}>{nyse.data.open ? "Open" : "Closed"}</span>}
            </Val>
          </span>
          <span className="tile-s">
            {nyse.data
              ? nyse.data.open
                ? `NYSE closes in ${hours(nyse.data.secondsUntilTransition)}`
                : `Moves live 24/7 · NYSE opens in ${hours(nyse.data.secondsUntilTransition)}`
              : " "}
          </span>
        </section>
      </div>

      <section className="card" aria-label="Recent fills">
        <h2 className="card-title">Recent fills</h2>
        {fills.data ? (
          fills.data.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Fee</th>
                    <th>Transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.data.items.map((f) => {
                    const a = d?.tokens.find((t) => t.address === f.tokenIn),
                      b = d?.tokens.find((t) => t.address === f.tokenOut);
                    return (
                      <tr key={f.txHash + f.logIndex}>
                        <td>
                          {f.kind === "PARITY" ? "Instant" : f.kind === "FALL-THROUGH" ? "Instant (AMM)" : f.kind === "DARK-RESIDUAL" ? "Cross residual" : "Sealed cross"}
                        </td>
                        <td>
                          {a ? `${fmtShares(toShares(BigInt(f.amountIn), a))} sh · ${platformName(a)}` : "—"}
                        </td>
                        <td>
                          {b ? `${fmtShares(toShares(BigInt(f.amountOut), b))} sh · ${platformName(b)}` : "—"}
                        </td>
                        <td>{f.feePips === null ? "—" : (f.feePips / 100).toFixed(2) + " bps"}</td>
                        <td>
                          <Hex value={f.txHash} kind="tx" simulated={config.useMocks} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No fills yet.</Empty>
          )
        ) : (
          <Val status={fills.status} w="100%" h="4em">
            {null}
          </Val>
        )}
      </section>

      <section className="card quiet">
        <button type="button" className="disclosure" aria-expanded={curve} onClick={() => setCurve(!curve)}>
          How fees work
        </button>
        {curve && <FeeCurve key={inventory.data && fees.data ? "live" : "static"} liveSkew={skew} liveOpen={fees.data?.fee.marketOpen} />}
      </section>
    </div>
  );
}
