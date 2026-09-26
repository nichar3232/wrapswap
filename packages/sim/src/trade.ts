// One real Convert on the fork: ParityHook quote → WrapSwapRouter.swapExactIn(recipient) → decoded Converted and
// InventoryFill. Shared by the verification run and the market simulation.
import { maxUint256, type Address, type Hex } from "viem";
import { abi, call, events, read, send, PARITY_HOOK, ROUTER, type Asset, type Wrapper } from "./chain.js";

export type Quote = {
  fillable: boolean;
  amountIn: bigint;
  amountOut: bigint;
  grossOut: bigint;
  shares: bigint;
  feeAmount: bigint;
  fee: { basePips: number; skewPips: number; totalPips: number; skewX18: bigint; postSkewX18: bigint; reducesImbalance: boolean };
};
export type ConvertResult = {
  txHash: Hex;
  block: bigint;
  quote: Quote;
  converted: { amountIn: bigint; sharesOut: bigint; baseFee: bigint; skewFee: bigint; postSkew: bigint; recipient: Address; sender: Address };
  fill: { amountIn: bigint; amountOut: bigint; shares: bigint; feeAmount: bigint; feePips: number };
};

const approved = new Set<string>();
export async function approveOnce(owner: Address, token: Address, spender: Address) {
  const k = `${owner}:${token}:${spender}`;
  if (approved.has(k)) return;
  await send(owner, token, abi.erc20, "approve", [spender, maxUint256]);
  approved.add(k);
}

export const zeroForOneOf = (a: Asset, from: Wrapper) => from.token === a.key.currency0;

export async function quoteConvert(a: Asset, from: Wrapper, amountIn: bigint): Promise<Quote> {
  return read<Quote>(PARITY_HOOK, abi.hook, "quote", [a.key, zeroForOneOf(a, from), -amountIn]);
}

export async function convert(a: Asset, trader: Address, from: Wrapper, amountIn: bigint, recipient: Address = trader): Promise<ConvertResult> {
  await approveOnce(trader, from.token, ROUTER);
  const zeroForOne = zeroForOneOf(a, from);
  const quote = await quoteConvert(a, from, amountIn);
  const receipt = await call(trader, ROUTER, abi.router, "swapExactIn", [
    {
      key: a.key,
      zeroForOne,
      amountIn,
      amountOutMin: quote.amountOut,
      recipient,
      deadline: 2n ** 40n,
      hookData: "0x",
    },
  ]);
  const ev = events(receipt.logs, abi.hook, PARITY_HOOK);
  const c = ev.find((e) => e.eventName === "Converted");
  const f = ev.find((e) => e.eventName === "InventoryFill");
  if (!c || !f) throw Error(`convert ${receipt.transactionHash}: no Converted/InventoryFill (fall-through?)`);
  return { txHash: receipt.transactionHash, block: receipt.blockNumber, quote, converted: c.args, fill: f.args };
}
