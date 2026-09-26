import type { FeeBreakdown, Route } from "@wrapswap/types";
export function RouteBadge({ route }: { route: Route }) {
  return (
    <span
      className={`pill ${route.startsWith("BLOCKED") ? "error" : "good"}`}
      data-testid="route-badge"
    >
      {route}
    </span>
  );
}
/** Total fee always visible; the off-hours premium is labelled inline; the breakdown expands on demand. */
export function Fees({
  fee,
  open = false,
  onToggle,
}: {
  fee: FeeBreakdown;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className={`fees${open ? " open" : ""}`}>
      <div className="fee-total">
        <span className="fee-label">
          Fee{" "}
          <Tip text="2 bps base + up to 13 bps for inventory skew + 10 bps while NYSE is closed. Max 25 bps." />
        </span>
        <span className="fee-value">{fee.totalBps} bps</span>
        {onToggle && (
          <button
            type="button"
            className="link-btn"
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? "Hide breakdown" : "Breakdown"}
          </button>
        )}
      </div>
      {!fee.marketOpen && (
        <p className="premium">
          NYSE closed: +{fee.closedPips / 100} bps off-hours premium
        </p>
      )}
      <dl className="fee-breakdown">
        <dt>Base fee</dt>
        <dd>{fee.basePips / 100} bps</dd>
        <dt>Inventory skew</dt>
        <dd>{(fee.skewPips / 100).toFixed(2)} bps</dd>
        <dt>Closed-market add-on</dt>
        <dd>{fee.closedPips / 100} bps</dd>
      </dl>
    </div>
  );
}
/** Hover/focus tooltip; the glyph and bubble are CSS-only so they never add DOM text. */
export function Tip({ text }: { text: string }) {
  return (
    <span
      className="tip"
      tabIndex={0}
      role="img"
      aria-label={text}
      data-tip={text}
    />
  );
}
