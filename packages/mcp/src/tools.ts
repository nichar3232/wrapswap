import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ApiError, UnisonApi, errorMessage } from "./api.js";
import { SHARE_DECIMALS, bps, formatUnits, parseUnits, shares, tokensForShares } from "./units.js";

/** Largest amount the demo relay executes per call, in canonical shares. Enforced here before any POST. */
export const RELAY_CAP_SHARES = 100;
export const EXPLORER = "https://sepolia.uniscan.xyz";

export type ToolResult = { summary: string; data: unknown };
export type ToolDef<S extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run: (args: z.infer<z.ZodObject<S>>, api: UnisonApi) => Promise<ToolResult>;
};

const asset = z
  .string()
  .min(1)
  .describe('Underlying stock symbol, e.g. "AAPL", "NVDA" or "TSLA" (see list_assets).');
const wrapper = (role: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${role} issuer wrapper of that asset: its token symbol (e.g. "mcbAAPL", "mAAPLx"), its platform ("Coinbase" or "xStocks"), or its token address.`,
    );
const amountShares = z
  .union([z.string(), z.number()])
  .describe('Size in canonical shares of the underlying (1 share = 1 share of the stock; decimals allowed, e.g. "50" or 12.5). Never USD.');
const recipient = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .optional()
  .describe("Optional EVM address that receives the output. Defaults to the relay's demo account.");

// ---------------------------------------------------------------- asset / wrapper resolution

type Platform = {
  platform: string;
  symbol: string;
  address: string;
  decimals: number;
  sharesPerTokenX18: string;
  healthy?: boolean;
};
type Asset = { asset: string; platforms: Platform[]; darkCross?: Record<string, unknown> };

async function assets(api: UnisonApi): Promise<Asset[]> {
  const r = await api.get<any>("/assets");
  return (Array.isArray(r) ? r : r.assets) as Asset[];
}

export async function resolveAsset(api: UnisonApi, symbol: string): Promise<Asset> {
  const all = await assets(api);
  const a = all.find((x) => x.asset.toLowerCase() === symbol.trim().toLowerCase());
  if (!a) throw new Error(`Unknown asset "${symbol}". Available: ${all.map((x) => x.asset).join(", ")}.`);
  return a;
}

export function resolveWrapper(a: Asset, ref: string): Platform {
  const r = ref.trim().toLowerCase();
  const w = a.platforms.find(
    (p) => p.symbol.toLowerCase() === r || p.platform.toLowerCase() === r || p.address.toLowerCase() === r,
  );
  if (!w) {
    const opts = a.platforms.map((p) => `${p.symbol} (${p.platform})`).join(", ");
    throw new Error(`"${ref}" is not a ${a.asset} wrapper. Use one of: ${opts}.`);
  }
  return w;
}

function sharesToTokens(w: Platform, amount: string | number): { sharesRaw: bigint; tokensRaw: bigint } {
  const sharesRaw = parseUnits(amount, SHARE_DECIMALS);
  if (sharesRaw === 0n) throw new Error("Amount must be greater than zero.");
  const tokensRaw = tokensForShares(sharesRaw, BigInt(w.sharesPerTokenX18), w.decimals);
  if (tokensRaw === 0n) throw new Error(`Amount is below one raw unit of ${w.symbol}.`);
  return { sharesRaw, tokensRaw };
}

const txLink = (hash?: string) => (hash ? `${EXPLORER}/tx/${hash}` : undefined);

// ---------------------------------------------------------------- tools

export const listAssets: ToolDef = {
  name: "list_assets",
  title: "List Unison assets and wrappers",
  description:
    "List every stock Unison converts between issuer wrappers (currently AAPL, NVDA, TSLA on Unichain Sepolia). " +
    "For each asset returns its issuer wrappers (platform Coinbase or xStocks, token symbol, address, decimals) and the live " +
    "multiplier: canonical shares per whole token, so 1 token = multiplier shares. Call this first when you do not know the " +
    "exact asset or wrapper names; every other tool takes these names. All sizes in Unison are shares of the stock, never USD.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run(_args, api) {
    const all = await assets(api);
    const data = all.map((a) => ({
      asset: a.asset,
      wrappers: a.platforms.map((p) => ({
        platform: p.platform,
        symbol: p.symbol,
        address: p.address,
        decimals: p.decimals,
        sharesPerToken: formatUnits(p.sharesPerTokenX18, SHARE_DECIMALS),
        healthy: p.healthy ?? true,
      })),
      darkCross: Boolean(a.darkCross),
    }));
    return {
      summary: data.map((a) => `${a.asset}: ${a.wrappers.map((w) => `${w.symbol} (${w.platform}, ×${w.sharesPerToken})`).join(" / ")}`).join("; "),
      data,
    };
  },
};

export const getPool: ToolDef<{ asset: typeof asset }> = {
  name: "get_pool",
  title: "Pool state and cheapest direction",
  description:
    "Read the live conversion pool of one asset: inventory held per wrapper (tokens and shares), inventory skew in %, the fee " +
    "right now in each direction (2 bps base, plus a skew fee only when the conversion deepens the imbalance), cheapDirection " +
    "(the wrapper pair that currently pays only the base fee because it rebalances inventory) and cumulative fees earned by the " +
    "LP. Use it before converting to learn which wrapper is cheapest to convert into, or to show pool health. Shares only, no USD.",
  inputSchema: { asset },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run({ asset: sym }, api) {
    const a = await resolveAsset(api, sym);
    const p = await api.get<any>(`/pool/${encodeURIComponent(a.asset)}`);
    const data = {
      asset: p.asset,
      block: p.block,
      wrappers: p.wrappers.map((w: any) => {
        const meta = a.platforms.find((x) => x.address.toLowerCase() === w.address.toLowerCase());
        return {
          platform: w.platform,
          symbol: w.symbol,
          inventory: meta ? formatUnits(w.inventory, meta.decimals) : w.inventory,
          inventoryShares: shares(w.inventoryShares),
        };
      }),
      totalShares: shares(p.totalShares),
      skewPct: Number(p.skewPct),
      directions: p.directions.map((d: any) => ({
        from: d.from,
        to: d.to,
        baseFee: bps(d.totalPips - d.skewFeePips),
        skewFee: bps(d.skewFeePips),
        totalFee: bps(d.totalPips),
        reducesImbalance: d.reducesImbalance,
      })),
      cheapDirection: p.cheapDirection,
      lpFees: p.lpFees && {
        fills: p.lpFees.fills,
        baseShares: shares(p.lpFees.baseShares),
        skewShares: shares(p.lpFees.skewShares),
        totalShares: shares(p.lpFees.totalShares),
      },
    };
    const cheap = data.directions.find((d: any) => d.from === p.cheapDirection?.from && d.to === p.cheapDirection?.to);
    return {
      summary:
        `${data.asset} skew ${data.skewPct}%` +
        (cheap ? `; cheapest now: ${cheap.from} → ${cheap.to} at ${cheap.totalFee}` : "") +
        `; ${data.directions.map((d: any) => `${d.from}→${d.to} ${d.totalFee}`).join(", ")}`,
      data,
    };
  },
};

export const quoteConvert: ToolDef<{
  asset: typeof asset;
  fromWrapper: ReturnType<typeof wrapper>;
  toWrapper: ReturnType<typeof wrapper>;
  amount: typeof amountShares;
}> = {
  name: "quote_convert",
  title: "Quote a wrapper-to-wrapper conversion",
  description:
    "Quote converting `amount` shares of a stock from one issuer wrapper into another (e.g. AAPL mcbAAPL → mAAPLx), priced " +
    "on-chain by the Unison ParityHook: share for share at the issuers' multipliers, no price risk. Returns sharesOut, the fee split " +
    "(baseFee and skewFee, in shares), youKeep (fraction of shares kept), whether the trade reduces the pool imbalance, and, if " +
    "converting the other way would be cheaper right now, a `cheaperReverse` note. Read-only; call it before convert. If you only " +
    "know the asset and want the cheapest target, call get_pool first.",
  inputSchema: { asset, fromWrapper: wrapper("Source"), toWrapper: wrapper("Target"), amount: amountShares },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run({ asset: sym, fromWrapper, toWrapper, amount }, api) {
    const a = await resolveAsset(api, sym);
    const from = resolveWrapper(a, fromWrapper);
    const to = resolveWrapper(a, toWrapper);
    if (from.address === to.address) throw new Error("fromWrapper and toWrapper are the same wrapper.");
    const { tokensRaw } = sharesToTokens(from, amount);
    const [q, pool] = await Promise.all([
      api.get<any>("/quote", { asset: a.asset, from: from.symbol, to: to.symbol, amount: tokensRaw.toString() }),
      api.get<any>(`/pool/${encodeURIComponent(a.asset)}`),
    ]);
    const reverse = pool.directions?.find((d: any) => d.from === to.symbol && d.to === from.symbol);
    const cheaperReverse =
      reverse && reverse.totalPips < q.fee.totalPips
        ? {
            from: to.symbol,
            to: from.symbol,
            totalFee: bps(reverse.totalPips),
            note: `Converting ${to.symbol} → ${from.symbol} is cheaper right now (${bps(reverse.totalPips)} vs ${bps(q.fee.totalPips)}) because it reduces the pool imbalance.`,
          }
        : undefined;
    const data = {
      asset: a.asset,
      from: from.symbol,
      to: to.symbol,
      sharesIn: shares(q.sharesIn),
      amountIn: `${formatUnits(q.amountIn, from.decimals)} ${from.symbol}`,
      sharesOut: shares(q.sharesOut),
      amountOut: `${formatUnits(q.amountOut, to.decimals)} ${to.symbol}`,
      baseFee: shares(q.baseFee),
      skewFee: shares(q.skewFee),
      totalFee: bps(q.fee.totalPips),
      youKeep: q.youKeep,
      reducesImbalance: q.reducesImbalance,
      postSkewPct: Number((Number(BigInt(q.postSkewX18 ?? q.fee.postSkewX18)) / 1e16).toFixed(2)),
      fillable: q.fillable,
      block: q.block,
      ...(cheaperReverse ? { cheaperReverse } : {}),
    };
    return {
      summary:
        `${data.sharesIn} shares ${from.symbol} → ${data.sharesOut} shares ${to.symbol} (${data.amountOut}); fee ${data.totalFee} ` +
        `(base ${data.baseFee}, skew ${data.skewFee} shares)${data.reducesImbalance ? ", reduces imbalance" : ""}` +
        (cheaperReverse ? `. ${cheaperReverse.note}` : "") +
        (q.fillable === false ? ". Not fillable from inventory right now." : ""),
      data,
    };
  },
};

export const getBatch: ToolDef<{ asset: typeof asset }> = {
  name: "get_batch",
  title: "Dark Cross batch status",
  description:
    "Read the Dark Cross (sealed-bid batch auction) state for one asset: current batch id, phase (COMMIT, REVEAL or SETTLE), seconds " +
    "remaining in the phase, committed participants and the oracle midpoint; plus the last settled batch: midpoint, crossed shares, " +
    "protocol fee (1 bp of crossed volume), residual filled by the conversion pool, and shares refunded unfilled. Use it before " +
    "commit_dark_order to see when an order would settle, or to report a batch result. Shares only.",
  inputSchema: { asset },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run({ asset: sym }, api) {
    const a = await resolveAsset(api, sym);
    const [cur, list] = await Promise.all([
      api.get<any>("/batches/current", { asset: a.asset }),
      api.get<any>("/batches", { asset: a.asset, settled: true }),
    ]);
    const rows = (Array.isArray(list) ? list : list.batches ?? list.items ?? []) as any[];
    const last = rows[0];
    const data = {
      asset: a.asset,
      current: {
        batchId: cur.batchId,
        phase: cur.phase,
        secondsRemaining: cur.secondsRemaining,
        phaseEndsBlock: cur.phaseEndsBlock,
        participants: cur.participants,
        oracleMid: cur.oracle?.midX18 ? formatUnits(cur.oracle.midX18, 18) : undefined,
        oracleStale: cur.oracle?.stale,
      },
      lastSettled: last && {
        batchId: last.batchId,
        midpoint: formatUnits(last.midX18, 18),
        crossedShares: shares(last.crossedShares ?? "0"),
        protocolFeeShares: shares(last.protocolFeeShares ?? "0"),
        residualFilled: (last.residualFilled ?? []).map((r: any) => ({
          trader: r.trader,
          feeShares: shares(r.feeShares ?? "0"),
          txHash: r.txHash,
        })),
        unfilledRefundedShares: shares(last.unfilledRefunded?.shares ?? "0"),
        participants: last.participants,
        settledTx: last.settledTx,
        explorer: txLink(last.settledTx),
      },
    };
    return {
      summary:
        `${a.asset} batch ${cur.batchId} in ${cur.phase}, ${cur.secondsRemaining}s left` +
        (last ? `; last settled #${last.batchId}: ${data.lastSettled.crossedShares} shares crossed at ${data.lastSettled.midpoint}, protocol fee ${data.lastSettled.protocolFeeShares} shares` : "; no settled batch yet"),
      data,
    };
  },
};

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .optional()
  .describe("EVM address to read. Defaults to the demo relay's account (the one convert and commit_dark_order trade from).");

export const getPortfolio: ToolDef<{ address: typeof address }> = {
  name: "get_portfolio",
  title: "Wallet balances and recent fills",
  description:
    "Read one wallet's holdings on Unichain Sepolia: for every asset, its balance of each issuer wrapper in tokens and in canonical " +
    "shares of the stock (at the adapter's live multiplier), the total shares per asset, and the wallet's 10 most recent fills from " +
    "the indexer (Convert, Dark Cross, residual) with shares, fee and a Uniscan link. Omit `address` to read the demo relay's account, " +
    "which is where convert and commit_dark_order output lands by default. Read-only; shares only, never USD.",
  inputSchema: { address },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async run({ address: addr }, api) {
    const who = addr ?? (await api.get<any>("/demo/status")).address;
    const [bal, fills] = await Promise.all([
      api.get<any>(`/balances/${who}`),
      api.get<any>("/fills", { account: who, limit: 10 }),
    ]);
    const tokens = new Map<string, { symbol: string; decimals: number; asset: string }>();
    for (const a of bal.assets) for (const w of a.wrappers) tokens.set(w.address.toLowerCase(), { symbol: w.symbol, decimals: w.decimals, asset: a.asset });
    const amount = (token: string, raw: string) => {
      const t = tokens.get(token.toLowerCase());
      return t ? `${formatUnits(raw, t.decimals, 6)} ${t.symbol}` : raw;
    };
    const data = {
      address: bal.address,
      block: bal.block,
      assets: bal.assets.map((a: any) => ({
        asset: a.asset,
        totalShares: shares(a.wrappers.reduce((s: bigint, w: any) => s + BigInt(w.shares), 0n)),
        wrappers: a.wrappers.map((w: any) => ({
          platform: w.platform,
          symbol: w.symbol,
          address: w.address,
          tokens: formatUnits(w.balance, w.decimals),
          shares: shares(w.shares),
        })),
      })),
      recentFills: (fills.items ?? []).map((f: any) => ({
        kind: f.kind,
        asset: tokens.get(f.tokenIn.toLowerCase())?.asset,
        from: tokens.get(f.tokenIn.toLowerCase())?.symbol ?? f.tokenIn,
        to: tokens.get(f.tokenOut.toLowerCase())?.symbol ?? f.tokenOut,
        amountIn: amount(f.tokenIn, f.amountIn),
        amountOut: amount(f.tokenOut, f.amountOut),
        shares: shares(f.shares),
        fee: bps(f.feePips),
        timestamp: new Date(Number(f.timestamp) * 1000).toISOString(),
        txHash: f.txHash,
        explorer: txLink(f.txHash),
      })),
    };
    return {
      summary:
        `${data.address} at block ${data.block}: ` +
        data.assets.map((a: any) => `${a.asset} ${a.totalShares} sh (${a.wrappers.map((w: any) => `${w.tokens} ${w.symbol}`).join(" + ")})`).join("; ") +
        `; ${data.recentFills.length} recent fill${data.recentFills.length === 1 ? "" : "s"}`,
      data,
    };
  },
};

// ---------------------------------------------------------------- execution (demo relay)

function capCheck(sharesRaw: bigint) {
  if (sharesRaw > parseUnits(RELAY_CAP_SHARES, SHARE_DECIMALS)) {
    throw new Error(`The demo relay executes at most ${RELAY_CAP_SHARES} shares per call; split the order or reduce the amount.`);
  }
}

async function relay(api: UnisonApi, path: string, body: unknown): Promise<any> {
  try {
    return await api.post(path, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error(`The demo relay (${api.base}${path}) is not live yet; read-only tools still work.`);
    }
    if (e instanceof ApiError) throw new Error(`Relay rejected the order: ${errorMessage(e.body) ?? e.message}`);
    throw e;
  }
}

export const convert: ToolDef<{
  asset: typeof asset;
  fromWrapper: ReturnType<typeof wrapper>;
  toWrapper: ReturnType<typeof wrapper>;
  amount: typeof amountShares;
  recipient: typeof recipient;
}> = {
  name: "convert",
  title: "Convert between issuer wrappers (executes)",
  description:
    "Execute a share-for-share conversion on Unichain Sepolia through the Unison demo relay: converts `amount` shares of the source " +
    "wrapper into the target wrapper, delivered to `recipient` if given (else kept by the relay's demo account). " +
    `Max ${RELAY_CAP_SHARES} shares per call; the relay also allows 3 actions per 10 minutes per client. Returns the transaction ` +
    "hash, a Uniscan link, the amount received and the fee split (baseFee, skewFee in shares, from the on-chain quote taken " +
    "immediately before execution). Spends testnet funds: when asked for the cheapest conversion, call get_pool and use its " +
    "cheapDirection, then quote_convert. On failure returns the relay's real reason (limit, revert, slippage).",
  inputSchema: {
    asset,
    fromWrapper: wrapper("Source"),
    toWrapper: wrapper("Target"),
    amount: amountShares,
    recipient,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run({ asset: sym, fromWrapper, toWrapper, amount, recipient: to }, api) {
    const a = await resolveAsset(api, sym);
    const from = resolveWrapper(a, fromWrapper);
    const target = resolveWrapper(a, toWrapper);
    if (from.address === target.address) throw new Error("fromWrapper and toWrapper are the same wrapper.");
    const { sharesRaw, tokensRaw } = sharesToTokens(from, amount);
    capCheck(sharesRaw);
    const tokens = formatUnits(tokensRaw, from.decimals);
    const q = await api.get<any>("/quote", { asset: a.asset, from: from.symbol, to: target.symbol, amount: tokensRaw.toString() });
    const body = { asset: a.asset, from: from.symbol, to: target.symbol, amount: tokens, ...(to ? { recipient: to } : {}) };
    const r = await relay(api, to ? "/demo/send-unichain" : "/demo/convert", body);
    const hash: string | undefined = r.txHash;
    const data = {
      asset: a.asset,
      from: from.symbol,
      to: target.symbol,
      sharesIn: shares(r.sharesIn ?? q.sharesIn),
      amountIn: `${formatUnits(r.amountIn ?? tokensRaw, from.decimals)} ${from.symbol}`,
      received: `${formatUnits(r.quotedOut ?? q.amountOut, target.decimals)} ${target.symbol}`,
      sharesOut: shares(q.sharesOut),
      totalFee: r.feeBps !== undefined ? `${r.feeBps} bps` : bps(q.fee.totalPips),
      baseFee: shares(q.baseFee),
      skewFee: shares(q.skewFee),
      reducesImbalance: q.reducesImbalance,
      feeSplitSource: `on-chain quote at block ${q.block}, immediately before execution`,
      recipient: r.recipient ?? to,
      txHash: hash,
      explorer: txLink(hash),
      approveTx: r.approveTx ?? undefined,
    };
    return {
      summary:
        `Converted ${data.sharesIn} shares ${from.symbol} → ${data.received}: ${hash} (${data.explorer}); ` +
        `fee ${data.totalFee} = base ${data.baseFee} + skew ${data.skewFee} shares`,
      data,
    };
  },
};

const side = z
  .enum(["sell", "buy"])
  .describe(
    'Order side against the asset\'s dark pair: "sell" sells the base (Coinbase) wrapper for the quote (xStocks) wrapper, "buy" sells the quote wrapper for the base wrapper.',
  );

export const commitDarkOrder: ToolDef<{ asset: typeof asset; side: typeof side; amount: typeof amountShares }> = {
  name: "commit_dark_order",
  title: "Commit a sealed Dark Cross order (executes)",
  description:
    "Commit a sealed order to the asset's Dark Cross batch through the Unison demo relay (for the relay's demo account). Opposite " +
    "sides cross at the oracle midpoint for a 1 bp protocol fee and no skew fee; any residual converts through the pool at base + " +
    `skew, and anything the pool cannot fill is refunded. Max ${RELAY_CAP_SHARES} shares per call, 3 relay actions per 10 minutes. ` +
    "The relay sets a limit 0.2% through the mid and reveals automatically; the crank settles. Returns the commit transaction, " +
    "batch id and the block/seconds until settlement; follow up with get_batch. Use convert instead for immediate execution.",
  inputSchema: { asset, side, amount: amountShares },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run({ asset: sym, side: s, amount }, api) {
    const a = await resolveAsset(api, sym);
    const dc = (a.darkCross ?? {}) as { baseToken?: string; quoteToken?: string; batchBlocks?: number | string };
    if (!dc.baseToken) throw new Error(`${a.asset} has no Dark Cross.`);
    const base = resolveWrapper(a, dc.baseToken);
    const quote = resolveWrapper(a, dc.quoteToken!);
    const lock = s === "sell" ? base : quote;
    const { sharesRaw, tokensRaw } = sharesToTokens(lock, amount);
    capCheck(sharesRaw);
    const r = await relay(api, "/demo/dark-commit", { asset: a.asset, from: lock.symbol, amount: formatUnits(tokensRaw, lock.decimals) });
    const cur = await api.get<any>("/batches/current", { asset: a.asset }).catch(() => undefined);
    const batchBlocks = BigInt(dc.batchBlocks ?? 20);
    const settlesAtBlock =
      cur?.batchOrigin !== undefined && r.batchId !== undefined
        ? BigInt(cur.batchOrigin) + (BigInt(r.batchId) + 1n) * batchBlocks - 2n // settle phase: last 2 blocks of the batch
        : undefined;
    const data = {
      asset: a.asset,
      side: s,
      sells: lock.symbol,
      shares: shares(r.sharesIn ?? sharesRaw),
      batchId: r.batchId,
      limitPrice: r.limitPriceX18 ? formatUnits(r.limitPriceX18, 18) : undefined,
      commitTx: r.txHash,
      explorer: txLink(r.txHash),
      fundTx: r.fundTx ?? undefined,
      reveal: r.reveal,
      settlesAtBlock: settlesAtBlock?.toString(),
      settlesInSeconds:
        settlesAtBlock !== undefined && cur?.blockNumber !== undefined
          ? Math.max(Number(settlesAtBlock - BigInt(cur.blockNumber)), 0) // Unichain Sepolia: ~1 s blocks
          : undefined,
    };
    return {
      summary:
        `Committed ${data.shares} shares (${s}: sells ${lock.symbol}) to ${a.asset} Dark Cross batch ${data.batchId}: ${data.commitTx}` +
        (data.settlesInSeconds !== undefined ? `; settles at block ${data.settlesAtBlock} (~${data.settlesInSeconds}s)` : ""),
      data,
    };
  },
};

// ---------------------------------------------------------------- registry

/** send_confidential is registered only when the Sui lane's status file starts with GO (and the relay serves it). */
export function suiGo(path = process.env.UNISON_SUI_STATUS || join(homedir(), "wrapswap-run/status/sui.md")): boolean {
  try {
    return /^GO\b/.test(readFileSync(path, "utf8").split("\n", 1)[0].trim());
  } catch {
    return false;
  }
}

export const readTools: ToolDef<any>[] = [listAssets, getPool, quoteConvert, getBatch, getPortfolio];
export const executionTools: ToolDef<any>[] = [convert, commitDarkOrder];

export function allTools(extra: ToolDef<any>[] = []): ToolDef<any>[] {
  return [...readTools, ...executionTools, ...extra];
}
