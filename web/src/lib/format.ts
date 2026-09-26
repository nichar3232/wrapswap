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
/** Share counts with fixed decimals (default two), e.g. "101.25", "101.10"; fees use four. */
export const fmtShares = (x: bigint | string, digits = 2) => {
  const [w, f = ""] = amount(x, 18, digits).split(".");
  return digits ? `${w}.${f.padEnd(digits, "0")}` : w;
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
