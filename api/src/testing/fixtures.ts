import { readFileSync } from "node:fs";
import { parseDeployment, canonical, topics } from "@wrapswap/types";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import { eventAbi } from "../indexer/events.js";
export const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const text = readFileSync(
  new URL("../../../INTERFACES.md", import.meta.url),
  "utf8",
);
const example = JSON.parse(
  text.split("Worked example, anvil")[1].split("```json\n")[1].split("```")[0],
);
example.pool.id = hash(99); // The illustrative ID in the frozen prose is shorter than bytes32.
example.startBlock = "1";
example.blocks = {};
export const deployment = parseDeployment(
  JSON.parse(
    JSON.stringify(example, (_, v) =>
      typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
        ? getAddress(v.toLowerCase())
        : v,
    ),
  ),
);
export function fixture(eventName: string, index = 0, overrides: any = {}) {
  const event: any = eventAbi.find((e: any) => e.name === eventName);
  const args: any = Object.fromEntries(
    event.inputs.map((i: any) => [
      i.name,
      i.type === "address"
        ? deployment.tokens[0].address
        : i.type === "bool"
          ? true
          : i.type.startsWith("bytes")
            ? i.type === "bytes"
              ? "0x1234"
              : hash(99)
            : 1n,
    ]),
  );
  if (eventName === "EligibilityDenied")
    args.caller = deployment.contracts.parityHook;
  // A dark residual: the DarkCrossHook's ParityHook fill for the trader and ResidualFilled, in one transaction.
  if (eventName === "InventoryFill") args.sender = deployment.contracts.darkCrossHook;
  Object.assign(args, overrides);
  const owner = Object.keys(topics)
    .find((k) => k.endsWith("." + eventName))!
    .split(".")[0];
  const key = (
    {
      IParityHook: "parityHook",
      IDarkCrossHook: "darkCrossHook",
      IEligibility: "eligibility",
      IPriceOracle: "oracle",
      IMockPriceOracle: "oracle",
      IIssuerRegistry: "registry",
    } as any
  )[owner];
  const emitter = key
    ? (deployment.contracts as any)[key]
    : owner === "IWrapperAdapter"
      ? deployment.tokens[0].adapter
      : deployment.tokens[0].address;
  return {
    address: emitter,
    topics: encodeEventTopics({ abi: [event], eventName, args }),
    data: encodeAbiParameters(
      event.inputs.filter((i: any) => !i.indexed),
      event.inputs.filter((i: any) => !i.indexed).map((i: any) => args[i.name]),
    ),
    blockNumber: 1n,
    blockHash: hash(1),
    transactionHash: ["InventoryFill", "ResidualFilled"].includes(eventName) ? hash(500) : hash(index + 100),
    logIndex: index,
    removed: false,
  };
}
export function chainMock() {
  const f = canonical.feeBreakdown(600n, 400n);
  return {
    getChainId: async () => 31337,
    getBlockNumber: async () => 1n,
    getBlock: async () => ({
      number: 1n,
      hash: hash(1),
      parentHash: hash(0),
      timestamp: 1790692200n,
    }),
    getLogs: async () => [],
    readContract: async ({
      functionName: fn,
      args,
      address,
    }: any): Promise<any> => {
      if (fn === "ratio")
        return [
          address.toLowerCase() === deployment.tokens[0].adapter.toLowerCase()
            ? 1012500000000000000n
            : 10n ** 18n,
          true,
        ];
      if (fn === "sharesPerToken")
        return address.toLowerCase() ===
          deployment.tokens[0].adapter.toLowerCase()
          ? 1012500000000000000n
          : 10n ** 18n;
      if (fn === "active") return true;
      if (fn === "balanceOf") return 100000000n;
      if (fn === "check") return [true, 0];
      if (fn === "demoMode") return true;
      if (fn === "feeBreakdown") return f;
      if (fn === "quote" && args.length === 4) {
        // ParityHook.quote(asset, from, to, amountIn) → (sharesOut, baseFee, skewFee, postSkew, reducesImbalance)
        const shares = (args[3] * 1012500000000000000n) / 10n ** 6n;
        const baseFee = (shares * BigInt(f.basePips)) / 1_000_000n,
          skewFee = (shares * BigInt(f.skewPips)) / 1_000_000n;
        return [shares - baseFee - skewFee, baseFee, skewFee, f.postSkewX18, f.reducesImbalance];
      }
      if (fn === "quote")
        return {
          fillable: true,
          ...canonical.parityQuote(
            { spt: 1012500000000000000n, decimals: 6 },
            { spt: 10n ** 18n, decimals: 18 },
            args[2],
            f.totalPips,
          ),
          fee: f,
        };
      if (fn === "pegStatus")
        return {
          poolPriceX18: 1012500000000000000n,
          parityPriceX18: 1012500000000000000n,
          deviationBps: 0n,
          tripped: false,
        };
      if (fn === "extsload") return hash(1);
      if (["inventory", "inventoryShares", "feesAccrued"].includes(fn))
        return 100n;
      if (fn === "currentBatch") return [1n, 2, 20n];
      if (fn === "participants") return [deployment.deployer];
      if (fn === "getMid") return [1012500000000000000n, 1790692200n];
      if (fn === "ORACLE_MAX_AGE") return 600n;
      if (fn === "baseFeePips") return 200n;
      if (fn === "SKEW_FEE_CAP_PIPS") return 5000n;
      if (fn === "batchOrigin") return 0n;
      if (fn === "settled" || fn === "pegTripped") return false;
      throw Error(`Unmocked ${fn}`);
    },
    simulateContract: async () => ({ result: [100n, 10n] }),
    getGasPrice: async () => 1n,
    waitForTransactionReceipt: async () => ({ status: "success" }),
    getTransactionCount: async () => 0,
  };
}
