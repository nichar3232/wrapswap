/**
 * Demo relay client (services/relay, served as {api}/demo/*): lets a visitor without a wallet trigger real
 * Unichain Sepolia (and, for Send, Sui testnet) transactions signed server-side by the demo key. Every call returns
 * real transaction hashes. The relay allows 3 actions per 10 minutes per IP (429 when exceeded).
 */
import { config } from "./config";

export type RelayStatus = {
  ok: boolean;
  address: `0x${string}`;
  ethWei: string;
  tokens: { asset: string; symbol: string; balance: string }[];
  sui?: { busy?: string | null };
  limits: { actionsPer10Min: number; maxShares: string };
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

export const RELAY_WINDOW_S = 600;
export const RELAY_ACTIONS = 3;

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds until the next action is allowed (429 only). */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const base = () => `${config.apiUrl}/demo`;

// This browser's own relay actions: the countdown when a 429 carries no Retry-After (the web server's proxy drops it).
const LOG_KEY = "unison:relay:actions",
  UNTIL_KEY = "unison:relay:until";
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked: the countdown lives for this page only */
  }
};
let memUntil = 0;
const actionLog = (): number[] => {
  try {
    const now = Date.now();
    return (JSON.parse(read(LOG_KEY) ?? "[]") as number[]).filter((t) => now - t < RELAY_WINDOW_S * 1000);
  } catch {
    return [];
  }
};
const listeners = new Set<() => void>();
export const onRelayLimit = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
/** Seconds until the relay accepts this visitor's next action (0 = now). */
export function relayCooldown(now = Date.now()) {
  const until = Math.max(Number(read(UNTIL_KEY) ?? 0), memUntil);
  return Math.max(0, Math.ceil((until - now) / 1000));
}
function limitedFor(seconds: number) {
  memUntil = Date.now() + seconds * 1000;
  write(UNTIL_KEY, String(memUntil));
  listeners.forEach((f) => f());
}

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
  if (r.status === 429) {
    const log = actionLog();
    const fromLog = log.length >= RELAY_ACTIONS ? Math.ceil((log[0] + RELAY_WINDOW_S * 1000 - Date.now()) / 1000) : RELAY_WINDOW_S;
    const retryAfter = Number(r.headers.get("retry-after")) || err?.retryAfter || fromLog;
    limitedFor(retryAfter);
    throw new RelayError(429, "RATE_LIMITED", err?.message ?? "3 demo actions per 10 minutes", retryAfter);
  }
  throw new RelayError(r.status, err?.code ?? (r.status === 404 ? "NOT_FOUND" : "RELAY"), err?.message ?? `demo relay ${r.status}`);
}

/** GET {api}/demo/status, or null when no relay is served. */
export const relayStatus = () => call<RelayStatus>("GET", "/status").catch(() => null);

async function action<T>(name: "convert" | "convert-all" | "dark-commit" | "send", body: unknown) {
  const out = await call<T>("POST", `/${name}`, body);
  write(LOG_KEY, JSON.stringify([...actionLog(), Date.now()]));
  return out;
}
/** Convert {asset, from, to, amount (whole tokens)} → WrapSwapRouter.swapExactIn delivering to the relay. */
export const relayConvert = (b: { asset: string; from: string; to: string; amount: string }) => action<RelayConvert>("convert", b);
/** Every other wrapper balance of every asset into the `to` issuer (default xStocks), one swap per asset; one action. */
export const relayConvertAll = (to = "xStocks") => action<{ to: string; results: RelayConvert[] }>("convert-all", { to });
/** Escrow + commit on the asset's DarkCrossHook; the relay reveals in the reveal phase and the crank settles. */
export const relayDarkCommit = (b: { asset: string; from: string; amount: string }) => action<RelayDarkCommit>("dark-commit", b);
/** Send on the Sui confidential path: ShareVault deposit → sealed pay on Sui → withdraw into the other issuer. */
export const relaySend = (b: { asset: string; from: string; to: string; amount: string; recipient: string }) => action<RelaySendJob>("send", b);
export const relaySendJob = (id: string) => call<RelaySendJob>("GET", `/send/${encodeURIComponent(id)}`);

/** Whole-token decimal string for the relay ("100", "0.5"): what the user typed, normalised. */
export const relayAmount = (input: string) => input.trim().replace(/\.$/, "").replace(/^0+(?=\d)/, "");
