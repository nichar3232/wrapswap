import { useCallback, useRef, useState } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  parseAbi,
  type Abi,
  type Hash,
  type Hex,
} from "viem";
import { abis } from "@wrapswap/types";
import { duration } from "../lib/format";
import { RelayError } from "../relay";
import { WalletError } from "../wallet";

export type TxState<R = unknown> =
  | { step: "idle" }
  | { step: "signing"; label: string }
  | { step: "pending"; label: string; hash: Hash; simulated: boolean }
  | { step: "confirmed"; label: string; hash?: Hash; simulated: boolean; result: R }
  | { step: "failed"; label: string; reason: string; hash?: Hash };

/** Contract custom errors (by decoded name) in plain words. Unknown errors are shown by their own name. */
const ERRORS: Record<string, string> = {
  TooLittleReceived: "The output fell below your 0.5% minimum before the swap landed. Retry to requote.",
  PegGuardTripped: "Peg guard: the pool drifted more than 50 bps from NAV parity, so conversions are paused until it recovers.",
  InsufficientInventory: "Hook inventory is short for this size. Try a smaller amount.",
  DeadlineExpired: "The quote expired before the transaction confirmed. Retry to requote.",
  NotEligible: "This wallet isn't eligible for issuer conversions (no valid attestation).",
  SwapperMismatch: "The swapper in the hook data doesn't match this wallet.",
  WrongPhase: "The batch moved to its next phase. Refresh the batch and try the current step.",
  OracleStale: "The oracle midpoint is older than 30 minutes, so settlement waits for the next update.",
  AlreadyCommitted: "This wallet already has an order in this batch.",
  AlreadyRevealed: "This order is already revealed.",
  AlreadySettled: "This batch is already settled.",
  UnknownCommit: "No sealed order from this wallet in this batch.",
  BatchFull: "This batch is full. Commit in the next batch.",
  BatchNotSettleable: "This batch can't settle yet. Wait for the settle window.",
  CommitMismatch: "The reveal didn't match your commitment. Keep this browser's saved order and retry.",
  InsufficientEscrow: "Not enough funded balance in the Dark Cross escrow.",
  ResidualBelowMinOut: "The residual couldn't fill at your limit, so it stays in escrow.",
  AdapterUnhealthy: "An issuer adapter reports unhealthy, so conversions of this wrapper are paused.",
  TokenPaused: "The issuer paused this token.",
  ZeroAmount: "Enter an amount above zero.",
  CooldownActive: "The faucet cooldown hasn't passed yet.",
  ERC20InsufficientBalance: "Not enough token balance in this wallet.",
  ERC20InsufficientAllowance: "The approval hasn't reached the chain yet. Retry in a moment.",
};
/** Failures that happen before or around the contract (wallet, balance, network, our own checks). */
const OTHER: [RegExp, string][] = [
  [/WrongChain/, "Your wallet is on another network. Switch to Unichain Sepolia and retry."],
  [/CommitNotAccepted/, "The commit wasn't accepted (eligibility denied). Your funded tokens stay in escrow."],
  [/RevealNotValid/, "The reveal didn't match your commitment. Keep this browser's saved order and retry."],
  [/NoRouter/, "Conversions are unavailable on this deployment (no WrapSwapRouter)."],
  [/NoRelay/, "The demo signer is unavailable. Connect a wallet to transact."],
  [/insufficient funds for gas|exceeds the balance of the account/i, "Not enough ETH for gas in this wallet."],
  [/transfer amount exceeds balance|ERC20InsufficientBalance/i, "Not enough token balance in this wallet."],
  [/ERC20InsufficientAllowance|allowance/i, "The approval hasn't reached the chain yet. Retry in a moment."],
  [/HTTP request failed|fetch failed|network|timed? ?out/i, "The network didn't respond. Check your connection and retry."],
];

/**
 * Every custom error the deployment can raise (all contract ABIs), plus v4's PoolManager wrapper: a revert inside a
 * hook reaches the router as WrappedError(target, selector, reason, details), with the hook's own error in `reason`.
 */
const ERROR_ABI: Abi = [
  ...Object.values(abis).flatMap((a) => (a as Abi).filter((x) => x.type === "error")),
  ...parseAbi([
    "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
    "error CooldownActive(uint256 secondsRemaining)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  ]),
];
function decodeRaw(data: Hex, depth = 0): { name?: string; text?: string } | undefined {
  try {
    const r = decodeErrorResult({ abi: ERROR_ABI, data });
    if (r.errorName === "WrappedError" && depth < 3) return decodeRaw((r.args as readonly Hex[])[2], depth + 1) ?? { text: "WrappedError" };
    const args = r.args?.length ? `(${r.args.map(String).join(", ")})` : "";
    return { name: r.errorName, text: r.errorName === "Error" ? String(r.args?.[0]) : r.errorName + args };
  } catch {
    return undefined;
  }
}

/** The decoded revert reason of a viem error: custom error name (with args), require() string, or panic. */
export function revertReason(e: unknown): { name?: string; text?: string } | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!reverted) return undefined;
  if (reverted.raw && reverted.raw !== "0x") {
    const decoded = decodeRaw(reverted.raw);
    if (decoded) return decoded;
  }
  if (reverted.data?.errorName) {
    const args = reverted.data.args?.length ? `(${reverted.data.args.map(String).join(", ")})` : "";
    return { name: reverted.data.errorName, text: reverted.data.errorName + args };
  }
  if (reverted.reason) return { text: reverted.reason };
  if (reverted.signature) return { text: `unknown error ${reverted.signature}` };
  return { text: reverted.shortMessage };
}

/** Revert data carried by a raw provider error (e.g. MetaMask: { data: { originalError: { data: "0x…" } } }). */
function providerRevertData(e: unknown, depth = 0): Hex | undefined {
  if (!e || typeof e !== "object" || depth > 5) return undefined;
  const o = e as Record<string, unknown>;
  if (typeof o.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(o.data)) return o.data as Hex;
  for (const k of ["data", "originalError", "error", "cause"]) {
    const found = providerRevertData(o[k], depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function humanize(e: unknown): string {
  if (e instanceof RelayError)
    return e.status === 429
      ? `Demo limit reached: ${e.message}. Next action in ${duration(e.retryAfter ?? 600)}.`
      : e.code === "BUSY"
        ? "One send at a time: the demo relay is already running a Sui send. Retry in a few minutes."
        : e.code === "OVER_LIMIT"
          ? "The demo relay moves at most 100 shares per action."
          : e.code === "UNAVAILABLE"
            ? "The demo relay didn't respond. Retry, or connect a wallet."
            : `The demo relay refused: ${e.message}.`;
  if (e instanceof WalletError)
    return e.kind === "no-wallet"
      ? "No browser wallet found. Install MetaMask (or another injected wallet) to sign."
      : "Your wallet didn't return an account. Unlock it and retry.";
  const code = (e as { code?: unknown })?.code;
  if (
    code === 4001 ||
    (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) ||
    /user rejected|user denied|rejected the request/i.test(String((e as Error)?.message ?? e))
  )
    return "You rejected the request in your wallet. Nothing was sent.";
  const raw = e instanceof BaseError ? undefined : providerRevertData(e);
  const revert = revertReason(e) ?? (raw ? decodeRaw(raw) : undefined);
  if (revert) return revert.name && ERRORS[revert.name] ? ERRORS[revert.name] : `The contract reverted: ${revert.text}.`;
  // Not a decoded revert: match on the error's short text only (never on the calldata or argument names).
  const text = e instanceof BaseError ? `${e.name} ${e.shortMessage} ${e.details ?? ""}` : String((e as Error)?.message ?? e);
  for (const [re, reason] of OTHER) if (re.test(text)) return reason;
  const short = e instanceof BaseError ? e.shortMessage : (e as Error)?.message;
  return short ? `The transaction failed: ${short.split("\n")[0]}` : "The transaction didn't go through. Nothing was sent.";
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
