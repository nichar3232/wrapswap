// Exact decimal <-> bigint conversion (no floating point anywhere on the money path).

export const SHARE_DECIMALS = 18;

/** "50", "0.5", 50 -> raw units with `decimals` places (truncates extra digits; rejects negatives and junk). */
export function parseUnits(value: string | number, decimals: number): bigint {
  const s = typeof value === "number" ? numberToString(value) : value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a non-negative decimal amount: ${value}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatUnits(raw: bigint | string, decimals: number, maxFraction = decimals): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  let frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? "." + frac : ""}`;
}

/** Canonical shares (1e18) as a readable decimal. */
export const shares = (raw: bigint | string) => formatUnits(raw, SHARE_DECIMALS, 6);

/** Token amount (raw) for `sharesRaw` canonical shares of a wrapper: floor(shares * 10^dec / sharesPerToken). */
export function tokensForShares(sharesRaw: bigint, sharesPerTokenX18: bigint, decimals: number): bigint {
  return (sharesRaw * 10n ** BigInt(decimals)) / sharesPerTokenX18;
}

export const bps = (pips: number | string) => `${(Number(pips) / 100).toFixed(2)} bps`;

function numberToString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`Not a non-negative amount: ${n}`);
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 });
}
