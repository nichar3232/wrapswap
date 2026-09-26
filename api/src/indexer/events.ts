import { abis, topics, type Deployment } from "@wrapswap/types";
import { decodeEventLog, type Abi } from "viem";
import { json } from "../chain/client.js";
export const eventAbi = Object.values(abis)
  .flat()
  .filter((x) => x.type === "event") as Abi;
export const eventNames = [
  ...new Set(Object.keys(topics).map((x) => x.split(".")[1])),
];
const tables: Record<string, string> = {
  PoolRegistered: "parity_pools",
  FeeQuoted: "parity_fee_quotes",
  InventoryFill: "parity_fills",
  FallThrough: "parity_fallthroughs",
  InventoryChanged: "parity_inventory_changes",
  FeesSwept: "parity_fee_sweeps",
  PegGuardStatus: "parity_peg_status",
  Committed: "dark_commits",
  Revealed: "dark_reveals",
  RevealRejected: "dark_reveal_rejections",
  Crossed: "dark_crosses",
  ResidualRouted: "dark_residuals",
  ResidualSkipped: "dark_residual_skips",
  Forfeited: "dark_forfeits",
  BatchSettled: "dark_batches",
  EligibilityDenied: "eligibility_denials",
  DemoModeSet: "demo_mode_changes",
  MidUpdated: "oracle_mids",
};
export function accepts(log: any, d: Deployment) {
  const key = Object.entries(topics).find(
    ([, topic]) => topic === log.topics[0],
  )?.[0];
  if (!key) return false;
  const owner = key.split(".")[0];
  const contract = (
    {
      IParityHook: "parityHook",
      IDarkCrossHook: "darkCrossHook",
      IEligibility: "eligibility",
      IPriceOracle: "oracle",
      IMockPriceOracle: "oracle",
      IIssuerRegistry: "registry",
      INyseCalendar: "calendar",
    } as Record<string, string>
  )[owner];
  const candidates = contract
    ? [d.contracts[contract as keyof Deployment["contracts"]]]
    : d.tokens.map((t) =>
        owner === "IWrapperAdapter" ? t.adapter : t.address,
      );
  return (
    candidates.some((a) => a?.toLowerCase() === log.address.toLowerCase()) &&
    log.blockNumber >=
      BigInt(contract ? (d.blocks[contract] ?? d.startBlock) : d.startBlock)
  );
}
export function decode(log: any) {
  return decodeEventLog({
    abi: eventAbi,
    data: log.data,
    topics: log.topics,
    strict: true,
  });
}
export function projection(
  event: string,
  args: any,
  provenance: Record<string, any>,
  d: Deployment,
) {
  let table = tables[event];
  let a: any = { ...json(args) };
  if (
    event === "EligibilityDenied" &&
    ![d.contracts.parityHook, d.contracts.darkCrossHook].some(
      (x) => x.toLowerCase() === a.caller.toLowerCase(),
    )
  )
    return null;
  if (event === "InventoryFill") {
    a.tokenIn = a.zeroForOne ? d.pool.key.currency0 : d.pool.key.currency1;
    a.tokenOut = a.zeroForOne ? d.pool.key.currency1 : d.pool.key.currency0;
  }
  if (event === "FeesSwept") {
    a.recipient = a.to;
    delete a.to;
  }
  if (event === "Funded" || event === "Withdrawn") {
    table = "dark_escrow_events";
    a.kind = event === "Funded" ? "FUNDED" : "WITHDRAWN";
  }
  if (event.startsWith("Issuer")) {
    table = "registry_events";
    a.kind = (
      {
        IssuerAdded: "ADDED",
        IssuerRemoved: "REMOVED",
        IssuerPaused: "PAUSED",
      } as any
    )[event];
  }
  if (event === "RatioUpdated" || event === "MultiplierUpdated") {
    table = "ratio_updates";
    a =
      event === "RatioUpdated"
        ? {
            source: "ADAPTER",
            token: a.token,
            oldValue: a.oldSharesPerToken,
            newValue: a.newSharesPerToken,
          }
        : {
            source: "TOKEN",
            token: provenance.contract,
            oldValue: a.oldMultiplier,
            newValue: a.newMultiplier,
          };
  }
  if (!table) {
    if (!eventNames.includes(event)) throw Error(`Unknown event ${event}`);
    table = "admin_events";
    a = { eventName: event, args: json(args) };
  }
  const row = {
    ...provenance,
    ...Object.fromEntries(
      Object.entries(a).map(([k, v]) => [
        k.replace(/[A-Z]/g, (x) => "_" + x.toLowerCase()),
        typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : v,
      ]),
    ),
  };
  return {
    sql: `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(
      row,
    )
      .map((_, i) => "$" + (i + 1))
      .join(",")}) ON CONFLICT DO NOTHING`,
    values: Object.values(row),
  };
}
