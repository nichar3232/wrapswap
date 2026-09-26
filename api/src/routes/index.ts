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
  parseAbi,
  keccak256,
  encodeAbiParameters,
  toHex,
} from "viem";
import { chainReader, publicClient } from "../chain/client.js";
import { permitsDarkFallback, routeErrors } from "../chain/reverts.js";
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
  ...f,
  basePips: Number(f.basePips),
  skewPips: Number(f.skewPips),
  closedPips: Number(f.closedPips),
  totalPips: Number(f.totalPips),
  totalBps: canonical.pipsToBps(f.totalPips),
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
  const client = new Proxy(chainClient, {
    get(target, key) {
      const value = target[key];
      return typeof value === "function"
        ? async (...args: any[]) => {
            try {
              return await value.apply(target, args);
            } catch (e) {
              throw Object.assign(fault("CHAIN_UNAVAILABLE", String(e)), {
                cause: e,
              });
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
  const token = async (address: string, b: any) => {
    const t = d.tokens.find((t) => eq(t.address, address))!;
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
  const quote = async (q: any, b: any) => {
    if (
      eq(q.tokenIn, q.tokenOut) ||
      ![q.tokenIn, q.tokenOut].every((a) =>
        d.tokens.some((t) => eq(t.address, a)),
      )
    )
      throw fault("NOT_FOUND", "Unknown token pair");
    const kind = q.kind ?? "exactIn",
      amountSpecified = BigInt(q.amount) * (kind === "exactIn" ? -1n : 1n),
      zeroForOne = eq(q.tokenIn, d.pool.key.currency0);
    const result = await read(
      "parityHook",
      "quote",
      [d.pool.key, zeroForOne, amountSpecified],
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
    return {
      block: b.number,
      poolId: d.pool.id,
      tokenIn: q.tokenIn,
      tokenOut: q.tokenOut,
      kind,
      zeroForOne,
      amountSpecified,
      ...result,
      feeToken: q.tokenOut,
      fee: fee(result.fee),
    };
  };
  const current = async (b: any) => {
    const [batchId, phase, phaseEndsBlock] = await read(
      "darkCrossHook",
      "currentBatch",
      [],
      b.number,
    );
    const participants = await read(
      "darkCrossHook",
      "participants",
      [batchId],
      b.number,
    );
    let oracle: any = { midX18: null, updatedAt: null, stale: true };
    try {
      const [mid, age] = await Promise.all([
        rawRead(
          "oracle",
          "getMid",
          [d.dark.baseToken, d.dark.quoteToken],
          b.number,
        ),
        read("darkCrossHook", "ORACLE_MAX_AGE", [], b.number),
      ]);
      oracle = {
        midX18: mid[0],
        updatedAt: mid[1],
        stale: b.timestamp - mid[1] > BigInt(age),
      };
    } catch (e) {
      if (!String(e).includes("NoPrice")) throw e;
    }
    return {
      batchId,
      phase: phases[Number(phase)],
      phaseEndsBlock,
      blockNumber: b.number,
      batchOrigin: d.dark.batchOrigin,
      participants: participants.length,
      oracle,
    };
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
  const batchSource = `SELECT b.*, p.block_number,p.log_index FROM v_dark_batches b JOIN LATERAL (SELECT block_number,log_index FROM raw_logs r WHERE r.chain_id=b.chain_id AND r.event_name IN ('Committed','BatchSettled') AND r.args->>'batchId'=b.batch_id::text ORDER BY block_number DESC,log_index DESC LIMIT 1) p ON true`;
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
      maxFeePips: 2500,
      formula: "min(200 + ceil(1300*|skew|) + (closed && |skew| grows ? ceil(1500*|postTradeSkew|) : 0), 2500) pips",
    };
  });
  get("/inventory", "InventoryResponse", async () => {
    const b = await block(),
      f = fee(await read("parityHook", "feeBreakdown", [d.pool.key], b.number));
    const tokens = await Promise.all(
      [d.pool.key.currency0, d.pool.key.currency1].map(async (address) => {
        const t = d.tokens.find((t) => eq(t.address, address))!;
        const [inventory, inventoryShares, feesAccrued] = await Promise.all(
          ["inventory", "inventoryShares", "feesAccrued"].map((fn) =>
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
      const quoter = parseAbi([
        `function ${exact ? "quoteExactInputSingle" : "quoteExactOutputSingle"}(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amount,uint256 gasEstimate)`,
      ]);
      try {
        const sim = await client.simulateContract({
          address: d.contracts.quoter,
          abi: [...quoter, ...routeErrors],
          functionName: exact
            ? "quoteExactInputSingle"
            : "quoteExactOutputSingle",
          args: [
            {
              poolKey: d.pool.key,
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
        if (!permitsDarkFallback(error))
          throw fault("CHAIN_UNAVAILABLE", String(error));
        if (q.allowDark === "false")
          return { ...result, route: "BLOCKED-PEG", reason: "PEG_GUARD" };
        const c = await current(b);
        return {
          ...result,
          route: "DARK",
          dark: {
            batchId: c.batchId,
            phase: c.phase,
            phaseEndsBlock: c.phaseEndsBlock,
            oracleMidX18: c.oracle.midX18,
            sellBase: eq(q.tokenIn, d.dark.baseToken),
          },
        };
      }
    },
    "RouteQuery",
  );
  get("/nyse", "NyseResponse", async () => {
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
      closedFeePips: Number(canonical.OFF_HOURS_MAX_FEE_PIPS), // max off-hours premium (skew-increasing trades only)
      source: "chain",
    };
  });
  get("/batches/current", "CurrentBatchResponse", async () =>
    current(await block()),
  );
  get(
    "/batches",
    "BatchListResponse",
    async (req) => {
      const settled = req.query.settled;
      return page(
        batchSource,
        req.query,
        settled ? " AND settled=$2" : "",
        settled ? [settled === "true"] : [],
        (r) => selectFields(r, batchFields),
      );
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
    const pools: any[] = (d as any).pools ?? [d.pool];
    const names = [...new Set(d.tokens.map((t) => t.underlying))];
    return {
      network: d.network,
      chainId: d.chainId,
      block: b.number,
      assets: await Promise.all(
        names.map(async (asset) => {
          const tokens = d.tokens.filter((t) => t.underlying === asset);
          const mine = (a: string) => tokens.some((t) => eq(t.address, a));
          const platforms = await Promise.all(
            tokens.map(async (t) => {
              const live = await token(t.address, b);
              return {
                issuer: t.issuer,
                symbol: t.symbol,
                name: t.name,
                address: t.address,
                decimals: t.decimals,
                adapter: t.adapter,
                adapterKind: t.adapterKind,
                sharesPerTokenX18: live.sharesPerTokenX18,
                healthy: live.healthy,
                mock: t.mock,
              };
            }),
          );
          return {
            asset,
            platforms,
            pools: pools
              .filter((p) => mine(p.key.currency0) && mine(p.key.currency1))
              .map((p) => ({ poolId: p.id, ...p.key })),
            darkCross:
              mine(d.dark.baseToken) && mine(d.dark.quoteToken)
                ? {
                    hook: d.contracts.darkCrossHook,
                    baseToken: d.dark.baseToken,
                    quoteToken: d.dark.quoteToken,
                    batchBlocks: d.dark.batchBlocks,
                  }
                : null,
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
        d.tokens.find((t) => eq(t.address, tokenAddress))?.underlying ?? "UNKNOWN";
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
          const t = d.tokens.find((t) => eq(t.address, r.tokenOut))!;
          const amount = BigInt(r.amount);
          return { symbol: t.symbol, address: t.address, amount, shares: await shares(t.address, amount) };
        }),
      );
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
        wallet,
      };
    },
    "StatsQuery",
  );
  get("/batches/:batchId", "BatchDetailResponse", async (req) => {
    const id = checked("UInt", req.params.batchId),
      args = [d.chainId, id];
    const batch = (
      await sql(
        "SELECT * FROM v_dark_batches WHERE chain_id=$1 AND batch_id=$2",
        args,
      )
    )[0];
    if (!batch) throw fault("NOT_FOUND", "Unknown batch");
    return {
      batch: selectFields(batch, batchFields),
      orders: (
        await sql(
          "SELECT * FROM v_dark_orders WHERE chain_id=$1 AND batch_id=$2",
          args,
        )
      ).map(orderMap),
      fills: (
        await sql(
          "SELECT * FROM v_fills WHERE chain_id=$1 AND batch_id=$2",
          args,
        )
      ).map(fillMap),
      skippedResiduals: await sql(
        "SELECT trader,reason,tx_hash FROM dark_residual_skips WHERE chain_id=$1 AND batch_id=$2",
        args,
      ),
    };
  });
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
