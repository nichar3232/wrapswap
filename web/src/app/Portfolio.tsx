import type { Deployment } from "@wrapswap/types";
import { config } from "../config";
import { useApi } from "../hooks/useApi";
import { amount } from "../lib/format";
import { isDemo } from "../wallet";
import { assetsOf, platformName, toShares } from "./assets";
import { fmtShares } from "./Move";
import { Hex, Skeleton, Val } from "./ui";
import { useWallet } from "./wallet";

/** Home: what you hold, per asset and platform, with one action per row. */
export function Portfolio({ d, onMove }: { d: Deployment | undefined; onMove: (fromToken: string) => void }) {
  const w = useWallet();
  const assets = assetsOf(d);
  const moves = useApi("fills", w.address ? `account=${w.address}` : null, 15000);
  const tokens = d?.tokens ?? [];
  const recent = (moves.data?.items ?? []).filter(
    (f) => (f.kind === "PARITY" || f.kind === "FALL-THROUGH") && f.account.toLowerCase() === w.address?.toLowerCase(),
  );

  return (
    <div className="page portfolio">
      {!w.address ? (
        <section className="card">
          <button className="primary wide" disabled={!!w.busy} onClick={() => void w.connect()}>
            {w.busy === "connect" ? "Connecting…" : "Connect to see your shares"}
          </button>
          {w.notice && <p className="block-reason">{w.notice}</p>}
        </section>
      ) : null}
      {assets.length === 0 && (
        <section className="card">
          <Skeleton w="100%" h="8em" />
        </section>
      )}
      {assets.map((asset) => {
        const rows = asset.platforms.map((p) => {
          const bal = w.balances.values[p.token.address];
          return { p, bal, shares: bal !== undefined ? toShares(bal, p.token) : undefined };
        });
        const total = rows.reduce((s, r) => s + (r.shares ?? 0n), 0n);
        return (
          <section key={asset.symbol} className="card asset" aria-label={`${asset.symbol} holdings`}>
            <div className="asset-head">
              <div>
                <span className="tile-k">{asset.symbol}</span>
                <span className="tile-v">
                  {w.address ? (
                    <Val status={w.balances.status} w="4em" h="1em">
                      {fmtShares(total)} <small>shares</small>
                    </Val>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
              <span className="hint">{isDemo() ? "Demo wallet · testnet mocks" : "Testnet mocks"}</span>
            </div>
            <ul className="holdings">
              {rows.map(({ p, bal, shares }) => {
                const pct = total > 0n && shares !== undefined ? Number((shares * 1000n) / total) / 10 : 0;
                return (
                  <li key={p.token.address} className="holding">
                    <div className="holding-name">
                      <span className="platform">{p.name}</span>
                      <span className="symbol">{p.token.symbol}</span>
                    </div>
                    <div className="holding-nums">
                      <span className="holding-shares">{shares !== undefined ? fmtShares(shares) : "—"} shares</span>
                      <span className="symbol">
                        {bal !== undefined ? amount(bal, p.token.decimals, 4) : "—"} {p.token.symbol}
                      </span>
                    </div>
                    <div className="holding-bar" role="img" aria-label={`${pct}% of your ${asset.symbol} shares on ${p.name}`}>
                      <span style={{ width: `${pct}%` }} />
                      <small>{pct.toFixed(1)}%</small>
                    </div>
                    {bal !== undefined && bal > 0n ? (
                      <button className="primary move-btn" onClick={() => onMove(p.token.address)}>
                        Move
                      </button>
                    ) : (
                      <span />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {w.address && recent.length > 0 && (
        <section className="card recent" aria-label="Recent moves">
          <h2 className="card-title">Recent moves</h2>
          <ul>
            {recent.slice(0, 6).map((f) => {
              const ti = tokens.find((t) => t.address === f.tokenIn),
                to = tokens.find((t) => t.address === f.tokenOut);
              return (
                <li key={f.txHash + f.logIndex}>
                  <span>
                    {ti && to
                      ? `${fmtShares(toShares(BigInt(f.amountIn), ti))} → ${fmtShares(toShares(BigInt(f.amountOut), to))} ${ti.underlying} shares · ${platformName(ti)} → ${platformName(to)}`
                      : f.kind}
                  </span>
                  <span className="muted">{f.feePips === null ? "" : `${(f.feePips / 100).toFixed(2)} bps`}</span>
                  <Hex value={f.txHash} kind="tx" simulated={config.useMocks} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
