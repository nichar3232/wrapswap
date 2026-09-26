import { it, expect, vi } from "vitest";
import { validators } from "@wrapswap/types";
import { Crank, retryDelay } from "./worker.js";
import { deployment, chainMock, hash } from "../../api/src/testing/fixtures.js";
function setup() {
  const client = chainMock(),
    original = client.readContract;
  const settled = new Set<string>();
  client.readContract = async (p: any) =>
    p.functionName === "settled"
      ? settled.has(String(p.args[0]))
      : p.functionName === "participants"
        ? p.args[0] === 1n
          ? [deployment.deployer]
          : []
        : original(p);
  const wallet = {
    writeContract: vi.fn(async (p: any) => {
      if (p.functionName === "settle") settled.add(String(p.args[0]));
      return hash(1);
    }),
  };
  const make = () =>
    new Crank(deployment, client, wallet, { address: deployment.deployer });
  return { client, wallet, make };
}
it("two runs and a restarted worker settle once", async () => {
  const { make, wallet } = setup();
  const w = make();
  await w.tick();
  await w.tick();
  await make().tick();
  expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  expect(validators.CrankStatusResponse.is(w.status)).toBe(true);
});
it("crash after broadcast recovers from on-chain settlement", async () => {
  const { make, client, wallet } = setup();
  client.waitForTransactionReceipt = vi
    .fn()
    .mockRejectedValueOnce(Error("crash after mining"))
    .mockResolvedValue({ status: "success" });
  await make().tick();
  await make().tick();
  expect(wallet.writeContract).toHaveBeenCalledTimes(1);
});
it("busy fence forbids overlapping transactions", async () => {
  const { make, wallet } = setup();
  const w = make();
  await Promise.all([w.tick(), w.tick()]);
  expect(wallet.writeContract).toHaveBeenCalledTimes(1);
});
it("pending nonce recovery waits and replaces stuck nonce", async () => {
  const { make, client } = setup();
  let replaced = false;
  client.getTransactionCount = async (p?: any) =>
    p.blockTag === "pending" && !replaced ? 1 : 0;
  const w = make();
  w.wallet.sendTransaction = vi.fn(async () => {
    replaced = true;
    return hash(2);
  });
  let time = 0;
  await w.recoverPending(
    () => time,
    async () => {
      time += 60000;
    },
  );
  expect(w.wallet.sendTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ nonce: 0, value: 0n }),
  );
});
it("retry jitter and fee bump are bounded", () =>
  expect(retryDelay(100, () => 1)).toBe(30000));
it("pushes missing oracle price before settlement and checks peg on swap blocks", async () => {
  const { client, wallet } = setup(),
    original = client.readContract;
  let price = false;
  client.readContract = async (p: any) => {
    if (p.functionName === "getMid") {
      if (!price) throw Error("NoPrice");
      return [1012500000000000000n, 1790692200n];
    }
    if (p.functionName === "pegStatus") return { tripped: true };
    return original(p);
  };
  client.getLogs = async () => [{}] as any;
  const write = wallet.writeContract.getMockImplementation()!;
  wallet.writeContract.mockImplementation(async (p: any) => {
    if (p.functionName === "setMid") price = true;
    return write(p);
  });
  const worker = new Crank(deployment, client, wallet, {
    address: deployment.deployer,
  });
  await worker.tick();
  expect(wallet.writeContract.mock.calls.map((c) => c[0].functionName)).toEqual(
    ["setMid", "settle", "checkPeg"],
  );
  expect(worker.status.lastOraclePush?.midX18).toBe("1012500000000000000");
  expect(worker.status.lastPegCheck?.tripped).toBe(true);
});
it("never settles the current batch during reveal", async () => {
  const { make, client, wallet } = setup(),
    read = client.readContract;
  client.readContract = async (p: any) =>
    p.functionName === "currentBatch" ? [1n, 1, 18n] : read(p);
  await make().tick();
  expect(wallet.writeContract).not.toHaveBeenCalled();
});
