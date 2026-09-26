import { formatUnits } from "viem";
export function amount(
  value: string | bigint | undefined | null,
  decimals = 18,
  digits = 4,
) {
  if (value === undefined || value === null) return "—";
  const [whole, fraction = ""] = formatUnits(BigInt(value), decimals).split(
    ".",
  );
  return (
    BigInt(whole).toLocaleString("en-US") +
    (digits && fraction
      ? "." + fraction.slice(0, digits).replace(/0+$/, "")
      : ""
    ).replace(/\.$/, "")
  );
}
export const short = (a: string) =>
  a ? a.slice(0, 6) + "…" + a.slice(-4) : "Disconnected";
export function countdown(ts: string) {
  const d = Math.max(0, Number(ts) - Date.now() / 1000);
  return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
}
export function parityOutput(
  input: bigint,
  fromRatio: bigint,
  toRatio: bigint,
  fromDecimals: number,
  toDecimals: number,
) {
  return (
    (input * fromRatio * 10n ** BigInt(toDecimals)) /
    (toRatio * 10n ** BigInt(fromDecimals))
  );
}
/**
 * A raw integer amount with `decimals` places, rounded half-up to `digits` places and grouped: display only. The raw
 * value stays in state and in transaction data.
 */
export function fixed(value: bigint | string, decimals: number, digits: number) {
  const v = BigInt(value);
  const neg = v < 0n,
    abs = neg ? -v : v;
  const drop = BigInt(decimals - digits);
  const scaled = drop > 0n ? (abs + 5n * 10n ** (drop - 1n)) / 10n ** drop : abs * 10n ** -drop;
  const unit = 10n ** BigInt(digits);
  const whole = (scaled / unit).toLocaleString("en-US"),
    frac = (scaled % unit).toString().padStart(digits, "0");
  return (neg && scaled ? "−" : "") + (digits ? `${whole}.${frac}` : whole);
}
/** Share counts (18 decimals): two places, half-up (99.999999 → "100.00", 99.979999 → "99.98"). */
export const fmtShares = (x: bigint | string, digits = 2) => fixed(x, 18, digits);
/** Token amounts: four places, half-up (98.990099 → "98.9901"). */
export const fmtTokens = (x: bigint | string, decimals: number, digits = 4) => fixed(x, decimals, digits);
/** The exact value behind a rounded number, for its tooltip: every digit, plus the raw integer. */
export const exact = (x: bigint | string, decimals: number, unit: string) => {
  const s = formatUnits(BigInt(x), decimals);
  return `${s} ${unit} (raw ${BigInt(x).toString()})`;
};
/** Seconds as "23h 04m", "4m 09s" or "9s". */
export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}h ${two(m)}m` : m ? `${m}m ${two(r)}s` : `${r}s`;
}
