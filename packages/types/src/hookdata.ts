// ParityHook hookData v1 (INTERFACES.md §3): abi.encode(uint8 version, address swapper, bytes32 attestationUid).
export const PARITY_HOOK_DATA_VERSION = 1;
const ZERO32 = `0x${"0".repeat(64)}` as const;

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export function encodeParityHookData(args: {
  swapper: `0x${string}`;
  attestationUid?: `0x${string}`;
}): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.swapper)) throw new Error("swapper must be a 20-byte address");
  const uid = args.attestationUid ?? ZERO32;
  if (!/^0x[0-9a-fA-F]{64}$/.test(uid)) throw new Error("attestationUid must be bytes32");
  return `0x${word(PARITY_HOOK_DATA_VERSION.toString(16))}${word(args.swapper)}${word(uid)}`;
}

export function decodeParityHookData(data: `0x${string}`):
  | { version: number; swapper: `0x${string}`; attestationUid: `0x${string}` }
  | null {
  const hex = data.replace(/^0x/, "");
  if (hex.length === 0) return null;
  if (hex.length !== 192) throw new Error("InvalidHookData: length");
  const version = Number.parseInt(hex.slice(0, 64), 16);
  if (version !== PARITY_HOOK_DATA_VERSION) throw new Error("InvalidHookData: version");
  return {
    version,
    swapper: `0x${hex.slice(64 + 24, 128)}`,
    attestationUid: `0x${hex.slice(128, 192)}`,
  };
}
