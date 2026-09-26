import type { Route } from "@wrapswap/types";
import { fmtShares } from "./lib/format";

export function RouteBadge({ route }: { route: Route }) {
  return (
    <span className={`pill ${route.startsWith("BLOCKED") ? "error" : "good"}`} data-testid="route-badge">
      {route}
    </span>
  );
}

/**
 * The Convert fee split, in shares. Both parts go to the LP (the protocol takes nothing on Convert). The skew fee is
 * charged only when the trade increases the inventory imbalance; a rebalancing trade shows 0 and says so.
 */
export function FeeRows({
  basePips,
  skewPips,
  baseFee,
  skewFee,
  reducesImbalance,
}: {
  basePips: number;
  skewPips: number;
  baseFee: bigint;
  skewFee: bigint;
  reducesImbalance: boolean;
}) {
  return (
    <dl className="fee-rows" data-testid="fee-breakdown">
      <div>
        <dt>
          Base fee <small>{(basePips / 100).toFixed(2)} bps · to LP</small>
        </dt>
        <dd>{fmtShares(baseFee, 4)}</dd>
      </div>
      <div>
        <dt>
          Skew fee{" "}
          <small>{reducesImbalance || skewPips === 0 ? "0 — this trade rebalances the pool" : `${(skewPips / 100).toFixed(2)} bps · to LP`}</small>
        </dt>
        <dd>{fmtShares(skewFee, 4)}</dd>
      </div>
    </dl>
  );
}

/** Hover/focus tooltip; the glyph and bubble are CSS-only so they never add DOM text. */
export function Tip({ text }: { text: string }) {
  return <span className="tip" tabIndex={0} role="img" aria-label={text} data-tip={text} />;
}
