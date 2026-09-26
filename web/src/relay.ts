/**
 * Demo relay client (services/relay, served as {api}/demo/*): lets a visitor without a wallet trigger real
 * Unichain Sepolia (and, for Send, Sui testnet) transactions signed server-side by the demo key. Every call returns
 * real transaction hashes. The relay has no per-action cap and no rate limit of its own.
 */
import { config } from "./config";

export type RelayStatus = {
  ok: boolean;
  address: `0x${string}`;
  ethWei: string;
  tokens: { asset: string; symbol: string; balance: string }[];
  sui?: { busy?: string | null };
  pendingReveals: { asset: string; batchId: string }[];
  recent: { at: string; action: string; asset?: string; txHash?: string; batchId?: string }[];
};
export type RelayConvert = { asset: string; from: string; to: string; amountIn: string; sharesIn: string; quotedOut: string; feeBps: string; approveTx: string | null; txHash: `0x${string}` };
export type RelayDarkCommit = { asset: string; batchId: string; side: "sellBase" | "sellQuote"; amountIn: string; sharesIn: string; limitPriceX18: string; fundTx: string | null; txHash: `0x${string}` };
export type RelaySendStep = { step: string; at: string; chain: "unichain" | "sui"; tx: string; url: string; detail?: Record<string, string> };
export type RelaySendJob = {
  id: string;
  status: "deposited" | "credited" | "paid" | "withdraw-submitted" | "settled" | "skipped" | "failed";
  asset: string;
  from: string;
  to: string;
  amountIn: string;
  shares: string;
  recipient: `0x${string}`;
  depositTx: `0x${string}`;
  steps: RelaySendStep[];
  error?: string;
  settledAmountOut?: string;
};

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds the web server's per-IP request limit asks to wait (429 only). */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const base = () => `${config.apiUrl}/demo`;

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${base()}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new RelayError(0, "UNAVAILABLE", "The demo relay didn't respond.");
  }
  const json = (r.headers.get("content-type") ?? "").includes("json") ? await r.json().catch(() => undefined) : undefined;
  if (r.ok && json) return json as T;
  const err = (json as { error?: { code?: string; message?: string; retryAfter?: number } } | undefined)?.error;
  if (r.status === 429)
    throw new RelayError(429, "RATE_LIMITED", err?.message ?? "too many requests", Number(r.headers.get("retry-after")) || err?.retryAfter || 60);
  throw new RelayError(r.status, err?.code ?? (r.status === 404 ? "NOT_FOUND" : "RELAY"), err?.message ?? `demo relay ${r.status}`);
}

/** GET {api}/demo/status, or null when no relay is served. */
export const relayStatus = () => call<RelayStatus>("GET", "/status").catch(() => null);

const action = <T>(name: "convert" | "dark-commit" | "send", body: unknown) => call<T>("POST", `/${name}`, body);
/** Convert {asset, from, to, amount (whole tokens)} → WrapSwapRouter.swapExactIn delivering to the relay. */
export const relayConvert = (b: { asset: string; from: string; to: string; amount: string }) => action<RelayConvert>("convert", b);
/** Escrow + commit on the asset's DarkCrossHook; the relay reveals in the reveal phase and the crank settles. */
export const relayDarkCommit = (b: { asset: string; from: string; amount: string }) => action<RelayDarkCommit>("dark-commit", b);
/** Send on the Sui confidential path: ShareVault deposit → sealed pay on Sui → withdraw into the other issuer. */
export const relaySend = (b: { asset: string; from: string; to: string; amount: string; recipient: string }) => action<RelaySendJob>("send", b);
export const relaySendJob = (id: string) => call<RelaySendJob>("GET", `/send/${encodeURIComponent(id)}`);

/** Whole-token decimal string for the relay ("100", "0.5"): what the user typed, normalised. */
export const relayAmount = (input: string) => input.trim().replace(/\.$/, "").replace(/^0+(?=\d)/, "");
