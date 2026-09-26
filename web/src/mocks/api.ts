import {
  DEMO,
  parseDeployment,
  type Network,
  type RouteName,
  type RouteResponses,
  type FeeBreakdown,
  type QuoteResponse,
} from "@wrapswap/types";
import source from "./deployment.json" with { type: "json" };
const str = (x: bigint) => x.toString();
export function fixtures(network: Network) {
  const v = DEMO.variants[network];
  const d = parseDeployment({ ...source, network, chainId: v.chainId });
  const [a, b] = d.tokens;
  const timestamp = String(
    network === "anvil" ? DEMO.variants.anvil.warpTimestamp : 1790424000,
  );
  const fee: FeeBreakdown = {
    basePips: 200,
    skewPips: 260,
    closedPips: v.marketOpen ? 0 : 1000,
    totalPips: v.parityFill.feePips,
    totalBps: v.parityFill.feeBps,
    skewX18: str(DEMO.skewX18.initial),
    // The §10 parity fill moves skew toward balance (-0.20 → -0.19).
    postSkewX18: str(DEMO.skewX18.afterParityFill),
    reducesImbalance: true,
    marketOpen: v.marketOpen,
  };
  const eligibility = {
    address: DEMO.accounts.demo.anvilAddress,
    eligible: true,
    reasonCode: 0,
    reason: "OK" as const,
    demoMode: true,
    attestationUid: null,
    block: "100",
  };
  const fill = {
    kind: "PARITY" as const,
    account: eligibility.address,
    tokenIn: a.address,
    tokenOut: b.address,
    amountIn: str(DEMO.parityFill.amountIn),
    amountOut: str(v.parityFill.amountOut),
    feeAmount: str(v.parityFill.feeAmount),
    feePips: fee.totalPips,
    shares: str(DEMO.parityFill.shares),
    batchId: null,
    poolId: d.pool.id,
    blockNumber: "100",
    timestamp,
    txHash: d.pool.id,
    logIndex: 0,
  };
  const tokenState = (t: typeof a) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
    adapter: t.adapter,
    sharesPerTokenX18: t.sharesPerTokenX18,
    healthy: true,
  });
  return {
    deployment: d,
    eligibility,
    health: {
      ok: true,
      network,
      chainId: d.chainId,
      rpcChainId: d.chainId,
      headBlock: "100",
      indexedBlock: "100",
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
      lastBlock: "100",
      lastSettle: null,
      lastOraclePush: null,
      lastPegCheck: null,
      lastError: null,
    },
    nyse: {
      open: v.marketOpen,
      block: "100",
      chainTimestamp: timestamp,
      nextTransition: String(
        v.marketOpen ? 1790712000 : DEMO.variants["unichain-sepolia"].nextOpen,
      ),
      nextState: v.marketOpen ? "CLOSED" : "OPEN",
      secondsUntilTransition: v.marketOpen ? 19800 : 178200,
      closedFeePips: 1000,
      source: "chain",
    },
    fees: {
      block: "100",
      timestamp,
      poolId: d.pool.id,
      fee,
      maxFeePips: 2500,
      formula: "baseFeePips + (|skew| grows ? min(ceil(1500*|postTradeSkew|), 5000) : 0) pips",
    },
    inventory: {
      block: "100",
      poolId: d.pool.id,
      tokens: [
        {
          symbol: a.symbol,
          address: a.address,
          inventory: str(DEMO.inventory.mcbAAPL),
          inventoryShares: "8100000000000000000000",
          feesAccrued: "0",
        },
        {
          symbol: b.symbol,
          address: b.address,
          inventory: str(DEMO.inventory.mAAPLx),
          inventoryShares: str(DEMO.inventory.mAAPLx),
          feesAccrued: "0",
        },
      ],
      totalShares: "20250000000000000000000",
      skewX18: str(DEMO.skewX18.initial),
      fee,
    },
    pool: {
      block: "100",
      timestamp,
      poolId: d.pool.id,
      key: d.pool.key,
      token0: tokenState(a),
      token1: tokenState(b),
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
    currentBatch: {
      batchId: "4",
      phase: "COMMIT",
      phaseEndsBlock: "106",
      blockNumber: "100",
      batchOrigin: d.dark.batchOrigin,
      participants: 2,
      oracle: {
        midX18: str(DEMO.dark.oracleMidX18),
        updatedAt: timestamp,
        stale: false,
      },
    },
    fills: {
      items: [
        fill,
        {
          ...fill,
          kind: "DARK-RESIDUAL",
          amountIn: str(DEMO.dark.residual.amountIn),
          amountOut: str(v.residual.amountOut),
          feeAmount: str(v.residual.feeAmount),
          feePips: v.residual.feePips,
          shares: str(DEMO.dark.residual.shares),
          batchId: "3",
          logIndex: 1,
        },
      ],
      nextCursor: null,
    },
    batches: {
      items: [
        {
          batchId: "3",
          settled: true,
          midX18: str(DEMO.dark.oracleMidX18),
          crossedBase: str(DEMO.dark.crossedBase),
          crossedQuote: str(DEMO.dark.crossedQuote),
          residualBaseIn: str(DEMO.dark.residual.amountIn),
          residualQuoteIn: "0",
          participants: 2,
          settledTx: d.pool.id,
          settledBlock: "99",
          settledAt: timestamp,
        },
      ],
      nextCursor: null,
    },
    orders: { items: [], nextCursor: null },
  } satisfies Partial<RouteResponses>;
}
export function mockResponse(
  name: RouteName,
  network: Network,
  search = "",
): unknown {
  const f = fixtures(network),
    p = new URLSearchParams(search);
  if (name === "quote" || name === "route") {
    const reverse = p.get("tokenIn") === f.deployment.tokens[1].address;
    const [a, b] = reverse
      ? [...f.deployment.tokens].reverse()
      : f.deployment.tokens;
    const input = BigInt(p.get("amount") || DEMO.parityFill.amountIn);
    const shares =
      (input * BigInt(a.sharesPerTokenX18)) / 10n ** BigInt(a.decimals);
    const gross =
      (shares * 10n ** BigInt(b.decimals)) / BigInt(b.sharesPerTokenX18);
    const feeAmount =
      (gross * BigInt(f.fees.fee.totalPips) + 999999n) / 1000000n;
    const q: QuoteResponse = {
      block: "100",
      poolId: f.deployment.pool.id,
      tokenIn: a.address,
      tokenOut: b.address,
      kind: "exactIn",
      zeroForOne: !reverse,
      amountSpecified: str(-input),
      fillable: gross <= BigInt(f.inventory.tokens[reverse ? 0 : 1].inventory),
      amountIn: str(input),
      amountOut: str(gross - feeAmount),
      grossOut: str(gross),
      shares: str(shares),
      feeAmount: str(feeAmount),
      feeToken: b.address,
      fee: f.fees.fee,
    };
    if (name === "quote") return q;
    return {
      route: q.fillable ? "PARITY" : "FALL-THROUGH",
      reason: q.fillable
        ? null
        : "Hook inventory insufficient; settle through the ParityHook pool.",
      block: "100",
      swapper: p.get("swapper") || f.eligibility.address,
      eligibility: {
        ...f.eligibility,
        address: p.get("swapper") || f.eligibility.address,
      },
      quote: q,
      fallThrough: q.fillable
        ? null
        : {
            amountIn: q.amountIn,
            amountOut: q.amountOut,
            feePips: q.fee.totalPips,
          },
      dark: null,
    };
  }
  if (name === "eligibility")
    return { ...f.eligibility, address: search || f.eligibility.address };
  if (!(name in f)) throw Error(`No mock fixture for ${name}`);
  return f[name as keyof typeof f];
}
