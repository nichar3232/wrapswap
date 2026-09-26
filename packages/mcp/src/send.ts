import { z } from "zod";
import { type ToolDef, EXPLORER, RELAY_CAP_SHARES, resolveAsset, resolveWrapper } from "./tools.js";
import { ApiError, errorMessage } from "./api.js";
import { SHARE_DECIMALS, formatUnits, parseUnits, shares } from "./units.js";

/**
 * send_confidential: a Sui confidential transfer of shares, settled back to Unichain in the recipient's chosen wrapper.
 * Registered only when ~/wrapswap-run/status/sui.md starts with GO AND the relay's POST /demo/send is the Sui path
 * (SEND_IS_SUI below, flipped once the relay ships it).
 */
export const SEND_IS_SUI = false;

const suiscan = (digest?: string) => (digest ? `https://suiscan.xyz/testnet/tx/${digest}` : undefined);
const uniscan = (hash?: string) => (hash ? `${EXPLORER}/tx/${hash}` : undefined);

const inputSchema = {
  asset: z.string().min(1).describe('Underlying stock symbol, e.g. "AAPL" (see list_assets).'),
  amount: z
    .union([z.string(), z.number()])
    .describe("Shares of the stock to send (decimals allowed). Never USD."),
  recipient: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe("Recipient EVM address on Unichain Sepolia that withdraws the shares."),
  withdrawWrapper: z
    .string()
    .min(1)
    .describe('Issuer wrapper the recipient receives on withdrawal: symbol ("mAAPLx"), platform ("xStocks") or address. A different issuer than the sender\'s pays the normal conversion fee.'),
};

export const sendConfidentialTool: ToolDef<typeof inputSchema> = {
  name: "send_confidential",
  title: "Send shares confidentially (Sui, executes)",
  description:
    "Send `amount` shares of a stock to a recipient privately: the relay deposits into the ShareVault on Unichain, the transfer " +
    "happens on Sui as a sealed (Seal/Walrus) batch so amounts and counterparties are not public, and the recipient withdraws on " +
    "Unichain into the issuer wrapper of their choice (`withdrawWrapper`). The Sui transfer itself is fee-free; withdrawing into a " +
    `different issuer's wrapper pays the normal conversion fee. Max ${RELAY_CAP_SHARES} shares per call, 3 relay actions per 10 minutes. ` +
    "Returns the deposit transaction, the Sui transaction and the withdrawal status. Use convert for a plain public conversion.",
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run({ asset: sym, amount, recipient, withdrawWrapper }, api) {
    const a = await resolveAsset(api, sym);
    const out = resolveWrapper(a, withdrawWrapper);
    const sharesRaw = parseUnits(amount, SHARE_DECIMALS);
    if (sharesRaw === 0n) throw new Error("Amount must be greater than zero.");
    if (sharesRaw > parseUnits(RELAY_CAP_SHARES, SHARE_DECIMALS)) {
      throw new Error(`The demo relay executes at most ${RELAY_CAP_SHARES} shares per call; reduce the amount.`);
    }
    let r: any;
    try {
      r = await api.post("/demo/send", {
        asset: a.asset,
        shares: formatUnits(sharesRaw, SHARE_DECIMALS),
        recipient,
        withdrawWrapper: out.symbol,
      });
    } catch (e) {
      if (e instanceof ApiError) throw new Error(`Relay rejected the send: ${errorMessage(e.body) ?? e.message}`);
      throw e;
    }
    const data = {
      asset: a.asset,
      shares: shares(sharesRaw),
      recipient,
      withdrawWrapper: out.symbol,
      depositTx: r.depositTx ?? r.txHash,
      depositExplorer: uniscan(r.depositTx ?? r.txHash),
      suiTx: r.suiDigest ?? r.suiTx,
      suiExplorer: suiscan(r.suiDigest ?? r.suiTx),
      withdrawTx: r.withdrawTx,
      withdrawExplorer: uniscan(r.withdrawTx),
      status: r.status,
    };
    return {
      summary: `Sent ${data.shares} ${a.asset} shares confidentially to ${recipient} (withdraw as ${out.symbol}); deposit ${data.depositTx}` +
        (data.suiTx ? `, Sui ${data.suiTx}` : "") + (data.withdrawTx ? `, withdraw ${data.withdrawTx}` : ""),
      data,
    };
  },
};

export const sendConfidential: ToolDef<any> | undefined = SEND_IS_SUI ? sendConfidentialTool : undefined;
