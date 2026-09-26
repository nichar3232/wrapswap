import { abis, topics, type Deployment } from "@wrapswap/types";
import { decodeEventLog, parseAbi, toEventSelector, type Abi } from "viem";
import { json } from "../chain/client.js";
// TestShareFaucet is a testnet mock outside the frozen interfaces; its events are indexed from the manifest's `faucet`.
export const faucetAbi = parseAbi([
  "event Claimed(address indexed account, uint256 timestamp)",
  "event TokenListed(address indexed token)",
]);
const faucetTopics = new Map(faucetAbi.map((e) => [toEventSelector(e), e.name]));
export const eventAbi = [
  ...Object.values(abis)
    .flat()
    .filter((x) => x.type === "event"),
  ...faucetAbi,
] as Abi;
/** Every issuer token in the manifest: `tokens` plus each `assets[].wrappers` entry (multi-asset deployments). */
export function deploymentTokens(d: Deployment) {
  const out = d.tokens.map((t) => ({ ...t }));
  for (const a of d.assets ?? [])
    for (const w of a.wrappers)
      if (!out.some((t) => t.address.toLowerCase() === w.token.toLowerCase()))
        out.push({
          symbol: w.symbol,
          address: w.token,
          adapter: w.adapter,
          decimals: w.decimals,
          underlying: a.symbol,
          issuer: w.platform.toLowerCase(),
        } as any);
  return out;
}
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
  Claimed: "faucet_claims",
};
/** Pool key for a ParityHook pool id: any `assets[].pool` in a multi-asset manifest, else the single `pool`. */
export function poolKeyOf(d: Deployment, poolId: string) {
  const pool = [...(d.assets ?? []).map((a) => a.pool), d.pool].find(
    (p) => p.id.toLowerCase() === String(poolId).toLowerCase(),
  );
  return pool?.key;
}
export function accepts(log: any, d: Deployment) {
  if (faucetTopics.has(log.topics[0]))
    return (
      !!d.faucet &&
      d.faucet.toLowerCase() === log.address.toLowerCase() &&
      log.blockNumber >= BigInt(d.startBlock)
    );
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
    : deploymentTokens(d).map((t) =>
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
  if (event === "TokenListed") return null;
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
    // One ParityHook serves every asset's pool: resolve the fill's currencies from its own poolId.
    const key = poolKeyOf(d, a.poolId);
    if (!key) return null; // a pool outside the manifest (anyone can initialise a pool on the hook)
    a.tokenIn = a.zeroForOne ? key.currency0 : key.currency1;
    a.tokenOut = a.zeroForOne ? key.currency1 : key.currency0;
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
