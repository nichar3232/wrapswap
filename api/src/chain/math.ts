export const WAD = 10n ** 18n;
export function shares(amount: bigint, spt: bigint, decimals: number) {
  return (amount * spt) / 10n ** BigInt(decimals);
}
export function tokens(qty: bigint, spt: bigint, decimals: number) {
  if (spt <= 0n) throw Error("Invalid share multiplier");
  return (qty * 10n ** BigInt(decimals)) / spt;
}
export function lessFee(amount: bigint, bps: number) {
  return amount - (BigInt(bps) * amount) / 10000n;
}
export function deviation(price: bigint, ratio: bigint) {
  return ratio === 0n
    ? 0
    : Number(
        ((price > ratio ? price - ratio : ratio - price) * 10000n) / ratio,
      );
}
export function poolPrice(sqrt: bigint, dec0: number, dec1: number) {
  return (
    (sqrt * sqrt * WAD * 10n ** BigInt(dec0)) /
    (2n ** 192n * 10n ** BigInt(dec1))
  );
}
