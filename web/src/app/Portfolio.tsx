import { useEffect, useState } from "react";
import type { Address, Deployment } from "@wrapswap/types";
import { useApi } from "../hooks/useApi";
import { amount, duration, fmtShares } from "../lib/format";
import { claimFaucet } from "../wallet";
import { findToken, toShares, type Asset } from "./assets";
import { useTx } from "./tx";
import { Hex, Skeleton, Spinner, TxPanel, Val } from "./ui";
import { useWallet } from "./wallet";

const KIND: Record<string, string> = { PARITY: "Convert", "FALL-THROUGH": "Convert (pool)", "DARK-CROSS": "Dark Cross", "DARK-RESIDUAL": "Dark Cross residual" };
const COOLDOWN = 86_400; // TestShareFaucet.COOLDOWN

/** Test-share faucet: claim every listed wrapper once per day; the cooldown comes from GET /faucet/:address. */
function Faucet({ d, assets, faucetAddr }: { d: Deployment | undefined; assets: Asset[]; faucetAddr?: Address }) {
  const w = useWallet();
  const feed = useApi("faucet", w.address ?? null, 20000);
  const tx = useTx<unknown>();
  const [claimedAt, setClaimedAt] = useState<number>();
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  const faucet = (feed.data?.faucet ?? faucetAddr) as Address | undefined;
  const next = Math.max(
    ...(feed.data?.tokens.map((t) => Number(t.nextClaimAt)) ?? [0]),
    claimedAt ? claimedAt + COOLDOWN : 0,
  );
  const wait = next > now ? next - now : 0;
  const claim = async () => {
    const done = await tx.run("Faucet claim", async (onHash) => {
      const sent = await claimFaucet(d!, w.address!, faucet!, { onHash });
      for (const t of feed.data?.tokens ?? []) w.adjust(t.address, BigInt(t.amount));
      setClaimedAt(Math.floor(Date.now() / 1000));
      feed.refresh();
      return { hash: sent.hash, simulated: sent.simulated, result: "claimed" };
    });
    if (!done) return;
  };
  // The demo relay holds its own test shares and has no faucet action; the faucet is for connected wallets.
  if (!w.address || w.relay) return null;
  const per = feed.data?.tokens[0];
  const perDecimals = per ? findToken(assets, per.address)?.token.decimals : undefined;
  return (
    <section className="card faucet" aria-label="Test shares faucet">
      <div>
        <span className="tile-k">Test shares</span>
        <p className="faucet-line">
          <Val status={feed.status} w="12em">
            {per && perDecimals !== undefined ? `${amount(per.amount, perDecimals, 0)} of each of ${feed.data!.tokens.length} test wrappers, once a day` : "—"}
          </Val>
        </p>
      </div>
      <div className="faucet-act">
        {wait > 0 ? (
          <span className="cooldown" data-testid="faucet-cooldown">
            Next claim in <strong>{duration(wait)}</strong>
          </span>
        ) : (
          <button className="primary" disabled={!faucet || !d || tx.busy || !feed.data} onClick={() => void claim()}>
            {tx.busy && <Spinner />}
            {tx.busy ? "Claiming…" : "Claim test shares"}
          </button>
        )}
      </div>
      <TxPanel tx={tx.state} onRetry={() => void claim()} />
    </section>
  );
}

/** Home: what you hold, per asset per wrapper in shares, the faucet, and your recent fills. */
export function Portfolio({
  d,
  assets,
  onMove,
  onTry,
}: {
  d: Deployment | undefined;
  assets: Asset[];
  onMove: (fromToken: string) => void;
  onTry: () => void;
}) {
  const w = useWallet();
  const stats = useApi("stats", w.address ? `address=${w.address}` : null, 15000);
  const recent = stats.data?.wallet?.recent ?? [];
  const mocks = import.meta.env.VITE_USE_MOCKS === "true";

  // Disconnected: one card, not three asset cards of dashes.
  if (!w.address)
    return (
      <div className="page portfolio">
        <section className="card connect-card" aria-label="Connect a wallet">
          <h2 className="card-title">Connect a wallet to see your shares</h2>
          <button className="primary wide" disabled={!!w.busy} onClick={() => void w.connect()}>
            {w.busy === "connect" ? "Connecting…" : "Connect"}
          </button>
          {w.notice && <p className="block-reason">{w.notice}</p>}
          <button type="button" className="link-btn" onClick={onTry}>
            or try a conversion without a wallet →
          </button>
        </section>
      </div>
    );

  return (
    <div className="page portfolio">
      <Faucet d={d} assets={assets} faucetAddr={d?.faucet} />
      {assets.length === 0 && (
        <section className="card">
          <Skeleton w="100%" h="8em" />
        </section>
      )}
      <div className="asset-grid">
        {assets.map((asset) => {
          const rows = asset.platforms.map((p) => {
            const bal = w.balances.values[p.token.address];
            return { p, bal, shares: bal !== undefined ? toShares(bal, p.token) : undefined };
          });
          const total = rows.reduce((s, r) => s + (r.shares ?? 0n), 0n);
          return (
            <section key={asset.symbol} className="card asset" aria-label={`${asset.symbol} holdings`}>
              <div className="asset-head">
                <span className="tile-k">{asset.symbol}</span>
                <span className="tile-v">
                  <Val status={w.balances.status} w="4em" h="1em">
                    {fmtShares(total)} <small>shares</small>
                  </Val>
                </span>
              </div>
              <ul className="holdings">
                {rows.map(({ p, bal, shares }) => (
                  <li key={p.token.address} className="holding">
                    <div className="holding-name">
                      <span className="platform">{p.name}</span>
                      <span className="symbol">
                        {bal !== undefined ? amount(bal, p.token.decimals, 4) : "—"} {p.token.symbol}
                      </span>
                    </div>
                    <span className="holding-shares">{shares !== undefined ? fmtShares(shares) : "—"} sh</span>
                    {bal !== undefined && bal > 0n ? (
                      <button className="ghost-btn move-btn" aria-label={`Convert ${p.token.symbol}`} onClick={() => onMove(p.token.address)}>
                        Convert
                      </button>
                    ) : (
                      <span />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <section className="card recent" aria-label="Recent fills">
        <h2 className="card-title">Recent fills</h2>
        {recent.length ? (
          <ul>
            {recent.slice(0, 8).map((f) => {
              const ti = findToken(assets, f.tokenIn)?.token,
                to = findToken(assets, f.tokenOut)?.token;
              return (
                <li key={f.txHash + f.logIndex}>
                  <span>
                    {ti && to ? `${fmtShares(toShares(BigInt(f.amountIn), ti))} → ${fmtShares(toShares(BigInt(f.amountOut), to))} ${ti.underlying} sh · ${ti.symbol} → ${to.symbol}` : f.kind}
                  </span>
                  <span className="muted">
                    {KIND[f.kind]}
                    {f.feePips === null ? "" : ` · ${(f.feePips / 100).toFixed(2)} bps`}
                  </span>
                  <Hex value={f.txHash} kind="tx" simulated={mocks} />
                </li>
              );
            })}
          </ul>
        ) : (
          <Val status={stats.status} w="100%" h="2em">
            <p className="muted">No fills from this wallet yet.</p>
          </Val>
        )}
      </section>
    </div>
  );
}
