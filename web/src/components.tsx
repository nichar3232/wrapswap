import React from "react";
import type { FeeBreakdown, Route } from "@wrapswap/types";
export function RouteBadge({ route }: { route: Route }) {
  return (
    <span
      className={`badge ${route.startsWith("BLOCKED") ? "error" : "good"}`}
      data-testid="route-badge"
    >
      {route}
    </span>
  );
}
export function Fees({ fee }: { fee: FeeBreakdown }) {
  return (
    <div data-testid="fee-breakdown">
      <dl>
        <dt>Base fee</dt>
        <dd>{fee.basePips / 100} bps</dd>
        <dt>Inventory skew</dt>
        <dd>{(fee.skewPips / 100).toFixed(2)} bps</dd>
        <dt>Closed-market add-on</dt>
        <dd>{fee.closedPips / 100} bps</dd>
        <dt>Total hook fee</dt>
        <dd>{fee.totalBps} bps</dd>
      </dl>
      {!fee.marketOpen && (
        <p className="premium">
          NYSE closed: +{fee.closedPips / 100} bps off-hours premium
        </p>
      )}
      <p className="muted">
        The hook prices inventory and off-hours risk. Maximum fee: 25 bps.
      </p>
    </div>
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
      <p role="alert" className="error">
        {label}: {state.error}. Retrying automatically…
      </p>
    );
  if (state.loading) return <p role="status">Loading {label.toLowerCase()}…</p>;
  if (empty || state.data === null) return <p>No {label.toLowerCase()} yet.</p>;
  return null;
}
