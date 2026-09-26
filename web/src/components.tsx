import React from "react";
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
export function Fees({ fee }: { fee: FeeBreakdown }) {
  return (
    <div className="fees" data-testid="fee-breakdown">
      <dl>
        <dt>Base fee</dt>
        <dd>{fee.basePips / 100} bps</dd>
        <dt>Inventory skew</dt>
        <dd>{(fee.skewPips / 100).toFixed(2)} bps</dd>
        <dt>Closed-market add-on</dt>
        <dd>{fee.closedPips / 100} bps</dd>
        <dt>
          Total{" "}
          <Tip text="Prices inventory skew and off-hours risk. Max 25 bps." />
        </dt>
        <dd>{fee.totalBps} bps</dd>
      </dl>
      {!fee.marketOpen && (
        <p className="premium">
          NYSE closed: +{fee.closedPips / 100} bps off-hours premium
        </p>
      )}
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
export function ApiState({
  state,
  label,
  empty = false,
}: {
  state: { loading: boolean; error?: string; data?: unknown };
  label: string;
  empty?: boolean;
}) {
  if (state.error)
    return (
      <p role="alert" className="state error">
        {label}: {state.error}. Retrying automatically…
      </p>
    );
  if (state.loading)
    return (
      <p role="status" className="state">
        Loading {label.toLowerCase()}…
      </p>
    );
  if (empty || state.data === null)
    return <p className="state">No {label.toLowerCase()} yet.</p>;
  return null;
}
