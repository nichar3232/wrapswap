import type { FastifyInstance } from "fastify";
import {
  abis,
  validators,
  canonical,
  encodeParityHookData,
  type Deployment,
} from "@wrapswap/types";
import {
  getAddress,
  stringToHex,
  parseAbi,
  keccak256,
  encodeAbiParameters,
  toHex,
} from "viem";
import { chainReader, publicClient } from "../chain/client.js";
import { permitsDarkFallback, routeErrors } from "../chain/reverts.js";
import { deploymentTokens } from "../indexer/events.js";
import { db, camel } from "../db/index.js";
const reasons = [
  "OK",
  "NO_ATTESTATION",
  "WRONG_SCHEMA",
  "WRONG_ATTESTER",
  "WRONG_RECIPIENT",
  "REVOKED",
  "EXPIRED",
  "RESTRICTED_COUNTRY",
];
const phases = ["COMMIT", "REVEAL", "SETTLE"];
const zero = "0x" + "0".repeat(64);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const fault = (code: string, message: string) =>
  Object.assign(Error(message), {
    code,
    statusCode:
      code === "BAD_REQUEST"
        ? 400
        : code === "NOT_FOUND"
          ? 404
          : code === "INTERNAL"
            ? 500
            : 503,
  });
function checked(name: string, v: unknown) {
  try {
    return (validators as any)[name].assert(v);
  } catch {
    throw fault("BAD_REQUEST", `Invalid ${name}`);
  }
}
export function output(name: string, v: any) {
  const normalize = (x: any): any =>
    typeof x === "bigint"
      ? x.toString()
      : typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x)
        ? getAddress(x.toLowerCase())
        : Array.isArray(x)
          ? x.map(normalize)
          : x && typeof x === "object"
            ? Object.fromEntries(
                Object.entries(x).map(([k, v]) => [k, normalize(v)]),
              )
            : x;
  return (validators as any)[name].assert(normalize(v));
}
const fee = (f: any) => ({
  basePips: Number(f.basePips),
  skewPips: Number(f.skewPips),
  totalPips: Number(f.totalPips),
  totalBps: canonical.pipsToBps(f.totalPips),
  skewX18: f.skewX18,
  postSkewX18: f.postSkewX18,
  reducesImbalance: f.reducesImbalance,
});
const selectFields = (r: any, fields: string) =>
  Object.fromEntries(fields.split(" ").map((k) => [k, r[k]]));
const batchFields =
  "batchId settled midX18 crossedBase crossedQuote residualBaseIn residualQuoteIn participants settledTx settledBlock settledAt";
const orderFields =
  "batchId trader commitHash lockToken locked committedTx revealed valid rejectReason sellBase amountIn limitPriceX18 routeResidual forfeited";
const fillFields =
  "kind account tokenIn tokenOut amountIn amountOut feeAmount feePips shares batchId poolId blockNumber timestamp txHash logIndex";
export async function routes(
  app: FastifyInstance,
  d: Deployment,
  chainClient: any = publicClient,
  pool: any = db,
) {
  // Load-balanced public RPCs (Unichain Sepolia) can route a read pinned to the newest block to a backend that has not
  // seen it yet ("returned no data", unknown block); retry those briefly before reporting CHAIN_UNAVAILABLE.
  const stale = /returned no data|header not found|unknown block|block not found|could not be found/i;
  const client = new Proxy(chainClient, {
    get(target, key) {
      const value = target[key];
      return typeof value === "function"
        ? async (...args: any[]) => {
            for (let attempt = 0; ; attempt++) {
              try {
                return await value.apply(target, args);
              } catch (e) {
                if (attempt < 3 && stale.test(String(e))) {
                  await new Promise((r) => setTimeout(r, 250));
                  continue;
                }
                throw Object.assign(fault("CHAIN_UNAVAILABLE", String(e)), {
                  cause: e,
                });
              }
            }
          }
        : value;
    },
  });
  const rawRead = chainReader(d, client);
  const read = async (...args: Parameters<typeof rawRead>) => {
    try {
      return await rawRead(...args);
    } catch (e) {
      throw Object.assign(fault("CHAIN_UNAVAILABLE", String(e)), { cause: e });
    }
  };
  const sql = async (q: string, a: any[] = []): Promise<any[]> => {
    try {
      return (await pool.query(q, a)).rows.map(camel);
    } catch (e) {
      throw fault("DB_UNAVAILABLE", String(e));
    }
  };
  const block = async () => {
    try {
      return await client.getBlock();
    } catch (e) {
      throw Object.assign(fault("CHAIN_UNAVAILABLE", String(e)), { cause: e });
    }
  };
  const allTokens = deploymentTokens(d);
  const faucetAbi = parseAbi([
    "function nextClaimAt(address account) view returns (uint256)",
    "function tokens() view returns (address[])",
    "function amountOf(address token) view returns (uint256)",
  ]);
  // Assets come only from the manifest: `assets[]` (multi-asset) or, for older manifests, `tokens` + `pool`.
  const assetList: any[] =
    d.assets ??
    [
      {
        symbol: d.tokens[0].underlying,
        pool: d.pool,
        darkCross: true,
        wrappers: d.tokens.map((t) => ({
          platform: t.issuer,
          symbol: t.symbol,
          token: t.address,
          adapter: t.adapter,
          decimals: t.decimals,
        })),
      },
    ];
  const assetOf = (symbol: string) => {
    const a = assetList.find(
      (a) => a.symbol.toLowerCase() === String(symbol).toLowerCase(),
    );
    if (!a) throw fault("NOT_FOUND", `Unknown asset ${symbol}`);
    return a;
  };
  const assetOfToken = (address: string) =>
    assetList.find((a) => a.wrappers.some((w: any) => eq(w.token, address)));
  const wrapperIn = (a: any, name: string) =>
    a.wrappers.find((w: any) =>
      [w.symbol, w.platform].some(
        (x: string) => x.toLowerCase() === String(name).toLowerCase(),
      ),
    );
  const assetId = (symbol: string) => stringToHex(symbol, { size: 32 }).toLowerCase();
  // Every asset's DarkCrossHook: `assets[].darkCrossHook` in a multi-asset manifest, else the single `dark` pair.
  const darkOf = (a: any) =>
    a?.darkCrossHook
      ? { hook: getAddress(a.darkCrossHook), base: getAddress(a.darkBaseToken), quote: getAddress(a.darkQuoteToken), asset: a.symbol }
      : a && a.pool?.id?.toLowerCase() === d.pool.id.toLowerCase()
        ? { hook: d.contracts.darkCrossHook, base: d.dark.baseToken, quote: d.dark.quoteToken, asset: a.symbol }
        : null;
  const darkList = assetList.map(darkOf).filter(Boolean) as { hook: string; base: string; quote: string; asset: string }[];
  const darkByContract = (contract: string) => darkList.find((x) => eq(x.hook, contract));
  const darkForQuery = (asset?: string) => {
    const dk = asset ? darkOf(assetOf(asset)) : darkList[0];
    if (!dk) throw fault("NOT_FOUND", `No Dark Cross for ${asset}`);
    return dk;
  };
  const darkRead = (hook: string, functionName: string, args: any[], blockNumber: bigint) =>
    client.readContract({ address: hook, abi: abis.IDarkCrossHook, functionName, args, blockNumber }) as Promise<any>;
  const sharesOfToken = async (address: string, amount: bigint, b: any) => {
    const t = await token(address, b);
    return canonical.toSharesDown(amount, t.sharesPerTokenX18, t.decimals);
  };
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const token = async (address: string, b: any) => {
    const t = allTokens.find((t) => eq(t.address, address))!;
    const [ratio, active] = await Promise.all([
      client.readContract({
        address: t.adapter,
        abi: abis.IWrapperAdapter,
        functionName: "ratio",
        blockNumber: b.number,
      }),
      read("registry", "active", [t.address], b.number),
    ]);
    return {
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      adapter: t.adapter,
      sharesPerTokenX18: ratio[0],
      healthy: ratio[1] && active,
    };
  };
  const eligibility = async (
    address: string,
    uid: string | undefined,
    source: string,
    b: any,
  ) => {
    const [[eligible, reasonCode], demoMode] = await Promise.all([
      read("eligibility", "check", [address, uid ?? zero], b.number),
      read("eligibility", "demoMode", [], b.number),
    ]);
    await sql(
      "INSERT INTO eligibility_checks(chain_id,account,attestation_uid,eligible,reason,demo_mode,block_number,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        d.chainId,
        address.toLowerCase(),
        uid ?? null,
        eligible,
        Number(reasonCode),
        demoMode,
        b.number.toString(),
        source,
      ],
    );
    return {
      address,
      eligible,
      reasonCode: Number(reasonCode),
      reason: reasons[Number(reasonCode)],
      demoMode,
      attestationUid: uid ?? null,
      block: b.number,
    };
  };
  const quote = async (q0: any, b: any) => {
    const q = { ...q0 };
    if (q.asset) {
      const a = assetOf(q.asset),
        from = wrapperIn(a, q.from ?? ""),
        to = wrapperIn(a, q.to ?? "");
      if (!from || !to) throw fault("NOT_FOUND", "Unknown wrapper for asset");
      q.tokenIn = getAddress(from.token);
      q.tokenOut = getAddress(to.token);
    }
    if (!q.tokenIn || !q.tokenOut)
      throw fault("BAD_REQUEST", "Pass tokenIn and tokenOut, or asset, from and to");
    const asset = assetOfToken(q.tokenIn);
    if (
      eq(q.tokenIn, q.tokenOut) ||
      !asset?.wrappers.some((w: any) => eq(w.token, q.tokenOut))
    )
      throw fault("NOT_FOUND", "Unknown token pair");
    const pool = asset.pool;
    const kind = q.kind ?? "exactIn",
      amountSpecified = BigInt(q.amount) * (kind === "exactIn" ? -1n : 1n),
      zeroForOne = eq(q.tokenIn, pool.key.currency0);
    const result = await read(
      "parityHook",
      "quote",
      [pool.key, zeroForOne, amountSpecified],
      b.number,
    );
    const [input, outputToken] = await Promise.all([
      token(q.tokenIn, b),
      token(q.tokenOut, b),
    ]);
    const calculated = canonical.parityQuote(
      { spt: input.sharesPerTokenX18, decimals: input.decimals },
      { spt: outputToken.sharesPerTokenX18, decimals: outputToken.decimals },
      amountSpecified,
      BigInt(result.fee.totalPips),
    );
    for (const [key, value] of Object.entries(calculated))
      if (BigInt(result[key]) !== value)
        throw fault(
          "INTERNAL",
          "On-chain quote disagrees with frozen rounding rules",
        );
    // Share-denominated view. Exact input: ParityHook.quote(asset, from, to, amountIn) returns the on-chain split;
    // exact output: the fee in shares split pro rata to the quoted pips.
    const sharesIn = BigInt(result.shares);
    let sharesOut: bigint, baseFee: bigint, skewFee: bigint;
    if (kind === "exactIn") {
      [sharesOut, baseFee, skewFee] = await read(
        "parityHook",
        "quote",
        [assetId(asset.symbol), q.tokenIn, q.tokenOut, BigInt(q.amount)],
        b.number,
      );
    } else {
      sharesOut = canonical.toSharesDown(BigInt(result.amountOut), outputToken.sharesPerTokenX18, outputToken.decimals);
      const feeShares = sharesIn - sharesOut,
        totalPips = BigInt(result.fee.totalPips);
      baseFee = totalPips ? (feeShares * BigInt(result.fee.basePips)) / totalPips : 0n;
      skewFee = feeShares - baseFee;
    }
    const preSkewX18 = BigInt(result.fee.skewX18),
      postSkewX18 = BigInt(result.fee.postSkewX18);
    const keep = sharesIn ? (sharesOut * 1_000_000n) / sharesIn : 0n;
    return {
      block: b.number,
      poolId: pool.id,
      tokenIn: q.tokenIn,
      tokenOut: q.tokenOut,
      kind,
      zeroForOne,
      amountSpecified,
      ...result,
      feeToken: q.tokenOut,
      fee: fee(result.fee),
      asset: asset.symbol,
      sharesIn,
      sharesOut,
      baseFee,
      skewFee,
      youKeep: `${keep / 1_000_000n}.${(keep % 1_000_000n).toString().padStart(6, "0")}`,
      preSkewX18,
      postSkewX18,
      reducesImbalance: Boolean(result.fee.reducesImbalance),
    };
  };
  const current = async (b: any, dk = darkList[0]) => {
    const [[batchId, phase, phaseEndsBlock], batchOrigin] = await Promise.all([
      darkRead(dk.hook, "currentBatch", [], b.number),
      darkRead(dk.hook, "batchOrigin", [], b.number),
    ]);
    const participants = await darkRead(dk.hook, "participants", [batchId], b.number);
    let oracle: any = { midX18: null, updatedAt: null, stale: true };
    try {
      const [mid, age] = await Promise.all([
        rawRead(
          "oracle",
          "getMid",
          [dk.base, dk.quote],
          b.number,
        ),
        darkRead(dk.hook, "ORACLE_MAX_AGE", [], b.number),
      ]);
      oracle = {
        midX18: mid[0],
        updatedAt: mid[1],
        stale: b.timestamp - mid[1] > BigInt(age),
      };
    } catch (e) {
      if (!String(e).includes("NoPrice")) throw e;
    }
    // Seconds left in the phase from the chain's average block time over the last 100 blocks.
    const earlier = await client.getBlock({ blockNumber: b.number - 100n });
    const blockMs = (Number(b.timestamp - earlier.timestamp) * 1000) / 100;
    const blocksLeft = phaseEndsBlock > b.number ? Number(phaseEndsBlock - b.number) : 0;
    return {
      batchId,
      phase: phases[Number(phase)],
      phaseEndsBlock,
      blockNumber: b.number,
      batchOrigin,
      participants: participants.length,
      asset: dk.asset,
      secondsRemaining: Math.ceil((blocksLeft * blockMs) / 1000),
      oracle,
    };
  };
  // Per-batch share-denominated detail from the hook's events: Crossed (matched shares, protocol fee), ResidualFilled
  // with its ParityHook fill, and Unfilled refunds. Items carry `contract` (the DarkCrossHook), stripped here.
  const enrichBatches = async (items: any[], b: any) => {
    if (!items.length) return items;
    const args = [d.chainId, items.map((i) => String(i.batchId))];
    const [crosses, residualFees, residualFills, unfilled] = await Promise.all([
      sql("SELECT contract, batch_id::text AS id, sum(matched_shares)::text AS matched, sum(protocol_fee)::text AS fee FROM dark_batch_crosses WHERE chain_id=$1 AND batch_id = ANY($2::numeric[]) GROUP BY 1,2", args),
      sql("SELECT contract, batch_id::text AS id, trader, tx_hash, (base_fee + skew_fee)::text AS fee FROM dark_residual_fills WHERE chain_id=$1 AND batch_id = ANY($2::numeric[])", args),
      sql("SELECT dark_contract AS contract, batch_id::text AS id, account, token_in, amount_in::text AS amount_in, amount_out::text AS amount_out, fee_amount::text AS fee_amount, tx_hash FROM v_fills WHERE chain_id=$1 AND batch_id = ANY($2::numeric[]) AND kind='DARK-RESIDUAL'", args),
      sql("SELECT contract, batch_id::text AS id, sum(shares_refunded)::text AS shares FROM dark_unfilled WHERE chain_id=$1 AND batch_id = ANY($2::numeric[]) GROUP BY 1,2", args),
    ]);
    return Promise.all(
      items.map(async ({ contract, ...i }) => {
        const dk = darkByContract(contract)!;
        const mine = (r: any) => eq(r.contract, contract) && r.id === String(i.batchId);
        const cross = crosses.find(mine);
        const residualFilled = residualFills.filter(mine).map((r) => ({
          trader: getAddress(r.account),
          tokenIn: getAddress(r.tokenIn),
          amountIn: BigInt(r.amountIn),
          amountOut: BigInt(r.amountOut),
          feeAmount: BigInt(r.feeAmount ?? 0),
          feeShares: BigInt(residualFees.find((f) => mine(f) && eq(f.trader, r.account) && f.txHash === r.txHash)?.fee ?? 0),
          txHash: r.txHash,
        }));
        const routed = (t: string) =>
          residualFilled.filter((r) => eq(r.tokenIn, t)).reduce((s, r) => s + r.amountIn, 0n);
        return {
          ...i,
          asset: dk.asset,
          crossedShares: cross ? BigInt(cross.matched) : await sharesOfToken(dk.base, BigInt(i.crossedBase ?? 0), b),
          protocolFeeShares: BigInt(cross?.fee ?? 0),
          residualFilled,
          unfilledRefunded: {
            base: BigInt(i.residualBaseIn ?? 0) - routed(dk.base),
            quote: BigInt(i.residualQuoteIn ?? 0) - routed(dk.quote),
            shares: BigInt(unfilled.find(mine)?.shares ?? 0),
          },
        };
      }),
    );
  };
  const page = async (
    source: string,
    q: any,
    extra = "",
    args: any[] = [],
    map = (x: any) => x,
  ) => {
    const params: any[] = [d.chainId, ...args];
    let where = "chain_id=$1" + extra;
    if (q.cursor) {
      const [n, i] = q.cursor.split(":");
      params.push(n, i);
      where += ` AND (block_number,log_index)<($${params.length - 1}::numeric,$${params.length}::integer)`;
    }
    params.push(Number(q.limit ?? 50) + 1);
    const rows = await sql(
      `SELECT * FROM (${source}) p WHERE ${where} ORDER BY block_number DESC,log_index DESC LIMIT $${params.length}`,
      params,
    );
    const more = rows.length > Number(q.limit ?? 50);
    if (more) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map(map),
      nextCursor: more ? `${last.blockNumber}:${last.logIndex}` : null,
    };
  };
  const batchSource = `SELECT b.*, p.block_number,p.log_index FROM v_dark_batches b JOIN LATERAL (SELECT block_number,log_index FROM raw_logs r WHERE r.chain_id=b.chain_id AND r.contract=b.contract AND r.event_name IN ('Committed','BatchSettled') AND r.args->>'batchId'=b.batch_id::text ORDER BY block_number DESC,log_index DESC LIMIT 1) p ON true`;
  const orderMap = (r: any) =>
    selectFields(
      {
        ...r,
        rejectReason:
          r.rejectReason === null
            ? null
            : [
                null,
                "WRONG_LOCK_TOKEN",
                "INSUFFICIENT_LOCK",
                "ZERO_AMOUNT",
                "ZERO_LIMIT",
              ][r.rejectReason],
      },
      orderFields,
    );
  const fillMap = (r: any) =>
    selectFields({ ...r, timestamp: r.blockTimestamp }, fillFields);
  function get(
    path: string,
    schema: string,
    handler: (req: any) => Promise<any>,
    query?: string,
  ) {
    app.get(path, async (req) => {
      if (query) checked(query, req.query);
      for (const record of [req.query, req.params])
        for (const [k, v] of Object.entries(record as any))
          if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v))
            (record as any)[k] = getAddress(v.toLowerCase());
      return output(schema, await handler(req));
    });
  }
  get("/deployment", "Deployment", async () => d);
  get("/health", "HealthResponse", async () => {
    let rpcChainId = null,
      headBlock: any = null,
      indexedBlock: any = null,
      database = "down";
    try {
      rpcChainId = await client.getChainId();
      headBlock = await client.getBlockNumber();
    } catch {}
    try {
      indexedBlock =
        (
          await sql("SELECT last_block FROM indexer_cursor WHERE chain_id=$1", [
            d.chainId,
          ])
        )[0]?.lastBlock ?? null;
      database = "ok";
    } catch {}
    const lagBlocks =
      headBlock !== null && indexedBlock !== null
        ? Number(headBlock - BigInt(indexedBlock))
        : null;
    return {
      ok:
        rpcChainId === d.chainId &&
        database === "ok" &&
        lagBlocks !== null &&
        lagBlocks >= 0 &&
        lagBlocks <= 10,
      network: d.network,
      chainId: d.chainId,
      rpcChainId,
      headBlock,
      indexedBlock,
      lagBlocks,
      db: database,
      demoMode: d.demoMode,
      deployCommit: d.deployCommit,
      startBlock: d.startBlock,
      addresses: {
        contracts: d.contracts,
        tokens: Object.fromEntries(d.tokens.map((t) => [t.symbol, t.address])),
        poolId: d.pool.id,
      },
    };
  });
  get("/fees", "FeesResponse", async () => {
    const b = await block();
    return {
      block: b.number,
      timestamp: b.timestamp,
      poolId: d.pool.id,
      fee: fee(
        await read("parityHook", "feeBreakdown", [d.pool.key], b.number),
      ),
      maxFeePips:
        Number(await read("parityHook", "baseFeePips", [], b.number)) +
        Number(await read("parityHook", "SKEW_FEE_CAP_PIPS", [], b.number)),
      formula: "baseFeePips + (|skew| grows ? min(ceil(1500*|postTradeSkew|), 5000) : 0) pips",
    };
  });
  get("/inventory", "InventoryResponse", async () => {
    const b = await block(),
      f = fee(await read("parityHook", "feeBreakdown", [d.pool.key], b.number));
    const tokens = await Promise.all(
      [d.pool.key.currency0, d.pool.key.currency1].map(async (address) => {
        const t = d.tokens.find((t) => eq(t.address, address))!;
        // Fees stay in inventory (100% to the LP), so nothing accrues separately.
        const feesAccrued = 0n;
        const [inventory, inventoryShares] = await Promise.all(
          ["inventory", "inventoryShares"].map((fn) =>
            read("parityHook", fn, [address], b.number),
          ),
        );
        return {
          symbol: t.symbol,
          address,
          inventory,
          inventoryShares,
          feesAccrued,
        };
      }),
    );
    return {
      block: b.number,
      poolId: d.pool.id,
      tokens,
      totalShares: tokens.reduce((s, t) => s + t.inventoryShares, 0n),
      skewX18: f.skewX18,
      fee: f,
    };
  });
  get("/pool", "PoolStateResponse", async () => {
    const b = await block();
    const [token0, token1, peg, last] = await Promise.all([
      token(d.pool.key.currency0, b),
      token(d.pool.key.currency1, b),
      read("parityHook", "pegStatus", [d.pool.key], b.number),
      sql(
        "SELECT * FROM parity_peg_status WHERE chain_id=$1 AND pool_id=$2 ORDER BY block_number DESC,log_index DESC LIMIT 1",
        [d.chainId, d.pool.id.toLowerCase()],
      ),
    ]);
    const slot = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }],
        [d.pool.id as any, 6n],
      ),
    );
    const storageAbi = parseAbi([
      "function extsload(bytes32 slot) view returns (bytes32)",
    ]);
    const [packed, liq] = await Promise.all(
      [slot, toHex(BigInt(slot) + 3n, { size: 32 })].map((s) =>
        client.readContract({
          address: d.contracts.poolManager,
          abi: storageAbi,
          functionName: "extsload",
          args: [s],
          blockNumber: b.number,
        }),
      ),
    );
    const word = BigInt(packed),
      tick = Number((word >> 160n) & 0xffffffn);
    return {
      block: b.number,
      timestamp: b.timestamp,
      poolId: d.pool.id,
      key: d.pool.key,
      token0,
      token1,
      sqrtPriceX96: word & ((1n << 160n) - 1n),
      tick: tick >= 0x800000 ? tick - 0x1000000 : tick,
      liquidity: BigInt(liq) & ((1n << 128n) - 1n),
      poolPriceX18: peg.poolPriceX18,
      parityPriceX18: peg.parityPriceX18,
      deviationBps: Number(peg.deviationBps),
      pegGuardBps: 50,
      pegTripped: peg.tripped,
      lastPegEvent: last[0]
        ? {
            tripped: last[0].tripped,
            deviationBps: Number(last[0].deviationBps),
            blockNumber: last[0].blockNumber,
            txHash: last[0].txHash,
          }
        : null,
    };
  });
  get(
    "/quote",
    "QuoteResponse",
    async (req) => quote(req.query, await block()),
    "SwapQuery",
  );
  get(
    "/route",
    "RouteResponse",
    async (req) => {
      const q = req.query,
        b = await block(),
        e = await eligibility(q.swapper, q.attestationUid, "route", b);
      const result: any = {
        route: "BLOCKED-ELIGIBILITY",
        reason: e.reason,
        block: b.number,
        swapper: q.swapper,
        eligibility: e,
        quote: null,
        fallThrough: null,
        dark: null,
      };
      if (!e.eligible) return result;
      const ts = await Promise.all(d.tokens.map((t) => token(t.address, b)));
      if (ts.some((t) => !t.healthy))
        return { ...result, route: "BLOCKED-PEG", reason: "ADAPTER_UNHEALTHY" };
      result.quote = await quote(q, b);
      result.reason = null;
      if (result.quote.fillable) return { ...result, route: "PARITY" };
      const exact = q.kind !== "exactOut";
      const routeAsset = assetOfToken(result.quote.tokenIn);
      const quoter = parseAbi([
        `function ${exact ? "quoteExactInputSingle" : "quoteExactOutputSingle"}(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amount,uint256 gasEstimate)`,
      ]);
      try {
        // No Uniswap quoter in the manifest: the fall-through cannot be simulated, so offer the dark route.
        if (!d.contracts.quoter) throw Object.assign(Error("no quoter"), { noQuoter: true });
        const sim = await client.simulateContract({
          address: d.contracts.quoter,
          abi: [...quoter, ...routeErrors],
          functionName: exact
            ? "quoteExactInputSingle"
            : "quoteExactOutputSingle",
          args: [
            {
              poolKey: routeAsset.pool.key,
              zeroForOne: result.quote.zeroForOne,
              exactAmount: BigInt(q.amount),
              hookData: encodeParityHookData({
                swapper: q.swapper,
                attestationUid: q.attestationUid,
              }),
            },
          ],
          blockNumber: b.number,
        });
        return {
          ...result,
          route: "FALL-THROUGH",
          fallThrough: {
            amountIn: exact ? BigInt(q.amount) : sim.result[0],
            amountOut: exact ? sim.result[0] : BigInt(q.amount),
            feePips: result.quote.fee.totalPips,
          },
        };
      } catch (error) {
        if (!(error as any).noQuoter && !permitsDarkFallback(error))
          throw fault("CHAIN_UNAVAILABLE", String(error));
        const dk = darkOf(routeAsset);
        if (q.allowDark === "false" || !dk)
          return { ...result, route: "BLOCKED-PEG", reason: "PEG_GUARD" };
        const c = await current(b, dk);
        return {
          ...result,
          route: "DARK",
          dark: {
            batchId: c.batchId,
            phase: c.phase,
            phaseEndsBlock: c.phaseEndsBlock,
            oracleMidX18: c.oracle.midX18,
            sellBase: eq(result.quote.tokenIn, dk.base),
          },
        };
      }
    },
    "RouteQuery",
  );
  get("/nyse", "NyseResponse", async () => {
    // The final fee model has no market-hours component; deployments without a calendar have no NYSE feed.
    if (!d.contracts.calendar) throw fault("NOT_FOUND", "No NYSE calendar in this deployment");
    const b = await block();
    const [open, nextTransition] = await Promise.all([
      read("calendar", "isOpen", [b.timestamp], b.number),
      read("calendar", "nextTransition", [b.timestamp], b.number),
    ]);
    return {
      open,
      block: b.number,
      chainTimestamp: b.timestamp,
      nextTransition,
      nextState: open ? "CLOSED" : "OPEN",
      secondsUntilTransition: Number(nextTransition - b.timestamp),
      closedFeePips: 0, // no off-hours premium in the final fee model
      source: "chain",
    };
  });
  get(
    "/batches/current",
    "CurrentBatchResponse",
    async (req) => current(await block(), darkForQuery(req.query.asset)),
    "AssetQuery",
  );
  get(
    "/batches",
    "BatchListResponse",
    async (req) => {
      const { settled, asset, ...q } = req.query;
      const args: any[] = [];
      let extra = "";
      if (asset) {
        const dk = darkOf(assetOf(asset));
        if (!dk) return { items: [], nextCursor: null };
        args.push(dk.hook.toLowerCase());
        extra += ` AND contract=$${args.length + 1}`;
      }
      if (settled) {
        args.push(settled === "true");
        extra += ` AND settled=$${args.length + 1}`;
      }
      const result = await page(batchSource, q, extra, args, (r) => ({
        ...selectFields(r, batchFields),
        contract: r.contract,
      }));
      return { ...result, items: await enrichBatches(result.items, await block()) };
    },
    "BatchesQuery",
  );
  get(
    "/orders/:address",
    "OrderListResponse",
    async (req) => {
      checked("Address", req.params.address);
      return page(
        "SELECT * FROM v_dark_orders",
        req.query,
        " AND trader=$2",
        [req.params.address.toLowerCase()],
        orderMap,
      );
    },
    "PageQuery",
  );
  get(
    "/fills",
    "FillListResponse",
    async (req) => {
      const q = req.query,
        args: any[] = [];
      let extra = "";
      if (q.account) {
        args.push(q.account.toLowerCase());
        extra += ` AND account=$${args.length + 1}`;
      }
      if (q.kind) {
        args.push(q.kind);
        extra += ` AND kind=$${args.length + 1}`;
      }
      return page("SELECT * FROM v_fills", q, extra, args, fillMap);
    },
    "FillsQuery",
  );
  get("/assets", "AssetsResponse", async () => {
    const b = await block();
    // A multi-pool deployment lists `pools`; the current schema has the single `pool`.
    const manifest =
      d.assets ??
      [...new Set(d.tokens.map((t) => t.underlying))].map((symbol) => ({
        symbol,
        pool: d.pool,
        darkCross: true,
        wrappers: d.tokens
          .filter((t) => t.underlying === symbol)
          .map((t) => ({ platform: t.issuer, symbol: t.symbol, token: t.address })),
      }));
    return {
      network: d.network,
      chainId: d.chainId,
      block: b.number,
      assets: await Promise.all(
        manifest.map(async (m: any) => {
          const mine = (a: string) => m.wrappers.some((w: any) => eq(w.token, a));
          const platforms = await Promise.all(
            m.wrappers.map(async (w: any) => {
              const t = allTokens.find((t) => eq(t.address, w.token))!;
              const known = d.tokens.find((x) => eq(x.address, w.token));
              const live = await token(t.address, b);
              return {
                platform: w.platform,
                issuer: t.issuer,
                symbol: t.symbol,
                name: known?.name ?? null,
                address: t.address,
                decimals: t.decimals,
                adapter: t.adapter,
                adapterKind: known?.adapterKind ?? null,
                sharesPerTokenX18: live.sharesPerTokenX18,
                healthy: live.healthy,
                mock: known?.mock ?? null,
              };
            }),
          );
          return {
            asset: m.symbol,
            platforms,
            pools: [m.pool].map((p: any) => ({ poolId: p.id, ...p.key })),
            darkCross: (() => {
              const dk = m.darkCross ? darkOf(m) : null;
              return dk && mine(dk.base) && mine(dk.quote)
                ? { hook: dk.hook, baseToken: dk.base, quoteToken: dk.quote, batchBlocks: d.dark.batchBlocks }
                : null;
            })(),
          };
        }),
      ),
    };
  });
  get("/pool/:asset", "PoolAssetResponse", async (req) => {
    const a = assetOf(req.params.asset),
      pool = a.pool,
      b = await block();
    const wrappers = await Promise.all(
      a.wrappers.map(async (w: any) => {
        const [inventory, inventoryShares] = await Promise.all(
          ["inventory", "inventoryShares"].map((fn) =>
            read("parityHook", fn, [w.token], b.number),
          ),
        );
        return { platform: w.platform, symbol: w.symbol, address: getAddress(w.token), inventory, inventoryShares };
      }),
    );
    const side = (c: string) => wrappers.find((w) => eq(w.address, c))!.inventoryShares as bigint;
    const s0 = side(pool.key.currency0),
      s1 = side(pool.key.currency1),
      skewX18 = canonical.skewX18(s0, s1);
    // Each direction: the on-chain quote for one whole `from` token.
    const directions = await Promise.all(
      wrappers.flatMap((from) =>
        wrappers
          .filter((to) => to !== from)
          .map(async (to) => {
            const t = allTokens.find((t) => eq(t.address, from.address))!;
            const zeroForOne = eq(from.address, pool.key.currency0);
            const r = await read("parityHook", "quote", [pool.key, zeroForOne, -(10n ** BigInt(t.decimals))], b.number);
            return {
              from: from.symbol,
              to: to.symbol,
              skewFeePips: Number(r.fee.skewPips),
              totalPips: Number(r.fee.totalPips),
              totalBps: canonical.pipsToBps(r.fee.totalPips),
              reducesImbalance: Boolean(r.fee.reducesImbalance),
            };
          }),
      ),
    );
    const cheap = directions.reduce((m, x) => (x.totalPips < m.totalPips ? x : m));
    // LP fees: every Converted event on this asset (inventory fills and dark residuals); fees stay in inventory.
    const [conv] = await sql(
      "SELECT count(*)::int AS n, COALESCE(sum(base_fee),0)::text AS base, COALESCE(sum(skew_fee),0)::text AS skew FROM parity_conversions WHERE chain_id=$1 AND asset=$2",
      [d.chainId, assetId(a.symbol)],
    );
    const lp = {
      fills: conv.n,
      baseShares: BigInt(conv.base),
      skewShares: BigInt(conv.skew),
      totalShares: BigInt(conv.base) + BigInt(conv.skew),
    };
    const hundredths = (skewX18 * 10000n) / canonical.ONE;
    return {
      asset: a.symbol,
      block: b.number,
      poolId: pool.id,
      wrappers,
      totalShares: s0 + s1,
      skewX18,
      skewPct: `${hundredths < 0n ? "-" : ""}${abs(hundredths) / 100n}.${(abs(hundredths) % 100n).toString().padStart(2, "0")}`,
      directions,
      cheapDirection: { from: cheap.from, to: cheap.to },
      lpFees: lp,
    };
  });
  get("/faucet/:address", "FaucetResponse", async (req) => {
    checked("Address", req.params.address);
    if (!d.faucet) throw fault("NOT_FOUND", "No faucet in the deployment");
    const b = await block();
    const call = (functionName: any, args: any[] = []) =>
      client.readContract({ address: d.faucet!, abi: faucetAbi, functionName, args, blockNumber: b.number }) as Promise<any>;
    const [list, next] = await Promise.all([call("tokens"), call("nextClaimAt", [req.params.address])]);
    const [last] = await sql(
      "SELECT max(\"timestamp\")::text AS t FROM faucet_claims WHERE chain_id=$1 AND account=$2",
      [d.chainId, req.params.address.toLowerCase()],
    );
    return {
      address: req.params.address,
      faucet: d.faucet,
      block: b.number,
      lastClaimAt: last?.t ?? null,
      tokens: await Promise.all(
        (list as string[]).map(async (t) => {
          const w = allTokens.find((x) => eq(x.address, t));
          return {
            asset: w?.underlying ?? "UNKNOWN",
            symbol: w?.symbol ?? t,
            address: getAddress(t),
            amount: await call("amountOf", [t]),
            nextClaimAt: next,
            claimable: next <= b.timestamp,
          };
        }),
      ),
    };
  });
  get(
    "/stats",
    "StatsResponse",
    async (req) => {
      const address = req.query.address?.toLowerCase();
      const b = await block();
      // Share figures use the on-chain adapter ratio of each fill's token (INTERFACES.md StatsResponse).
      const ratios = new Map<string, { spt: bigint; decimals: number }>();
      const underlying = (tokenAddress: string) =>
        allTokens.find((t) => eq(t.address, tokenAddress))?.underlying ?? "UNKNOWN";
      const shares = async (tokenAddress: string, amount: bigint) => {
        const key = tokenAddress.toLowerCase();
        if (!ratios.has(key)) {
          const t = await token(tokenAddress, b);
          ratios.set(key, { spt: t.sharesPerTokenX18, decimals: t.decimals });
        }
        const r = ratios.get(key)!;
        return canonical.toSharesDown(amount, r.spt, r.decimals);
      };
      const volume = async (account?: string) => {
        const args: any[] = [d.chainId];
        let where = "chain_id=$1";
        if (account) {
          args.push(account);
          where += " AND account=$2";
        }
        const [kinds, inputs] = await Promise.all([
          sql(`SELECT kind, count(*)::int AS n FROM v_fills WHERE ${where} GROUP BY kind`, args),
          sql(`SELECT token_in, count(*)::int AS n, sum(amount_in)::text AS amount FROM v_fills WHERE ${where} GROUP BY token_in`, args),
        ]);
        let sharesVolume = 0n;
        const assets = new Map<string, { fills: number; sharesVolume: bigint }>();
        for (const r of inputs) {
          const v = await shares(r.tokenIn, BigInt(r.amount));
          sharesVolume += v;
          const a = underlying(r.tokenIn);
          const cur = assets.get(a) ?? { fills: 0, sharesVolume: 0n };
          assets.set(a, { fills: cur.fills + r.n, sharesVolume: cur.sharesVolume + v });
        }
        const byKind: Record<string, number> = { PARITY: 0, "FALL-THROUGH": 0, "DARK-CROSS": 0, "DARK-RESIDUAL": 0 };
        for (const r of kinds) byKind[r.kind] = r.n;
        return { byKind, fills: kinds.reduce((n, r) => n + r.n, 0), sharesVolume, assets };
      };
      const crossFees = await sql(
        "SELECT token_out, sum(fee_amount)::text AS amount FROM v_fills WHERE chain_id=$1 AND kind='DARK-CROSS' GROUP BY token_out",
        [d.chainId],
      );
      const protocolTokens = await Promise.all(
        crossFees.map(async (r) => {
          const t = allTokens.find((t) => eq(t.address, r.tokenOut))!;
          const amount = BigInt(r.amount);
          return { symbol: t.symbol, address: t.address, amount, shares: await shares(t.address, amount) };
        }),
      );
      const [cursor, total, fees] = await Promise.all([
        sql("SELECT last_block FROM indexer_cursor WHERE chain_id=$1", [d.chainId]),
        volume(),
        sql(
          "SELECT token_out, sum(fee_amount)::text AS amount FROM v_fills WHERE chain_id=$1 AND kind IN ('PARITY','DARK-RESIDUAL') AND fee_amount IS NOT NULL GROUP BY token_out",
          [d.chainId],
        ),
      ]);
      const tokens = await Promise.all(
        fees.map(async (r) => {
          const t = allTokens.find((t) => eq(t.address, r.tokenOut))!;
          const amount = BigInt(r.amount);
          return { symbol: t.symbol, address: t.address, amount, shares: await shares(t.address, amount) };
        }),
      );
      let faucet = null;
      if (d.faucet) {
        const [claims] = await sql(
          "SELECT count(*)::int AS n, count(DISTINCT account)::int AS accounts, max(CASE WHEN account=$2 THEN \"timestamp\" END)::text AS last FROM faucet_claims WHERE chain_id=$1",
          [d.chainId, address ?? ""],
        );
        let next = null;
        if (address)
          try {
            next = await client.readContract({
              address: d.faucet,
              abi: faucetAbi,
              functionName: "nextClaimAt",
              args: [req.query.address],
              blockNumber: b.number,
            });
          } catch (e) {
            throw Object.assign(fault("CHAIN_UNAVAILABLE", String(e)), { cause: e });
          }
        faucet = {
          address: d.faucet,
          claims: claims.n,
          claimants: claims.accounts,
          walletLastClaimAt: address ? claims.last : null,
          walletNextClaimAt: next,
        };
      }
      let wallet = null;
      if (address) {
        const w = await volume(address);
        const recent = await page("SELECT * FROM v_fills", { limit: "10" }, " AND account=$2", [address], fillMap);
        wallet = { address: req.query.address, fills: w.fills, sharesVolume: w.sharesVolume, recent: recent.items };
      }
      return {
        indexedBlock: BigInt(cursor[0]?.lastBlock ?? 0),
        fills: total.fills,
        byKind: total.byKind,
        sharesVolume: total.sharesVolume,
        byAsset: [...total.assets].map(([asset, v]) => ({
          asset,
          fills: v.fills,
          sharesVolume: v.sharesVolume,
          feesEarnedShares: tokens
            .filter((t) => underlying(t.address) === asset)
            .reduce((s, t) => s + t.shares, 0n),
        })),
        feesEarned: { totalShares: tokens.reduce((s, t) => s + t.shares, 0n), tokens },
        protocolFees: {
          totalShares: protocolTokens.reduce((s, t) => s + t.shares, 0n),
          tokens: protocolTokens,
        },
        faucet,
        wallet,
      };
    },
    "StatsQuery",
  );
  get(
    "/batches/:batchId",
    "BatchDetailResponse",
    async (req) => {
      const id = checked("UInt", req.params.batchId),
        dk = darkForQuery(req.query.asset),
        args = [d.chainId, id, dk.hook.toLowerCase()];
      const batch = (
        await sql("SELECT * FROM v_dark_batches WHERE chain_id=$1 AND batch_id=$2 AND contract=$3", args)
      )[0];
      if (!batch) throw fault("NOT_FOUND", "Unknown batch");
      return {
        batch: (await enrichBatches([{ ...selectFields(batch, batchFields), contract: batch.contract }], await block()))[0],
        orders: (await sql("SELECT * FROM v_dark_orders WHERE chain_id=$1 AND batch_id=$2 AND contract=$3", args)).map(orderMap),
        fills: (await sql("SELECT * FROM v_fills WHERE chain_id=$1 AND batch_id=$2 AND dark_contract=$3", args)).map(fillMap),
        skippedResiduals: await sql(
          "SELECT trader,reason,tx_hash FROM dark_residual_skips WHERE chain_id=$1 AND batch_id=$2 AND contract=$3",
          args,
        ),
      };
    },
    "AssetQuery",
  );
  get(
    "/inventory/changes",
    "InventoryChangesResponse",
    async (req) =>
      page(
        `SELECT chain_id,block_number,log_index,block_timestamp,tx_hash,currency,actor,delta,inventory_after,CASE reason WHEN 0 THEN 'DEPOSIT' WHEN 1 THEN 'WITHDRAW' WHEN 2 THEN 'FILL_IN' ELSE 'FILL_OUT' END AS kind FROM parity_inventory_changes UNION ALL SELECT chain_id,block_number,log_index,block_timestamp,tx_hash,currency,recipient,-amount,NULL,'FEE_SWEEP' FROM parity_fee_sweeps`,
        req.query,
        "",
        [],
        (r) =>
          selectFields(
            { ...r, timestamp: r.blockTimestamp },
            "kind currency actor delta inventoryAfter blockNumber timestamp txHash logIndex",
          ),
      ),
    "PageQuery",
  );
  get(
    "/eligibility/:address",
    "EligibilityResponse",
    async (req) => {
      checked("Address", req.params.address);
      return eligibility(
        req.params.address,
        req.query.attestationUid,
        "eligibility",
        await block(),
      );
    },
    "EligibilityQuery",
  );
  get("/status", "CrankStatusResponse", async () => {
    const port = process.env.CRANK_HEALTH_PORT;
    if (!port) throw fault("CHAIN_UNAVAILABLE", "CRANK_HEALTH_PORT required");
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw fault("CHAIN_UNAVAILABLE", "Crank unavailable");
    return r.json();
  });
  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", message: "Unknown route" } }),
  );
  app.setErrorHandler((e: any, req, reply) => {
    const code = [
      "BAD_REQUEST",
      "NOT_FOUND",
      "CHAIN_UNAVAILABLE",
      "DB_UNAVAILABLE",
      "INTERNAL",
    ].includes(e.code)
      ? e.code
      : "INTERNAL";
    reply
      .status(e.statusCode ?? 500)
      .send(output("ErrorResponse", { error: { code, message: e.message } }));
  });
}
