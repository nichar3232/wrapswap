import type { FastifyInstance } from "fastify";
import { isAddress, parseAbi, type Address } from "viem";
import {
  read,
  manifest,
  publicClient,
  ratio,
  erc20,
  type Token,
} from "../chain/client.js";
import { rows } from "../db/index.js";
import {
  WAD,
  shares,
  tokens,
  lessFee,
  deviation,
  poolPrice,
} from "../chain/math.js";
const stateAbi = parseAbi([
  "function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
]);
const oracleAbi = parseAbi([
  "function decimals() view returns(uint8)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)",
]);
export async function parity() {
  const m = manifest();
  return Promise.all(
    m.pools
      .filter((p) => p.kind === "parity")
      .map(async (p) => {
        const issuer =
          p.key.currency0.toLowerCase() === m.tokens.uAAPL.address.toLowerCase()
            ? p.key.currency1
            : p.key.currency0;
        const t = Object.values(m.tokens).find(
          (t) => t.address.toLowerCase() === issuer.toLowerCase(),
        )!;
        const [r, slot, i, o, fee] = await Promise.all([
          ratio(issuer),
          publicClient.readContract({
            address: m.contracts.stateView,
            abi: stateAbi,
            functionName: "getSlot0",
            args: [p.id],
          }),
          read("parityHook", "inventory", [issuer]),
          read("parityHook", "inventory", [m.tokens.uAAPL.address]),
          read("parityHook", "feeBpsNow", [issuer]),
        ]);
        const issuer0 = issuer.toLowerCase() === p.key.currency0.toLowerCase();
        const direct = poolPrice(
          slot[0],
          issuer0 ? t.decimals : 18,
          issuer0 ? 18 : t.decimals,
        );
        const price = issuer0 ? direct : direct ? (WAD * WAD) / direct : 0n;
        return {
          poolId: p.id,
          issuer,
          ratio: r,
          poolPrice: price,
          deviationBps: deviation(price, r),
          hookInventory: { in: i, out: o },
          feeBpsNow: Number(fee),
          route: i > 0n && o > 0n ? "hook" : "curve",
        };
      }),
  );
}
export async function quote(from: Address, to: Address, amount: bigint) {
  const m = manifest();
  const find = (a: Address) =>
    Object.values(m.tokens).find(
      (t) => t.address.toLowerCase() === a.toLowerCase(),
    );
  const a = find(from),
    b = find(to);
  if (
    !a ||
    !b ||
    a.symbol === "USDC" ||
    b.symbol === "USDC" ||
    from.toLowerCase() === to.toLowerCase() ||
    amount <= 0n
  )
    throw Object.assign(
      Error("Select distinct supported stock tokens and a positive amount"),
      { statusCode: 400 },
    );
  const [ra, rb] = await Promise.all([ratio(from), ratio(to)]);
  const gross = tokens(shares(amount, ra, a.decimals), rb, b.decimals);
  const isU = (t: Token) =>
    t.address.toLowerCase() === m.tokens.uAAPL.address.toLowerCase();
  if (!isU(a) && !isU(b)) {
    const held = await publicClient.readContract({
      address: b.address,
      abi: erc20,
      functionName: "balanceOf",
      args: [m.contracts.vault],
    });
    if (held < lessFee(gross, 5))
      throw Error("Insufficient selected issuer inventory in vault");
    return {
      from,
      to,
      amountIn: amount,
      expectedOut: lessFee(gross, 5),
      ratio: (ra * WAD) / rb,
      route: "vault",
      feeBps: 5,
      priceImpactBps: 0,
    };
  }
  const pool = m.pools.find(
    (p) =>
      p.kind === "parity" &&
      [p.key.currency0.toLowerCase(), p.key.currency1.toLowerCase()].includes(
        from.toLowerCase(),
      ) &&
      [p.key.currency0.toLowerCase(), p.key.currency1.toLowerCase()].includes(
        to.toLowerCase(),
      ),
  );
  if (!pool)
    return {
      from,
      to,
      amountIn: amount,
      expectedOut: lessFee(gross, isU(a) ? 5 : 0),
      ratio: (ra * WAD) / rb,
      route: "vault",
      feeBps: isU(a) ? 5 : 0,
      priceImpactBps: 0,
    };
  const [inventory, fee] = await Promise.all([
    read("parityHook", "inventory", [to]),
    read("parityHook", "feeBpsNow", [isU(a) ? to : from]),
  ]);
  if (inventory >= gross)
    return {
      from,
      to,
      amountIn: amount,
      expectedOut: lessFee(gross, Number(fee)),
      ratio: (ra * WAD) / rb,
      route: "hook",
      feeBps: Number(fee),
      priceImpactBps: 0,
      poolId: pool.id,
    };
  const q = await publicClient.simulateContract({
    address: m.contracts.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: pool.key,
        zeroForOne: pool.key.currency0.toLowerCase() === from.toLowerCase(),
        exactAmount: amount,
        hookData: "0x",
      },
    ],
  });
  return {
    from,
    to,
    amountIn: amount,
    expectedOut: q.result[0],
    ratio: (ra * WAD) / rb,
    route: "curve",
    feeBps: Number(fee),
    priceImpactBps: deviation(q.result[0], gross),
    poolId: pool.id,
  };
}
export async function routes(app: FastifyInstance) {
  app.get("/health", async () => {
    const chainId = await publicClient.getChainId();
    const c = await rows("SELECT last_block FROM cursor WHERE chain_id=$1", [
      chainId,
    ]);
    return { ok: true, chainId, indexedBlock: c[0]?.lastBlock ?? "0" };
  });
  app.get("/deployments", async () => {
    const m = manifest();
    if (
      m.chainId === 84532 ||
      !m.demoMode ||
      !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(
        process.env.LOCAL_RPC || "http://127.0.0.1:8545",
      )
    )
      delete m.burners;
    return m;
  });
  app.get("/backing", async () => {
    const [issuers, totalShares, totalSupply] = await read("vault", "backing");
    return {
      issuers,
      totalShares,
      totalSupply,
      invariant: totalShares >= totalSupply,
    };
  });
  app.get("/parity", parity);
  app.get("/quote", async (req) => {
    const { from, to, amount } = req.query as any;
    if (
      !isAddress(from || "") ||
      !isAddress(to || "") ||
      !/^\d+$/.test(amount || "")
    )
      throw Object.assign(
        Error("from/to addresses and raw integer amount required"),
        { statusCode: 400 },
      );
    return quote(from, to, BigInt(amount));
  });
  app.get("/batch/current", async () => {
    const [[batchId, phase, phaseEndsBlock], blockNumber] = await Promise.all([
      read("darkCrossHook", "currentBatch"),
      publicClient.getBlockNumber(),
    ]);
    return {
      batchId,
      phase: ["Commit", "Reveal", "Settle"][Number(phase)],
      phaseEndsBlock,
      blockNumber,
    };
  });
  app.get("/batch/:id", async (req) => {
    const { id } = req.params as any;
    if (!/^\d+$/.test(id))
      throw Object.assign(Error("Invalid batch"), { statusCode: 400 });
    const [b, o, f] = await Promise.all([
      rows("SELECT * FROM batches WHERE batch_id=$1", [id]),
      rows("SELECT * FROM orders WHERE batch_id=$1", [id]),
      rows("SELECT * FROM fills WHERE batch_id=$1", [id]),
    ]);
    return {
      batchId: id,
      mid: null,
      midSource: null,
      crossedQty: "0",
      routedQty: "0",
      settledTx: null,
      ...b[0],
      orders: o,
      fills: f,
    };
  });
  for (const name of ["orders", "fills", "conversions"] as const)
    app.get("/" + name + "/:addr", async (req) => {
      const { addr } = req.params as any;
      if (!isAddress(addr))
        throw Object.assign(Error("Invalid address"), { statusCode: 400 });
      return rows(
        `SELECT * FROM ${name} WHERE lower(trader)=$1 ORDER BY ${name === "conversions" ? "block" : "batch_id"} DESC LIMIT 200`,
        [addr.toLowerCase()],
      );
    });
  app.get("/intents/:addr", async () => []);
  app.get("/hours", async () => {
    const block = await publicClient.getBlock();
    const [open, nextTransitionTs] = await Promise.all([
      read("calendar", "isOpen", [block.timestamp]),
      read("calendar", "nextTransition", [block.timestamp]),
    ]);
    return { open, nextTransitionTs };
  });
  app.get("/oracle", async () => {
    const m = manifest();
    const [round, dec, block] = await Promise.all([
      publicClient.readContract({
        address: m.contracts.oracle,
        abi: oracleAbi,
        functionName: "latestRoundData",
      }),
      publicClient.readContract({
        address: m.contracts.oracle,
        abi: oracleAbi,
        functionName: "decimals",
      }),
      publicClient.getBlock(),
    ]);
    return {
      price: (round[1] * WAD) / 10n ** BigInt(dec),
      updatedAt: round[3],
      stale:
        block.timestamp - round[3] >
        BigInt(process.env.ORACLE_HEARTBEAT || 86400) + 60n,
    };
  });
  app.get("/metrics", async () => {
    const [v, f, b, p] = await Promise.all([
      rows(
        "SELECT COALESCE(sum(shares),0)::text AS volume FROM conversions WHERE ts > $1",
        [Math.floor(Date.now() / 1000) - 86400],
      ),
      rows(
        "SELECT COALESCE(sum(crossed_qty),0)::text AS crossed,COALESCE(sum(routed_qty),0)::text AS routed FROM batches",
      ),
      rows("SELECT count(*)::int AS count FROM batches WHERE phase='Settled'"),
      parity(),
    ]);
    let fees = 0n;
    for (const t of Object.values(manifest().tokens).filter(
      (t) => t.symbol !== "USDC",
    ))
      fees += shares(
        await read("parityHook", "feeAccrued", [t.address]),
        await ratio(t.address),
        t.decimals,
      );
    return {
      conversionVolume24h: v[0].volume,
      crossedVolume: f[0]?.crossed ?? "0",
      routedVolume: f[0]?.routed ?? "0",
      hookFeePnl: fees,
      meanAbsoluteDeviationBps:
        p.reduce((s, v) => s + v.deviationBps, 0) / (p.length || 1),
      batchesSettled: b[0].count,
    };
  });
}
