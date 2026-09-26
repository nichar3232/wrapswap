import type { PoolAssetResponse } from "@wrapswap/types";
import type { Feed } from "../hooks/useApi";
import { amount, fmtShares } from "../lib/format";
import { issuerLabel, type Asset } from "./assets";
import { keeperSetInventory, skewPct } from "./fees";
import { Tip } from "../components";
import { Skeleton, Val } from "./ui";

type Wrapper = PoolAssetResponse["wrappers"][number];
type Direction = PoolAssetResponse["directions"][number];

/** A beam that tips toward the wrapper the hook holds more of; each pan shows its inventory in shares. */
function Balance({ wrappers, skewX18 }: { wrappers: Wrapper[]; skewX18: string }) {
  const [l, r] = wrappers;
  const L = BigInt(l.inventoryShares),
    R = BigInt(r.inventoryShares);
  const total = L + R;
  const tilt = total === 0n ? 0 : Number(((R - L) * 10_000n) / total) / 10_000; // −1…1, + = right heavier
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
      aria-label={`Inventory: ${wrappers.map((x) => `${issuerLabel(x.platform)} ${fmtShares(x.inventoryShares)} shares`).join(", ")}; skew ${skewPct(skewX18)}`}
    >
      <path className="bal-post" d={`M${cx} ${cy} L${cx - 26} 214 H${cx + 26} Z`} />
      <line className="bal-beam" x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} />
      <circle className="bal-pivot" cx={cx} cy={cy} r={6} />
      {wrappers.map((x, i) => (
        <g key={x.address} className="bal-pan">
          <line x1={ends[i].x} y1={ends[i].y} x2={ends[i].x} y2={ends[i].y + 30} />
          <rect x={ends[i].x - 96} y={ends[i].y + 30} width={192} height={64} rx={12} />
          <text x={ends[i].x} y={ends[i].y + 56} textAnchor="middle" className="bal-name">
            {issuerLabel(x.platform)}
          </text>
          <text x={ends[i].x} y={ends[i].y + 78} textAnchor="middle" className="bal-fee">
            {amount(x.inventoryShares, 18, 0)} sh
          </text>
        </g>
      ))}
    </svg>
  );
}

const KEEPER_WHY =
  "Keeper only in v1: one inventory supplier keeps the multiplier attestations and wrapper whitelisting simple. Permissionless deposits come in v2.";

/**
 * Liquidity for the selected asset, from GET /pool/:asset: inventory per wrapper, skew, the fee each direction pays
 * now, and what the LP has earned. Display-only: depositInventory / withdrawInventory are keeper-only.
 */
export function Liquidity({ asset, pool, onMove }: { asset: Asset | undefined; pool: Feed<"poolAsset">; onMove: (fromToken: string) => void }) {
  const p = pool.data && asset && pool.data.asset === asset.symbol ? pool.data : undefined;
  if (!asset || !p)
    return (
      <div className="page">
        <section className="card">
          {pool.status === "unavailable" ? (
            <Val status="unavailable">{null}</Val>
          ) : (
            <Skeleton w="100%" h="14em" />
          )}
        </section>
      </div>
    );
  const name = (sym: string) => {
    const w = p.wrappers.find((x) => x.symbol === sym);
    return w ? issuerLabel(w.platform) : sym;
  };
  const tokenOf = (sym: string) => asset.platforms.find((x) => x.token.symbol === sym)?.token.address;
  const cheap = p.directions.find((x) => x.from === p.cheapDirection.from && x.to === p.cheapDirection.to) ?? p.directions[0];
  const baseBps = (x: Direction) => ((x.totalPips - x.skewFeePips) / 100).toFixed(2);
  return (
    <div className="page liquidity">
      <h1 className="page-title">Pool inventory &amp; LP economics</h1>
      <div className="liq-top">
        <section className="card liq-hero" aria-label={`${asset.symbol} fee by direction`}>
          <span className="tile-k">{asset.symbol} · fee by direction now</span>
          <div className="dir-fees">
            {p.directions.map((x) => (
              <div key={x.from} className={`dir${x === cheap ? " cheap" : ""}`}>
                <span className="dir-name">
                  {name(x.from)} → {name(x.to)}
                </span>
                <span className="dir-v">
                  {x.totalBps} <small>bps</small>
                </span>
                <span className="dir-s">
                  {x.reducesImbalance || x.skewFeePips === 0
                    ? `${baseBps(x)} base · skew 0 — rebalances the pool`
                    : `${baseBps(x)} base + ${(x.skewFeePips / 100).toFixed(2)} skew · to LP`}
                </span>
              </div>
            ))}
          </div>
          <button className="primary" disabled={!tokenOf(cheap.from)} onClick={() => onMove(tokenOf(cheap.from)!)}>
            Cheap direction now: {name(cheap.from)} → {name(cheap.to)}
          </button>
        </section>
        <section className="card" aria-label={`${asset.symbol} inventory`}>
          <div className="card-head">
            <span className="tile-k">
              Inventory · <span data-testid="skew">skew {skewPct(p.skewX18)}</span>
            </span>
            <span className="muted">{fmtShares(p.totalShares, 0)} sh total</span>
          </div>
          <Balance wrappers={p.wrappers} skewX18={p.skewX18} />
          <ul className="inv-rows">
            {p.wrappers.map((x) => {
              const t = asset.platforms.find((q) => q.token.address.toLowerCase() === x.address.toLowerCase())?.token;
              return (
                <li key={x.address}>
                  <span>{issuerLabel(x.platform)}</span>
                  <span className="mono">
                    {fmtShares(x.inventoryShares)} sh · {t ? amount(x.inventory, t.decimals, 2) : "—"} {x.symbol}
                  </span>
                </li>
              );
            })}
          </ul>
          {keeperSetInventory(p) && (
            <p className="muted small" data-testid="keeper-set">
              Inventory set by pool keeper
            </p>
          )}
        </section>
      </div>
      <section className="card keeper" aria-label="Who supplies inventory">
        <p className="lp-line">
          <strong>Who supplies inventory:</strong> in v1 a single pool keeper (a market maker) seeds and rebalances both wrappers and earns 100% of
          Convert fees. Permissionless LP deposits are v2.
        </p>
        <div className="keeper-act">
          <button type="button" className="ghost-btn" disabled aria-describedby="keeper-why">
            Add inventory <small>keeper only in v1</small>
          </button>
          <Tip text={KEEPER_WHY} />
          <span id="keeper-why" className="sr-only">
            {KEEPER_WHY}
          </span>
        </div>
      </section>
      <section className="card lp" aria-label="LP economics">
        <h2 className="card-title">LP economics</h2>
        <div className="tiles">
          <div className="tile">
            <span className="tile-k">LP fees earned</span>
            <span className="tile-v">
              {fmtShares(p.lpFees.totalShares, 4)} <small>sh</small>
            </span>
            <span className="tile-s">
              {p.lpFees.fills} conversion{p.lpFees.fills === 1 ? "" : "s"}
            </span>
          </div>
          <div className="tile">
            <span className="tile-k">Base fees</span>
            <span className="tile-v">
              {fmtShares(p.lpFees.baseShares, 4)} <small>sh</small>
            </span>
          </div>
          <div className="tile">
            <span className="tile-k">Skew fees</span>
            <span className="tile-v">
              {fmtShares(p.lpFees.skewShares, 4)} <small>sh</small>
            </span>
          </div>
        </div>
        <p className="lp-line">All Convert fees (base + skew) go to the LP. The protocol takes 0 on Convert.</p>
        <p className="lp-line">Both sides are the same share — no impermanent loss from price divergence. Risk is inventory getting stuck lopsided.</p>
        <p className="muted small">Inventory is added and removed by the pool keeper (keeper-only on ParityHook).</p>
      </section>
    </div>
  );
}
