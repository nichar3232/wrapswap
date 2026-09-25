import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Abi,
} from "viem";
export const rpc = process.env.LOCAL_RPC || "http://127.0.0.1:8545";
export const publicClient = createPublicClient({ transport: http(rpc) });
export type Token = { address: Address; symbol: string; decimals: number };
export type Manifest = {
  chainId: number;
  blockNumber: string;
  demoMode: boolean;
  contracts: Record<string, Address>;
  tokens: Record<string, Token>;
  pools: {
    id: `0x${string}`;
    kind: string;
    key: {
      currency0: Address;
      currency1: Address;
      fee: number;
      tickSpacing: number;
      hooks: Address;
    };
  }[];
  burners?: { address: Address; privateKey: `0x${string}` }[];
};
export function manifest(): Manifest {
  return JSON.parse(
    readFileSync(
      process.env.DEPLOYMENT_FILE || "deployments/local.json",
      "utf8",
    ),
  );
}
export function abi(name: string): Abi {
  const raw = JSON.parse(
    readFileSync(resolve("deployments/abis", name + ".json"), "utf8"),
  );
  return raw.abi || raw;
}
export const erc20 = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function decimals() view returns(uint8)",
]);
export const adapterAbi = parseAbi([
  "function sharesPerToken() view returns(uint256)",
]);
export async function read(
  contract: string,
  name: string,
  args: unknown[] = [],
): Promise<any> {
  const m = manifest();
  const names: Record<string, string> = {
    vault: "CanonicalStock",
    registry: "IssuerRegistry",
    calendar: "NyseCalendar",
    parityHook: "ParityHook",
    darkCrossHook: "DarkCrossHook",
  };
  return publicClient.readContract({
    address: m.contracts[contract],
    abi: abi(names[contract]),
    functionName: name,
    args,
  });
}
export async function ratio(token: Address) {
  const m = manifest();
  if (token.toLowerCase() === m.tokens.uAAPL.address.toLowerCase())
    return 10n ** 18n;
  const addr = await read("registry", "adapterOf", [token]);
  return publicClient.readContract({
    address: addr,
    abi: adapterAbi,
    functionName: "sharesPerToken",
  });
}
export const stringify = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
