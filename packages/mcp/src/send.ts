import { z } from "zod";
import { type ToolDef, RELAY_CAP_SHARES, resolveAsset, resolveWrapper } from "./tools.js";
import { ApiError, errorMessage } from "./api.js";
import { SHARE_DECIMALS, formatUnits, parseUnits, shares, tokensForShares } from "./units.js";

/**
 * send_confidential: the relay's POST /demo/send, the Sui confidential path (ShareVault deposit on Unichain → sealed pay
 * on Sui → sealed withdraw into the OTHER issuer's wrapper, settled on Unichain by the keeper). Registered only when
 * ~/wrapswap-run/status/sui.md starts with GO (registry.ts).
 */
const inputSchema = {
  asset: z.string().min(1).describe('Underlying stock symbol. Unison Pay (the ShareVault) currently holds "AAPL" only.'),
  amount: z
    .union([z.string(), z.number()])
    .describe("Shares of the stock to send (decimals allowed). Never USD."),
  recipient: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("Recipient EVM address on Unichain Sepolia; receives the withdrawn wrapper."),
  withdrawWrapper: z
    .string()
    .min(1)
    .describe(
      'Issuer wrapper the recipient receives: symbol ("mAAPLx"), platform ("xStocks") or address. The relay deposits the OTHER wrapper of the asset, so the withdrawal crosses issuers and pays the normal conversion fee.',
    ),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(120)
    .optional()
    .describe("How long to follow the send before returning (default 30). The full flow takes a few minutes; the result includes a tracking URL."),
};

type Step = { step: string; chain: string; tx?: string; url?: string };
type Job = {
  id: string;
  status: string;
  asset: string;
  from: string;
  to: string;
  amountIn: string;
  shares: string;
  recipient: string;
  depositTx: string;
  steps: Step[];
  error?: string;
  settledAmountOut?: string;
  track?: string;
};
const DONE = new Set(["settled", "skipped", "failed"]);

export const sendConfidential: ToolDef<typeof inputSchema> = {
  name: "send_confidential",
  title: "Send shares confidentially via Sui (executes)",
  description:
    "Send `amount` shares of a stock to a recipient privately. The relay deposits one issuer's wrapper into the Unison ShareVault " +
    "on Unichain, pays the recipient on Sui with a sealed (Seal/Walrus) instruction so amount and counterparty are not public, then " +
    "withdraws on Unichain into `withdrawWrapper` (the other issuer) for the recipient. The Sui transfer is fee-free; the cross-issuer " +
    `withdrawal pays the normal conversion fee. AAPL only for now; max ${RELAY_CAP_SHARES} shares; one send at a time (BUSY otherwise). ` +
    "Returns the deposit transaction and each step so far (Unichain and Sui links) plus a tracking URL; the whole flow takes a few " +
    "minutes. Use convert with a recipient for a plain public transfer.",
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run({ asset: sym, amount, recipient, withdrawWrapper, waitSeconds }, api) {
    const a = await resolveAsset(api, sym);
    const to = resolveWrapper(a, withdrawWrapper);
    const from = a.platforms.find((p) => p.address.toLowerCase() !== to.address.toLowerCase());
    if (!from) throw new Error(`${a.asset} has no second issuer wrapper to send from.`);
    const sharesRaw = parseUnits(amount, SHARE_DECIMALS);
    if (sharesRaw === 0n) throw new Error("Amount must be greater than zero.");
    if (sharesRaw > parseUnits(RELAY_CAP_SHARES, SHARE_DECIMALS)) {
      throw new Error(`The demo relay executes at most ${RELAY_CAP_SHARES} shares per call; reduce the amount.`);
    }
    const tokensRaw = tokensForShares(sharesRaw, BigInt(from.sharesPerTokenX18), from.decimals);
    if (tokensRaw === 0n) throw new Error(`Amount is below one raw unit of ${from.symbol}.`);
    let job: Job;
    try {
      job = await api.post<Job>("/demo/send", {
        asset: a.asset,
        from: from.symbol,
        to: to.symbol,
        amount: formatUnits(tokensRaw, from.decimals),
        recipient,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Error("The relay's confidential send (/demo/send) is not live.");
      if (e instanceof ApiError) throw new Error(`Relay rejected the send: ${errorMessage(e.body) ?? e.message}`);
      throw e;
    }
    const track = `${api.base}${job.track ?? `/demo/send/${job.id}`}`;
    const deadline = Date.now() + (waitSeconds ?? 30) * 1000;
    while (!DONE.has(job.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        job = { ...job, ...(await api.get<Job>(`/demo/send/${encodeURIComponent(job.id)}`)) };
      } catch {
        break; // keep what we have; the tracking URL still works
      }
    }
    const data = {
      id: job.id,
      status: job.status,
      asset: a.asset,
      sends: `${formatUnits(tokensRaw, from.decimals)} ${from.symbol}`,
      shares: shares(sharesRaw),
      withdrawWrapper: to.symbol,
      recipient: job.recipient ?? recipient,
      depositTx: job.depositTx,
      steps: job.steps?.map((s) => ({ step: s.step, chain: s.chain, tx: s.tx, url: s.url })) ?? [],
      settledAmountOut: job.settledAmountOut !== undefined ? `${formatUnits(job.settledAmountOut, to.decimals)} ${to.symbol}` : undefined,
      error: job.error,
      track,
    };
    const done = DONE.has(job.status);
    return {
      summary:
        `Confidential send ${job.id}: ${data.shares} ${a.asset} shares to ${data.recipient} as ${to.symbol}; status ${job.status}` +
        ` (${data.steps.length} steps; deposit ${job.depositTx})` +
        (data.settledAmountOut ? `; recipient received ${data.settledAmountOut}` : "") +
        (done ? "" : `; still in progress, track at ${track}`),
      data,
    };
  },
};
