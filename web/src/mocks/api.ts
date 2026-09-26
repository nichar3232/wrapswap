/**
 * Mock API for the VITE_USE_MOCKS=true build (Playwright and unit tests only; the production build drops this
 * module). Every figure comes from the shared formula (canonical.*) or the DEMO narrative in @wrapswap/types; the
 * shapes follow the live API (INTERFACES.md), including /pool/:asset, /faucet/:address and per-asset batches.
 */
import {
  DEMO,
  canonical,
  parseDeployment,
  type Address,
  type BatchSummary,
  type Deployment,
  type FeeBreakdown,
  type FillView,
  type Network,
  type PoolKey,
  type QuoteResponse,
  type RouteName,
  type RouteResponses,
  routes,
} from "@wrapswap/types";
import { keccak256, toHex } from "viem";
import anvilSource from "./deployment.json" with { type: "json" };
import unichainSource from "../../../deployments/unichain-sepolia.resolved.json" with { type: "json" };

const str = (x: bigint) => x.toString();
const ONE = canonical.ONE;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hashOf = (s: string) => keccak256(toHex(s));

/** Demo figures: the §10 narrative (parity fill and dark residual both rebalance, so each pays the base fee). */
export function demoVariant(network: Network) {
  return network === "anvil" ? DEMO.variants.anvil : DEMO.variants["unichain-sepolia"];
}

type Wrapper = { platform: string; symbol: string; name: string; address: Address; decimals: number; adapter: Address; spt: bigint; issuer: string; mock: boolean; adapterKind: string };
type MockAsset = {
  symbol: string;
  wrappers: [Wrapper, Wrapper];
  pool: { id: `0x${string}`; key: PoolKey };
  dark: { hook: Address; baseToken: Address; quoteToken: Address } | null;
  /** Inventory in canonical shares, per wrapper (same order as wrappers). */
  shares: [bigint, bigint];
};

/** Per-asset seed inventory in shares: AAPL is the §10 narrative (−20% skew), the others mirror the live pools. */
const SEED: Record<string, [bigint, bigint]> = {
  AAPL: [8100n * ONE, 12150n * ONE],
  NVDA: [9021n * ONE, 10979n * ONE],
  TSLA: [10600n * ONE, 9400n * ONE],
};

function mockAssets(d: Deployment): MockAsset[] {
  const tok = (address: string) => d.tokens.find((t) => eq(t.address, address));
  if (d.assets?.length)
    return d.assets.map((a) => {
      const wrappers = a.wrappers.map((w) => ({
        platform: w.platform,
        symbol: w.symbol,
        name: tok(w.token)?.name ?? w.symbol,
        address: w.token,
        decimals: w.decimals,
        adapter: w.adapter,
        spt: BigInt(w.multiplier),
        issuer: w.platform.toLowerCase(),
        mock: true,
        adapterKind: w.platform === "Coinbase" ? "B20Multiplier" : "XStocksMultiplier",
      })) as [Wrapper, Wrapper];
      const seed = SEED[a.symbol] ?? [10000n * ONE, 10000n * ONE];
      return {
        symbol: a.symbol,
        wrappers,
        pool: { id: a.pool.id, key: a.pool.key },
        dark:
          a.darkCross && a.darkCrossHook && a.darkBaseToken && a.darkQuoteToken
            ? { hook: a.darkCrossHook, baseToken: a.darkBaseToken, quoteToken: a.darkQuoteToken }
            : null,
        shares: seed,
      };
    });
  const wrappers = d.tokens.map((t) => ({
    platform: t.issuer === "coinbase" ? "Coinbase" : "xStocks",
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    adapter: t.adapter,
    spt: BigInt(t.sharesPerTokenX18),
    issuer: t.issuer,
    mock: t.mock,
    adapterKind: t.adapterKind,
  })) as [Wrapper, Wrapper];
  return [
    {
      symbol: d.tokens[0].underlying,
      wrappers,
      pool: { id: d.pool.id, key: d.pool.key },
      dark: { hook: d.contracts.darkCrossHook, baseToken: d.dark.baseToken, quoteToken: d.dark.quoteToken },
      shares: SEED.AAPL,
    },
  ];
}

/** Inventory in currency0 / currency1 order. */
const byCurrency = (a: MockAsset) => {
  const first = eq(a.wrappers[0].address, a.pool.key.currency0);
  return first ? a.shares : ([a.shares[1], a.shares[0]] as [bigint, bigint]);
};

/** The contract's exact-in quote: shares in, fee on the gross output, shares out, and the base/skew split. */
function quoteOf(a: MockAsset, from: Wrapper, to: Wrapper, amountIn: bigint, block: string) {
  const [s0, s1] = byCurrency(a);
  const zeroForOne = eq(from.address, a.pool.key.currency0);
  const shares = canonical.toSharesDown(amountIn, from.spt, from.decimals);
  const f = canonical.tradeFeeBreakdown(s0, s1, zeroForOne, shares);
  const grossOut = canonical.fromSharesDown(shares, to.spt, to.decimals);
  const feeAmount = canonical.feeOnGross(grossOut, f.totalPips);
  const amountOut = grossOut - feeAmount;
  const sharesOut = canonical.toSharesDown(amountOut, to.spt, to.decimals);
  const feeShares = shares - sharesOut;
  const baseFee = f.totalPips ? (feeShares * f.basePips) / f.totalPips : 0n;
  const keep = shares ? (sharesOut * 1_000_000n) / shares : 0n;
  const fee: FeeBreakdown = {
    basePips: Number(f.basePips),
    skewPips: Number(f.skewPips),
    totalPips: Number(f.totalPips),
    totalBps: canonical.pipsToBps(f.totalPips),
    skewX18: str(f.skewX18),
    postSkewX18: str(f.postSkewX18),
    reducesImbalance: f.reducesImbalance,
  };
  const inventoryOut = a.shares[a.wrappers.indexOf(to)];
  const q: QuoteResponse = {
    block,
    poolId: a.pool.id,
    tokenIn: from.address,
    tokenOut: to.address,
    kind: "exactIn",
    zeroForOne,
    amountSpecified: str(-amountIn),
    fillable: shares <= inventoryOut,
    amountIn: str(amountIn),
    amountOut: str(amountOut),
    grossOut: str(grossOut),
    shares: str(shares),
    feeAmount: str(feeAmount),
    feeToken: to.address,
    fee,
    asset: a.symbol,
    sharesIn: str(shares),
    sharesOut: str(sharesOut),
    baseFee: str(baseFee),
    skewFee: str(feeShares - baseFee),
    youKeep: `${keep / 1_000_000n}.${(keep % 1_000_000n).toString().padStart(6, "0")}`,
    preSkewX18: str(f.skewX18),
    postSkewX18: str(f.postSkewX18),
    reducesImbalance: f.reducesImbalance,
  };
  return q;
}

/** Mock batch clock: 24 s batches (commit 10 s, reveal 8 s, settle 6 s), one block per second. */
export const MOCK_BATCH = { seconds: 24, commit: 10, reveal: 8, origin: 1_790_000_000 };
function batchNow(now = Date.now()) {
  const t = Math.floor(now / 1000) - MOCK_BATCH.origin;
  const batchId = Math.floor(t / MOCK_BATCH.seconds);
  const at = t % MOCK_BATCH.seconds;
  const phase = at < MOCK_BATCH.commit ? "COMMIT" : at < MOCK_BATCH.commit + MOCK_BATCH.reveal ? "REVEAL" : "SETTLE";
  const ends = phase === "COMMIT" ? MOCK_BATCH.commit : phase === "REVEAL" ? MOCK_BATCH.commit + MOCK_BATCH.reveal : MOCK_BATCH.seconds;
  return { batchId, phase: phase as "COMMIT" | "REVEAL" | "SETTLE", secondsRemaining: ends - at, block: t };
}

export function fixtures(network: Network) {
  const v = demoVariant(network);
  const source = network === "anvil" ? anvilSource : unichainSource;
  const d = parseDeployment({ ...source, network, chainId: v.chainId });
  const assets = mockAssets(d);
  const aapl = assets[0];
  const [a, b] = aapl.wrappers;
  const now = Math.floor(Date.now() / 1000);
  const timestamp = String(network === "anvil" ? DEMO.variants.anvil.warpTimestamp : now);
  const clock = batchNow();
  const block = String(clock.block);
  // The mock wallet's account (the deployment's demo account), so its fills and orders show as "mine".
  const demoAddress = (d.demoAccounts.accounts.find((x) => x.role === "demo")?.address ?? DEMO.accounts.demo.anvilAddress) as Address;
  const parity = quoteOf(aapl, a, b, DEMO.parityFill.amountIn, block);
  const eligibility = {
    address: demoAddress,
    eligible: true,
    reasonCode: 0,
    reason: "OK" as const,
    demoMode: true,
    attestationUid: null,
    block,
  };
  const fill: FillView = {
    kind: "PARITY",
    account: demoAddress,
    tokenIn: a.address,
    tokenOut: b.address,
    amountIn: str(DEMO.parityFill.amountIn),
    amountOut: parity.amountOut,
    feeAmount: parity.feeAmount,
    feePips: parity.fee.totalPips,
    shares: parity.shares,
    batchId: null,
    poolId: aapl.pool.id,
    blockNumber: block,
    timestamp,
    txHash: hashOf(`demo-fill-${network}-parity`),
    logIndex: 0,
  };
  const residual: FillView = {
    ...fill,
    kind: "DARK-RESIDUAL",
    amountIn: str(DEMO.dark.residual.amountIn),
    amountOut: str(v.residual.amountOut),
    feeAmount: str(v.residual.feeAmount),
    feePips: v.residual.feePips,
    shares: str(DEMO.dark.residual.shares),
    batchId: "3",
    logIndex: 1,
    txHash: hashOf(`demo-fill-${network}-residual`),
  };
  const tokenState = (t: Wrapper) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
    adapter: t.adapter,
    sharesPerTokenX18: str(t.spt),
    healthy: true,
  });
  const [s0, s1] = byCurrency(aapl);
  const inv = canonical.feeBreakdown(s0, s1);
  const poolFee: FeeBreakdown = {
    basePips: Number(inv.basePips),
    skewPips: Number(inv.skewPips),
    totalPips: Number(inv.totalPips),
    totalBps: canonical.pipsToBps(inv.totalPips),
    skewX18: str(inv.skewX18),
    postSkewX18: str(inv.postSkewX18),
    reducesImbalance: inv.reducesImbalance,
  };
  return {
    deployment: d,
    assetsList: assets,
    eligibility,
    health: {
      ok: true,
      network,
      chainId: d.chainId,
      rpcChainId: d.chainId,
      headBlock: block,
      indexedBlock: block,
      lagBlocks: 0,
      db: "ok",
      demoMode: true,
      deployCommit: d.deployCommit,
      startBlock: d.startBlock,
      addresses: {
        contracts: d.contracts,
        tokens: { mcbAAPL: a.address, mAAPLx: b.address },
        poolId: d.pool.id,
      },
    },
    crankStatus: {
      ok: true,
      network,
      chainId: d.chainId,
      signer: DEMO.accounts.crank.anvilAddress,
      lastBlock: block,
      lastSettle: null,
      lastOraclePush: null,
      lastPegCheck: null,
      lastError: null,
    },
    fees: {
      block,
      timestamp,
      poolId: aapl.pool.id,
      fee: poolFee,
      maxFeePips: 5200,
      formula: "baseFeePips + (|skew| grows ? min(ceil(1500*|postTradeSkew|), 5000) : 0) pips",
    },
    inventory: {
      block,
      poolId: aapl.pool.id,
      tokens: aapl.wrappers.map((w, i) => ({
        symbol: w.symbol,
        address: w.address,
        inventory: str(canonical.fromSharesDown(aapl.shares[i], w.spt, w.decimals)),
        inventoryShares: str(aapl.shares[i]),
        feesAccrued: "0",
      })),
      totalShares: str(aapl.shares[0] + aapl.shares[1]),
      skewX18: str(inv.skewX18),
      fee: poolFee,
    },
    pool: {
      block,
      timestamp,
      poolId: d.pool.id,
      key: d.pool.key,
      token0: tokenState(eq(a.address, d.pool.key.currency0) ? a : b),
      token1: tokenState(eq(a.address, d.pool.key.currency0) ? b : a),
      sqrtPriceX96: d.pool.initSqrtPriceX96,
      tick: DEMO.pool.mcbAAPLIsCurrency0.tick,
      liquidity: "1000000000000",
      poolPriceX18: str(DEMO.parityMidX18),
      parityPriceX18: str(DEMO.parityMidX18),
      deviationBps: 0,
      pegGuardBps: 50,
      pegTripped: false,
      lastPegEvent: null,
    },
    fills: { items: [fill, residual], nextCursor: null },
    orders: { items: [], nextCursor: null },
    assets: {
      network,
      chainId: d.chainId,
      block,
      assets: assets.map((x) => ({
        asset: x.symbol,
        platforms: x.wrappers.map((w) => ({
          platform: w.platform,
          issuer: w.issuer,
          symbol: w.symbol,
          name: w.name,
          address: w.address,
          decimals: w.decimals,
          adapter: w.adapter,
          adapterKind: w.adapterKind,
          sharesPerTokenX18: str(w.spt),
          healthy: true,
          mock: w.mock,
        })),
        pools: [{ poolId: x.pool.id, ...x.pool.key }],
        darkCross: x.dark ? { hook: x.dark.hook, baseToken: x.dark.baseToken, quoteToken: x.dark.quoteToken, batchBlocks: MOCK_BATCH.seconds } : null,
      })),
    },
  } satisfies Partial<RouteResponses> & { deployment: Deployment; assetsList: MockAsset[] };
}

/** The §10 Dark Cross batch (60 base sold by the demo account against 50.625 quote), settled, for any batch id. */
function settledBatch(f: ReturnType<typeof fixtures>, asset: MockAsset, batchId: number, network: Network): BatchSummary {
  const [base, quote] = asset.dark ? [asset.dark.baseToken, asset.dark.quoteToken] : [asset.wrappers[0].address, asset.wrappers[1].address];
  const baseW = asset.wrappers.find((w) => eq(w.address, base))!;
  const settledAt = String(MOCK_BATCH.origin + (batchId + 1) * MOCK_BATCH.seconds);
  const residualShares = DEMO.dark.residual.shares;
  const residualQuote = quoteOf(asset, baseW, asset.wrappers.find((w) => eq(w.address, quote))!, DEMO.dark.residual.amountIn, "0");
  return {
    batchId: String(batchId),
    settled: true,
    midX18: str(DEMO.dark.oracleMidX18),
    crossedBase: str(DEMO.dark.crossedBase),
    crossedQuote: str(DEMO.dark.crossedQuote),
    residualBaseIn: str(DEMO.dark.residual.amountIn),
    residualQuoteIn: "0",
    participants: 2,
    settledTx: hashOf(`demo-settle-${network}-${asset.symbol}-${batchId}`),
    settledBlock: String(batchId * MOCK_BATCH.seconds + MOCK_BATCH.seconds),
    settledAt,
    asset: asset.symbol,
    crossedShares: str(canonical.toSharesDown(DEMO.dark.crossedBase, baseW.spt, baseW.decimals)),
    protocolFeeShares: str(canonical.toSharesDown(DEMO.dark.crossFees.counterpartyA, 10n ** 18n, 18) * 2n),
    residualFilled: [
      {
        trader: f.eligibility.address,
        tokenIn: base,
        amountIn: str(DEMO.dark.residual.amountIn),
        amountOut: residualQuote.amountOut,
        feeAmount: residualQuote.feeAmount,
        feeShares: str(residualShares - BigInt(residualQuote.sharesOut!)),
        txHash: hashOf(`demo-settle-${network}-${asset.symbol}-${batchId}`),
      },
    ],
    unfilledRefunded: { base: "0", quote: "0", shares: "0" },
  };
}

export function mockResponse(name: RouteName, network: Network, search = ""): unknown {
  const f = fixtures(network);
  // Path-parameter routes get "value" or "value?query"; the others get a query string.
  const hasParam = routes.find((r) => r.name === name)!.path.includes(":");
  const [path, query = ""] = hasParam ? search.split("?") : ["", search];
  const p = new URLSearchParams(query);
  const assetNamed = (s: string | null) => f.assetsList.find((a) => a.symbol === s) ?? f.assetsList[0];
  const clock = batchNow();
  if (name === "quote" || name === "route") {
    const tokenIn = p.get("tokenIn") ?? f.assetsList[0].wrappers[0].address;
    const asset = f.assetsList.find((a) => a.wrappers.some((w) => eq(w.address, tokenIn))) ?? f.assetsList[0];
    const from = asset.wrappers.find((w) => eq(w.address, tokenIn)) ?? asset.wrappers[0];
    const to = asset.wrappers.find((w) => w !== from)!;
    const q = quoteOf(asset, from, to, BigInt(p.get("amount") || DEMO.parityFill.amountIn), String(clock.block));
    if (name === "quote") return q;
    const swapper = p.get("swapper") || f.eligibility.address;
    return {
      route: q.fillable ? "PARITY" : "FALL-THROUGH",
      reason: q.fillable ? null : "Hook inventory insufficient; settle through the ParityHook pool.",
      block: q.block,
      swapper,
      eligibility: { ...f.eligibility, address: swapper },
      quote: q,
      fallThrough: q.fillable ? null : { amountIn: q.amountIn, amountOut: q.amountOut, feePips: q.fee.totalPips },
      dark: null,
    };
  }
  if (name === "poolAsset") {
    const a = assetNamed(path);
    const [s0, s1] = byCurrency(a);
    const skewX18 = canonical.skewX18(s0, s1);
    const directions = a.wrappers.map((from) => {
      const to = a.wrappers.find((w) => w !== from)!;
      const q = quoteOf(a, from, to, 10n ** BigInt(from.decimals), "0");
      return {
        from: from.symbol,
        to: to.symbol,
        skewFeePips: q.fee.skewPips,
        totalPips: q.fee.totalPips,
        totalBps: q.fee.totalBps,
        reducesImbalance: q.fee.reducesImbalance,
      };
    });
    const cheap = directions.reduce((m, x) => (x.totalPips < m.totalPips ? x : m));
    const lp = a.symbol === "AAPL" ? { base: 22_275_000_000_000_000n, skew: 0n, fills: 2 } : { base: 0n, skew: 0n, fills: 0 };
    const hundredths = (skewX18 * 10000n) / ONE;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    return {
      asset: a.symbol,
      block: String(clock.block),
      poolId: a.pool.id,
      wrappers: a.wrappers.map((w, i) => ({
        platform: w.platform,
        symbol: w.symbol,
        address: w.address,
        inventory: str(canonical.fromSharesDown(a.shares[i], w.spt, w.decimals)),
        inventoryShares: str(a.shares[i]),
      })),
      totalShares: str(s0 + s1),
      skewX18: str(skewX18),
      skewPct: `${hundredths < 0n ? "-" : ""}${abs(hundredths) / 100n}.${(abs(hundredths) % 100n).toString().padStart(2, "0")}`,
      directions,
      cheapDirection: { from: cheap.from, to: cheap.to },
      lpFees: { fills: lp.fills, baseShares: str(lp.base), skewShares: str(lp.skew), totalShares: str(lp.base + lp.skew) },
    };
  }
  if (name === "faucet") {
    const address = path || f.eligibility.address;
    return {
      address,
      faucet: f.deployment.faucet ?? f.deployment.contracts.registry,
      block: String(clock.block),
      lastClaimAt: null,
      tokens: f.assetsList.flatMap((a) =>
        a.wrappers.map((w) => ({
          asset: a.symbol,
          symbol: w.symbol,
          address: w.address,
          amount: str(1000n * 10n ** BigInt(w.decimals)),
          nextClaimAt: "0",
          claimable: true,
        })),
      ),
    };
  }
  if (name === "currentBatch") {
    const a = assetNamed(p.get("asset"));
    return {
      batchId: String(clock.batchId),
      phase: clock.phase,
      phaseEndsBlock: String(clock.block + clock.secondsRemaining),
      blockNumber: String(clock.block),
      batchOrigin: "0",
      participants: clock.phase === "COMMIT" ? 1 : 2,
      asset: a.symbol,
      secondsRemaining: clock.secondsRemaining,
      oracle: { midX18: str(DEMO.dark.oracleMidX18), updatedAt: String(Math.floor(Date.now() / 1000) - 60), stale: false },
    };
  }
  if (name === "batches") {
    const a = assetNamed(p.get("asset"));
    return { items: [1, 2, 3].map((k) => settledBatch(f, a, clock.batchId - k, network)), nextCursor: null };
  }
  if (name === "batch") {
    const a = assetNamed(p.get("asset"));
    const id = Number(path);
    const batch = settledBatch(f, a, id, network);
    const base = a.dark?.baseToken ?? a.wrappers[0].address,
      quote = a.dark?.quoteToken ?? a.wrappers[1].address;
    const me = f.eligibility.address;
    const other = DEMO.accounts.counterpartyB.anvilAddress as Address;
    const tx = batch.settledTx!;
    const order = (trader: Address, sellBase: boolean, lock: Address, amount: bigint, limit: bigint) => ({
      batchId: path,
      trader,
      commitHash: hashOf(`commit-${path}-${trader}`),
      lockToken: lock,
      locked: str(amount),
      committedTx: hashOf(`commit-tx-${path}-${trader}`),
      revealed: true,
      valid: true,
      rejectReason: null,
      sellBase,
      amountIn: str(amount),
      limitPriceX18: str(limit),
      routeResidual: true,
      forfeited: null,
    });
    const o = DEMO.dark.orders;
    const fill = (account: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, amountOut: bigint, fee: bigint, logIndex: number): FillView => ({
      kind: "DARK-CROSS",
      account,
      tokenIn,
      tokenOut,
      amountIn: str(amountIn),
      amountOut: str(amountOut),
      feeAmount: str(fee),
      feePips: DEMO.dark.crossFeePips,
      shares: null,
      batchId: path,
      poolId: null,
      blockNumber: batch.settledBlock!,
      timestamp: batch.settledAt!,
      txHash: tx,
      logIndex,
    });
    const r = batch.residualFilled![0];
    return {
      batch,
      orders: [
        order(me, true, base, o.counterpartyA.amountIn, o.counterpartyA.limitPriceX18),
        order(other, false, quote, o.counterpartyB.amountIn, o.counterpartyB.limitPriceX18),
      ],
      fills: [
        fill(me, base, quote, DEMO.dark.crossedBase, DEMO.dark.crossOut.counterpartyA, DEMO.dark.crossFees.counterpartyA, 3),
        fill(other, quote, base, DEMO.dark.crossedQuote, DEMO.dark.crossOut.counterpartyB, DEMO.dark.crossFees.counterpartyB, 4),
        {
          ...fill(me, base, quote, BigInt(r.amountIn), BigInt(r.amountOut), BigInt(r.feeAmount), 5),
          kind: "DARK-RESIDUAL",
          feePips: 200,
          shares: str(DEMO.dark.residual.shares),
          poolId: a.pool.id,
        },
      ],
      skippedResiduals: [],
    };
  }
  if (name === "stats") {
    // Built from the same mock fills, so totals and rows agree.
    const items = f.fills.items;
    const byKind = { PARITY: 0, "FALL-THROUGH": 0, "DARK-CROSS": 0, "DARK-RESIDUAL": 0 };
    for (const x of items) byKind[x.kind]++;
    const sharesOf = (x: FillView) => BigInt(x.shares ?? "0");
    const volume = items.reduce((s, x) => s + sharesOf(x), 0n);
    const [a, b] = f.assetsList[0].wrappers;
    const tokens = [a, b].map((t) => {
      const amount = items.filter((x) => eq(x.tokenOut, t.address)).reduce((s, x) => s + BigInt(x.feeAmount ?? "0"), 0n);
      return { symbol: t.symbol, address: t.address, amount: str(amount), shares: str(canonical.toSharesDown(amount, t.spt, t.decimals)) };
    });
    const feeShares = tokens.reduce((s, t) => s + BigInt(t.shares), 0n);
    const address = p.get("address");
    const mine = address ? items.filter((x) => eq(x.account, address)) : [];
    return {
      indexedBlock: String(clock.block),
      fills: items.length,
      byKind,
      sharesVolume: str(volume),
      byAsset: [{ asset: f.assetsList[0].symbol, fills: items.length, sharesVolume: str(volume), feesEarnedShares: str(feeShares) }],
      feesEarned: { totalShares: str(feeShares), tokens },
      faucet: null,
      wallet: address ? { address, fills: mine.length, sharesVolume: str(mine.reduce((s, x) => s + sharesOf(x), 0n)), recent: mine.slice(0, 10) } : null,
    };
  }
  if (name === "eligibility") return { ...f.eligibility, address: search || f.eligibility.address };
  if (name === "nyse") throw Error("No mock fixture for nyse: the fee has no clock input");
  if (!(name in f)) throw Error(`No mock fixture for ${name}`);
  return f[name as keyof typeof f];
}
