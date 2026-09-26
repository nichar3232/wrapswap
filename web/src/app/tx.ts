import { useCallback, useRef, useState } from "react";
import type { Hash } from "viem";
import { WalletError } from "../wallet";

export type TxState<R = unknown> =
  | { step: "idle" }
  | { step: "signing"; label: string }
  | { step: "pending"; label: string; hash: Hash; simulated: boolean }
  | { step: "confirmed"; label: string; hash?: Hash; simulated: boolean; result: R }
  | { step: "failed"; label: string; reason: string; hash?: Hash };

/** Contract custom errors and wallet codes, in plain words. Order matters: first match wins. */
const REASONS: [RegExp, string][] = [
  [/4001|user rejected|user denied|rejected the request|denied transaction/i, "You rejected the request in your wallet. Nothing was sent."],
  [/TooLittleReceived|slippage|amountOutMin/i, "The price moved past your 0.5% slippage limit before the swap landed. Retry to requote."],
  [/PegGuardTripped|peg/i, "Peg guard: the pool drifted more than 50 bps from NAV parity, so conversions are paused until it recovers."],
  [/InsufficientInventory/i, "Hook inventory is short for this size. Try a smaller amount, or retry to route it through the pool."],
  [/DeadlineExpired/i, "The quote expired before the transaction confirmed. Retry to requote."],
  [/closed|off-?hours/i, "The off-hours fee changed while you were signing. Review the wider fee and retry."],
  [/WrongChain/i, "Your wallet is on another network. Switch to Unichain Sepolia and retry."],
  [/insufficient funds|exceeds balance|transfer amount exceeds/i, "Not enough balance (or ETH for gas) in this wallet."],
  [/Ineligible|eligib|Unauthorized|SwapperMismatch/i, "This wallet isn't eligible for issuer conversions (no valid attestation)."],
  [/WrongPhase/i, "The batch moved to its next phase. Refresh the batch and try the current step."],
  [/OracleStale/i, "The oracle midpoint is stale, so settlement is paused until the next update."],
  [/AlreadyCommitted|AlreadyRevealed|AlreadySettled/i, "That step is already done for this batch."],
  [/CommitNotAccepted/i, "The commit wasn't accepted. Your funded tokens stay in escrow; check eligibility and retry."],
  [/RevealNotValid|CommitMismatch/i, "The reveal didn't match your commitment. Keep this browser's saved order and retry."],
  [/BatchNotSettleable/i, "This batch can't settle yet. Wait for the settle window."],
  [/NoRouter/, "Conversions are unavailable on this deployment (no WrapSwapRouter)."],
  [/timeout|network|fetch|RPC/i, "The network didn't respond. Check your connection and retry."],
];

export function humanize(e: unknown): string {
  if (e instanceof WalletError)
    return e.kind === "no-wallet"
      ? "No browser wallet found. Install MetaMask (or another injected wallet) to sign."
      : "Your wallet didn't return an account. Unlock it and retry.";
  const parts: string[] = [];
  const walk = (x: unknown, depth = 0) => {
    if (!x || depth > 5) return;
    if (typeof x === "string") return void parts.push(x);
    const o = x as Record<string, unknown>;
    for (const k of ["code", "name", "message", "shortMessage", "details", "reason", "errorName"])
      if (o[k] !== undefined) parts.push(String(o[k]));
    const data = o.data as Record<string, unknown> | undefined;
    if (data?.errorName) parts.push(String(data.errorName));
    walk(o.cause, depth + 1);
    walk(o.error, depth + 1);
    walk(data?.originalError, depth + 1);
  };
  walk(e);
  const text = parts.join(" ");
  for (const [re, reason] of REASONS) if (re.test(text)) return reason;
  return "The transaction didn't go through. Nothing was lost; please retry.";
}

type Runner<R> = (onHash: (hash: Hash) => void) => Promise<{ hash?: Hash; simulated: boolean; result: R }>;

/** Signing → pending (with hash) → confirmed | failed, with retry of the last action. */
export function useTx<R = unknown>() {
  const [state, setState] = useState<TxState<R>>({ step: "idle" });
  const last = useRef<{ label: string; run: Runner<R> } | null>(null);
  const run = useCallback(async (label: string, fn: Runner<R>) => {
    last.current = { label, run: fn };
    setState({ step: "signing", label });
    let hash: Hash | undefined;
    try {
      const out = await fn((h) => {
        hash = h;
        setState({ step: "pending", label, hash: h, simulated: false });
      });
      setState({ step: "confirmed", label, hash: out.hash ?? hash, simulated: out.simulated, result: out.result });
      return out.result;
    } catch (e) {
      console.warn(`[${label}]`, e);
      setState({ step: "failed", label, reason: humanize(e), hash });
      return undefined;
    }
  }, []);
  const retry = useCallback(() => {
    if (last.current) void run(last.current.label, last.current.run);
  }, [run]);
  const reset = useCallback(() => setState({ step: "idle" }), []);
  const busy = state.step === "signing" || state.step === "pending";
  return { state, run, retry, reset, busy };
}
