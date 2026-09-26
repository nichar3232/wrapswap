import "./runtime.js";
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, getAddress, type Abi } from "viem";
import {
  abis,
  parseDeployment,
  parseNetwork,
  deploymentPath,
  type Deployment,
} from "@wrapswap/types";
// Unichain Sepolia (1301) is the default network; NETWORK=anvil selects the offline stack. Set before `rpc` below
// is read, and before every entrypoint (all import this module) checks its required env.
process.env.NETWORK ||= "unichain-sepolia";
if (process.env.NETWORK === "unichain-sepolia") process.env.RPC_URL ||= "https://sepolia.unichain.org";
export function loadDeployment(
  network = process.env.NETWORK,
  root = process.cwd(),
): Deployment {
  const n = parseNetwork(network);
  const d = parseDeployment(
    JSON.parse(readFileSync(resolve(root, deploymentPath(n)), "utf8")),
  );
  if (d.network !== n) throw Error("Deployment network mismatch");
  return JSON.parse(
    JSON.stringify(d, (_, v) =>
      typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
        ? getAddress(v.toLowerCase())
        : v,
    ),
  );
}
export const manifest = loadDeployment;
export const rpc = process.env.RPC_URL;
export const publicClient = createPublicClient({
  transport: http(rpc || `http://127.0.0.1:${process.env.ANVIL_PORT ?? 18504}`),
});
export const contractAbis: Record<string, Abi> = {
  parityHook: abis.IParityHook,
  darkCrossHook: abis.IDarkCrossHook,
  eligibility: abis.IEASEligibility,
  oracle: abis.IMockPriceOracle,
  registry: abis.IIssuerRegistry,
  calendar: abis.INyseCalendar,
};
export const stringify = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export const json = (value: unknown): any =>
  JSON.parse(stringify(value), (_, v) =>
    typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
      ? v.toLowerCase()
      : v,
  );
export function chainReader(d: Deployment, client: any = publicClient) {
  return async (
    contract: string,
    functionName: string,
    args: unknown[] = [],
    blockNumber?: bigint,
  ): Promise<any> =>
    client.readContract({
      address: d.contracts[contract as keyof typeof d.contracts],
      abi: contractAbis[contract],
      functionName,
      args,
      blockNumber,
    });
}
